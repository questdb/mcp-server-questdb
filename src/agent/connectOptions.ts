import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { ENV_PORT_PIN, type PortPin } from "../bindWithRetry.js"
import { parsePort } from "../cli.js"
import {
  AGENT_PRESETS,
  customAgentLaunch,
  isAgentPresetId,
  type AgentChoice,
} from "./agentPresets.js"
import { defaultAgentWorkspace } from "./bridgeHome.js"

export const DEFAULT_CONSOLE_ORIGIN = "http://127.0.0.1:9000"
const DEFAULT_AGENT = "claude"
const DEFAULT_AGENT_NAME = "Custom agent"

export type ConnectOptions = {
  agent: AgentChoice
  workspace: string
  consoleOrigin: string
  // The console's address: its origin, and the path it is served under.
  consoleUrl: string
  // The fixed port, and the option or variable that fixed it.
  pinnedPort: { port: number; by: PortPin } | null
  openBrowser: boolean
}

export type ConnectOptionsResult =
  | { kind: "options"; options: ConnectOptions }
  | { kind: "help" }
  | { kind: "error"; error: string }

const PORT_OPTION_PIN: PortPin = { name: "--port", unpin: "leave out --port" }

const PRESET_IDS = Object.keys(AGENT_PRESETS)

// A path under the home folder, written the short way.
const tildePath = (path: string): string => {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path
}

// Option descriptions start in this column and wrap before this width.
const DESCRIPTION_COLUMN = 29
const LINE_WIDTH = 80

// `text` wrapped into the description column.
const describe = (text: string): string => {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (
      line &&
      DESCRIPTION_COLUMN + line.length + 1 + word.length > LINE_WIDTH
    ) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  lines.push(line)
  return lines.join(`\n${" ".repeat(DESCRIPTION_COLUMN)}`)
}

// The `connect` part of the help, for the main help and `connect --help`.
export const connectUsage = (launch: string): string =>
  `Chat with your coding agent in the QuestDB Web Console:
  ${launch} connect [console-url] [options]
      Run your coding agent for the Web Console at console-url.
      Default console-url: $CONSOLE_ORIGIN, or ${DEFAULT_CONSOLE_ORIGIN}

  Options:
    --agent <name>           ${describe(`Agent to run: ${PRESET_IDS.join(", ")}.`)}
                             Default: ${DEFAULT_AGENT}
    --workspace <dir>        Folder the agent works in.
                             Default: ${tildePath(defaultAgentWorkspace())}
    -h, --help               Print this help and exit

  Advanced:
    --agent-command "<cmd>"  Run another ACP agent instead of --agent
    --agent-name <name>      Name shown for that agent. Default: ${DEFAULT_AGENT_NAME}
    --port <n>               Fixed port for the console's connection.
                             Default: $MCP_BRIDGE_PORT, or a free one
    --no-open                Print the console link without opening it

The agent's own tools, like file edits and commands, run without asking.
Questions the agent asks you appear in the Web Console's chat.
`

// The Web Console's address from the URL the user gave, without its query,
// fragment or trailing slash; `source` names where it came from, for the
// error. A console can be served under a path, like https://host/questdb.
const consoleUrlOf = (
  raw: string,
  source: string,
): { origin: string; url: string } | { error: string } => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      error: `${source} '${raw}' is not a URL. Use the Web Console's address, like https://questdb.example.com.`,
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `${source} '${raw}' must start with http:// or https://.` }
  }
  const path = url.pathname.replace(/\/(index\.html)?$/, "")
  return { origin: url.origin, url: `${url.origin}${path}` }
}

const resolveAgentChoice = (
  agent: string,
  agentCommand: string | undefined,
  agentName: string,
): AgentChoice | string => {
  if (agentCommand) {
    return {
      kind: "custom",
      launch: customAgentLaunch(agentCommand, agentName),
    }
  }
  if (isAgentPresetId(agent)) return { kind: "preset", id: agent }
  return `unknown agent '${agent}'. Use one of: ${PRESET_IDS.join(", ")}`
}

export const parseConnectOptions = (
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ConnectOptionsResult => {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options: {
        agent: { type: "string", default: DEFAULT_AGENT },
        "agent-command": { type: "string" },
        "agent-name": { type: "string", default: DEFAULT_AGENT_NAME },
        workspace: { type: "string" },
        port: { type: "string" },
        "no-open": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const { values, positionals } = parsed
  if (values.help) return { kind: "help" }

  if (positionals.length > 1) {
    return {
      kind: "error",
      error: `connect takes one Web Console URL, but got ${positionals.length}: ${positionals.join(" ")}`,
    }
  }
  const consoleUrl =
    positionals[0] !== undefined
      ? consoleUrlOf(positionals[0], "The console URL")
      : env.CONSOLE_ORIGIN !== undefined
        ? consoleUrlOf(env.CONSOLE_ORIGIN, "CONSOLE_ORIGIN")
        : { origin: DEFAULT_CONSOLE_ORIGIN, url: DEFAULT_CONSOLE_ORIGIN }
  if ("error" in consoleUrl) return { kind: "error", error: consoleUrl.error }

  const agent = resolveAgentChoice(
    values.agent,
    values["agent-command"],
    values["agent-name"],
  )
  if (typeof agent === "string") return { kind: "error", error: agent }

  const port = parsePort(values.port ?? env.MCP_BRIDGE_PORT)
  if ("error" in port) return { kind: "error", error: port.error }

  return {
    kind: "options",
    options: {
      agent,
      workspace: values.workspace
        ? resolve(cwd, values.workspace)
        : defaultAgentWorkspace(),
      consoleOrigin: consoleUrl.origin,
      consoleUrl: consoleUrl.url,
      pinnedPort:
        "pinned" in port
          ? {
              port: port.pinned,
              by: values.port !== undefined ? PORT_OPTION_PIN : ENV_PORT_PIN,
            }
          : null,
      openBrowser: !values["no-open"],
    },
  }
}
