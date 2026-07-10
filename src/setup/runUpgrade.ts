import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import {
  BRIDGE_PACKAGE,
  buildAgents,
  SERVER_NAME,
  type AgentConfig,
} from "./agents.js"
import { resolveConfigPath } from "./applyConfig.js"
import {
  execCodex,
  getCodexServer,
  putCodexServer,
  sameCodexEntry,
  stringEnv,
  type CodexServer,
  type ExecFn,
} from "./codexCli.js"
import {
  getJsonServerEntry,
  readRawFileOrNull,
  upsertJsonServer,
  writeRawFile,
} from "./configWriter.js"

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Best-effort description of what the old entry launched, for the report line:
// the pinned spec when one is present ("0.1.0", "^0.1.0", even a corrupted
// "0.2.0@^0.1.0"), "unpinned" when the package appears without a version (bare
// npx spec, node_modules path of a global install), null when the entry never
// references the bridge at all.
export const describeOldPin = (entryText: string): string | null => {
  const m = new RegExp(`${escapeRe(BRIDGE_PACKAGE)}@([^\\s"'\\]]+)`).exec(
    entryText,
  )
  if (m) return m[1]
  return entryText.includes(BRIDGE_PACKAGE) ? "unpinned" : null
}

type ExistingEntry = { text: string; env?: Record<string, string> }

// The current `questdb` entry of a JSON-format agent, or null when the agent
// doesn't have one. Throws when the config can't be parsed — a PUT on top of
// a broken file would emit broken output, so the caller reports a failure
// instead.
const readExistingEntry = (
  raw: string,
  agent: AgentConfig,
): ExistingEntry | null => {
  const entry = getJsonServerEntry(raw, agent.configKey, SERVER_NAME)
  if (entry === null) return null
  // Read only the key this agent honors (agents.ts envKey) — a stray inert
  // `env`/`environment` must not shadow or activate the live one.
  return {
    text: JSON.stringify(entry),
    env: stringEnv(entry[agent.envKey]),
  }
}

type AgentOutcome =
  | { agent: string; kind: "updated"; from: string | null; path: string }
  | { agent: string; kind: "current"; path: string }
  | { agent: string; kind: "absent" }
  | { agent: string; kind: "failed"; path: string; error: string }

// Codex path: same PUT semantics, but read and write go through the codex CLI
// (`mcp get --json` / `mcp add`), which owns config.toml and validates it
// before writing. Every CLI failure — binary missing, broken config, codex
// too old for `--json` — surfaces as "failed", never a blind write.
const upgradeCodexAgent = async (
  agent: AgentConfig,
  exec: ExecFn,
): Promise<AgentOutcome> => {
  const path = await resolveConfigPath(agent.configPaths)
  let existing: CodexServer | null
  try {
    existing = await getCodexServer(SERVER_NAME, exec)
  } catch (err) {
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (existing === null) return { agent: agent.displayName, kind: "absent" }

  const entry = agent.buildEntry(existing.env ?? {})
  if (sameCodexEntry(existing, entry))
    return { agent: agent.displayName, kind: "current", path }
  try {
    await putCodexServer(SERVER_NAME, entry, exec)
  } catch (err) {
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    agent: agent.displayName,
    kind: "updated",
    from: describeOldPin(existing.text),
    path,
  }
}

// PUT semantics: the `questdb` server entry is wholly ours. When one exists,
// it is replaced with the exact entry setup would write today — pinned to this
// CLI's version — no matter what launched it before (range pins, corrupted
// specs, node_modules paths). Only the env block carries over: setup selected
// it, and users hand-add debug vars there. Everything else in the config file,
// including bridge references outside the `questdb` entry, is not ours to
// touch.
export const upgradeAgent = async (
  agent: AgentConfig,
  codexExec: ExecFn = execCodex,
): Promise<AgentOutcome> => {
  if (agent.format === "codex-cli") return upgradeCodexAgent(agent, codexExec)

  const path = await resolveConfigPath(agent.configPaths)
  let raw: string | null
  try {
    raw = await readRawFileOrNull(path)
  } catch (err) {
    // The file exists but couldn't be read (permissions, a directory in the
    // path). It may still pin the bridge, so surface a failure rather than
    // silently skipping it and exiting 0.
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (raw === null) return { agent: agent.displayName, kind: "absent" }

  let existing: ExistingEntry | null
  try {
    existing = readExistingEntry(raw, agent)
  } catch (err) {
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (existing === null) return { agent: agent.displayName, kind: "absent" }

  const entry = agent.buildEntry(existing.env ?? {})
  const { content } = upsertJsonServer(
    raw,
    agent.configKey,
    SERVER_NAME,
    entry,
  )
  if (content === raw)
    return { agent: agent.displayName, kind: "current", path }
  try {
    await writeRawFile(path, content)
  } catch (err) {
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    agent: agent.displayName,
    kind: "updated",
    from: describeOldPin(existing.text),
    path,
  }
}

export const runUpgrade = async (): Promise<number> => {
  const target = MCP_BRIDGE_VERSION
  const agents = buildAgents()
  console.log(
    `@questdb/mcp-bridge upgrade — pinning coding-agent configs to v${target}\n`,
  )

  const reported: string[] = []
  let changed = 0
  let failed = 0
  for (const agent of Object.values(agents)) {
    const r = await upgradeAgent(agent)
    if (r.kind === "updated") {
      reported.push(
        r.from !== null
          ? `  ✓ ${r.agent}: ${r.from} → ${target}  (${r.path})`
          : `  ✓ ${r.agent}: replaced existing "questdb" entry → ${target}  (${r.path})`,
      )
      changed++
    } else if (r.kind === "current") {
      reported.push(`  • ${r.agent}: already v${target}`)
    } else if (r.kind === "failed") {
      reported.push(`  ✗ ${r.agent}: ${r.error}  (${r.path})`)
      failed++
    }
    // "absent" agents (no `questdb` server entry) stay silent.
  }

  if (reported.length === 0) {
    console.log(
      `  No coding-agent config has a "questdb" MCP server.\n` +
        `  Run \`npx @questdb/mcp-bridge@${target} setup\` to configure one.`,
    )
  } else {
    console.log(reported.join("\n"))
  }
  if (changed > 0) {
    console.log(
      `\nRestart your coding agent (or reload its MCP servers) so v${target} launches.`,
    )
  }
  return failed > 0 ? 1 : 0
}
