import { describe, expect, it } from "vitest"
import {
  codexNotFoundError,
  getCodexServer,
  isCodexNotFound,
  putCodexServer,
  sameCodexEntry,
  stringEnv,
  winQuote,
  type ExecFn,
  type ExecResult,
} from "../setup/codexCli.js"

const fakeExec = (
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

// The exact shape codex 0.137 prints for `mcp get questdb --json`.
const GET_JSON = JSON.stringify({
  name: "questdb",
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@questdb/mcp-bridge@0.1.0"],
    env: { CONSOLE_ORIGIN: "http://x" },
    env_vars: [],
    cwd: null,
  },
  startup_timeout_sec: null,
})

describe("getCodexServer", () => {
  it("parses command, args, env, and keeps the transport text for reporting", async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: GET_JSON, stderr: "" }])
    const server = await getCodexServer("questdb", exec)
    expect(calls[0]).toEqual(["mcp", "get", "questdb", "--json"])
    expect(server).not.toBeNull()
    expect(server?.command).toBe("npx")
    expect(server?.args).toEqual(["-y", "@questdb/mcp-bridge@0.1.0"])
    expect(server?.env).toEqual({ CONSOLE_ORIGIN: "http://x" })
    expect(server?.text).toContain("@questdb/mcp-bridge@0.1.0")
  })

  it("returns null for codex's missing-server error", async () => {
    const { exec } = fakeExec([
      {
        code: 1,
        stdout: "",
        stderr: "Error: No MCP server named 'questdb' found.\n",
      },
    ])
    expect(await getCodexServer("questdb", exec)).toBeNull()
  })

  it("throws on any other nonzero exit, quoting codex's first error line", async () => {
    const { exec } = fakeExec([
      {
        code: 1,
        stdout: "",
        stderr:
          "Error: failed to load configuration\n\nCaused by:\n  bad toml\n",
      },
    ])
    await expect(getCodexServer("questdb", exec)).rejects.toThrow(
      "failed to load configuration",
    )
  })

  it("throws on unparseable output (a codex too old for --json)", async () => {
    const { exec } = fakeExec([
      { code: 0, stdout: "questdb\n  command: npx\n", stderr: "" },
    ])
    await expect(getCodexServer("questdb", exec)).rejects.toThrow(
      "update codex",
    )
  })
})

describe("putCodexServer", () => {
  it("builds the add argv: env flags, then `--`, then the launch command", async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: "Added\n", stderr: "" }])
    await putCodexServer(
      "questdb",
      {
        command: "npx",
        args: ["-y", "@questdb/mcp-bridge@0.2.0"],
        env: { CONSOLE_ORIGIN: "http://x", MCP_BRIDGE_PORT: "9009" },
      },
      exec,
    )
    expect(calls[0]).toEqual([
      "mcp",
      "add",
      "questdb",
      "--env",
      "CONSOLE_ORIGIN=http://x",
      "--env",
      "MCP_BRIDGE_PORT=9009",
      "--",
      "npx",
      "-y",
      "@questdb/mcp-bridge@0.2.0",
    ])
  })

  it("omits env flags when the entry has no env", async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: "Added\n", stderr: "" }])
    await putCodexServer(
      "questdb",
      { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.2.0"] },
      exec,
    )
    expect(calls[0]).toEqual([
      "mcp",
      "add",
      "questdb",
      "--",
      "npx",
      "-y",
      "@questdb/mcp-bridge@0.2.0",
    ])
  })

  it("throws when codex refuses the add", async () => {
    const { exec } = fakeExec([
      { code: 1, stdout: "", stderr: "Error: invalid server name\n" },
    ])
    await expect(
      putCodexServer("questdb", { command: "npx", args: [] }, exec),
    ).rejects.toThrow("codex mcp add")
  })
})

describe("isCodexNotFound", () => {
  it("recognizes the marker error by code, not message", () => {
    expect(isCodexNotFound(codexNotFoundError())).toBe(true)
    expect(isCodexNotFound(new Error("codex CLI not found on PATH"))).toBe(
      false,
    )
    expect(isCodexNotFound(null)).toBe(false)
  })
})

describe("winQuote", () => {
  it("doubles percent signs so cmd.exe does not expand env references", () => {
    expect(winQuote("LOG_PATH=%TEMP%\\bridge.log")).toBe(
      '"LOG_PATH=%%TEMP%%\\bridge.log"',
    )
  })

  it("leaves simple args unquoted", () => {
    expect(winQuote("questdb")).toBe("questdb")
  })
})

describe("sameCodexEntry", () => {
  const existing = {
    command: "npx",
    args: ["-y", "@questdb/mcp-bridge@0.2.0"],
    env: { CONSOLE_ORIGIN: "http://x" },
    text: "",
  }

  it("matches an identical launch spec", () => {
    expect(
      sameCodexEntry(existing, {
        command: "npx",
        args: ["-y", "@questdb/mcp-bridge@0.2.0"],
        env: { CONSOLE_ORIGIN: "http://x" },
      }),
    ).toBe(true)
  })

  it("treats missing env and empty env as equal", () => {
    expect(
      sameCodexEntry(
        { ...existing, env: undefined },
        { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.2.0"] },
      ),
    ).toBe(true)
  })

  it.each([
    [
      "different spec",
      { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.1.0"], env: { CONSOLE_ORIGIN: "http://x" } },
    ],
    ["different command", { command: "node", args: ["-y", "@questdb/mcp-bridge@0.2.0"], env: { CONSOLE_ORIGIN: "http://x" } }],
    ["different env", { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.2.0"], env: { CONSOLE_ORIGIN: "http://y" } }],
    ["missing env", { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.2.0"] }],
  ])("rejects a %s", (_label, entry) => {
    expect(sameCodexEntry(existing, entry)).toBe(false)
  })
})

describe("stringEnv", () => {
  it("keeps strings and coerces scalars, dropping everything else", () => {
    expect(
      stringEnv({ A: "x", B: 9, C: true, D: null, E: { a: 1 }, F: [1] }),
    ).toEqual({ A: "x", B: "9", C: "true" })
  })

  it("returns undefined for empty or non-object input", () => {
    expect(stringEnv({})).toBeUndefined()
    expect(stringEnv(null)).toBeUndefined()
    expect(stringEnv("env")).toBeUndefined()
  })
})
