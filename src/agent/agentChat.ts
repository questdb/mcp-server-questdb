import { randomBytes } from "node:crypto"
import type * as acp from "@agentclientprotocol/sdk"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { AgentChannel } from "../bridgeSession.js"
import type {
  AgentCommand,
  AgentConfig,
  AgentInboundMessage,
  AgentInfo,
  AgentOutboundMessage,
  AgentQuestionField,
  AgentQuestionMessage,
  AgentPromptMessage,
  AgentSettingsMessage,
  AgentState,
  AgentTurnResult,
} from "../agentProtocol.js"
import type { Log } from "../types.js"
import type { AcpAgentConnection } from "./acpAgentProcess.js"
import type { InboundRejection } from "./inboundMessages.js"
import {
  configChanges,
  SESSION_MODEL_ID,
  toAgentConfig,
  type DesiredAgentConfig,
} from "./agentConfig.js"
import { AgentProcesses } from "./agentProcesses.js"
import { LocalImageStream } from "./localImages.js"
import { AGENT_MODE_INSTRUCTIONS } from "./questdbMcpHttpServer.js"
import { describeAgentError, isAuthError } from "./agentErrors.js"
import type { AgentLaunch } from "./agentPresets.js"
import type { AgentSessionStore } from "./agentSessionStore.js"
import { autoApprovalOf } from "./agentPermissions.js"
import {
  elicitationContentOf,
  questionFieldsOf,
  skippedContentOf,
} from "./agentQuestions.js"
import { toAgentUpdate, toTokenUsage } from "./agentUpdates.js"

// How long a running turn survives a browser disconnect (sleep, reload). Its
// updates are buffered and delivered when the console reconnects.
export const DETACHED_GRACE_MS = 30_000
const MAX_BUFFERED_MESSAGES = 5_000

const CANCELLED_PERMISSION: acp.RequestPermissionResponse = {
  outcome: { outcome: "cancelled" },
}

type AgentChatConfig = {
  info: AgentInfo
  launch: AgentLaunch
  questdbMcpServerFor: (route: string) => acp.McpServer
  store: AgentSessionStore
  send: (msg: AgentOutboundMessage) => boolean
  log: Log
}

type LiveSession = {
  generation: number
  sessionId: string
  config: AgentConfig
  // Opened for this conversation and not prompted yet. Its first prompt
  // carries the console's instructions, for agents that do not read the
  // MCP server's own instructions. A reopened session has them already.
  isNew?: boolean
  // Reopened, and the agent has not started to reply yet. Its notices until
  // then are about the reopening, like Codex's warning that the session was
  // recorded with another model before the console's model applies.
  reopened?: boolean
}

type WarmSession = LiveSession & { route: string }

type ActiveTurn = {
  turnId: string
  connection: AcpAgentConnection | null
  sessionId: string | null
  cancelled: boolean
  // The reply, with the images it shows from disk written in.
  reply?: { stream: LocalImageStream; messageId: string | null }
  // The text of the message being sent, and of the one before it.
  messages?: { current: string; previous: string }
}

// Codex asks some questions without stopping: it keeps working and takes an
// answer whenever one comes, so a declined question leaves it waiting for an
// answer that never arrives. Its adapter marks these questions.
const keepsWorkingWhileAsking = (request: acp.CreateElicitationRequest) => {
  const codex = request._meta?.codex as
    | Record<string, unknown>
    | null
    | undefined
  return codex?.delivery === "async"
}

// A repeat shorter than this is as likely a new message that starts the same.
const MIN_REPEAT_CHARS = 20

// Whether a message's first piece is the whole of the message before it, sent
// again. Codex sends a /review's findings twice: once as the review's output,
// once as its own message.
const repeatsPrevious = (previous: string, text: string): boolean =>
  text === previous && previous.trim().length >= MIN_REPEAT_CHARS

// How a question ended: answered, skipped by the user, or closed without an
// answer because the turn ended first.
type QuestionOutcome =
  | { kind: "answered"; answers: Record<string, string | string[]> }
  | { kind: "skipped" }
  | { kind: "closed" }

type PendingQuestion = {
  conversationId: string
  message: AgentQuestionMessage
  resolve: (outcome: QuestionOutcome) => void
  // For a link: the agent's id for it, to close it when the agent no longer
  // needs it opened.
  elicitationId?: string
}

const CANCELLED_ELICITATION: acp.CreateElicitationResponse = {
  action: "cancel",
}

type AgentStatus = {
  state: AgentState
  config: AgentConfig | null
  error: string | null
  commands: AgentCommand[]
  acceptsImages: boolean
}

// What the console shows of the agent's commands. The bounds keep a long
// list from an agent within what the console reads.
const MAX_COMMANDS = 100
const commandsOf = (available: acp.AvailableCommand[]): AgentCommand[] =>
  available.slice(0, MAX_COMMANDS).map((command) => ({
    name: command.name.slice(0, 64),
    description: (command.description ?? "").slice(0, 300),
    hint:
      command.input && "hint" in command.input && command.input.hint
        ? String(command.input.hint).slice(0, 80)
        : null,
  }))

const sessionKey = ({
  generation,
  sessionId,
}: {
  generation: number
  sessionId: string
}): string => `${generation}:${sessionId}`

// Config option updates leave out a model that comes from the session's
// `models` field; it stays as it was.
const withSessionModel = (
  next: AgentConfig,
  previous: AgentConfig,
): AgentConfig =>
  next.model || previous.model?.id !== SESSION_MODEL_ID
    ? next
    : { ...next, model: previous.model }

export class AgentChat implements AgentChannel {
  readonly info: AgentInfo
  private readonly processes: AgentProcesses
  private status: AgentStatus = {
    state: "starting",
    config: null,
    error: null,
    commands: [],
    acceptsImages: false,
  }
  private settings: AgentSettingsMessage | null = null
  private warm: Promise<WarmSession | null> | null = null
  private sessions = new Map<string, LiveSession>()
  // Keyed by sessionKey(): session ids are only unique within one process.
  private conversationBySession = new Map<string, string>()
  // Sessions being reopened with session/load, whose history replay must not
  // reach the console as a live reply.
  private reopening = new Set<string>()
  // Route segment of a session's MCP URL → its conversation. The warm
  // session's route is known before any conversation claims it (null): agents
  // connect to their MCP servers as soon as the session opens.
  private routes = new Map<string, string | null>()
  private routeByConversation = new Map<string, string>()
  private activeTurns = new Map<string, ActiveTurn>()
  // An agent CLI often reads its credentials once, when it starts. After a
  // sign-in error the next message starts a fresh process, so a sign-in the
  // user made meanwhile takes effect and the conversation goes on.
  private freshProcessNeeded = false
  private pendingQuestions = new Map<string, PendingQuestion>()
  private browserAttached = false
  private outbox: AgentOutboundMessage[] = []
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private config: AgentChatConfig) {
    this.info = config.info
    this.processes = new AgentProcesses({
      launch: config.launch,
      cwd: config.info.cwd,
      log: config.log,
      handlers: {
        onSessionUpdate: (notification, generation) =>
          this.handleSessionUpdate(notification, generation),
        requestPermission: (request, generation) =>
          this.decidePermission(request, generation),
        elicit: (request, generation) =>
          this.answerElicitation(request, generation),
        onElicitationComplete: (elicitationId) =>
          this.closeLinkRequest(elicitationId),
        onExit: (generation) => this.handleAgentExit(generation),
      },
      isBusy: (conversationId) => this.activeTurns.has(conversationId),
      onRetired: (conversationId) => this.forgetSessionOf(conversationId),
    })
  }

  // Starts the agent before the first message: the console learns the
  // agent's models and effort levels, and the first turn starts instantly.
  start(): void {
    this.warm = this.openWarmSession()
  }

  routeOf(route: string): { conversationId: string | null } | null {
    const conversationId = this.routes.get(route)
    return conversationId === undefined ? null : { conversationId }
  }

  handleBrowserMessage(msg: AgentInboundMessage): void {
    switch (msg.type) {
      case "agent_prompt":
        void this.runTurn(msg)
        return
      case "agent_cancel":
        this.cancelTurn(msg.conversationId)
        return
      case "agent_question_answer":
        this.resolveQuestion(msg.requestId, msg.answers)
        return
      case "agent_settings":
        this.settings = msg
        return
      case "agent_restart":
        void this.restart()
        return
    }
  }

  onBrowserAttached(sameConsole: boolean): void {
    this.browserAttached = true
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    // A fresh console, like a reloaded page, knows none of the running turns:
    // it would drop their updates, and could neither see nor stop them while
    // they block their conversations and call its tools. They are stopped.
    if (!sameConsole) {
      this.outbox = []
      for (const conversationId of this.activeTurns.keys()) {
        this.config.log(
          "INFO",
          `stopping the turn of conversation ${conversationId}: a new console paired`,
        )
        this.cancelTurn(conversationId)
      }
    }
    this.sendStatus()
    const buffered = this.outbox
    this.outbox = []
    for (const msg of buffered) this.deliver(msg)
    for (const pending of this.pendingQuestions.values()) {
      this.config.send(pending.message)
    }
  }

  // A console frame that failed validation still gets an answer, so the
  // console never waits on a turn or a question the agent never saw.
  handleRejectedMessage(rejection: InboundRejection): void {
    switch (rejection.type) {
      case "agent_prompt":
        this.sendTurnEnd(rejection.conversationId, rejection.turnId, {
          outcome: "failed",
          error: rejection.reason,
        })
        return
      case "agent_question_answer":
        this.askAgain(rejection.requestId, rejection.reason)
        return
    }
  }

  onBrowserDetached(): void {
    this.browserAttached = false
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      this.outbox = []
      for (const conversationId of this.activeTurns.keys()) {
        this.cancelTurn(conversationId)
      }
    }, DETACHED_GRACE_MS)
    this.graceTimer.unref()
  }

  stop(): Promise<void> {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    return this.processes.stopAll()
  }

  // ---- Lifecycle ------------------------------------------------------------

  private setStatus(next: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...next }
    this.sendStatus()
  }

  private sendStatus(): void {
    this.deliver({
      v: MCP_BRIDGE_VERSION,
      type: "agent_status",
      ...this.status,
    })
  }

  private async openWarmSession(): Promise<WarmSession | null> {
    this.setStatus({ state: "starting", error: null })
    try {
      const connection = await this.processes.forWarmSession().connection()
      const route = this.newRoute()
      this.routes.set(route, null)
      const created = await this.newSession(connection, route)
      this.setStatus({
        state: "ready",
        config: created.config,
        error: null,
        acceptsImages:
          connection.capabilities.promptCapabilities?.image === true,
      })
      return { ...created, route }
    } catch (err) {
      if (isAuthError(err)) this.freshProcessNeeded = true
      this.setStatus({
        state: "error",
        error: describeAgentError(err, this.config.launch),
      })
      return null
    }
  }

  private async restart(): Promise<void> {
    await this.processes.stopAll()
    this.forgetLiveSessions()
    this.start()
  }

  // Sessions belong to one agent process. After it ends they are reopened from
  // the store on the next message, never reused.
  private forgetLiveSessions(): void {
    for (const session of this.sessions.values()) {
      this.conversationBySession.delete(sessionKey(session))
    }
    this.sessions.clear()
    this.warm = null
  }

  private forgetSessionOf(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.sessions.delete(conversationId)
    this.conversationBySession.delete(sessionKey(session))
  }

  // With a process per conversation, one ending only affects its own
  // conversation, which starts it again on its next message.
  private handleAgentExit(generation: number): void {
    if (this.processes.perConversation) {
      for (const [conversationId, session] of this.sessions) {
        if (session.generation === generation) {
          this.forgetSessionOf(conversationId)
        }
      }
      return
    }
    this.forgetLiveSessions()
    this.setStatus({
      state: "error",
      error: "The agent stopped. Start it again to continue.",
    })
  }

  // ---- Sessions -------------------------------------------------------------

  private newRoute(): string {
    return randomBytes(16).toString("base64url")
  }

  private bindRoute(route: string, conversationId: string): void {
    this.routes.set(route, conversationId)
    this.routeByConversation.set(conversationId, route)
  }

  private routeFor(conversationId: string): string {
    const existing = this.routeByConversation.get(conversationId)
    if (existing) return existing
    const route = this.newRoute()
    this.bindRoute(route, conversationId)
    return route
  }

  private async newSession(
    connection: AcpAgentConnection,
    route: string,
  ): Promise<LiveSession> {
    const response = await connection.agent.request("session/new", {
      cwd: this.info.cwd,
      mcpServers: [this.config.questdbMcpServerFor(route)],
      _meta: {
        claudeCode: {
          options: { allowedTools: ["mcp__questdb_console"] },
        },
      },
    })
    return {
      generation: connection.generation,
      sessionId: response.sessionId,
      config: toAgentConfig(response),
      isNew: true,
    }
  }

  // Picks the agent's own session back up after a bridge restart. Resume
  // skips the history replay; load replays it, and the replay is dropped
  // because the session is not mapped to its conversation yet.
  private async reopenSession(
    connection: AcpAgentConnection,
    sessionId: string,
    route: string,
  ): Promise<LiveSession | null> {
    const params = {
      sessionId,
      cwd: this.info.cwd,
      mcpServers: [this.config.questdbMcpServerFor(route)],
    }
    const reopeningKey = sessionKey({
      generation: connection.generation,
      sessionId,
    })
    this.reopening.add(reopeningKey)
    try {
      const response = connection.capabilities.sessionCapabilities?.resume
        ? await connection.agent.request("session/resume", params)
        : connection.capabilities.loadSession
          ? await connection.agent.request("session/load", params)
          : null
      if (!response) return null
      return {
        generation: connection.generation,
        sessionId,
        config: toAgentConfig(response),
        reopened: true,
      }
    } catch (err) {
      this.config.log(
        "WARN",
        `could not reopen agent session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    } finally {
      this.reopening.delete(reopeningKey)
    }
  }

  private async claimWarmSession(
    connection: AcpAgentConnection,
    conversationId: string,
  ): Promise<LiveSession | null> {
    const pending = this.warm
    this.warm = null
    const warm = await pending
    if (!warm || warm.generation !== connection.generation) return null
    this.bindRoute(warm.route, conversationId)
    return warm
  }

  private async sessionFor(
    connection: AcpAgentConnection,
    conversationId: string,
  ): Promise<LiveSession> {
    const live = this.sessions.get(conversationId)
    if (live?.generation === connection.generation) return live

    const storedId = this.config.store.get(conversationId)
    const session =
      (storedId
        ? await this.reopenSession(
            connection,
            storedId,
            this.routeFor(conversationId),
          )
        : await this.claimWarmSession(connection, conversationId)) ??
      (await this.newSession(connection, this.routeFor(conversationId)))

    this.sessions.set(conversationId, session)
    this.conversationBySession.set(sessionKey(session), conversationId)
    await this.config.store.set(conversationId, session.sessionId)
    return session
  }

  private async applySettings(
    connection: AcpAgentConnection,
    session: LiveSession,
  ): Promise<void> {
    const desired: DesiredAgentConfig = {
      model: this.settings?.model ?? null,
      effort: this.settings?.effort ?? null,
    }
    // One change at a time: a new model can offer other effort levels, so
    // each next change is checked against the config the agent returned.
    const attempted = new Set<string>()
    for (;;) {
      const change = configChanges(session.config, desired).find(
        ({ configId }) => !attempted.has(configId),
      )
      if (!change) break
      attempted.add(change.configId)
      session.config = await this.applyChange(connection, session, change)
      this.config.log(
        "INFO",
        `agent setting: ${change.configId} = ${change.value}`,
      )
    }
    this.setStatus({ config: session.config })
  }

  private async applyChange(
    connection: AcpAgentConnection,
    session: LiveSession,
    change: { configId: string; value: string },
  ): Promise<AgentConfig> {
    if (change.configId === SESSION_MODEL_ID) {
      await connection.agent.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: change.value,
      })
      const model = session.config.model
      return {
        ...session.config,
        model: model && { ...model, current: change.value },
      }
    }
    const response = await connection.agent.request(
      "session/set_config_option",
      {
        sessionId: session.sessionId,
        configId: change.configId,
        value: change.value,
      },
    )
    return withSessionModel(
      toAgentConfig({ configOptions: response.configOptions }),
      session.config,
    )
  }

  // ---- Turns ----------------------------------------------------------------

  private async runTurn(msg: AgentPromptMessage): Promise<void> {
    const { conversationId, turnId } = msg
    if (this.activeTurns.has(conversationId)) {
      this.sendTurnEnd(conversationId, turnId, {
        outcome: "failed",
        error: "The agent is still answering the previous message.",
      })
      return
    }

    const turn: ActiveTurn = {
      turnId,
      connection: null,
      sessionId: null,
      cancelled: false,
    }
    this.activeTurns.set(conversationId, turn)
    try {
      // Only when no other conversation is answering: the restart would
      // stop its turn too.
      if (this.freshProcessNeeded && this.activeTurns.size === 1) {
        this.freshProcessNeeded = false
        await this.processes.stopAll()
        this.forgetLiveSessions()
        if (!this.processes.perConversation) this.start()
      } else if (
        this.status.state === "error" &&
        !this.processes.perConversation
      ) {
        this.start()
      }
      turn.connection = await this.processes
        .forConversation(conversationId)
        .connection()
      const session = await this.sessionFor(turn.connection, conversationId)
      turn.sessionId = session.sessionId
      await this.applySettings(turn.connection, session)
      if (this.status.state !== "ready") {
        this.setStatus({ state: "ready", config: session.config, error: null })
      }
      if (turn.cancelled) {
        this.endTurn(conversationId, {
          outcome: "completed",
          stopReason: "cancelled",
          usage: null,
        })
        return
      }
      // An agent that does not read images gets none; the console does
      // not offer to attach them to it.
      const readsImages =
        turn.connection.capabilities.promptCapabilities?.image === true
      const prompt = msg.prompt.flatMap((block): acp.ContentBlock[] =>
        block.type === "text"
          ? [{ type: "text", text: block.text }]
          : readsImages
            ? [{ type: "image", mimeType: block.mimeType, data: block.data }]
            : [],
      )
      // A command, like /review, is read only at the start of a message;
      // the instructions wait for the next one.
      const isCommand =
        msg.prompt[0]?.type === "text" && msg.prompt[0].text.startsWith("/")
      if (session.isNew && !isCommand) {
        session.isNew = false
        prompt.unshift({
          type: "text",
          text: `<questdb_console_instructions>\n${AGENT_MODE_INSTRUCTIONS}\n</questdb_console_instructions>`,
        })
      }
      const response = await turn.connection.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt,
      })
      this.endTurn(conversationId, {
        outcome: "completed",
        stopReason: response.stopReason,
        usage: toTokenUsage(response),
      })
    } catch (err) {
      if (isAuthError(err)) this.freshProcessNeeded = true
      const error = describeAgentError(err, this.config.launch)
      this.config.log("ERROR", `agent turn failed: ${error}`)
      this.endTurn(conversationId, { outcome: "failed", error })
    }
  }

  private cancelTurn(conversationId: string): void {
    const turn = this.activeTurns.get(conversationId)
    if (!turn) return
    turn.cancelled = true
    this.cancelQuestionsOf(conversationId)
    if (turn.connection && turn.sessionId) {
      void turn.connection.agent
        .notify("session/cancel", { sessionId: turn.sessionId })
        .catch(() => undefined)
    }
  }

  private endTurn(conversationId: string, result: AgentTurnResult): void {
    const turn = this.activeTurns.get(conversationId)
    if (turn) this.flushReply(conversationId, turn)
    this.activeTurns.delete(conversationId)
    this.cancelQuestionsOf(conversationId)
    if (turn) this.sendTurnEnd(conversationId, turn.turnId, result)
  }

  // Sends what of the reply waited for the rest of an image.
  private flushReply(conversationId: string, turn: ActiveTurn): void {
    if (!turn.reply) return
    const text = turn.reply.stream.flush()
    if (!text) return
    this.deliver({
      v: MCP_BRIDGE_VERSION,
      type: "agent_update",
      conversationId,
      turnId: turn.turnId,
      update: { kind: "message_chunk", messageId: turn.reply.messageId, text },
    })
  }

  private sendTurnEnd(
    conversationId: string,
    turnId: string,
    result: AgentTurnResult,
  ): void {
    this.deliver({
      v: MCP_BRIDGE_VERSION,
      type: "agent_turn_end",
      conversationId,
      turnId,
      result,
    })
  }

  private handleSessionUpdate(
    notification: acp.SessionNotification,
    generation: number,
  ): void {
    // The agent's commands are the same for every session; they arrive when a
    // session opens, before any conversation claims it.
    if (notification.update.sessionUpdate === "available_commands_update") {
      const commands = commandsOf(notification.update.availableCommands)
      if (JSON.stringify(commands) !== JSON.stringify(this.status.commands)) {
        this.setStatus({ commands })
      }
      return
    }
    const key = sessionKey({ generation, sessionId: notification.sessionId })
    if (this.reopening.has(key)) return
    const conversationId = this.conversationBySession.get(key)
    if (!conversationId) return
    if (notification.update.sessionUpdate === "config_option_update") {
      const session = this.sessions.get(conversationId)
      if (session) {
        session.config = withSessionModel(
          toAgentConfig({ configOptions: notification.update.configOptions }),
          session.config,
        )
      }
      return
    }
    // Notices are logged; those during a turn are also shown in its reply,
    // unless they are about reopening the session.
    const session = this.sessions.get(conversationId)
    if (notification.update.sessionUpdate === "notice") {
      const { severity, title, description } = notification.update
      this.config.log(
        severity === "info" ? "INFO" : "WARN",
        `agent notice: ${title}${description ? ` (${description})` : ""}`,
      )
      if (session?.reopened) return
    } else if (session?.reopened) {
      session.reopened = false
    }
    const turn = this.activeTurns.get(conversationId)
    if (!turn) return
    const parsed = toAgentUpdate(notification.update)
    if (!parsed) return
    let update = parsed
    if (update.kind === "message_chunk") {
      const startsMessage =
        !turn.reply || turn.reply.messageId !== update.messageId
      turn.messages ??= { current: "", previous: "" }
      if (startsMessage && turn.messages.current) {
        turn.messages = { current: "", previous: turn.messages.current }
      }
      if (
        startsMessage &&
        turn.reply &&
        repeatsPrevious(turn.messages.previous, update.text)
      ) {
        turn.reply.messageId = update.messageId
        return
      }
      turn.messages.current += update.text
      if (turn.reply && turn.reply.messageId !== update.messageId) {
        this.flushReply(conversationId, turn)
      }
      turn.reply ??= {
        stream: new LocalImageStream(this.info.cwd),
        messageId: update.messageId,
      }
      turn.reply.messageId = update.messageId
      const text = turn.reply.stream.push(update.text)
      if (!text) return
      update = { ...update, text }
    } else if (turn.reply) {
      // A step between two parts of the reply ends the part before it.
      this.flushReply(conversationId, turn)
    }
    this.deliver({
      v: MCP_BRIDGE_VERSION,
      type: "agent_update",
      conversationId,
      turnId: turn.turnId,
      update,
    })
  }

  // ---- Permissions and questions ---------------------------------------------

  // The agent's tools run without asking: an agent's own policy decides what it
  // asks about, and the console approves whatever it asks. QuestDB tools are
  // further limited by the console's read, write and schema permissions.
  private decidePermission(
    request: acp.RequestPermissionRequest,
    generation: number,
  ): Promise<acp.RequestPermissionResponse> {
    const conversationId = this.conversationBySession.get(
      sessionKey({ generation, sessionId: request.sessionId }),
    )
    const approval = conversationId ? autoApprovalOf(request) : null
    if (!approval) return Promise.resolve(CANCELLED_PERMISSION)
    this.config.log(
      "INFO",
      `auto-approved: ${request.toolCall.title ?? "tool call"}`,
    )
    return Promise.resolve(approval)
  }

  // A question the agent asks the user, like which of a few options to take.
  // The console shows it in place of the message box until it is answered.
  private async answerElicitation(
    request: acp.CreateElicitationRequest,
    generation: number,
  ): Promise<acp.CreateElicitationResponse> {
    const sessionId = (request as { sessionId?: unknown }).sessionId
    const conversationId =
      typeof sessionId === "string"
        ? this.conversationBySession.get(sessionKey({ generation, sessionId }))
        : undefined
    if (!conversationId) return CANCELLED_ELICITATION
    if (request.mode === "url" && "url" in request) {
      return this.askToOpenLink(
        conversationId,
        request.message,
        String(request.url),
        typeof request.elicitationId === "string" ? request.elicitationId : "",
      )
    }
    if (request.mode !== "form" || !("requestedSchema" in request)) {
      return CANCELLED_ELICITATION
    }
    const schema = request.requestedSchema as acp.ElicitationSchema
    const fields = questionFieldsOf(schema)
    if (!fields) {
      this.config.log("WARN", "agent asked a question the console cannot show")
      return CANCELLED_ELICITATION
    }
    const outcome = await this.askQuestion(
      conversationId,
      request.message,
      fields,
    )
    switch (outcome.kind) {
      case "answered":
        return {
          action: "accept",
          content: elicitationContentOf(schema, outcome.answers),
        }
      case "skipped":
        // An agent that keeps working while it waits takes nothing from a
        // decline and waits on; it is told of the skip as an answer.
        return keepsWorkingWhileAsking(request)
          ? { action: "accept", content: skippedContentOf(schema) }
          : { action: "decline" }
      case "closed":
        return CANCELLED_ELICITATION
    }
  }

  // A page the agent wants the user to open, like a sign-in for a service it
  // connects to. Only web pages are shown; the user opens it or declines.
  private async askToOpenLink(
    conversationId: string,
    text: string,
    url: string,
    elicitationId: string,
  ): Promise<acp.CreateElicitationResponse> {
    if (!/^https?:\/\//i.test(url)) {
      this.config.log(
        "WARN",
        `agent asked to open a link that is not a web page: ${url}`,
      )
      return { action: "decline" }
    }
    const outcome = await this.askQuestion(conversationId, text, [], {
      url,
      elicitationId,
    })
    switch (outcome.kind) {
      case "answered":
        return { action: "accept" }
      case "skipped":
        return { action: "decline" }
      case "closed":
        return CANCELLED_ELICITATION
    }
  }

  private closeLinkRequest(elicitationId: string): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (!elicitationId || pending.elicitationId !== elicitationId) continue
      this.pendingQuestions.delete(requestId)
      pending.resolve({ kind: "answered", answers: {} })
      this.deliver({
        v: MCP_BRIDGE_VERSION,
        type: "agent_question_closed",
        requestId,
      })
    }
  }

  private askQuestion(
    conversationId: string,
    text: string,
    fields: AgentQuestionField[],
    link?: { url: string; elicitationId: string },
  ): Promise<QuestionOutcome> {
    const message: AgentQuestionMessage = {
      v: MCP_BRIDGE_VERSION,
      type: "agent_question",
      requestId: randomBytes(8).toString("hex"),
      conversationId,
      message: text,
      fields,
      ...(link && { url: link.url }),
    }
    return new Promise((resolve) => {
      this.pendingQuestions.set(message.requestId, {
        conversationId,
        message,
        resolve,
        ...(link?.elicitationId && { elicitationId: link.elicitationId }),
      })
      this.deliver(message)
    })
  }

  // The question stays open: the console is told why the answer did not go
  // through and shows the question again.
  private askAgain(requestId: string, reason: string): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return
    const turn = this.activeTurns.get(pending.conversationId)
    if (turn) {
      this.deliver({
        v: MCP_BRIDGE_VERSION,
        type: "agent_update",
        conversationId: pending.conversationId,
        turnId: turn.turnId,
        update: {
          kind: "notice",
          severity: "error",
          title: "The answer did not reach the agent",
          description: `${reason} Answer the question again.`,
        },
      })
    }
    this.config.send(pending.message)
  }

  private resolveQuestion(
    requestId: string,
    answers: Record<string, string | string[]> | null,
  ): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return
    this.pendingQuestions.delete(requestId)
    pending.resolve(
      answers ? { kind: "answered", answers } : { kind: "skipped" },
    )
  }

  private cancelQuestionsOf(conversationId: string): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.conversationId !== conversationId) continue
      this.pendingQuestions.delete(requestId)
      pending.resolve({ kind: "closed" })
      this.deliver({
        v: MCP_BRIDGE_VERSION,
        type: "agent_question_closed",
        requestId,
      })
    }
  }

  // ---- Delivery -------------------------------------------------------------

  // Turn traffic waits in the outbox while the console is away; status is
  // resent in full on reconnect, and permission requests are replayed from
  // the pending list, so neither is buffered.
  private deliver(msg: AgentOutboundMessage): void {
    if (this.browserAttached && this.config.send(msg)) return
    const isTurnTraffic =
      msg.type === "agent_update" || msg.type === "agent_turn_end"
    if (!isTurnTraffic || this.outbox.length >= MAX_BUFFERED_MESSAGES) return
    this.outbox.push(msg)
  }
}
