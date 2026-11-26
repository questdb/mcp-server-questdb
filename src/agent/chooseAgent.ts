import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  AGENT_PRESETS,
  isAgentPresetId,
  type AgentPresetId,
} from "./agentPresets.js"
import { gray } from "../setup/banner.js"
import { lastAgentPath } from "./bridgeHome.js"

// `connect` without --agent asks which agent to run. Agents the user already
// uses come first, and the last choice is preselected, so it is one Enter.

// Folders an agent's own CLI creates on first use.
const signsOf = (
  id: AgentPresetId,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  switch (id) {
    case "claude":
      return [env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")]
    case "codex":
      return [env.CODEX_HOME ?? join(home, ".codex")]
    case "gemini":
      return [join(home, ".gemini")]
    case "copilot":
      return [join(home, ".copilot")]
    case "cursor":
      return [join(home, ".cursor")]
    case "opencode":
      return [
        join(home, ".config", "opencode"),
        join(home, ".local", "share", "opencode"),
      ]
    case "pi":
      return [join(home, ".pi")]
  }
}

export const installedAgents = (
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Set<AgentPresetId> =>
  new Set(
    (Object.keys(AGENT_PRESETS) as AgentPresetId[]).filter((id) =>
      signsOf(id, home, env).some((path) => existsSync(path)),
    ),
  )

export type AgentOption = {
  id: AgentPresetId
  label: string
  installed: boolean
}

// The agents in the order to offer them: the installed ones first,
// each group in the usual order. The default is the last choice, else the
// first installed agent.
export const agentOptionsOf = (
  found: Set<AgentPresetId>,
  last: AgentPresetId | null,
): { options: AgentOption[]; preselected: AgentPresetId | undefined } => {
  const ids = Object.keys(AGENT_PRESETS) as AgentPresetId[]
  const ordered = [
    ...ids.filter((id) => found.has(id)),
    ...ids.filter((id) => !found.has(id)),
  ]
  const options = ordered.map((id) => ({
    id,
    label: AGENT_PRESETS[id].label,
    installed: found.has(id),
  }))
  return {
    options,
    preselected: last ?? options.find((o) => o.installed)?.id,
  }
}

export const readLastAgent = async (
  path: string = lastAgentPath(),
): Promise<AgentPresetId | null> => {
  try {
    const id = (await readFile(path, "utf8")).trim()
    return isAgentPresetId(id) ? id : null
  } catch {
    return null
  }
}

export const writeLastAgent = async (
  id: AgentPresetId,
  path: string = lastAgentPath(),
): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${id}\n`)
  } catch {
    // Only a convenience: the next run asks without a preselection.
  }
}

export const NO_TTY_AGENT_ERROR = `connect cannot ask which agent to run here. Name it with --agent: ${Object.keys(
  AGENT_PRESETS,
).join(", ")}.`

// The question, for @inquirer/prompts' select.
export const agentQuestionOf = (
  found: Set<AgentPresetId>,
  last: AgentPresetId | null,
) => {
  const { options, preselected } = agentOptionsOf(found, last)
  return {
    message: "Select an agent to use in QuestDB Web Console",
    default: preselected,
    choices: options.map((option) => ({
      value: option.id,
      name: option.installed
        ? `${option.label}  ${gray("installed")}`
        : option.label,
      short: option.label,
    })),
  }
}

// Asks in the terminal. Rejects when the user cancels (Ctrl+C).
export const askForAgent = async (): Promise<AgentPresetId> => {
  const { select } = await import("@inquirer/prompts")
  return select<AgentPresetId>(
    agentQuestionOf(installedAgents(), await readLastAgent()),
  )
}
