import { homedir } from "node:os"
import { join } from "node:path"

// Everything the agent mode keeps on disk lives under one folder:
//   agents/<id>-<version>/  pinned adapter installs
//   workspace/              the agents' default working folder
//   sessions.json           conversation → agent session map
export const bridgeHome = (): string =>
  process.env.QUESTDB_MCP_SERVER_HOME ??
  join(homedir(), ".questdb", "mcp-server")

export const agentInstallsDir = (): string => join(bridgeHome(), "agents")

export const defaultAgentWorkspace = (): string =>
  join(bridgeHome(), "workspace")

export const sessionStorePath = (): string =>
  join(bridgeHome(), "sessions.json")
