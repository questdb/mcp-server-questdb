import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import type { Log } from "../types.js"
import { agentInstallsDir } from "./bridgeHome.js"

// The standalone build replaces this identifier with the parsed manifest.
declare const __BUNDLED_AGENT_INSTALLS__: unknown

export type AgentInstall = {
  package: string
  version: string
  packageJson: Record<string, unknown>
  packageLock: Record<string, unknown>
}

type AgentInstalls = Record<string, AgentInstall>

const INSTALLED_MARKER = ".installed"

// Same split as bundledTools: the standalone bundle inlines the manifest, the
// npm build reads it from beside the compiled module.
const loadNpmAgentInstalls = (): unknown =>
  createRequire(import.meta.url)("../consts/agent-installs.json")

let agentInstalls: AgentInstalls | null = null

// Read on first use: the manifest is large, and only installing an agent
// needs it.
export const agentInstallOf = (id: string): AgentInstall => {
  agentInstalls ??= (
    typeof __BUNDLED_AGENT_INSTALLS__ !== "undefined"
      ? __BUNDLED_AGENT_INSTALLS__
      : loadNpmAgentInstalls()
  ) as AgentInstalls
  const install = agentInstalls[id]
  if (!install) throw new Error(`no pinned install for agent '${id}'`)
  return install
}

const installRoot = (id: string, install: AgentInstall): string =>
  join(agentInstallsDir(), `${id}-${install.version}`)

export const NPM_MISSING =
  "npm was not found. It comes with Node.js: install Node.js from " +
  "https://nodejs.org, then start the MCP server again."

// npm's own reason for a failed install, without its log boilerplate: the
// lines it marks as errors, less the bare code, syscall and errno lines.
export const npmFailureReason = (output: string): string => {
  const reasons = output
    .split(/\r?\n/)
    .map((line) => /^npm (?:ERR!|error)\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(
      (line) =>
        line !== "" &&
        !/^(code|syscall|errno|path|dest)\b/.test(line) &&
        !/complete log of this run/i.test(line),
    )
  const lastLine = output.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
  return [...new Set(reasons)].slice(0, 2).join(" ") || lastLine
}

const runNpmCi = (cwd: string, log: Log): Promise<void> =>
  new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32"
    const child = spawn(
      isWindows ? "npm.cmd" : "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
      { cwd, stdio: ["ignore", "pipe", "pipe"], shell: isWindows },
    )
    const output: string[] = []
    const collect = (chunk: Buffer) => output.push(chunk.toString("utf8"))
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.once("error", (err: Error & { code?: string }) => {
      reject(err.code === "ENOENT" ? new Error(NPM_MISSING) : err)
    })
    child.once("exit", (code) => {
      if (code === 0) return resolve()
      const text = output.join("")
      log("ERROR", `npm ci failed:\n${text}`)
      // cmd.exe, not npm, answers when npm.cmd is missing.
      if (isWindows && /is not recognized/i.test(text)) {
        return reject(new Error(NPM_MISSING))
      }
      reject(new Error(`npm could not install it: ${npmFailureReason(text)}`))
    })
  })

// The entry script an installed package declares as its executable; null
// when the install is missing it.
export const packageBinPath = async (
  root: string,
  packageName: string,
): Promise<string | null> => {
  const packageDir = join(root, "node_modules", packageName)
  let manifest: { bin?: string | Record<string, string> }
  try {
    manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    ) as typeof manifest
  } catch {
    return null
  }
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : Object.values(manifest.bin ?? {})[0]
  if (!bin) throw new Error(`${packageName} declares no executable`)
  const entry = join(packageDir, bin)
  return existsSync(entry) ? entry : null
}

export const isAgentInstalled = (id: string, install: AgentInstall): boolean =>
  existsSync(join(installRoot(id, install), INSTALLED_MARKER))

const isAlreadyThere = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM"
}

// Installs the pinned package once per version and returns its folder.
// Each MCP server installs into its own staging folder and moves it into
// place; when another one finished first, its complete install wins and is
// never touched, since a running agent may be loading modules from it. With
// `replace`, an install whose files are damaged is installed again.
export const ensureAgentInstalled = async (
  id: string,
  install: AgentInstall,
  log: Log,
  { replace = false }: { replace?: boolean } = {},
): Promise<string> => {
  const root = installRoot(id, install)
  if (replace || !isAgentInstalled(id, install)) {
    const staging = `${root}.staging-${process.pid}-${Date.now()}`
    await mkdir(staging, { recursive: true })
    try {
      await writeFile(
        join(staging, "package.json"),
        JSON.stringify(install.packageJson),
      )
      await writeFile(
        join(staging, "package-lock.json"),
        JSON.stringify(install.packageLock),
      )
      await runNpmCi(staging, log)
      await writeFile(join(staging, INSTALLED_MARKER), install.version)
      if (replace || !isAgentInstalled(id, install)) {
        // A root without the marker is an interrupted install; replace it.
        await rm(root, { recursive: true, force: true })
        await rename(staging, root).catch((err: unknown) => {
          if (!isAlreadyThere(err) || !isAgentInstalled(id, install)) throw err
        })
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return root
}
