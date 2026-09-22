import { createRequire } from "node:module"

// Baked in by the standalone bundle build (esbuild --define) — a single-file
// bundle has no package.json next to it to read. The tsc/npm build leaves it
// undefined and falls through to the require below.
declare const __BRIDGE_VERSION__: string | undefined

const BRIDGE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type ParsedBridgeVersion = {
  version: string
  major: number
  minor: number
  patch: number
}

// Bridge versions travel across a local trust boundary and are later rendered
// into package specs, filenames, and URLs. Bridge releases use exactly three
// numeric components: no whitespace, leading zeroes, prerelease identifiers,
// build metadata, path separators, or partial versions.
export const parseBridgeVersion = (
  version: unknown,
): ParsedBridgeVersion | null => {
  if (typeof version !== "string") return null
  const m = BRIDGE_VERSION_RE.exec(version)
  if (!m) return null
  return {
    version,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  }
}

export const requireBridgeVersion = (version: unknown): string => {
  if (typeof version === "string" && parseBridgeVersion(version)) return version
  throw new Error(
    "FATAL: bridge/package version must be canonical major.minor.patch. " +
      "This is a packaging bug — fail loudly so we never wire an unsafe version.",
  )
}

const readPackageVersion = (): string => {
  const require = createRequire(import.meta.url)
  const pkg = require("../package.json") as Record<string, unknown>
  return requireBridgeVersion(pkg.version)
}

export const MCP_BRIDGE_VERSION: string = requireBridgeVersion(
  typeof __BRIDGE_VERSION__ === "string"
    ? __BRIDGE_VERSION__
    : readPackageVersion(),
)

export const parseMajor = (version: unknown): number | null => {
  return parseBridgeVersion(version)?.major ?? null
}
