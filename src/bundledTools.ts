import { createRequire } from "node:module"
import type { ToolSchema } from "./types.js"

// The standalone build replaces this identifier with the parsed JSON object,
// letting esbuild inline it. The npm build keeps createRequire, avoiding
// ExperimentalWarning on supported Node 22.0–22.11.
declare const __BUNDLED_SHARED_DEFINITIONS__: unknown
// esbuild --define replaces this with "standalone" in the bundle. Its absence
// (the tsc/npm build) means "npm".
declare const __BRIDGE_DISTRIBUTION__: string | undefined

type SharedDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  category?: string
  mutatesNotebook?: boolean
  surfaces?: ("ai" | "mcp")[]
}

// A relative require from beside a downloaded single-file bundle is a
// supply-chain hazard (it would load whatever ./consts/shared-definitions.json
// happens to sit next to the bundle). Isolate it in its own binding, reached
// only on the npm channel, so esbuild tree-shakes the require out of the
// standalone bundle entirely instead of leaving it as dead-by-emit-order code.
// The `typeof` guard keeps the bare identifier from throwing ReferenceError
// under plain tsc/Node, where neither define is substituted.
const loadNpmSharedDefinitions = (): unknown =>
  createRequire(import.meta.url)("./consts/shared-definitions.json")

const sharedDefinitions = (
  typeof __BUNDLED_SHARED_DEFINITIONS__ !== "undefined"
    ? __BUNDLED_SHARED_DEFINITIONS__
    : typeof __BRIDGE_DISTRIBUTION__ !== "undefined" &&
        __BRIDGE_DISTRIBUTION__ === "standalone"
      ? (() => {
          throw new Error(
            "standalone bundle is missing its inlined tool definitions",
          )
        })()
      : loadNpmSharedDefinitions()
) as SharedDefinition[]

const isMcpSurfaced = (def: SharedDefinition): boolean =>
  !def.surfaces || def.surfaces.includes("mcp")

export const BUNDLED_FUNCTIONAL_TOOLS: ToolSchema[] = sharedDefinitions
  .filter(isMcpSurfaced)
  .map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }))

export const BUNDLED_TOOL_NAMES = new Set(
  BUNDLED_FUNCTIONAL_TOOLS.map((t) => t.name),
)
