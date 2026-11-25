import { execFile, spawn, type ChildProcess } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { BUNDLED_TOOL_NAMES } from "../bundledTools.js"
import { bundleFileName, commandArg } from "../distribution.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { NO_TTY_AGENT_ERROR } from "../agent/chooseAgent.js"

const execFileP = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const BUNDLE_SCRIPT = join(REPO_ROOT, "src/scripts/bundle.js")

type JsonRpcMessage = {
  id?: number
  result?: {
    serverInfo?: { name: string; version: string }
    tools?: { name: string }[]
    content?: { type: string; text: string }[]
  }
}

// The only executable a child may resolve from PATH. Node's own directory is
// not usable here: on Homebrew and nvm installs it also holds every globally
// installed tool, so a contributor with `codex` beside `node` would leak a
// real Codex CLI into the upgrade tests and `codex mcp get` would run against
// the synthetic CODEX_HOME.
let isolatedBin: string

const createIsolatedBin = (dir: string): string => {
  const bin = join(dir, "isolated-bin")
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, basename(process.execPath)))
  return bin
}

// Keep every child away from the contributor's bridge settings and agent
// configs. The explicit allowlist retains only the OS values needed to launch
// Node; bridge-specific variables from the host cannot affect the test.
const isolatedEnv = (home: string): NodeJS.ProcessEnv => ({
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: join(home, ".codex"),
  PATH: isolatedBin,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
  ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
})

// A live bundle process driven over stdio like an MCP client would.
class BundleSession {
  private child: ChildProcess
  private buf = ""
  private pending = new Map<number, (msg: JsonRpcMessage) => void>()
  private protocolErrors: string[] = []

  constructor(bundlePath: string, cwd: string) {
    this.child = spawn(process.execPath, [bundlePath, "start"], {
      cwd,
      env: isolatedEnv(join(cwd, "home-session")),
      stdio: ["pipe", "pipe", "pipe"],
    })
    // The bridge logs to stderr. Drain it so a verbose inherited/default log
    // level can never backpressure the long-lived child.
    this.child.stderr!.resume()
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString()
      let nl
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as JsonRpcMessage
          if (msg.id !== undefined) this.pending.get(msg.id)?.(msg)
        } catch {
          this.protocolErrors.push(line)
        }
      }
    })
  }

  rpc(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`rpc ${method} timed out`)),
        10_000,
      )
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(msg)
      })
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      )
    })
  }

  notify(method: string): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n")
  }

  kill(): void {
    this.child.kill()
  }

  assertClean(): void {
    if (this.protocolErrors.length > 0) {
      throw new Error(
        `bundle emitted non-JSON stdout: ${this.protocolErrors.join(" | ")}`,
      )
    }
  }
}

// Resolves "connected" on success, the error/timeout description otherwise.
const wsAttempt = (url: string, origin: string): Promise<string> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } })
    const timer = setTimeout(() => {
      ws.terminate()
      resolve("timeout")
    }, 5_000)
    ws.on("open", () => {
      clearTimeout(timer)
      ws.close()
      resolve("connected")
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      resolve(err.message)
    })
  })

// End-to-end: build the real standalone bundle with the real build script,
// then exercise it from an empty directory (no node_modules in scope) — CLI
// surface, MCP handshake over stdio, and the WebSocket pairing endpoint the
// Web Console connects to. This is the release gate for the bundle artifact:
// it fails if bundling regresses (e.g. a dep esbuild can't inline, a runtime
// file read that doesn't exist next to a single file).
describe.skipIf(process.platform === "win32")("standalone bundle e2e", () => {
  let dir: string
  let outDir: string
  let bundlePath: string
  let session: BundleSession

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"))
    isolatedBin = createIsolatedBin(dir)
    outDir = join(dir, "artifact")
    const unrelatedCwd = join(dir, "unrelated-cwd")
    mkdirSync(unrelatedCwd)
    // If the standalone help guard regresses, it will accidentally print this
    // neighbouring file instead of the bridge's built-in usage text.
    writeFileSync(join(dir, "README.md"), "UNRELATED SENTINEL README")
    await execFileP(process.execPath, [BUNDLE_SCRIPT, `--out=${outDir}`], {
      cwd: unrelatedCwd,
    })
    bundlePath = join(outDir, bundleFileName(MCP_BRIDGE_VERSION))
    session = new BundleSession(bundlePath, outDir)
  }, 60_000)

  afterAll(() => {
    try {
      session?.assertClean()
    } finally {
      session?.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--version prints the package version", async () => {
    const { stdout, stderr } = await execFileP(process.execPath, [
      bundlePath,
      "--version",
    ])
    expect(stdout.trim()).toBe(MCP_BRIDGE_VERSION)
    expect(stderr).toBe("")
  })

  it("--help renders standalone (node, not npx) usage", async () => {
    const { stdout } = await execFileP(process.execPath, [bundlePath, "--help"])
    expect(stdout).toContain(`node ${commandArg(bundlePath)} setup`)
    expect(stdout).toContain(
      `node ${commandArg(bundlePath)} connect [console-url] [options]`,
    )
    expect(stdout).toContain("--workspace <dir>")
    // The bundle's own path is a temporary folder named after the test.
    const usage = stdout.replaceAll(commandArg(bundlePath), "<bundle>")
    expect(usage).not.toMatch(/\bstart\b|bridge/)
    expect(stdout).not.toContain("UNRELATED SENTINEL README")
    expect(stdout).not.toContain("npx @questdb/mcp-server-questdb setup")
  })

  it("unknown commands render a standalone help hint", async () => {
    const err = (await execFileP(process.execPath, [
      bundlePath,
      "badcmd",
    ]).catch((e: unknown) => e)) as { code: number; stderr: string }
    expect(err.code).toBe(2)
    expect(err.stderr).toContain(`node ${commandArg(bundlePath)} --help`)
    expect(err.stderr).not.toContain("npx")
  })

  it("bundle script rejects --out without a directory", async () => {
    const err = (await execFileP(process.execPath, [BUNDLE_SCRIPT, "--out"], {
      cwd: dir,
    }).catch((e: unknown) => e)) as { code: number; stderr: string }
    expect(err.code).toBe(2)
    expect(err.stderr).toContain("--out requires a directory")
  })

  it("bundle script rejects unknown arguments", async () => {
    const err = (await execFileP(process.execPath, [
      BUNDLE_SCRIPT,
      "--unknown",
    ]).catch((e: unknown) => e)) as { code: number; stderr: string }
    expect(err.code).toBe(2)
    expect(err.stderr).toContain("unknown argument: --unknown")
  })

  it("does not leave an orphan bundle when the output pair cannot be promoted", async () => {
    const blockedOut = join(dir, "blocked-output")
    mkdirSync(join(blockedOut, "THIRD_PARTY_NOTICES.txt"), {
      recursive: true,
    })
    const err = (await execFileP(process.execPath, [
      BUNDLE_SCRIPT,
      "--out",
      blockedOut,
    ]).catch((e: unknown) => e)) as { code: number; stderr: string }
    expect(err.code).not.toBe(0)
    expect(err.stderr).toContain("refusing to replace non-file output")
    expect(
      existsSync(join(blockedOut, bundleFileName(MCP_BRIDGE_VERSION))),
    ).toBe(false)
  })

  it("completes the MCP initialize handshake", async () => {
    const init = await session.rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    })
    expect(init.result?.serverInfo?.version).toBe(MCP_BRIDGE_VERSION)
    session.notify("notifications/initialized")
  })

  it("lists every bundled tool", async () => {
    const listed = await session.rpc(2, "tools/list", {})
    const names = new Set(listed.result?.tools?.map((t) => t.name))
    for (const name of BUNDLED_TOOL_NAMES) expect(names).toContain(name)
    expect(names).toContain("get_pairing_credentials")
  })

  it("upgrade rewrites an agent config to launch the bundle", async () => {
    const home = join(dir, "home-upgrade")
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-server-questdb@0.3.0"],
            env: { CONSOLE_ORIGIN: "http://127.0.0.1:9000" },
          },
        },
      }),
    )

    const { stdout } = await execFileP(
      process.execPath,
      [bundlePath, "upgrade"],
      { cwd: dir, env: isolatedEnv(home) },
    )
    expect(stdout).toContain(`0.3.0 → ${MCP_BRIDGE_VERSION}`)
    const written = JSON.parse(
      readFileSync(join(home, ".claude.json"), "utf8"),
    ) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(written.mcpServers.questdb).toEqual({
      command: "node",
      args: [resolve(bundlePath)],
      env: { CONSOLE_ORIGIN: "http://127.0.0.1:9000" },
    })
  })

  it("preserves a stable symlink path when upgrading agent config", async () => {
    const home = join(dir, "home-symlink-upgrade")
    const binDir = join(dir, "bin")
    const symlinkPath = join(binDir, "questdb-bridge.mjs")
    mkdirSync(home, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    symlinkSync(bundlePath, symlinkPath)
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-server-questdb@0.3.0"],
          },
        },
      }),
    )

    await execFileP(process.execPath, [symlinkPath, "upgrade"], {
      cwd: dir,
      env: isolatedEnv(home),
    })
    const written = JSON.parse(
      readFileSync(join(home, ".claude.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(written.mcpServers.questdb).toEqual({
      command: "node",
      args: [resolve(symlinkPath)],
    })
  })

  it("setup without a TTY exits 1 with standalone (not npx) guidance", async () => {
    const home = join(dir, "home-setup")
    mkdirSync(home, { recursive: true })
    const err = (await execFileP(process.execPath, [bundlePath, "setup"], {
      cwd: dir,
      env: isolatedEnv(home),
    }).catch((e: unknown) => e)) as { code: number; stderr: string }
    expect(err.code).toBe(1)
    expect(err.stderr).toContain(`node ${commandArg(bundlePath)} setup`)
    expect(err.stderr).not.toContain("npx")
  })

  it("connect without --agent and without a terminal asks for --agent and starts nothing", async () => {
    // Given
    const home = join(dir, "connect-no-tty")
    mkdirSync(home)

    // When
    const err = (await execFileP(
      process.execPath,
      [bundlePath, "connect", "http://127.0.0.1:9000", "--no-open"],
      {
        cwd: home,
        env: {
          ...isolatedEnv(home),
          QUESTDB_MCP_SERVER_HOME: join(home, "mcp-server"),
        },
      },
    ).catch((e: unknown) => e)) as { code: number; stderr: string }

    // Then
    expect(err.code).toBe(2)
    expect(err.stderr.trim()).toBe(NO_TTY_AGENT_ERROR)
    expect(existsSync(join(home, "mcp-server"))).toBe(false)
  })

  it("pairing WebSocket enforces the token and accepts a bearer", async () => {
    const creds = await session.rpc(3, "tools/call", {
      name: "get_pairing_credentials",
      arguments: { auto_open_browser: false },
    })
    const text = creds.result?.content?.[0]?.text
    expect(text).toBeDefined()
    const { wsUrl, token, deepLink } = JSON.parse(text!) as {
      wsUrl?: string
      token?: string
      deepLink?: string
    }
    expect(wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toBeTruthy()
    // The console names the agent from its MCP clientInfo.
    expect(new URL(deepLink!).searchParams.get("mcp-client")).toBe("e2e")

    const origin = "http://127.0.0.1:9000"
    expect(await wsAttempt(`${wsUrl}/?token=wrong`, origin)).toContain("401")
    expect(
      await wsAttempt(`${wsUrl}/?token=${encodeURIComponent(token!)}`, origin),
    ).toBe("connected")
  })

  // `connect` with the scripted fake agent, until it prints its pairing link.
  const startConnect = async (name: string) => {
    const home = join(dir, `connect-${name}`)
    mkdirSync(home)
    const pidFile = join(home, "agent-pids")
    const child = spawn(
      process.execPath,
      [
        bundlePath,
        "connect",
        "http://127.0.0.1:9000",
        "--agent-command",
        `${process.execPath} ${FAKE_AGENT}`,
        "--no-open",
        "--workspace",
        join(home, "workspace"),
      ],
      {
        cwd: home,
        env: {
          ...isolatedEnv(home),
          QUESTDB_MCP_SERVER_HOME: join(home, "mcp-server"),
          FAKE_AGENT_PID_FILE: pidFile,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    const exited = new Promise<number | null>((done) =>
      child.once("exit", (code) => done(code)),
    )
    let stderr = ""
    const link = await new Promise<URL>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`connect printed no pairing link:\n${stderr}`)),
        15_000,
      )
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
        const found = /^\s+(http\S+mcp-token\S+)$/m.exec(stderr)
        if (found) {
          clearTimeout(timer)
          done(new URL(found[1]))
        }
      })
    })
    const agentPid = await waitUntil(() => {
      const pid = Number(
        existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n")[0] : "",
      )
      return pid > 0 ? pid : null
    })
    return { child, exited, link, agentPid }
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`connect stops its agent and exits cleanly on ${signal}`, async () => {
      // Given a running connect with its agent started
      const connection = await startConnect(signal)

      // When
      connection.child.kill(signal)

      // Then
      expect(await connection.exited).toBe(0)
      await waitUntil(() => (isRunning(connection.agentPid) ? null : true))
    }, 30_000)
  }

  it("connect takes a message with images past the old 4 MB frame limit and answers it", async () => {
    // Given a console paired with connect
    const connection = await startConnect("large-prompt")
    const wsUrl = connection.link.searchParams.get("mcp-ws")!
    const token = connection.link.searchParams.get("mcp-token")!
    const ws = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`, {
      headers: { origin: "http://127.0.0.1:9000" },
    })
    type Frame = { type: string; turnId?: string; result?: unknown }
    const frames: Frame[] = []
    ws.on("message", (data) => {
      frames.push(JSON.parse((data as Buffer).toString("utf8")) as Frame)
    })
    await new Promise((done) => ws.once("open", done))
    ws.send(
      JSON.stringify({
        v: MCP_BRIDGE_VERSION,
        type: "hello",
        token,
        userAgent: "e2e",
        expectedBridgeVersion: MCP_BRIDGE_VERSION,
        consoleOrigin: "http://127.0.0.1:9000",
        tools: [],
        permissions: { grantSchemaAccess: true, read: true, write: true },
      }),
    )
    await waitUntil(() => frames.find((f) => f.type === "hello_ack") ?? null)

    try {
      // When it sends a message of about 6 MB
      const image = {
        type: "image",
        mimeType: "image/png",
        data: "A".repeat(3_000_000),
      }
      ws.send(
        JSON.stringify({
          v: MCP_BRIDGE_VERSION,
          type: "agent_prompt",
          conversationId: "c1",
          turnId: "t1",
          prompt: [{ type: "text", text: "hello" }, image, image],
        }),
      )

      // Then the turn is answered
      const end = await waitUntil(
        () =>
          frames.find(
            (f) => f.type === "agent_turn_end" && f.turnId === "t1",
          ) ?? null,
      )
      expect(end.result).toMatchObject({ outcome: "completed" })
    } finally {
      ws.close()
      connection.child.kill("SIGTERM")
      await connection.exited
    }
  }, 30_000)
})

const FAKE_AGENT = fileURLToPath(
  new URL("./fixtures/fakeAgent.mjs", import.meta.url),
)

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Polls until `probe` returns a value, for at most 15 seconds.
const waitUntil = async <T>(probe: () => T | null): Promise<T> => {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = probe()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((done) => setTimeout(done, 50))
  }
}
