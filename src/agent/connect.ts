import { writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { BridgeSession } from "../bridgeSession.js"
import { bindWithRetry } from "../bindWithRetry.js"
import { BRIDGE_PACKAGE } from "../bridgePackage.js"
import type { Logger } from "../logger.js"
import { openInBrowser } from "../openBrowser.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { findFreePort, generateToken } from "../sessionStore.js"
import { createShutdownController } from "../shutdown.js"
import { toolDeadlineMs } from "../toolDeadlines.js"
import { deriveAllowedOrigins, startWsServer } from "../wsServer.js"
import { AgentChat } from "./agentChat.js"
import { resolveAgentLaunch } from "./agentPresets.js"
import { AgentSessionStore } from "./agentSessionStore.js"
import { sessionStorePath } from "./bridgeHome.js"
import {
  AGENT_MODE_NOT_PAIRED_RECOVERY,
  startQuestdbMcpHttpServer,
} from "./questdbMcpHttpServer.js"
import type { ResolvedConnectOptions } from "./connectOptions.js"

const QUESTDB_MCP_SERVER_NAME = "questdb_console"

const printLines = (lines: string[]): void => {
  writeSync(process.stderr.fd, `${lines.join("\n")}\n`)
}

export const runConnect = async (
  options: ResolvedConnectOptions,
  logger: Logger,
  // Runs once the agent's program is found, before it starts.
  onAgentResolved: () => Promise<void> = async () => {},
): Promise<void> => {
  const { log } = logger
  const allowedOrigins = deriveAllowedOrigins(options.consoleOrigin)

  const browserToken = generateToken()
  let port = 0

  const session = new BridgeSession({
    token: browserToken,
    getPort: () => port,
    consoleOrigin: options.consoleOrigin,
    consoleUrl: options.consoleUrl,
    getDeadlineMs: toolDeadlineMs,
    log,
    notPairedRecovery: AGENT_MODE_NOT_PAIRED_RECOVERY,
  })

  // The port comes first, so a taken one fails before the agent is installed
  // or started. No console can pair yet: the token is printed only below,
  // once the agent is attached.
  const ws = await bindWithRetry({
    port: options.pinnedPort?.port ?? (await findFreePort()),
    isPinned: options.pinnedPort !== null,
    ...(options.pinnedPort && { pinnedBy: options.pinnedPort.by }),
    attemptListen: (p) =>
      startWsServer({
        port: p,
        token: browserToken,
        allowedOrigins,
        session,
        log,
      }),
    findFreePort,
    log,
  })
  port = ws.port

  const logFile = logger.getFilePath()
  const launch = await resolveAgentLaunch(options.agent, {
    log,
    notify: (line) => printLines([line]),
  }).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(logFile ? `${reason}\nDetails: ${logFile}` : reason)
  })
  await onAgentResolved()
  await mkdir(options.workspace, { recursive: true })

  const store = new AgentSessionStore(
    sessionStorePath(),
    `${launch.id}:${options.workspace}`,
    log,
  )
  await store.load()

  const mcpToken = generateToken()
  let chat: AgentChat | null = null
  const mcpHttp = await startQuestdbMcpHttpServer({
    session,
    token: mcpToken,
    routeOf: (route) => chat?.routeOf(route) ?? null,
    log,
  })

  chat = new AgentChat({
    info: { id: launch.id, label: launch.label, cwd: options.workspace },
    launch,
    questdbMcpServerFor: (route) => ({
      type: "http",
      name: QUESTDB_MCP_SERVER_NAME,
      url: mcpHttp.urlFor(route),
      headers: [{ name: "Authorization", value: `Bearer ${mcpToken}` }],
    }),
    store,
    send: (msg) => session.sendToBrowser(msg),
    log,
  })
  session.attachAgentChannel(chat)
  chat.start()

  const deepLink = session.buildDeepLink()
  printLines([
    "",
    `Let ${launch.label} work in the QuestDB Web Console's AI Assistant`,
    `  Workspace: ${options.workspace}`,
    `  Console:   ${options.consoleUrl}`,
    `  Version:   ${BRIDGE_PACKAGE} v${MCP_BRIDGE_VERSION}`,
    `  Log file:  ${logFile ?? "(stderr only)"}`,
    "",
    options.openBrowser
      ? "A Web Console tab should open. If it does not, open this link:"
      : `Open this link to connect ${launch.label} to the Web Console:`,
    `  ${deepLink}`,
    "",
    "Accept the connection there; it then works in the AI Assistant.",
    "Keep this terminal open while it works. Press Ctrl+C to stop.",
    "",
  ])
  if (options.openBrowser) await openInBrowser(deepLink, log)

  const activeChat = chat
  const { shutdown } = createShutdownController({
    stopMcp: async () => {
      await activeChat.stop()
      await mcpHttp.stop()
    },
    settleWs: () => Promise.resolve(),
    getStopWs: () => ws.stop,
    exit: (code) => process.exit(code),
    log,
    stepBudgetMs: 2_000,
    hardBudgetMs: 5_000,
  })
  process.on("SIGINT", () => void shutdown("received SIGINT"))
  process.on("SIGTERM", () => void shutdown("received SIGTERM"))
  // Without this the terminal closing would kill the bridge without stopping
  // the agent, which runs in its own process group.
  process.on(
    "SIGHUP",
    () => void shutdown("received SIGHUP: the terminal was closed"),
  )
}
