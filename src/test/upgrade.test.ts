import { execSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseCli } from "../cli.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { buildAgents, type AgentConfig } from "../setup/agents.js"
import {
  codexNotFoundError,
  type ExecFn,
  type ExecResult,
} from "../setup/codexCli.js"
import { describeOldPin, upgradeAgent } from "../setup/runUpgrade.js"

const SPEC = `@questdb/mcp-server-questdb@${MCP_BRIDGE_VERSION}`
const agents = buildAgents()

const tmpPath = (name: string, content?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "qdb-upgrade-"))
  const path = join(dir, name)
  if (content !== undefined) writeFileSync(path, content)
  return path
}

// Real agent definitions (real buildEntry / format / configKey), pointed at a
// temp config file instead of the user's home directory.
const at = (agent: AgentConfig, path: string): AgentConfig => ({
  ...agent,
  displayName: "Test Agent",
  configPaths: [path],
})

describe("parseCli — upgrade", () => {
  it("routes the upgrade command to the upgrade outcome", () => {
    expect(parseCli(["upgrade"], "1.2.3", () => "")).toEqual({
      kind: "upgrade",
    })
  })
})

describe("describeOldPin", () => {
  it.each([
    ['"@questdb/mcp-server-questdb@0.3.0"', "0.3.0"],
    ['"@questdb/mcp-server-questdb"', "unpinned"],
    // legacy-name pins predate the 0.3.0 rename and must stay recognized
    ['"@questdb/mcp-bridge@0.1.0"', "0.1.0"],
    ['"@questdb/mcp-bridge@^0.1.0"', "^0.1.0"],
    // a spec corrupted by a past partial rewrite still reports what was there
    ['"@questdb/mcp-bridge@0.2.0@^0.1.0"', "0.2.0@^0.1.0"],
    ['"@questdb/mcp-bridge"', "unpinned"],
    ['"/usr/lib/node_modules/@questdb/mcp-bridge/dist/index.js"', "unpinned"],
    ['"some-other-server"', null],
  ])("%s → %s", (text, expected) => {
    expect(describeOldPin(text)).toBe(expected)
  })
})

describe("upgradeAgent — PUT semantics", () => {
  it("replaces a hand-written entry wholesale, carrying only env", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-bridge@^0.1.0", "--hand-added-flag"],
            env: { CONSOLE_ORIGIN: "http://x", LOG_PATH: "/tmp/bridge.log" },
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("^0.1.0")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcpServers.questdb).toEqual({
      command: "npx",
      args: ["-y", SPEC],
      env: { CONSOLE_ORIGIN: "http://x", LOG_PATH: "/tmp/bridge.log" },
    })
  })

  it("converts a global-install path entry to the canonical npx spec", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "node",
            args: ["/usr/lib/node_modules/@questdb/mcp-bridge/dist/index.js"],
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("unpinned")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcpServers.questdb).toEqual({
      command: "npx",
      args: ["-y", SPEC],
    })
  })

  it("overwrites a questdb entry that doesn't reference the bridge", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: { questdb: { url: "https://example.com/mcp" } },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBeNull()
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcpServers.questdb).toEqual({
      command: "npx",
      args: ["-y", SPEC],
    })
  })

  it("leaves sibling server entries untouched", async () => {
    const sibling = {
      command: "npx",
      args: ["-y", "@questdb/mcp-bridge-cli@1.0.0"],
    }
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.0.1"] },
          other: sibling,
        },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(parsed.mcpServers.other).toEqual(sibling)
  })

  it("ignores bridge mentions outside the questdb entry (claude.json history)", async () => {
    const raw = JSON.stringify({
      mcpServers: {},
      history: ["please upgrade @questdb/mcp-bridge@0.1.0 for me"],
    })
    const path = tmpPath("config.json", raw)
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("absent")
    expect(readFileSync(path, "utf-8")).toBe(raw)
  })

  it("preserves comments outside the entry in a JSONC config", async () => {
    const path = tmpPath(
      "opencode.jsonc",
      `{\n  // my opencode config\n  "mcp": {\n    "questdb": { "type": "local", "command": ["npx", "-y", "@questdb/mcp-bridge@0.0.1"], "enabled": true }\n  }\n}\n`,
    )
    const r = await upgradeAgent(at(agents.opencode, path))
    expect(r.kind).toBe("updated")
    expect(readFileSync(path, "utf-8")).toContain("// my opencode config")
  })

  it("carries `environment` and restores canonical fields for OpenCode", async () => {
    const path = tmpPath(
      "opencode.json",
      JSON.stringify({
        mcp: {
          questdb: {
            type: "local",
            command: ["npx", "-y", "@questdb/mcp-bridge@0.1.0"],
            environment: { CONSOLE_ORIGIN: "http://x" },
            // PUT: a hand-disabled entry comes back enabled, like setup wrote it
            enabled: false,
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.opencode, path))
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("0.1.0")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcp: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcp.questdb).toEqual({
      type: "local",
      command: ["npx", "-y", SPEC],
      environment: { CONSOLE_ORIGIN: "http://x" },
      enabled: true,
    })
  })

  // Codex is delegated to its own CLI: `codex mcp get --json` to read,
  // `codex mcp add` to PUT. These tests fake the exec; the real binary is
  // exercised by the integration suite below.
  const codexGetJson = (
    args: string[],
    env?: Record<string, string>,
  ): string =>
    JSON.stringify({
      name: "questdb",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args,
        env: env ?? null,
        env_vars: [],
        cwd: null,
      },
    })

  const fakeCodex = (
    results: ExecResult[],
  ): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = []
    const exec: ExecFn = (args) => {
      calls.push(args)
      const r = results[calls.length - 1]
      return r
        ? Promise.resolve(r)
        : Promise.reject(new Error("unexpected codex call"))
    }
    return { exec, calls }
  }

  it("re-pins codex via `codex mcp add`, re-passing the existing env", async () => {
    const { exec, calls } = fakeCodex([
      {
        code: 0,
        stdout: codexGetJson(["-y", "@questdb/mcp-bridge@0.0.1"], {
          CONSOLE_ORIGIN: "http://localhost:9000",
        }),
        stderr: "",
      },
      { code: 0, stdout: "Added global MCP server 'questdb'.\n", stderr: "" },
    ])
    const r = await upgradeAgent(agents.codex, exec)
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("0.0.1")
    expect(calls[0]).toEqual(["mcp", "get", "questdb", "--json"])
    expect(calls[1]).toEqual([
      "mcp",
      "add",
      "questdb",
      "--env",
      "CONSOLE_ORIGIN=http://localhost:9000",
      "--",
      "npx",
      "-y",
      SPEC,
    ])
  })

  it("reports codex current without writing when already canonical", async () => {
    const { exec, calls } = fakeCodex([
      { code: 0, stdout: codexGetJson(["-y", SPEC]), stderr: "" },
    ])
    const r = await upgradeAgent(agents.codex, exec)
    expect(r.kind).toBe("current")
    expect(calls).toHaveLength(1)
  })

  it("reports codex absent when no questdb server is configured", async () => {
    const { exec } = fakeCodex([
      {
        code: 1,
        stdout: "",
        stderr: "Error: No MCP server named 'questdb' found.\n",
      },
    ])
    expect((await upgradeAgent(agents.codex, exec)).kind).toBe("absent")
  })

  it("reports codex absent when the codex CLI is not installed", async () => {
    const exec: ExecFn = () => Promise.reject(codexNotFoundError())
    expect((await upgradeAgent(agents.codex, exec)).kind).toBe("absent")
  })

  it("reports codex failed when its CLI rejects (broken config, old codex)", async () => {
    const { exec } = fakeCodex([
      {
        code: 1,
        stdout: "",
        stderr: "Error: failed to load configuration\n",
      },
    ])
    const r = await upgradeAgent(agents.codex, exec)
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") expect(r.error).toContain("codex mcp get")
  })

  it("reports codex failed when the add step fails after a good get", async () => {
    const { exec } = fakeCodex([
      {
        code: 0,
        stdout: codexGetJson(["-y", "@questdb/mcp-bridge@0.0.1"]),
        stderr: "",
      },
      { code: 1, stdout: "", stderr: "Error: cannot write config\n" },
    ])
    const r = await upgradeAgent(agents.codex, exec)
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") expect(r.error).toContain("codex mcp add")
  })

  it("coerces numeric and boolean JSON env values to strings", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-bridge@0.0.1"],
            env: {
              CONSOLE_ORIGIN: "http://x",
              MCP_BRIDGE_PORT: 9345,
              DEBUG: true,
              BROKEN: null,
              NESTED: { a: 1 },
            },
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: { questdb: { env: Record<string, string> } }
    }
    expect(parsed.mcpServers.questdb.env).toEqual({
      CONSOLE_ORIGIN: "http://x",
      MCP_BRIDGE_PORT: "9345",
      DEBUG: "true",
    })
  })

  it("reads only OpenCode's `environment`, ignoring a stray `env` key", async () => {
    const path = tmpPath(
      "opencode.json",
      JSON.stringify({
        mcp: {
          questdb: {
            type: "local",
            command: ["npx", "-y", "@questdb/mcp-bridge@0.1.0"],
            env: { STALE: "inert-copy" },
            environment: { CONSOLE_ORIGIN: "http://live:9000" },
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.opencode, path))
    expect(r.kind).toBe("updated")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcp: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcp.questdb).toEqual({
      type: "local",
      command: ["npx", "-y", SPEC],
      environment: { CONSOLE_ORIGIN: "http://live:9000" },
      enabled: true,
    })
  })

  it("does not promote a stray `environment` key for env-based agents", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-bridge@0.1.0"],
            environment: { CONSOLE_ORIGIN: "http://inert" },
          },
        },
      }),
    )
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("updated")
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: { questdb: Record<string, unknown> }
    }
    expect(parsed.mcpServers.questdb).toEqual({
      command: "npx",
      args: ["-y", SPEC],
    })
  })

  it("is idempotent: the second run reports current", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({
        mcpServers: {
          questdb: { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.0.1"] },
        },
      }),
    )
    const agent = at(agents.claude, path)
    expect((await upgradeAgent(agent)).kind).toBe("updated")
    expect((await upgradeAgent(agent)).kind).toBe("current")
  })

  it("reports absent for a missing config (ENOENT)", async () => {
    const r = await upgradeAgent(at(agents.claude, tmpPath("nope.json")))
    expect(r.kind).toBe("absent")
  })

  it("reports absent when no questdb entry exists", async () => {
    const path = tmpPath(
      "config.json",
      JSON.stringify({ mcpServers: { other: { command: "foo" } } }),
    )
    expect((await upgradeAgent(at(agents.claude, path))).kind).toBe("absent")
  })

  it("reports failed (not absent) for a present-but-unreadable config", async () => {
    // A directory where a file is expected: it exists, so it's not ENOENT —
    // reading it fails (EISDIR). It must surface as a failure, never be
    // silently skipped as if the bridge spec weren't there.
    const dir = mkdtempSync(join(tmpdir(), "qdb-upgrade-"))
    expect((await upgradeAgent(at(agents.claude, dir))).kind).toBe("failed")
  })

  it("reports failed for an unparseable config and leaves it untouched", async () => {
    const raw = '{ "mcpServers": { "questdb": '
    const path = tmpPath("config.json", raw)
    const r = await upgradeAgent(at(agents.claude, path))
    expect(r.kind).toBe("failed")
    expect(readFileSync(path, "utf-8")).toBe(raw)
  })
})

// End-to-end against the real codex binary in a throwaway CODEX_HOME. Skipped
// where codex isn't installed (CI); the mocked tests above always run.
const hasCodex = ((): boolean => {
  try {
    execSync("codex --version", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasCodex)("upgradeAgent — real codex CLI", () => {
  it(
    "re-pins the questdb entry via codex mcp add, preserving env",
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qdb-codex-home-"))
      writeFileSync(
        join(dir, "config.toml"),
        '[mcp_servers.questdb]\ncommand = "npx"\nargs = ["-y", "@questdb/mcp-bridge@0.0.1"]\n\n' +
          '[mcp_servers.questdb.env]\nCONSOLE_ORIGIN = "http://localhost:9000"\n',
      )
      const prev = process.env.CODEX_HOME
      process.env.CODEX_HOME = dir
      try {
        const agent = {
          ...agents.codex,
          displayName: "Test Agent",
          configPaths: [join(dir, "config.toml")],
        }
        const r = await upgradeAgent(agent)
        expect(r.kind).toBe("updated")
        if (r.kind === "updated") expect(r.from).toBe("0.0.1")
        const content = readFileSync(join(dir, "config.toml"), "utf-8")
        expect(content).toContain(SPEC)
        expect(content).toContain("CONSOLE_ORIGIN")
        expect(content).toContain("http://localhost:9000")
        expect(content).not.toContain("0.0.1")
        // Second run round-trips codex's own output → current, no write.
        expect((await upgradeAgent(agent)).kind).toBe("current")
      } finally {
        if (prev === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = prev
      }
    },
  )
})
