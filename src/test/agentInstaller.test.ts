import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  agentInstallOf,
  ensureAgentInstalled,
  NPM_MISSING,
  npmFailureReason,
} from "../agent/agentInstaller.js"
import { resolveAgentLaunch } from "../agent/agentPresets.js"

const folders: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

const tempFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "agent-installer-"))
  folders.push(folder)
  return folder
}

// The MCP server's home in a temporary folder, with only `npm` from `bin` on
// the PATH, beside the system's own tools.
const isolate = (bin: string): void => {
  vi.stubEnv("QUESTDB_MCP_SERVER_HOME", tempFolder())
  vi.stubEnv("PATH", [bin, "/bin", "/usr/bin"].join(delimiter))
}

// An `npm` that runs `script` in the folder it installs into, and records
// each run in the returned file.
const fakeNpm = (script: string): { calls: () => string[] } => {
  const bin = tempFolder()
  const callsFile = join(bin, "calls")
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >> "${callsFile}"\n${script}\n`,
  )
  chmodSync(join(bin, "npm"), 0o755)
  isolate(bin)
  return {
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n")
        : [],
  }
}

const CLAUDE_PACKAGE = "node_modules/@agentclientprotocol/claude-agent-acp"

const INSTALLS_CLAUDE = [
  `mkdir -p ${CLAUDE_PACKAGE}/dist`,
  `printf '{"bin":{"claude-agent-acp":"dist/index.js"}}' > ${CLAUDE_PACKAGE}/package.json`,
  `printf '' > ${CLAUDE_PACKAGE}/dist/index.js`,
].join("\n")

const resolveClaude = (notify = vi.fn()) =>
  resolveAgentLaunch(
    { kind: "preset", id: "claude" },
    { log: () => undefined, notify },
  )

describe("npmFailureReason", () => {
  it("keeps npm's own reason, without its codes and log notice", () => {
    // Given
    const output = [
      "npm error code ENOTFOUND",
      "npm error syscall getaddrinfo",
      "npm error errno ENOTFOUND",
      "npm error network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "npm error network This is a problem related to network connectivity.",
      "npm error A complete log of this run can be found in: /tmp/npm.log",
    ].join("\n")

    // When
    const reason = npmFailureReason(output)

    // Then
    expect(reason).toBe(
      "network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org network This is a problem related to network connectivity.",
    )
  })

  it("falls back to the last line of output", () => {
    expect(npmFailureReason("something\nwent wrong\n")).toBe("went wrong")
  })
})

describe.skipIf(process.platform === "win32")("agent installs", () => {
  it("says that npm is missing, and where to get it", async () => {
    // Given a PATH without npm
    isolate(tempFolder())

    // When
    const installing = ensureAgentInstalled(
      "claude",
      agentInstallOf("claude"),
      () => undefined,
    )

    // Then
    await expect(installing).rejects.toThrow(NPM_MISSING)
  })

  it("says why npm could not install the agent", async () => {
    // Given an npm that cannot reach the registry
    fakeNpm(
      [
        `echo "npm error code E404" >&2`,
        `echo "npm error 404 Not Found - GET https://registry.npmjs.org/x - Not found" >&2`,
        "exit 1",
      ].join("\n"),
    )

    // When
    const installing = ensureAgentInstalled(
      "claude",
      agentInstallOf("claude"),
      () => undefined,
    )

    // Then
    await expect(installing).rejects.toThrow(
      "npm could not install it: 404 Not Found - GET https://registry.npmjs.org/x - Not found",
    )
  })

  it("installs an agent once, and tells the user while it does", async () => {
    // Given
    const npm = fakeNpm(INSTALLS_CLAUDE)
    const firstNotify = vi.fn()
    const secondNotify = vi.fn()

    // When the agent is started twice
    const first = await resolveClaude(firstNotify)
    const second = await resolveClaude(secondNotify)

    // Then
    expect(npm.calls()).toHaveLength(1)
    expect(firstNotify).toHaveBeenCalledWith(
      `Installing Claude Code (@agentclientprotocol/claude-agent-acp@${agentInstallOf("claude").version}). This runs once and can take a minute.`,
    )
    expect(secondNotify).not.toHaveBeenCalled()
    expect(second).toEqual(first)
  })

  it("installs an agent again when its files are missing", async () => {
    // Given an install whose entry script was deleted
    const npm = fakeNpm(INSTALLS_CLAUDE)
    const installed = await resolveClaude()
    const entry = installed.args[0]
    rmSync(entry)
    const notify = vi.fn()

    // When
    const resolved = await resolveClaude(notify)

    // Then
    expect(notify).toHaveBeenCalledWith(
      "Installing Claude Code again: some of its files are missing.",
    )
    expect(npm.calls()).toHaveLength(2)
    expect(resolved.args[0]).toBe(entry)
    expect(existsSync(entry)).toBe(true)
  })

  it("fails clearly when a fresh install still lacks the agent's program", async () => {
    // Given an npm that installs nothing
    fakeNpm("mkdir -p node_modules")

    // When
    const resolving = resolveClaude()

    // Then
    await expect(resolving).rejects.toThrow(
      "Claude Code was installed, but its program is missing.",
    )
  })
})
