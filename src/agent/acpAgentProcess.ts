import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { BRIDGE_PACKAGE } from "../bridgePackage.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { Log } from "../types.js"
import type { AgentLaunch } from "./agentPresets.js"

// Each call names the process generation it came from: session ids are only
// unique within one agent process.
export type AcpAgentHandlers = {
  onSessionUpdate: (
    notification: acp.SessionNotification,
    generation: number,
  ) => void
  requestPermission: (
    request: acp.RequestPermissionRequest,
    generation: number,
  ) => Promise<acp.RequestPermissionResponse>
  // A question the agent asks the user, as a form.
  elicit: (
    request: acp.CreateElicitationRequest,
    generation: number,
  ) => Promise<acp.CreateElicitationResponse>
  // A link the agent asked the user to open no longer needs opening.
  onElicitationComplete: (elicitationId: string, generation: number) => void
  onExit: (generation: number) => void
}

export type AcpAgentConnection = {
  generation: number
  agent: acp.ClientContext
  capabilities: acp.AgentCapabilities
}

type AcpAgentProcessConfig = {
  launch: AgentLaunch
  cwd: string
  handlers: AcpAgentHandlers
  log: Log
}

type LiveAgent = AcpAgentConnection

const INITIALIZE_TIMEOUT_MS = 60_000
const AUTHENTICATE_TIMEOUT_MS = 60_000

// Generations are unique across processes: a conversation's session records
// the generation of the process it lives in, and several processes can run.
let lastGeneration = 0

const AUTH_REQUIRED_CODE = -32000

// Rejects with `message` when `promise` takes longer than `ms`.
const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(onTimeout()), ms)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

const isWindows = process.platform === "win32"

// The command to spawn. Through a shell, Node joins the command and its
// arguments with spaces and cmd.exe splits them again, so a path with a space,
// like C:\Users\John Doe\...\cursor-agent.cmd, is quoted to stay whole.
export const spawnCommandOf = (
  launch: Pick<AgentLaunch, "command" | "shell">,
): string =>
  launch.shell && !/^".*"$/.test(launch.command)
    ? `"${launch.command}"`
    : launch.command

// The agent runs in its own process group, so stopping it also stops the
// tools and sub-agents it started.
const killProcessTree = (child: ChildProcess): void => {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (isWindows) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } else {
      process.kill(-child.pid, "SIGTERM")
    }
  } catch {
    child.kill()
  }
}

// An agent that offers the preset's auth method is asked to use it. It signs
// in with the credentials its own CLI stored; one that has none can hang
// waiting for an interactive sign-in, so that counts as not signed in.
const authenticateWith = async (
  agent: acp.ClientContext,
  initialized: acp.InitializeResponse,
  launch: AgentLaunch,
): Promise<void> => {
  const methodId = launch.authMethodId
  if (!methodId) return
  if (!initialized.authMethods?.some((method) => method.id === methodId)) {
    return
  }
  await withTimeout(
    agent.request("authenticate", { methodId }),
    AUTHENTICATE_TIMEOUT_MS,
    () =>
      Object.assign(new Error("Authentication required"), {
        code: AUTH_REQUIRED_CODE,
      }),
  )
}

export class AcpAgentProcess {
  private live: Promise<LiveAgent> | null = null
  private generation = ++lastGeneration
  // The running process, known from the moment it spawns, so stop() and a
  // failed start can always end it.
  private running: { child: ChildProcess; close: () => void } | null = null

  constructor(private config: AcpAgentProcessConfig) {}

  connection(): Promise<AcpAgentConnection> {
    if (!this.live) {
      // A start that fails after stop() must not drop the process started
      // since: only the failed start clears its own promise.
      const live: Promise<LiveAgent> = this.spawnAndInitialize().catch(
        (err: unknown) => {
          if (this.live === live) this.live = null
          throw err
        },
      )
      this.live = live
    }
    return this.live
  }

  // Retires the current generation first, so its exit is not reported as a
  // crash, then ends the process even if it is still starting.
  stop(): Promise<void> {
    this.live = null
    this.generation = ++lastGeneration
    this.endRunning()
    return Promise.resolve()
  }

  private authenticate(
    agent: acp.ClientContext,
    initialized: acp.InitializeResponse,
  ): Promise<void> {
    return authenticateWith(agent, initialized, this.config.launch)
  }

  private endRunning(): void {
    const running = this.running
    this.running = null
    if (!running) return
    running.close()
    killProcessTree(running.child)
  }

  private async spawnAndInitialize(): Promise<LiveAgent> {
    const { launch, cwd, handlers, log } = this.config
    const generation = (this.generation = ++lastGeneration)
    log("INFO", `starting agent: ${launch.label}`)
    log("DEBUG", `agent command: ${launch.command} ${launch.args.join(" ")}`)

    const child = spawn(spawnCommandOf(launch), launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
      shell: launch.shell ?? false,
    })
    child.stderr.on("data", (chunk: Buffer) => {
      log("DEBUG", `[agent] ${chunk.toString("utf8").trimEnd()}`)
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const connection = acp
      .client({ name: BRIDGE_PACKAGE })
      .onNotification("session/update", ({ params }) =>
        handlers.onSessionUpdate(params, generation),
      )
      .onRequest("session/request_permission", ({ params }) =>
        handlers.requestPermission(params, generation),
      )
      .onRequest("elicitation/create", ({ params }) =>
        handlers.elicit(params, generation),
      )
      .onNotification("elicitation/complete", ({ params }) =>
        handlers.onElicitationComplete(params.elicitationId, generation),
      )
      .connect(stream)

    this.running = { child, close: () => connection.close() }

    const forget = (reason: Error): void => {
      connection.close(reason)
      if (this.generation !== generation) return
      this.live = null
      this.running = null
      handlers.onExit(generation)
    }
    child.once("error", (err) => {
      log("ERROR", `agent process error: ${err.message}`)
      forget(err)
    })
    child.once("exit", (code, signal) => {
      log("WARN", `agent process exited (code=${code}, signal=${signal})`)
      forget(new Error("The coding agent stopped."))
    })

    let initialized: acp.InitializeResponse
    try {
      initialized = await withTimeout(
        connection.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          // Forms carry the agents' questions to the user; without them,
          // agents answer their own questions or ask in plain text.
          // Notices keep the agent's own warnings out of its replies.
          clientCapabilities: {
            // Links let an agent, or a service it connects to, send the user
            // to a page, like a sign-in.
            elicitation: { form: {}, url: {} },
            session: { notices: {} },
          },
          clientInfo: { name: BRIDGE_PACKAGE, version: MCP_BRIDGE_VERSION },
        }),
        INITIALIZE_TIMEOUT_MS,
        () => new Error(`${launch.label} did not start within a minute.`),
      )
      await this.authenticate(connection.agent, initialized)
    } catch (err) {
      // Retired before it is ended, like stop(): the exit that follows is the
      // bridge's doing, not a crash that would replace this error with "The
      // agent stopped".
      if (this.generation === generation) {
        this.generation = ++lastGeneration
        this.endRunning()
      }
      throw err
    }
    log(
      "INFO",
      `agent ready: ${initialized.agentInfo?.title ?? launch.label} ${initialized.agentInfo?.version ?? ""}`,
    )

    return {
      generation,
      agent: connection.agent,
      capabilities: initialized.agentCapabilities ?? {},
    }
  }
}
