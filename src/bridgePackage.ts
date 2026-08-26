// Published as @questdb/mcp-bridge before 0.3.0; every release since is
// dual-published under both names so commands baked into shipped consoles
// keep resolving.
import { parseBridgeVersion } from "./protocolVersion.js"

export const BRIDGE_PACKAGE = "@questdb/mcp-server-questdb"
export const LEGACY_BRIDGE_PACKAGE = "@questdb/mcp-bridge"

const isPreRenameVersion = (version: string): boolean => {
  const parsed = parseBridgeVersion(version)
  return parsed !== null && parsed.major === 0 && parsed.minor < 3
}

// Versions below 0.3.0 exist only under the legacy name, so a rendered
// command must use it — `npx @questdb/mcp-server-questdb@0.2.0` does not
// resolve on npm.
export const bridgePackageForVersion = (version: string): string =>
  isPreRenameVersion(version) ? LEGACY_BRIDGE_PACKAGE : BRIDGE_PACKAGE
