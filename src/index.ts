#!/usr/bin/env node
import { findFreePort, generateToken } from "./sessionStore.js"
import { BridgeSession } from "./bridgeSession.js"
import { BRIDGE_PACKAGE } from "./bridgePackage.js"
import { commandArg, DISTRIBUTION_CHANNEL, selfPath } from "./distribution.js"
import { MCP_BRIDGE_VERSION } from "./protocolVersion.js"
import {
  startWsServer,
  deriveAllowedOrigins,
  InvalidConsoleOriginError,
} from "./wsServer.js"
import { startMcpServer } from "./mcpServer.js"
import { type AttemptListenFn } from "./bindWithRetry.js"
import { createWsListener } from "./wsListener.js"
import { createShutdownController } from "./shutdown.js"
import { parseCli, parsePort } from "./cli.js"
import { Logger } from "./logger.js"
import { writeSync } from "node:fs"
import { toolDeadlineMs } from "./toolDeadlines.js"
import {
  connectUsage,
  DEFAULT_CONSOLE_ORIGIN,
  parseConnectOptions,
} from "./agent/connectOptions.js"

// How the user invokes us, rendered per distribution channel: the npm install
// goes through npx; the standalone bundle is a file run with node.
const LAUNCH =
  DISTRIBUTION_CHANNEL === "standalone"
    ? `node ${commandArg(selfPath())}`
    : `npx ${BRIDGE_PACKAGE}`

const USAGE = `Connect your coding agent to the QuestDB Web Console.

${connectUsage(LAUNCH)}
Or let your coding agent work from your terminal:
  ${LAUNCH} setup
      Set up your coding agents, then ask them to connect to the
      QuestDB Web Console
  ${LAUNCH} upgrade
      Update the version your coding agents use

Other:
  ${LAUNCH} --version, -v
      Print the version and exit
  ${LAUNCH} --help, -h
      Print this help and exit
`

// Synchronous, best-effort writes to a standard fd.
const writeFd = (fd: number, text: string): void => {
  try {
    writeSync(fd, text)
  } catch {
    /* nothing actionable if the output target rejects the write */
  }
}

const helpText = (): string => USAGE

// Parse argv before any logger/server side effects so --version and --help
// stay pure (no log file, no port allocation) and exit immediately.
const cli = parseCli(
  process.argv.slice(2),
  MCP_BRIDGE_VERSION,
  helpText,
  `${LAUNCH} --help`,
)
if (cli.kind === "exit") {
  if (cli.stdout !== undefined) writeFd(process.stdout.fd, cli.stdout)
  if (cli.stderr !== undefined) writeFd(process.stderr.fd, cli.stderr)
  process.exit(cli.code)
}

if (cli.kind === "setup") {
  const { runSetup } = await import("./setup/runSetup.js")
  const code = await runSetup()
  process.exit(code)
}

if (cli.kind === "upgrade") {
  const { runUpgrade } = await import("./setup/runUpgrade.js")
  const code = await runUpgrade()
  process.exit(code)
}

const logger = new Logger()
const { log, fatal } = logger

if (cli.kind === "connect") {
  const parsed = parseConnectOptions(cli.args, process.env, process.cwd())
  if (parsed.kind === "help") {
    writeFd(process.stdout.fd, connectUsage(LAUNCH))
    process.exit(0)
  }
  if (parsed.kind === "error") {
    writeFd(process.stderr.fd, `${parsed.error}\n\n${connectUsage(LAUNCH)}`)
    process.exit(2)
  }
  const options = parsed.options
  const chooser = await import("./agent/chooseAgent.js")
  if (options.agent === null) {
    // Asking needs a terminal; a script names the agent instead.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      writeFd(process.stderr.fd, `${chooser.NO_TTY_AGENT_ERROR}\n`)
      process.exit(2)
    }
    try {
      options.agent = { kind: "preset", id: await chooser.askForAgent() }
    } catch {
      // Ctrl+C at the question.
      process.exit(130)
    }
  }
  const { runConnect } = await import("./agent/connect.js")
  const agent = options.agent
  // Remember a choice that works: an agent that cannot be found or
  // installed is not preselected next time.
  const remember = async () => {
    if (agent.kind === "preset") await chooser.writeLastAgent(agent.id)
  }
  await runConnect({ ...options, agent }, logger, remember).catch(
    (err: unknown) => {
      fatal(
        `connect failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
  )
}

const main = async () => {
  const portChoice = parsePort(process.env.MCP_BRIDGE_PORT)
  if ("error" in portChoice) {
    fatal(portChoice.error, 2)
  }
  const pinnedPort = "pinned" in portChoice ? portChoice.pinned : null

  const consoleOrigin = process.env.CONSOLE_ORIGIN ?? DEFAULT_CONSOLE_ORIGIN
  let allowedOrigins: string[]
  try {
    allowedOrigins = deriveAllowedOrigins(consoleOrigin)
  } catch (err) {
    if (err instanceof InvalidConsoleOriginError) {
      fatal(err.message, 2)
    }
    throw err
  }

  const token = generateToken()

  let port = 0

  const session = new BridgeSession({
    token,
    getPort: () => port,
    consoleOrigin,
    getDeadlineMs: toolDeadlineMs,
    log,
  })

  let stopWs: (() => Promise<void>) | null = null

  let fatalShutdown: (kind: string, err: Error) => void = (kind, err) => {
    log("ERROR", `fatal (${kind}) before shutdown wired:`, err)
    process.exit(3)
  }
  const attemptListen: AttemptListenFn = (p) =>
    startWsServer({
      port: p,
      token,
      allowedOrigins,
      session,
      log,
      onFatalError: (kind, err) => fatalShutdown(kind, err),
    })

  const { ensureListening, settle: settleWs } = createWsListener({
    pinnedPort,
    attemptListen,
    findFreePort,
    onListening: (stop, boundPort) => {
      stopWs = stop
      port = boundPort
    },
    log,
  })

  const mcp = await startMcpServer({ session, log, ensureListening })

  log("INFO", `${BRIDGE_PACKAGE} v${MCP_BRIDGE_VERSION}`)
  log("INFO", `ws server: deferred until first pairing`)
  log("INFO", `console origin: ${consoleOrigin}`)
  log("INFO", `log file: ${logger.getFilePath() ?? "(disabled — stderr only)"}`)
  log("INFO", `log level: ${logger.getLevelName()}`)

  const SHUTDOWN_STEP_BUDGET_MS = 2_000
  const SHUTDOWN_HARD_BUDGET_MS = 5_000
  const { shutdown, requestFatal } = createShutdownController({
    stopMcp: () => mcp.stop(),
    settleWs,
    getStopWs: () => stopWs,
    exit: (code: number) => process.exit(code),
    log,
    stepBudgetMs: SHUTDOWN_STEP_BUDGET_MS,
    hardBudgetMs: SHUTDOWN_HARD_BUDGET_MS,
  })
  fatalShutdown = (kind, err) => void requestFatal(kind, err)

  process.on("SIGINT", () => void shutdown("received SIGINT"))
  process.on("SIGTERM", () => void shutdown("received SIGTERM"))
  process.on(
    "SIGHUP",
    () => void shutdown("received SIGHUP: the terminal was closed"),
  )
  process.stdin.on(
    "end",
    () => void shutdown("stdin ended: the MCP client closed the connection"),
  )
  process.stdin.on("close", () => void shutdown("stdin closed"))
}

if (cli.kind === "start")
  main().catch((err: unknown) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    fatal(`startup error: ${text}`, 1)
  })
