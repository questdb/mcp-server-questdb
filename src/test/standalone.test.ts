import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  bundleInstallPath,
  bundleDownloadUrl,
  commandArg,
  DISTRIBUTION_CHANNEL,
  hasStandaloneBundle,
  launchSpec,
  setupCommand,
} from "../distribution.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { buildAgents, type AgentConfig } from "../setup/agents.js"
import type { ExecFn, ExecResult } from "../setup/codexCli.js"
import {
  describeBundlePath,
  describeOldPin,
  upgradeAgent,
} from "../setup/runUpgrade.js"

const SPEC = `@questdb/mcp-server-questdb@${MCP_BRIDGE_VERSION}`

// selfPath("standalone") resolves process.argv[1] — the entry the bundle was
// launched by. Under vitest that is the test runner, which is not a bundle, so
// the standalone tests pin argv[1] to a real bundle-shaped path. This makes the
// assertions test the production launch target instead of comparing selfPath()
// to itself.
const FAKE_BUNDLE = `/opt/questdb/mcp-server-questdb-${MCP_BRIDGE_VERSION}.mjs`
let savedArgv1: string | undefined
beforeEach(() => {
  savedArgv1 = process.argv[1]
  process.argv[1] = FAKE_BUNDLE
})
afterEach(() => {
  if (savedArgv1 === undefined) process.argv.length = 1
  else process.argv[1] = savedArgv1
})

describe("launchSpec", () => {
  it("npm channel launches via pinned npx", () => {
    expect(launchSpec("npm")).toEqual({ command: "npx", args: ["-y", SPEC] })
  })

  it("standalone channel launches the bundle file via the running node", () => {
    const spec = launchSpec("standalone")
    expect(spec.command).toBe("node")
    expect(spec.args).toEqual([FAKE_BUNDLE])
    expect(isAbsolute(spec.args[0])).toBe(true)
    expect(spec.args[0]).toMatch(/mcp-server-questdb-[\d.]+\.mjs$/)
  })
})

describe("setupCommand", () => {
  it("renders setup instructions for an injected distribution channel", () => {
    expect(setupCommand("0.4.1", "npm")).toBe(
      "npx @questdb/mcp-server-questdb@0.4.1 setup",
    )
    expect(setupCommand("0.2.0", "npm")).toBe(
      "npx @questdb/mcp-bridge@0.2.0 setup",
    )
    expect(setupCommand("0.4.1", "standalone")).toBe(
      `node ${commandArg(bundleInstallPath("0.4.1", "standalone"))} setup`,
    )
    // The current version renders the exact running bundle path.
    expect(setupCommand(MCP_BRIDGE_VERSION, "standalone")).toBe(
      `node ${commandArg(FAKE_BUNDLE)} setup`,
    )
  })
})

describe("buildAgents — standalone channel", () => {
  it("stdio agents point at the bundle file, not npx", () => {
    const agents = buildAgents("standalone")
    for (const id of ["claude", "codex", "cursor", "gemini"] as const) {
      const entry = agents[id].buildEntry({})
      expect(entry.command).toBe("node")
      expect(entry.args).toEqual([FAKE_BUNDLE])
    }
  })

  it("opencode uses its array command shape", () => {
    const entry = buildAgents("standalone").opencode.buildEntry({})
    expect(entry.command).toEqual(["node", FAKE_BUNDLE])
  })

  it("default channel still writes npx entries", () => {
    const entry = buildAgents().claude.buildEntry({})
    expect(entry).toEqual({ command: "npx", args: ["-y", SPEC] })
  })
})

describe("describeOldPin — standalone entries", () => {
  const fileEntry = JSON.stringify({
    command: "/usr/local/bin/node",
    args: ["/opt/questdb/mcp-server-questdb-0.4.0.mjs"],
  })
  const opencodeFileEntry = JSON.stringify({
    type: "local",
    command: [
      "/usr/local/bin/node",
      "/opt/questdb/mcp-server-questdb-0.4.0.mjs",
    ],
  })

  it("describeOldPin reads the version out of a bundle filename", () => {
    expect(describeOldPin(fileEntry)).toBe("0.4.0")
    expect(describeOldPin(opencodeFileEntry)).toBe("0.4.0")
  })

  it("ignores package-like environment values when reporting the launch pin", () => {
    const entry = JSON.stringify({
      command: "node",
      args: ["/opt/questdb/mcp-server-questdb-0.4.0.mjs"],
      env: { NOTE: "@questdb/mcp-server-questdb@9.9.9" },
    })
    expect(describeOldPin(entry)).toBe("0.4.0")
    expect(describeBundlePath(entry)).toBe(
      "/opt/questdb/mcp-server-questdb-0.4.0.mjs",
    )
  })

  it("ignores a bundle-like environment value when reporting the launch path", () => {
    const entry = JSON.stringify({
      command: "npx",
      args: ["-y", "@questdb/mcp-server-questdb@0.4.0"],
      env: { NOTE: "/opt/questdb/mcp-server-questdb-9.9.9.mjs" },
    })
    expect(describeBundlePath(entry)).toBe(null)
  })
})

// The running binary's channel wins, unconditionally: whichever distribution
// runs upgrade rewrites the entry to its own launch style, carrying env over.
describe("upgradeAgent — cross-channel PUT", () => {
  const at = (agent: AgentConfig, path: string): AgentConfig => ({
    ...agent,
    displayName: "Test Agent",
    configPaths: [path],
  })

  const configWith = (path: string, entry: Record<string, unknown>): void =>
    writeFileSync(path, JSON.stringify({ mcpServers: { questdb: entry } }))

  it("the npm binary converts a standalone entry to npx, env preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qdb-standalone-"))
    const path = join(dir, "config.json")
    configWith(path, {
      command: "/usr/local/bin/node",
      args: ["/opt/questdb/mcp-server-questdb-0.3.0.mjs"],
      env: { CONSOLE_ORIGIN: "http://127.0.0.1:9000" },
    })

    const r = await upgradeAgent(at(buildAgents("npm").claude, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("0.3.0")
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(written.mcpServers.questdb).toEqual({
      command: "npx",
      args: ["-y", SPEC],
      env: { CONSOLE_ORIGIN: "http://127.0.0.1:9000" },
    })
  })

  it("the standalone binary converts an npx entry to its own file, env preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qdb-standalone-"))
    const path = join(dir, "config.json")
    configWith(path, {
      command: "npx",
      args: ["-y", "@questdb/mcp-server-questdb@0.3.0"],
      env: { MCP_BRIDGE_PORT: "9123" },
    })

    const r = await upgradeAgent(at(buildAgents("standalone").claude, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("0.3.0")
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(written.mcpServers.questdb).toEqual({
      command: "node",
      args: [FAKE_BUNDLE],
      env: { MCP_BRIDGE_PORT: "9123" },
    })
  })

  it("reports both paths when only a same-version standalone path changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qdb-standalone-"))
    const path = join(dir, "config.json")
    const previous = `/old/location/mcp-server-questdb-${MCP_BRIDGE_VERSION}.mjs`
    const next = "/new/location/questdb-bridge.mjs"
    configWith(path, { command: "node", args: [previous] })
    const agent = at(buildAgents("standalone").claude, path)
    agent.buildEntry = () => ({ command: "node", args: [next] })

    const result = await upgradeAgent(agent)
    expect(result.kind).toBe("updated")
    if (result.kind === "updated") {
      expect(result.from).toBe(MCP_BRIDGE_VERSION)
      expect(result.fromBundlePath).toBe(previous)
      expect(result.toBundlePath).toBe(next)
    }
  })

  const fakeExec = (
    results: ExecResult[],
  ): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = []
    return {
      calls,
      exec: (args) => {
        calls.push(args)
        const result = results[calls.length - 1]
        return result
          ? Promise.resolve(result)
          : Promise.reject(new Error("unexpected codex call"))
      },
    }
  }

  const codexJson = (
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): string => JSON.stringify({ transport: { command, args, env } })

  it("the standalone binary converts a Codex npx entry through the CLI", async () => {
    const { exec, calls } = fakeExec([
      {
        code: 0,
        stdout: codexJson("npx", ["-y", "@questdb/mcp-server-questdb@0.3.0"]),
        stderr: "",
      },
      { code: 0, stdout: "Added\n", stderr: "" },
    ])
    const result = await upgradeAgent(buildAgents("standalone").codex, exec)
    expect(result.kind).toBe("updated")
    expect(calls[1]).toEqual([
      "mcp",
      "add",
      "questdb",
      "--",
      "node",
      FAKE_BUNDLE,
    ])
  })

  it("the npm binary converts a standalone Codex entry through the CLI", async () => {
    const { exec, calls } = fakeExec([
      {
        code: 0,
        stdout: codexJson("node", [FAKE_BUNDLE], { MCP_BRIDGE_PORT: "9123" }),
        stderr: "",
      },
      { code: 0, stdout: "Added\n", stderr: "" },
    ])
    const result = await upgradeAgent(buildAgents("npm").codex, exec)
    expect(result.kind).toBe("updated")
    expect(calls[1]).toEqual([
      "mcp",
      "add",
      "questdb",
      "--env",
      "MCP_BRIDGE_PORT=9123",
      "--",
      "npx",
      "-y",
      SPEC,
    ])
  })

  it("does not PUT an already-current standalone Codex entry", async () => {
    const { exec, calls } = fakeExec([
      {
        code: 0,
        stdout: codexJson("node", [FAKE_BUNDLE]),
        stderr: "",
      },
    ])
    const result = await upgradeAgent(buildAgents("standalone").codex, exec)
    expect(result.kind).toBe("current")
    expect(calls).toHaveLength(1)
  })
})

describe("commandArg", () => {
  it("quotes metacharacter paths for the running platform's shell", () => {
    if (process.platform === "win32") {
      expect(commandArg("C:\\Program Files\\q\\b.mjs")).toBe(
        '"C:\\Program Files\\q\\b.mjs"',
      )
      expect(commandArg("C:\\x\\%USERNAME%\\b.mjs")).toBe(
        '"C:\\x\\%%USERNAME%%\\b.mjs"',
      )
    } else {
      expect(commandArg("/opt/q/b.mjs")).toBe("'/opt/q/b.mjs'")
      expect(commandArg("/Users/a b/$(id -u)/b.mjs")).toBe(
        "'/Users/a b/$(id -u)/b.mjs'",
      )
      expect(commandArg("/o'brien/b.mjs")).toBe("'/o'\\''brien/b.mjs'")
    }
  })
})

describe("bundleDownloadUrl", () => {
  it("renders the deterministic GitHub Release asset URL", () => {
    expect(bundleDownloadUrl("0.5.0")).toBe(
      "https://github.com/questdb/mcp-server-questdb/releases/download/v0.5.0/mcp-server-questdb-0.5.0.mjs",
    )
  })
})

describe("hasStandaloneBundle", () => {
  it("accepts canonical versions", () => {
    expect(hasStandaloneBundle("0.2.0")).toBe(true)
    expect(hasStandaloneBundle("0.3.0")).toBe(true)
    expect(hasStandaloneBundle("0.3.9")).toBe(true)
    expect(hasStandaloneBundle("0.4.0")).toBe(true)
    expect(hasStandaloneBundle("0.4.1")).toBe(true)
    expect(hasStandaloneBundle("0.10.0")).toBe(true)
    expect(hasStandaloneBundle("1.0.0")).toBe(true)
    expect(hasStandaloneBundle("not-a-version")).toBe(false)
    expect(hasStandaloneBundle("0.4.0/../../escape")).toBe(false)
    expect(hasStandaloneBundle(" 0.4.0")).toBe(false)
    expect(hasStandaloneBundle("0.4.0-rc.1")).toBe(false)
    expect(hasStandaloneBundle("0.4.0+build.1")).toBe(false)
  })
})

describe("distribution defaults", () => {
  it("keeps source/npm builds on the npm channel", () => {
    expect(DISTRIBUTION_CHANNEL).toBe("npm")
  })
})

describe("bundleDownloadUrl validation", () => {
  it("rejects non-canonical and path-like versions", () => {
    expect(() => bundleDownloadUrl("0.4.0/../../escape")).toThrow("FATAL")
    expect(() => bundleDownloadUrl("0.4")).toThrow("FATAL")
    expect(() => bundleDownloadUrl(" 0.4.0")).toThrow("FATAL")
    expect(() => setupCommand("0.4.0; touch /tmp/nope", "npm")).toThrow("FATAL")
  })

  it("rejects prerelease versions and build metadata", () => {
    expect(() => bundleDownloadUrl("0.5.0-rc.1")).toThrow("major.minor.patch")
    expect(() => bundleDownloadUrl("0.5.0+build.1")).toThrow(
      "major.minor.patch",
    )
  })
})
