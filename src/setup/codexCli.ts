import { execFile } from "node:child_process"

// Codex owns ~/.codex/config.toml — its schema, its formatting, its TOML
// quirks. Instead of parsing and rewriting that file ourselves, we delegate to
// the codex CLI: `codex mcp get --json` to read the entry and `codex mcp add`
// to PUT it (verified overwrite semantics; stdio adds trigger no OAuth probe,
// no network). Both commands validate the config before writing and exit
// nonzero on a broken file, so every failure surfaces as a clean error instead
// of a corrupt write.

const WINDOWS = process.platform === "win32"

// codex installs as a .cmd shim on Windows, which Node refuses to execFile
// without a shell; with a shell enabled, execFile does NOT quote args, so
// quote anything the shell would mangle. Percent signs must be doubled even
// inside quotes because cmd.exe expands %NAME% before launching the shim.
export const winQuote = (a: string): string =>
  /[\s"&|<>^%]/.test(a) ? `"${a.replace(/%/g, "%%").replace(/"/g, '\\"')}"` : a

export type ExecResult = { code: number; stdout: string; stderr: string }
// Injectable for tests; production always spawns the real `codex` binary with
// the inherited environment (so CODEX_HOME passes through).
export type ExecFn = (args: string[]) => Promise<ExecResult>

export const codexNotFoundError = (): Error =>
  Object.assign(
    new Error(
      "codex CLI not found on PATH — install Codex or update it, then re-run",
    ),
    { code: "codex-not-found" },
  )

export const isCodexNotFound = (err: unknown): boolean =>
  err instanceof Error &&
  (err as Error & { code?: string }).code === "codex-not-found"

export const execCodex: ExecFn = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "codex",
      WINDOWS ? args.map(winQuote) : args,
      { shell: WINDOWS, timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null
        if (e && e.code === "ENOENT") {
          reject(codexNotFoundError())
          return
        }
        if (e && typeof e.code !== "number") {
          // Timeout or spawn failure — there is no exit code to report.
          reject(new Error(`codex did not complete: ${e.message}`))
          return
        }
        const code = e === null ? 0 : typeof e.code === "number" ? e.code : 1
        // shell:true masks ENOENT on Windows: cmd.exe spawns fine and exits
        // 9009 ("'codex' is not recognized as an internal or external
        // command") when the binary is missing.
        if (WINDOWS && (code === 9009 || stderr.includes("is not recognized"))) {
          reject(codexNotFoundError())
          return
        }
        resolve({ code, stdout, stderr })
      },
    )
  })

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? ""

// JSON scalars carry over, coerced to strings — a hand-edited numeric port or
// boolean flag must survive the PUT; objects/arrays/null are dropped.
export const stringEnv = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  let out: Record<string, string> | undefined
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean"
    )
      (out ??= {})[k] = String(val)
  }
  return out
}

export type CodexServer = {
  command: string | null
  args: string[]
  env?: Record<string, string>
  text: string
}

// The configured `name` server as codex sees it, or null when absent.
// Absence is recognized by codex's error message; if a future codex rewords
// it, we fail loudly (kind "failed") rather than misreport absent — the safe
// direction. Throws on every other failure: binary missing, broken config,
// a codex too old to know `--json`.
export const getCodexServer = async (
  name: string,
  exec: ExecFn = execCodex,
): Promise<CodexServer | null> => {
  const r = await exec(["mcp", "get", name, "--json"])
  if (r.code !== 0) {
    const output = `${r.stderr}\n${r.stdout}`
    if (output.includes("No MCP server named")) return null
    throw new Error(
      `\`codex mcp get\` failed: ${firstLine(output) || `exit ${r.code}`}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    throw new Error(
      "unexpected `codex mcp get --json` output — update codex and re-run",
    )
  }
  const transport =
    parsed && typeof parsed === "object" && "transport" in parsed
      ? parsed.transport
      : parsed
  const t = (transport ?? {}) as Record<string, unknown>
  return {
    command: typeof t.command === "string" ? t.command : null,
    args: Array.isArray(t.args)
      ? t.args.filter((a): a is string => typeof a === "string")
      : [],
    env: stringEnv(t.env),
    text: JSON.stringify(transport ?? parsed),
  }
}

// PUT the entry as the global `name` server via `codex mcp add` (overwrites
// any existing entry). `entry` is our stdio shape: { command, args, env? }.
export const putCodexServer = async (
  name: string,
  entry: Record<string, unknown>,
  exec: ExecFn = execCodex,
): Promise<void> => {
  const { command } = entry
  if (typeof command !== "string") {
    throw new Error("codex entries must launch a command")
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : []
  const envFlags = Object.entries(
    (entry.env as Record<string, string> | undefined) ?? {},
  ).flatMap(([k, v]) => ["--env", `${k}=${v}`])
  const r = await exec(["mcp", "add", name, ...envFlags, "--", command, ...args])
  if (r.code !== 0) {
    throw new Error(
      `\`codex mcp add\` failed: ${firstLine(`${r.stderr}\n${r.stdout}`) || `exit ${r.code}`}`,
    )
  }
}

// True when what codex has configured already launches exactly what `entry`
// would — same command, args, and env — so an upgrade can report "current"
// without writing.
export const sameCodexEntry = (
  existing: CodexServer,
  entry: Record<string, unknown>,
): boolean => {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : []
  const env = (entry.env as Record<string, string> | undefined) ?? {}
  const existingEnv = existing.env ?? {}
  return (
    existing.command === entry.command &&
    existing.args.length === args.length &&
    existing.args.every((a, i) => a === args[i]) &&
    Object.keys(env).length === Object.keys(existingEnv).length &&
    Object.entries(env).every(([k, v]) => existingEnv[k] === v)
  )
}
