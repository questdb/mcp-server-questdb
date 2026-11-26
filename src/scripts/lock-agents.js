#!/usr/bin/env node
// Pins every ACP agent package with a full npm lockfile. The bridge installs an
// adapter from this manifest with `npm ci` on first use, so the user downloads
// exactly the audited dependency tree and nothing is resolved at runtime.
//
// Usage: node src/scripts/lock-agents.js
// Edit ADAPTERS to bump a version, then re-run and commit the result.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The Cursor preset runs the user's own Cursor CLI, so it is not pinned here.
const ADAPTERS = {
  claude: { name: "@agentclientprotocol/claude-agent-acp", version: "0.107.3" },
  codex: { name: "@agentclientprotocol/codex-acp", version: "2.7.0" },
  pi: { name: "@openma/pi-acp", version: "0.1.8" },
  gemini: { name: "@google/gemini-cli", version: "0.68.0" },
  copilot: { name: "@github/copilot", version: "1.0.113" },
  opencode: { name: "opencode-ai", version: "1.19.6" },
}

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, "../consts/agent-installs.json")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

// `npm audit` exits non-zero whenever it finds anything, so read its report
// from the failure as well.
const runAudit = (dir) => {
  try {
    return execFileSync(npm, ["audit", "--json"], { cwd: dir }).toString()
  } catch (err) {
    return err.stdout?.toString() ?? ""
  }
}

const lockAdapter = ({ name, version }) => {
  const dir = mkdtempSync(join(tmpdir(), "questdb-agent-lock-"))
  try {
    const packageJson = {
      name: "questdb-agent-adapter",
      private: true,
      dependencies: { [name]: version },
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson))
    execFileSync(
      npm,
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
    )
    const audit = JSON.parse(runAudit(dir) || "{}")
    const findings = audit.metadata?.vulnerabilities ?? {}
    if ((findings.high ?? 0) + (findings.critical ?? 0) > 0) {
      throw new Error(`${name}@${version} has high/critical advisories: ${JSON.stringify(findings)}`)
    }
    const packageLock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"))
    return { package: name, version, packageJson, packageLock }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const installs = Object.fromEntries(
  Object.entries(ADAPTERS).map(([id, adapter]) => [id, lockAdapter(adapter)]),
)
writeFileSync(target, `${JSON.stringify(installs, null, 2)}\n`)
console.log(`lock-agents: wrote ${target}`)
