import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { Log } from "../types.js"
import { spawnCommandOf } from "./acpAgentProcess.js"
import {
  agentInstallOf,
  ensureAgentInstalled,
  isAgentInstalled,
  packageBinPath,
  type AgentInstall,
} from "./agentInstaller.js"

export type AgentLaunch = {
  id: string
  label: string
  command: string
  args: string[]
  env: Record<string, string>
  // The ACP auth method the bridge calls before the first session, for agents
  // that need one even when their own CLI is signed in.
  authMethodId?: string
  // Runs a separate agent process for each conversation, for agents that
  // share the MCP servers of all their sessions.
  processPerConversation?: boolean
  // Runs the command through the shell, for Windows .cmd launchers.
  shell?: boolean
}

// How a preset's agent is started:
// node    — the pinned npm package's entry script, run with the bridge's Node.js
// native  — a platform binary that the pinned npm package installs
// system  — the agent's own CLI, installed by the user
type AgentSource =
  | { kind: "node"; args: string[] }
  | { kind: "native"; binary: () => string[]; args: string[] }
  | {
      kind: "system"
      commands: () => string[]
      args: string[]
      install: string
      // Run before the agent starts: a CLI too old for ACP fails it.
      check: CliCheck
    }

// A command whose output shows that the user's CLI can run as an ACP agent.
type CliCheck = { args: string[]; accepts: RegExp; otherwise: string }

type AgentPreset = {
  label: string
  // Extra environment for the agent, on top of the bridge's own.
  env: Record<string, string>
  source: AgentSource
  authMethodId?: string
  processPerConversation?: boolean
}

const isWindows = process.platform === "win32"

// OpenCode publishes one package per platform; some have a baseline build for
// CPUs without AVX2, and Linux has musl builds.
const openCodeBinaries = (): string[] => {
  const platform = isWindows ? "windows" : process.platform
  const arch = process.arch
  const isMusl =
    process.platform === "linux" &&
    !(
      process.report?.getReport() as {
        header?: { glibcVersionRuntime?: string }
      }
    )?.header?.glibcVersionRuntime
  const base = `opencode-${platform}-${arch}`
  const names = isMusl
    ? [`${base}-musl`, `${base}-baseline-musl`]
    : [base, `${base}-baseline`]
  const binary = isWindows ? "opencode.exe" : "opencode"
  return names.map((name) => join(name, "bin", binary))
}

// The Cursor installer puts `cursor-agent` (and the alias `agent`) into
// ~/.local/bin, which is not always on the PATH of a GUI or service.
const cursorCommands = (): string[] => {
  const names = isWindows
    ? ["cursor-agent.exe", "cursor-agent.cmd"]
    : ["cursor-agent"]
  const local = join(homedir(), ".local", "bin")
  const dirs = [...(process.env.PATH ?? "").split(delimiter), local]
  return [
    ...dirs.flatMap((dir) => names.map((name) => join(dir, name))),
    join(local, isWindows ? "agent.exe" : "agent"),
  ]
}

export const AGENT_PRESETS = {
  claude: { label: "Claude Code", env: {}, source: { kind: "node", args: [] } },
  codex: { label: "Codex", env: {}, source: { kind: "node", args: [] } },
  gemini: {
    label: "Gemini CLI",
    env: {},
    source: { kind: "node", args: ["--acp"] },
  },
  copilot: {
    label: "GitHub Copilot",
    env: {},
    source: { kind: "node", args: ["--acp"] },
  },
  cursor: {
    label: "Cursor",
    env: {},
    source: {
      kind: "system",
      commands: cursorCommands,
      args: ["acp"],
      install:
        "Install the Cursor CLI (https://cursor.com/cli) and sign in with `cursor-agent login`, then run the connect command again.",
      // `acp` is hidden from the CLI's command list, and versions before
      // March 2026 do not have it; `help acp` prints its usage when they do.
      check: {
        args: ["help", "acp"],
        accepts: /^Usage: \S+ acp\b/m,
        otherwise:
          "Your Cursor CLI is too old to work with the QuestDB Web Console. Update it with `cursor-agent update`, then run the connect command again.",
      },
    },
    authMethodId: "cursor_login",
  },
  opencode: {
    label: "OpenCode",
    env: {},
    source: { kind: "native", binary: openCodeBinaries, args: ["acp"] },
    processPerConversation: true,
  },

  pi: {
    label: "Pi",
    env: { PI_ACP_QUIET_STARTUP: "1" },
    source: { kind: "node", args: [] },
  },
} as const satisfies Record<string, AgentPreset>

export type AgentPresetId = keyof typeof AGENT_PRESETS

export const isAgentPresetId = (value: string): value is AgentPresetId =>
  Object.hasOwn(AGENT_PRESETS, value)

export type AgentChoice =
  | { kind: "preset"; id: AgentPresetId }
  | { kind: "custom"; launch: AgentLaunch }

export const customAgentLaunch = (
  commandLine: string,
  label: string,
): AgentLaunch => {
  const [command, ...args] = commandLine.trim().split(/\s+/)
  return { id: "custom", label, command, args, env: {} }
}

const firstExisting = (paths: string[]): string | null =>
  paths.find((path) => existsSync(path)) ?? null

// What resolving a preset tells the user, like that it installs the agent.
export type ResolveContext = { log: Log; notify: (line: string) => void }

type Command = { command: string; args: string[] }

const CHECK_TIMEOUT_MS = 15_000

// A check that cannot run does not block the agent: it is logged, and the
// agent's own start reports a real problem.
const runCliCheck = (command: string, check: CliCheck, log: Log) =>
  new Promise<void>((resolve, reject) => {
    const shell = isWindows && command.endsWith(".cmd")
    execFile(
      spawnCommandOf({ command, shell }),
      check.args,
      { timeout: CHECK_TIMEOUT_MS, shell, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          log("WARN", `could not check ${command}: ${err.message}`)
          return resolve()
        }
        if (check.accepts.test(`${stdout}${stderr}`)) return resolve()
        reject(new Error(check.otherwise))
      },
    )
  })

// The platform builds a native package ships, by their path under
// node_modules; empty when it has none for this platform.
const platformBinariesOf = (
  install: AgentInstall,
  binaries: string[],
): string[] => {
  const packages = (install.packageLock.packages ?? {}) as Record<
    string,
    unknown
  >
  return binaries.filter(
    (binary) => `node_modules/${binary.split(/[\\/]/)[0]}` in packages,
  )
}

// The command an install runs; null when its files are missing.
const installedCommandOf = async (
  id: AgentPresetId,
  source: Extract<AgentSource, { kind: "node" | "native" }>,
  root: string,
): Promise<Command | null> => {
  if (source.kind === "native") {
    const binaries = platformBinariesOf(agentInstallOf(id), source.binary())
    const command = firstExisting(
      binaries.map((binary) => join(root, "node_modules", binary)),
    )
    return command ? { command, args: source.args } : null
  }
  // A preset runs its pinned package with the MCP server's own Node.js, so
  // no shell, `npx` or registry lookup is involved once it is installed.
  const entry = await packageBinPath(root, agentInstallOf(id).package)
  return entry
    ? { command: process.execPath, args: [entry, ...source.args] }
    : null
}

const installedCommand = async (
  id: AgentPresetId,
  source: Extract<AgentSource, { kind: "node" | "native" }>,
  { log, notify }: ResolveContext,
): Promise<Command> => {
  const { label } = AGENT_PRESETS[id]
  const install = agentInstallOf(id)
  if (
    source.kind === "native" &&
    platformBinariesOf(install, source.binary()).length === 0
  ) {
    throw new Error(
      `${label} has no build for ${process.platform}-${process.arch}.`,
    )
  }
  if (!isAgentInstalled(id, install)) {
    notify(
      `Installing ${label} (${install.package}@${install.version}). This runs once and can take a minute.`,
    )
  }
  const root = await ensureAgentInstalled(id, install, log)
  const command = await installedCommandOf(id, source, root)
  if (command) return command
  log("WARN", `the install of ${label} in ${root} is missing files`)
  notify(`Installing ${label} again: some of its files are missing.`)
  await ensureAgentInstalled(id, install, log, { replace: true })
  const reinstalled = await installedCommandOf(id, source, root)
  if (!reinstalled) {
    throw new Error(`${label} was installed, but its program is missing.`)
  }
  return reinstalled
}

const commandFor = async (
  id: AgentPresetId,
  source: AgentSource,
  context: ResolveContext,
): Promise<Command> => {
  if (source.kind !== "system") return installedCommand(id, source, context)
  const command = firstExisting(source.commands())
  if (!command) throw new Error(source.install)
  await runCliCheck(command, source.check, context.log)
  return { command, args: source.args }
}

export const resolveAgentLaunch = async (
  choice: AgentChoice,
  context: ResolveContext,
): Promise<AgentLaunch> => {
  if (choice.kind === "custom") return choice.launch
  const preset: AgentPreset = AGENT_PRESETS[choice.id]
  const { command, args } = await commandFor(choice.id, preset.source, context)
  return {
    id: choice.id,
    label: preset.label,
    command,
    args,
    env: preset.env,
    ...(preset.authMethodId && { authMethodId: preset.authMethodId }),
    ...(preset.processPerConversation && { processPerConversation: true }),
    ...(isWindows && command.endsWith(".cmd") && { shell: true }),
  }
}
