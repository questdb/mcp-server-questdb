import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { BRIDGE_PACKAGE, bridgePackageForVersion } from "./bridgePackage.js"
import { MCP_BRIDGE_VERSION, requireBridgeVersion } from "./protocolVersion.js"

// Baked in by the standalone bundle build (esbuild --define). The tsc/npm
// build never defines it, so absence means "npm" — today's behavior exactly.
declare const __BRIDGE_DISTRIBUTION__: string | undefined

// How this running bridge was installed — NOT where it was downloaded from.
// "npm": launched via `npx <pkg>@<version>`. "standalone": a single-file
// bundle on disk, launched by absolute path; hosting (GitHub Release, internal
// mirror, MDM push) is irrelevant to the mechanism.
export type DistributionChannel = "npm" | "standalone"

export const DISTRIBUTION_CHANNEL: DistributionChannel =
  typeof __BRIDGE_DISTRIBUTION__ === "string" &&
  __BRIDGE_DISTRIBUTION__ === "standalone"
    ? "standalone"
    : "npm"

// Absolute path the user invoked. process.argv[1] preserves a stable symlink,
// unlike import.meta.url (which Node resolves to the real file). Source/npm
// imports use the module URL because they are not a standalone entry process.
// `channel`/`argv1` are parameters (not the module globals) so the value is
// honored consistently when a caller resolves a specific channel, and so tests
// can pin a real bundle path instead of the test runner's own entry.
export const selfPath = (
  channel: DistributionChannel = DISTRIBUTION_CHANNEL,
  argv1: string | undefined = process.argv[1],
): string =>
  channel === "standalone" && argv1
    ? resolve(argv1)
    : fileURLToPath(import.meta.url)

// Quote a filesystem path for a shell command rendered into user- and
// agent-facing text (never executed by us). POSIX single-quoting neutralizes
// $, backtick, spaces and the rest; Windows uses the same double-quote +
// %-doubling scheme as codex config writing (setup/codexCli winQuote), since a
// standalone user runs the rendered command on the same platform as the bridge.
export const commandArg = (value: string): string =>
  process.platform === "win32"
    ? `"${value.replace(/%/g, "%%").replace(/"/g, '\\"')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`

export type LaunchSpec = { command: string; args: string[] }

// The command agent configs should launch the bridge with. Standalone uses
// PATH-resolved "node" pointing at the bundle file: the npm channel's `npx`
// already relies on PATH resolution in every supported agent, and — unlike
// process.execPath — "node" survives Node upgrades (execPath pins a
// version-specific path on Homebrew/nvm installs) and works on Windows.
export const launchSpec = (
  channel: DistributionChannel = DISTRIBUTION_CHANNEL,
): LaunchSpec =>
  channel === "standalone"
    ? { command: "node", args: [selfPath(channel)] }
    : {
        command: "npx",
        args: ["-y", `${BRIDGE_PACKAGE}@${MCP_BRIDGE_VERSION}`],
      }

// Standalone bundles are published as GitHub Release assets under a
// deterministic URL, so runtime messages can render a full download
// instruction for any version.
export const bundleDownloadUrl = (version: string): string => {
  const v = encodeURIComponent(requireBridgeVersion(version))
  return `https://github.com/questdb/mcp-server-questdb/releases/download/v${v}/mcp-server-questdb-${v}.mjs`
}

export const bundleFileName = (version: string): string =>
  `mcp-server-questdb-${requireBridgeVersion(version)}.mjs`

// Matching bundles are kept beside the current standalone install. This gives
// upgrade guidance an exact, durable absolute path instead of assuming a cwd or
// pinning an agent config to an incidental downloads directory.
export const bundleInstallPath = (
  version: string,
  channel: DistributionChannel = DISTRIBUTION_CHANNEL,
): string => join(dirname(selfPath(channel)), bundleFileName(version))

// The exact setup command for this channel, pinned to `version` — rendered
// into user-facing guidance (a standalone user cannot run npx, so every
// instruction must match how they installed).
export const setupCommand = (
  version: string = MCP_BRIDGE_VERSION,
  channel: DistributionChannel = DISTRIBUTION_CHANNEL,
): string => {
  const target = requireBridgeVersion(version)
  return channel === "standalone"
    ? `node ${commandArg(
        target === MCP_BRIDGE_VERSION
          ? selfPath(channel)
          : bundleInstallPath(target, channel),
      )} setup`
    : `npx ${bridgePackageForVersion(target)}@${target} setup`
}

// A standalone release asset exists for any canonical version, so availability
// reduces to accepting the same canonical version format used at the protocol
// boundary.
export const hasStandaloneBundle = (version: string): boolean => {
  try {
    requireBridgeVersion(version)
    return true
  } catch {
    return false
  }
}
