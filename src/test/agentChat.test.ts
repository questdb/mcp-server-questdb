import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  AgentOutboundMessage,
  AgentQuestionMessage,
  AgentStatusMessage,
  AgentTurnEndMessage,
} from "../agentProtocol.js"
import { AgentChat, DETACHED_GRACE_MS } from "../agent/agentChat.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { AgentLaunch } from "../agent/agentPresets.js"
import type { Log } from "../types.js"
import { MAX_CONVERSATION_PROCESSES } from "../agent/agentProcesses.js"
import { AgentSessionStore } from "../agent/agentSessionStore.js"
import { parseInboundAgentMessage } from "../agent/inboundMessages.js"

const FAKE_AGENT = fileURLToPath(
  new URL("./fixtures/fakeAgent.mjs", import.meta.url),
)

type Harness = {
  chat: AgentChat
  outbox: AgentOutboundMessage[]
  store: AgentSessionStore
  storePath: string
}

const chats: AgentChat[] = []
const folders: string[] = []

afterEach(async () => {
  await Promise.all(chats.splice(0).map((chat) => chat.stop()))
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true })
})

type ChatOptions = {
  log?: Log
  storePath?: string
  launch?: Partial<AgentLaunch>
  mcpUrl?: string
  // Whether the console's socket takes a frame right now.
  writable?: () => boolean
}

const startChat = async ({
  log = () => undefined,
  storePath,
  launch,
  mcpUrl = "http://127.0.0.1:1/mcp",
  writable = () => true,
}: ChatOptions = {}): Promise<Harness> => {
  const folder = mkdtempSync(join(tmpdir(), "agent-chat-test-"))
  folders.push(folder)
  const path = storePath ?? join(folder, "sessions.json")
  const store = new AgentSessionStore(path, "fake:/tmp", () => undefined)
  await store.load()
  const outbox: AgentOutboundMessage[] = []
  const chat = new AgentChat({
    info: { id: "fake", label: "Fake Agent", cwd: folder },
    launch: {
      id: "fake",
      label: "Fake Agent",
      command: process.execPath,
      args: [FAKE_AGENT],
      env: {},
      ...launch,
    },
    questdbMcpServerFor: (route) => ({
      type: "http",
      name: "questdb_console",
      url: `${mcpUrl}/${route}`,
      headers: [{ name: "Authorization", value: "Bearer test" }],
    }),
    store,
    send: (msg) => {
      if (!writable()) return false
      outbox.push(msg)
      return true
    },
    log,
  })
  chats.push(chat)
  chat.onBrowserAttached(false)
  chat.start()
  return { chat, outbox, store, storePath: path }
}

const setEffort = (chat: AgentChat, effort: string | null = null) =>
  chat.handleBrowserMessage({
    v: MCP_BRIDGE_VERSION,
    type: "agent_settings",
    model: null,
    effort,
  })

const prompt = (chat: AgentChat, conversationId: string, text: string) =>
  chat.handleBrowserMessage({
    v: MCP_BRIDGE_VERSION,
    type: "agent_prompt",
    conversationId,
    turnId: `${conversationId}-${text}`,
    prompt: [{ type: "text", text }],
  })

const waitFor = <T extends AgentOutboundMessage>(
  outbox: AgentOutboundMessage[],
  predicate: (msg: AgentOutboundMessage) => msg is T,
): Promise<T> =>
  vi.waitFor(
    () => {
      const found = outbox.find(predicate)
      if (!found) throw new Error("not yet")
      return found
    },
    { timeout: 10_000, interval: 20 },
  )

const turnEnd =
  (conversationId: string) =>
  (msg: AgentOutboundMessage): msg is AgentTurnEndMessage =>
    msg.type === "agent_turn_end" && msg.conversationId === conversationId

const noticesOf = (outbox: AgentOutboundMessage[], conversationId: string) =>
  outbox.flatMap((msg) =>
    msg.type === "agent_update" &&
    msg.conversationId === conversationId &&
    msg.update.kind === "notice"
      ? [msg.update]
      : [],
  )

const replyText = (outbox: AgentOutboundMessage[], conversationId: string) =>
  outbox
    .flatMap((msg) =>
      msg.type === "agent_update" &&
      msg.conversationId === conversationId &&
      msg.update.kind === "message_chunk"
        ? [msg.update.text]
        : [],
    )
    .join("")

describe("AgentChat", () => {
  it("reports the agent ready with its models and effort levels before the first message", async () => {
    // When
    const { outbox } = await startChat()

    // Then
    const ready = await vi.waitFor(
      () => {
        const status = outbox.find(
          (msg) => msg.type === "agent_status" && msg.state === "ready",
        )
        if (!status || status.type !== "agent_status")
          throw new Error("not ready")
        return status
      },
      { timeout: 10_000 },
    )
    expect(ready.config?.model?.choices.map((choice) => choice.value)).toEqual([
      "fast",
      "deep",
    ])
    expect(ready.config?.effort?.current).toBe("high")
  })

  it("answers a prompt in its conversation and applies the chosen effort first", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat, "low")

    // When
    prompt(chat, "c1", "hello")

    // Then
    const end = await waitFor(outbox, turnEnd("c1"))
    expect(end.result).toEqual({
      outcome: "completed",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 5 },
    })
    expect(replyText(outbox, "c1")).toBe("echo:hello")
    const lastStatus = outbox
      .filter((msg) => msg.type === "agent_status")
      .at(-1)
    expect(
      lastStatus?.type === "agent_status" && lastStatus.config?.effort?.current,
    ).toBe("low")
  })

  it("approves the agent's own tools one call at a time, without asking the console", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "please approve")

    // Then
    await waitFor(outbox, turnEnd("c1"))
    expect(outbox.some((msg) => msg.type === "agent_question")).toBe(false)
    expect(replyText(outbox, "c1")).toBe("permission:once")
  })

  it("asks the user to open the page the agent links to, and tells the agent they did", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "link")
    const request = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_question_answer",
      requestId: request.requestId,
      answers: {},
    })

    // Then
    await waitFor(outbox, turnEnd("c1"))
    expect(request).toMatchObject({
      conversationId: "c1",
      message: "Sign in to Example Analytics so I can read your dashboards.",
      url: "https://auth.example.com/authorize?client=questdb",
      fields: [],
    })
    expect(replyText(outbox, "c1")).toBe("link:accept")
  })

  it("tells the console the agent's commands, and that it reads images", async () => {
    // Given
    const { outbox } = await startChat()

    // When
    const status = await waitFor(
      outbox,
      (msg): msg is AgentStatusMessage =>
        msg.type === "agent_status" && (msg.commands?.length ?? 0) > 0,
    )

    // Then
    expect(status.commands).toContainEqual({
      name: "review",
      description: "Review the current changes",
      hint: "[focus]",
    })
    expect(status.commands).toContainEqual({
      name: "compact",
      description: "Summarize the conversation",
      hint: null,
    })
    expect(status.acceptsImages).toBe(true)
  })

  it("sends the images the user attached to an agent that reads them", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_prompt",
      conversationId: "c1",
      turnId: "t1",
      prompt: [
        { type: "text", text: "What is this?" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    })
    await waitFor(outbox, turnEnd("c1"))

    // Then
    expect(replyText(outbox, "c1")).toBe("I see 1 image (image/png).")
  })

  it("shows the agent's question in the console and gives the agent the answers in the types it asked for", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "question")
    const question = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_question_answer",
      requestId: question.requestId,
      answers: {
        database: "questdb",
        features: ["sql", "ilp"],
        sure: "true",
        replicas: "3",
      },
    })

    // Then
    await waitFor(outbox, turnEnd("c1"))
    expect(question).toMatchObject({
      conversationId: "c1",
      message: "Which database should we use?",
    })
    expect(question.fields).toEqual([
      {
        id: "database",
        kind: "choice",
        title: "Database",
        prompt: null,
        options: [
          { value: "questdb", label: "QuestDB", description: "Time series" },
          { value: "postgres", label: "Postgres", description: null },
        ],
        multiple: false,
        required: true,
        otherFieldId: "database_custom",
      },
      {
        id: "features",
        kind: "choice",
        title: "Features",
        prompt: null,
        options: [
          { value: "sql", label: "SQL", description: null },
          { value: "ilp", label: "ILP", description: null },
        ],
        multiple: true,
        required: false,
        otherFieldId: null,
      },
      {
        id: "sure",
        kind: "choice",
        title: "Are you sure?",
        prompt: null,
        options: [
          { value: "true", label: "Yes", description: null },
          { value: "false", label: "No", description: null },
        ],
        multiple: false,
        required: false,
        otherFieldId: null,
      },
      {
        id: "replicas",
        kind: "text",
        title: "Replicas",
        prompt: null,
        required: false,
      },
    ])
    expect(JSON.parse(replyText(outbox, "c1").replace("answer:", ""))).toEqual({
      action: "accept",
      content: {
        database: "questdb",
        features: ["sql", "ilp"],
        sure: true,
        replicas: 3,
      },
    })
  })

  it("tells the agent the user skipped its question, and closes a question when the turn is stopped", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)
    prompt(chat, "c1", "question")
    const skipped = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )

    // When
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_question_answer",
      requestId: skipped.requestId,
      answers: null,
    })
    await waitFor(outbox, turnEnd("c1"))
    prompt(chat, "c2", "question")
    const stopped = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage =>
        msg.type === "agent_question" && msg.conversationId === "c2",
    )
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_cancel",
      conversationId: "c2",
    })

    // Then
    expect(replyText(outbox, "c1")).toBe('answer:{"action":"decline"}')
    await waitFor(outbox, turnEnd("c2"))
    expect(
      outbox.some(
        (msg) =>
          msg.type === "agent_question_closed" &&
          msg.requestId === stopped.requestId,
      ),
    ).toBe(true)
  })

  it("tells an agent that keeps working while it asks that the user skipped, as an answer", async () => {
    // Given a question asked the way Codex asks while it keeps working
    const { chat, outbox } = await startChat()
    setEffort(chat)
    prompt(chat, "c1", "asyncask")
    const question = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )

    // When the user skips it
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_question_answer",
      requestId: question.requestId,
      answers: null,
    })
    await waitFor(outbox, turnEnd("c1"))

    // Then the agent gets the skip as an answer, which it passes on, rather
    // than a decline, which it drops
    expect(JSON.parse(replyText(outbox, "c1").replace("answer:", ""))).toEqual({
      action: "accept",
      content: {
        question_0: "None of the above",
        question_0_note: "The user skipped this question without answering.",
      },
    })
  })

  it("cancels a running turn on request", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)
    prompt(chat, "c1", "slow")
    await vi.waitFor(() => {
      if (replyText(outbox, "c1").length < 3)
        throw new Error("not streaming yet")
    })

    // When
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_cancel",
      conversationId: "c1",
    })

    // Then
    const end = await waitFor(outbox, turnEnd("c1"))
    expect(end.result).toMatchObject({
      outcome: "completed",
      stopReason: "cancelled",
    })
  })

  it("turns a sign-in failure into instructions instead of a protocol error", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "auth")

    // Then
    const end = await waitFor(outbox, turnEnd("c1"))
    expect(end.result).toEqual({
      outcome: "failed",
      error:
        "Fake Agent needs you to sign in. Sign in with its own command line tool, then send your message again.",
    })
  })

  it("holds turn updates while the console is away and delivers them on reconnect", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)
    await vi.waitFor(() => {
      if (
        !outbox.some(
          (msg) => msg.type === "agent_status" && msg.state === "ready",
        )
      ) {
        throw new Error("not ready")
      }
    })
    chat.onBrowserDetached()

    // When
    prompt(chat, "c1", "hello")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const deliveredWhileAway = outbox.filter(turnEnd("c1")).length
    chat.onBrowserAttached(true)

    // Then
    expect(deliveredWhileAway).toBe(0)
    await waitFor(outbox, turnEnd("c1"))
    expect(replyText(outbox, "c1")).toBe("echo:hello")
  })

  it("remembers each conversation's agent session across bridge restarts", async () => {
    // Given
    const first = await startChat()
    setEffort(first.chat)
    prompt(first.chat, "c1", "hello")
    await waitFor(first.outbox, turnEnd("c1"))
    const sessionId = first.store.get("c1")
    await first.chat.stop()

    // When
    const second = await startChat({ storePath: first.storePath })

    setEffort(second.chat)
    prompt(second.chat, "c1", "again")
    await waitFor(second.outbox, turnEnd("c1"))

    // Then the reopened session answers, without what the agent said while
    // it was being reopened
    expect(sessionId).toMatch(/^fake-/)
    expect(second.store.get("c1")).toBe(sessionId)
    expect(replyText(second.outbox, "c1")).toBe("echo:again")
    expect(noticesOf(second.outbox, "c1")).toEqual([])
  })

  it("passes on what the agent notices during a turn, in place", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "notice")
    await waitFor(outbox, turnEnd("c1"))

    // Then
    const kinds = outbox.flatMap((msg) =>
      msg.type === "agent_update" ? [msg.update.kind] : [],
    )
    expect(kinds).toEqual(["message_chunk", "notice", "message_chunk"])
    expect(noticesOf(outbox, "c1")).toEqual([
      {
        kind: "notice",
        severity: "warning",
        title: "Rate limit close",
        description: "Slow down.",
      },
    ])
  })

  it("shows an image, a file link and an embedded file the agent replies with", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "files")
    await waitFor(outbox, turnEnd("c1"))

    // Then
    const reply = replyText(outbox, "c1")
    expect(reply).toContain(
      "![Image from the agent](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAK0lEQVR4nGPofvkXji66FcIRqeIMw9ggSjQjiw9ngwZfrA0+gwZfrA06gwBjBPrfuMvWDQAAAABJRU5ErkJggg==)",
    )
    expect(reply).toContain("`/tmp/notes.txt`")
    expect(reply).toContain("```sql\nselect 1\n```")
  })

  it("writes in an image the agent saved and shows by its path", async () => {
    // Given an image the agent saved on this machine
    const folder = mkdtempSync(join(tmpdir(), "agent-image-"))
    folders.push(folder)
    const path = join(folder, "chart.png")
    writeFileSync(path, Buffer.from("png bytes"))
    const { chat, outbox } = await startChat({
      launch: { env: { FAKE_AGENT_IMAGE_PATH: path } },
    })
    setEffort(chat)

    // When its reply shows the image, split between pieces
    prompt(chat, "c1", "mdimages")
    await waitFor(outbox, turnEnd("c1"))

    // Then the console gets the image itself, and web images stay links
    const reply = replyText(outbox, "c1")
    expect(reply).toContain(
      `Local: ![heat](data:image/png;base64,${Buffer.from("png bytes").toString("base64")})`,
    )
    expect(reply).toContain(
      `![Open the chart](data:image/png;base64,${Buffer.from("png bytes").toString("base64")})`,
    )
    expect(reply).toContain("![logo](https://questdb.com/img/logo.png)")
    expect(reply).toContain("[Open data-url.txt](/private/tmp/data-url.txt)")
    expect(reply).not.toContain(path)
  })

  it("shows a message the agent sends twice in a row once", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "/review")
    await waitFor(outbox, turnEnd("c1"))

    // Then the repeat is dropped, but what follows it and short messages
    // that happen to match are kept
    expect(replyText(outbox, "c1")).toBe(
      "Review comment:\n\n- [P1] Close the string literal in trades.sql:3" +
        "\n\nNo other issues.DoneDone",
    )
  })

  it("says why a turn stopped short", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "limit")
    const end = await waitFor(outbox, turnEnd("c1"))

    // Then
    expect(end.result).toMatchObject({
      outcome: "completed",
      stopReason: "max_tokens",
    })
  })

  it("signs in with the agent's auth method before it opens a session", async () => {
    // Given an agent that refuses sessions until the client authenticates
    const env = { FAKE_AGENT_AUTH_METHOD: "fake_login" }
    const signedIn = await startChat({
      launch: { env, authMethodId: "fake_login" },
    })
    const notSignedIn = await startChat({ launch: { env } })
    setEffort(signedIn.chat)

    // When
    prompt(signedIn.chat, "c1", "hello")

    // Then
    await waitFor(signedIn.outbox, turnEnd("c1"))
    expect(replyText(signedIn.outbox, "c1")).toBe("echo:hello")
    const failed = await waitFor(
      notSignedIn.outbox,
      (msg): msg is Extract<AgentOutboundMessage, { type: "agent_status" }> =>
        msg.type === "agent_status" && msg.state === "error",
    )
    expect(failed.error).toMatch(/needs you to sign in/)
  })

  it("goes on once the user signs in, when the agent refused to open a session", async () => {
    // Given an agent that reads its credentials once, at start, like Gemini
    // CLI, and found none
    const signInFile = join(mkdtempSync(join(tmpdir(), "sign-in-")), "creds")
    const { chat, outbox } = await startChat({
      launch: {
        env: {
          FAKE_AGENT_SIGN_IN_FILE: signInFile,
          FAKE_AGENT_SIGN_IN_CHECK: "session",
        },
      },
    })
    const failed = await waitFor(
      outbox,
      (msg): msg is Extract<AgentOutboundMessage, { type: "agent_status" }> =>
        msg.type === "agent_status" && msg.state === "error",
    )
    setEffort(chat)

    // When the user signs in, then sends a message
    writeFileSync(signInFile, "signed in")
    prompt(chat, "c1", "hello")

    // Then
    expect(failed.error).toMatch(/needs you to sign in/)
    await waitFor(outbox, turnEnd("c1"))
    expect(replyText(outbox, "c1")).toBe("echo:hello")
  })

  it("goes on in the same conversation once the user signs in, when the agent refused a message", async () => {
    // Given an agent that opens sessions but refuses messages until signed
    // in, like Claude Code with an expired sign-in
    const signInFile = join(mkdtempSync(join(tmpdir(), "sign-in-")), "creds")
    const { chat, outbox } = await startChat({
      launch: {
        env: {
          FAKE_AGENT_SIGN_IN_FILE: signInFile,
          FAKE_AGENT_SIGN_IN_CHECK: "prompt",
        },
      },
    })
    setEffort(chat)
    prompt(chat, "c1", "first")
    const refused = await waitFor(outbox, turnEnd("c1"))

    // When the user signs in, then sends the message again
    writeFileSync(signInFile, "signed in")
    const before = outbox.length
    prompt(chat, "c1", "again")

    // Then
    expect(refused.result).toMatchObject({ outcome: "failed" })
    await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        outbox.indexOf(msg) >= before && turnEnd("c1")(msg),
    )
    expect(replyText(outbox.slice(before), "c1")).toBe("echo:again")
  })

  it("offers the models an agent lists outside its config options, and switches between them", async () => {
    // Given an agent that reports its models the way Gemini CLI does
    const { chat, outbox } = await startChat({
      launch: { env: { FAKE_AGENT_SESSION_MODELS: "1" } },
    })
    const ready = await waitFor(
      outbox,
      (msg): msg is Extract<AgentOutboundMessage, { type: "agent_status" }> =>
        msg.type === "agent_status" && msg.state === "ready",
    )

    // When
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_settings",
      model: "pro",
      effort: null,
    })
    prompt(chat, "c1", "model")

    // Then
    expect(ready.config?.model?.current).toBe("auto")
    expect(ready.config?.model?.choices.map((choice) => choice.name)).toEqual([
      "Auto",
      "Pro",
    ])
    await waitFor(outbox, turnEnd("c1"))
    expect(replyText(outbox, "c1")).toBe("model:pro")
  })

  it("keeps each conversation's QuestDB tools on its own route when the agent shares MCP servers between sessions", async () => {
    // Given an agent like OpenCode, and conversations c1 and c2 that each
    // registered their route, c2 last
    const mcp = await startRouteEcho()
    const shared = await startChat({
      launch: { env: { FAKE_AGENT_SHARED_MCP: "1" } },
      mcpUrl: mcp.url,
    })
    const isolated = await startChat({
      launch: {
        env: { FAKE_AGENT_SHARED_MCP: "1" },
        processPerConversation: true,
      },
      mcpUrl: mcp.url,
    })
    for (const { chat, outbox } of [shared, isolated]) {
      setEffort(chat)
      prompt(chat, "c1", "hello")
      await waitFor(outbox, turnEnd("c1"))
      prompt(chat, "c2", "hello")
      await waitFor(outbox, turnEnd("c2"))
    }

    // When c1 calls a QuestDB tool
    for (const { chat } of [shared, isolated]) prompt(chat, "c1", "tool")

    // Then only the agent with a process per conversation reaches c1's route
    const routeCalled = async ({ chat, outbox }: Harness) => {
      await waitFor(
        outbox,
        (msg): msg is AgentTurnEndMessage =>
          msg.type === "agent_turn_end" && msg.turnId === "c1-tool",
      )
      const route = replyText(outbox, "c1").split("tables:")[1] ?? ""
      return chat.routeOf(route)?.conversationId
    }
    expect(await routeCalled(isolated)).toBe("c1")
    expect(await routeCalled(shared)).toBe("c2")
  })
})

describe("AgentChat instructions", () => {
  it("gives a new session the console's instructions once, with its first message", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "blocks")
    await waitFor(outbox, turnEnd("c1"))
    prompt(chat, "c1", "blocks again")
    await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        msg.type === "agent_turn_end" && msg.turnId === "c1-blocks again",
    )

    // Then
    expect(replyText(outbox, "c1")).toBe(
      "blocks:2:<questdb_console_instructions>blocks:1:blocks again",
    )
  })
})

describe("AgentChat commands", () => {
  it("sends a command first, and the instructions with the next message", async () => {
    // Given
    const { chat, outbox } = await startChat()
    setEffort(chat)

    // When
    prompt(chat, "c1", "/blocks")
    await waitFor(outbox, turnEnd("c1"))
    prompt(chat, "c1", "blocks again")
    await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        msg.type === "agent_turn_end" && msg.turnId === "c1-blocks again",
    )

    // Then
    expect(replyText(outbox, "c1")).toBe(
      "blocks:1:/blocksblocks:2:<questdb_console_instructions>",
    )
  })
})

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidsIn = (path: string): number[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : []

const isReady = (msg: AgentOutboundMessage): msg is AgentStatusMessage =>
  msg.type === "agent_status" && msg.state === "ready"

describe("AgentChat restart", () => {
  it("replaces an agent that is still starting with exactly one new process, and stops it", async () => {
    // Given an agent that takes a moment to start
    const folder = mkdtempSync(join(tmpdir(), "agent-chat-pids-"))
    folders.push(folder)
    const pidFile = join(folder, "pids")
    const { chat, outbox } = await startChat({
      launch: {
        env: {
          FAKE_AGENT_START_DELAY_MS: "1000",
          FAKE_AGENT_PID_FILE: pidFile,
        },
      },
    })
    setEffort(chat)
    await vi.waitFor(() => {
      if (pidsIn(pidFile).length === 0) throw new Error("not spawned yet")
    })

    // When the console restarts it before it is ready, then sends a message
    chat.handleBrowserMessage({ v: MCP_BRIDGE_VERSION, type: "agent_restart" })
    await waitFor(outbox, isReady)
    prompt(chat, "c1", "hello")
    await waitFor(outbox, turnEnd("c1"))

    // Then one process replaced the first, and stopping the chat ends it
    const pids = pidsIn(pidFile)
    expect(pids).toHaveLength(2)
    await chat.stop()
    await vi.waitFor(() => {
      if (pids.some(isRunning)) throw new Error("still running")
    })
  })
})

describe("AgentChat while the console is away", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const startStreaming = async () => {
    const harness = await startChat()
    setEffort(harness.chat)
    prompt(harness.chat, "c1", "slow")
    await vi.waitFor(() => {
      if (replyText(harness.outbox, "c1").length < 3)
        throw new Error("not streaming yet")
    })
    return harness
  }

  it("stops a running turn when the console stays away past the grace period", async () => {
    // Given a turn that streams until it is stopped
    const { chat, outbox } = await startStreaming()

    // When the console leaves for the whole grace period, then comes back
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    chat.onBrowserDetached()
    vi.advanceTimersByTime(DETACHED_GRACE_MS)
    vi.useRealTimers()
    chat.onBrowserAttached(true)

    // Then the agent was told to stop and the turn ends as cancelled
    const end = await waitFor(outbox, turnEnd("c1"))
    expect(end.result).toMatchObject({
      outcome: "completed",
      stopReason: "cancelled",
    })
  })

  it("keeps a running turn when the console comes back within the grace period", async () => {
    // Given a turn that streams until it is stopped
    const { chat, outbox } = await startStreaming()

    // When the console comes back just before the grace period ends
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    chat.onBrowserDetached()
    vi.advanceTimersByTime(DETACHED_GRACE_MS - 1)
    chat.onBrowserAttached(true)
    vi.advanceTimersByTime(DETACHED_GRACE_MS)
    vi.useRealTimers()

    // Then the turn goes on streaming, with no end
    const streamed = replyText(outbox, "c1").length
    await vi.waitFor(() => {
      if (replyText(outbox, "c1").length <= streamed)
        throw new Error("not streaming")
    })
    expect(outbox.some(turnEnd("c1"))).toBe(false)
  })

  it("stops the running turns when a fresh console pairs, so a reloaded page can use its conversation again", async () => {
    // Given a turn that streams until it is stopped
    const { chat, outbox } = await startStreaming()

    // When the page reloads: its socket closes and the new page pairs
    chat.onBrowserDetached()
    chat.onBrowserAttached(false)

    // Then the old turn is stopped, and the conversation takes a new message
    const stopped = await waitFor(outbox, turnEnd("c1"))
    expect(stopped).toMatchObject({
      turnId: "c1-slow",
      result: { outcome: "completed", stopReason: "cancelled" },
    })
    prompt(chat, "c1", "hello")
    const next = await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        msg.type === "agent_turn_end" && msg.turnId === "c1-hello",
    )
    expect(next.result).toMatchObject({ outcome: "completed" })
  })

  it("refuses a second message in a conversation while its turn runs", async () => {
    // Given a turn that streams until it is stopped
    const { chat, outbox } = await startStreaming()

    // When the console sends another message in the same conversation
    prompt(chat, "c1", "hello")

    // Then that message fails, and the running turn goes on
    const refused = await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        msg.type === "agent_turn_end" && msg.turnId === "c1-hello",
    )
    expect(refused.result).toEqual({
      outcome: "failed",
      error: "The agent is still answering the previous message.",
    })
    expect(
      outbox.some(
        (msg) => msg.type === "agent_turn_end" && msg.turnId === "c1-slow",
      ),
    ).toBe(false)
  })
})

describe("AgentChat failures the console waits on", () => {
  it("keeps the sign-in instructions when the agent refuses to authenticate, and ends its process", async () => {
    // Given an agent whose own CLI is not signed in
    const folder = mkdtempSync(join(tmpdir(), "agent-chat-pids-"))
    folders.push(folder)
    const pidFile = join(folder, "pids")
    const { outbox } = await startChat({
      launch: {
        env: {
          FAKE_AGENT_AUTH_METHOD: "fake_login",
          FAKE_AGENT_AUTH_REJECTS: "1",
          FAKE_AGENT_PID_FILE: pidFile,
        },
        authMethodId: "fake_login",
      },
    })

    // When it fails to start, and its process has exited
    await waitFor(
      outbox,
      (msg): msg is AgentStatusMessage =>
        msg.type === "agent_status" && msg.state === "error",
    )
    const [pid] = pidsIn(pidFile)
    await vi.waitFor(() => {
      if (pid === undefined || isRunning(pid)) throw new Error("running")
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Then the last status still says how to sign in
    const statuses = outbox.filter(
      (msg): msg is AgentStatusMessage => msg.type === "agent_status",
    )
    expect(statuses.at(-1)?.error).toMatch(/needs you to sign in/)
  })

  it("ends a turn stopped before its message reached the agent", async () => {
    // Given an agent that is slow to start
    const { chat, outbox } = await startChat({
      launch: { env: { FAKE_AGENT_START_DELAY_MS: "1000" } },
    })

    // When a message is sent and stopped while the agent starts
    prompt(chat, "c1", "hello")
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_cancel",
      conversationId: "c1",
    })

    // Then the turn ends as stopped, and the agent never answered it
    const end = await waitFor(outbox, turnEnd("c1"))
    expect(end.result).toMatchObject({
      outcome: "completed",
      stopReason: "cancelled",
    })
    expect(replyText(outbox, "c1")).toBe("")
  })

  it("fails the turn of a message the bridge rejected", async () => {
    // Given
    const { chat, outbox } = await startChat()

    // When
    chat.handleRejectedMessage({
      type: "agent_prompt",
      conversationId: "c9",
      turnId: "t9",
      reason: "The message is too large.",
    })

    // Then
    const end = await waitFor(outbox, turnEnd("c9"))
    expect(end).toMatchObject({
      turnId: "t9",
      result: { outcome: "failed", error: "The message is too large." },
    })
  })

  it("asks a question again when its answer was rejected, then takes a long answer", async () => {
    // Given a question the agent waits on
    const { chat, outbox } = await startChat()
    setEffort(chat)
    prompt(chat, "c1", "question")
    const question = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )

    // When an answer is rejected, then a long one is sent
    chat.handleRejectedMessage({
      type: "agent_question_answer",
      requestId: question.requestId,
      reason: "The answer is too large.",
    })
    const askedAgain = outbox.filter(
      (msg) =>
        msg.type === "agent_question" && msg.requestId === question.requestId,
    ).length
    const notice = outbox.find(
      (msg) => msg.type === "agent_update" && msg.update.kind === "notice",
    )
    const longAnswer = "x".repeat(10_001)
    const answer = parseInboundAgentMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_question_answer",
      requestId: question.requestId,
      answers: { database: "questdb", database_custom: longAnswer },
    })
    if (!answer) throw new Error("a 10,001 character answer was rejected")
    chat.handleBrowserMessage(answer)

    // Then the console was told and shown the question again, and the agent
    // got the long answer
    expect(askedAgain).toBe(2)
    expect(notice).toMatchObject({
      turnId: "c1-question",
      update: {
        kind: "notice",
        severity: "error",
        description: "The answer is too large. Answer the question again.",
      },
    })
    await waitFor(outbox, turnEnd("c1"))
    expect(replyText(outbox, "c1")).toContain(longAnswer)
  })

  it("shows a pending question again when the console comes back", async () => {
    // Given a question the agent waits on
    const { chat, outbox } = await startChat()
    setEffort(chat)
    prompt(chat, "c1", "question")
    const question = await waitFor(
      outbox,
      (msg): msg is AgentQuestionMessage => msg.type === "agent_question",
    )

    // When the console leaves and comes back
    chat.onBrowserDetached()
    chat.onBrowserAttached(true)

    // Then it is shown the question again
    expect(
      outbox.filter(
        (msg) =>
          msg.type === "agent_question" && msg.requestId === question.requestId,
      ),
    ).toHaveLength(2)
  })

  it("keeps a turn's end the socket could not write, and delivers it when the console is back", async () => {
    // Given a console whose socket stops taking frames as it closes
    let writable = true
    const { chat, outbox } = await startChat({ writable: () => writable })
    setEffort(chat)
    await waitFor(outbox, isReady)

    // When a turn ends while the socket is closing, then the console is back
    writable = false
    prompt(chat, "c1", "hello")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const deliveredWhileClosing = outbox.filter(turnEnd("c1")).length
    writable = true
    chat.onBrowserDetached()
    chat.onBrowserAttached(true)

    // Then
    expect(deliveredWhileClosing).toBe(0)
    await waitFor(outbox, turnEnd("c1"))
    expect(replyText(outbox, "c1")).toBe("echo:hello")
  })
})

describe("AgentChat with a process per conversation", () => {
  it("stops the least recently used idle process past the limit and picks its session back up on the next message", async () => {
    // Given one more conversation than processes are kept
    const log = vi.fn()
    const { chat, outbox, store } = await startChat({
      launch: { processPerConversation: true },
      log,
    })
    setEffort(chat)
    const conversations = Array.from(
      { length: MAX_CONVERSATION_PROCESSES + 1 },
      (_, index) => `c${index + 1}`,
    )
    for (const conversationId of conversations) {
      prompt(chat, conversationId, "hello")
      await waitFor(outbox, turnEnd(conversationId))
    }
    const firstSession = store.get("c1")
    expect(log).toHaveBeenCalledWith(
      "INFO",
      "stopped the idle agent process of conversation c1",
    )

    // When the first conversation, whose process was stopped, continues
    chat.handleBrowserMessage({
      v: MCP_BRIDGE_VERSION,
      type: "agent_prompt",
      conversationId: "c1",
      turnId: "c1-again",
      prompt: [{ type: "text", text: "again" }],
    })

    // Then it answers in the same agent session
    await waitFor(
      outbox,
      (msg): msg is AgentTurnEndMessage =>
        msg.type === "agent_turn_end" && msg.turnId === "c1-again",
    )
    expect(replyText(outbox, "c1")).toBe("echo:helloecho:again")
    expect(store.get("c1")).toBe(firstSession)
  })
})

// An MCP stand-in that answers every tool call with the route it came in on.
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

const startRouteEcho = async (): Promise<{ url: string }> => {
  const server = createServer((req, res) => {
    const route = (req.url ?? "").split("/").pop() ?? ""
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: route }] },
      }),
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}/mcp` }
}
