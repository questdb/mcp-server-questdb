import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

// Insert/replace our server while preserving the user's comments and formatting
// (handles both .json and .jsonc). `alreadyExists` distinguishes a fresh write
// from a reconfigure. Throws if the existing file is structurally invalid — a
// tolerant edit would emit still-broken JSON, so we leave it untouched and let
// the caller report a failure rather than a false success.
export const upsertJsonServer = (
  raw: string,
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): { content: string; alreadyExists: boolean } => {
  const source = raw.trim() === "" ? "{}" : raw
  const errors: ParseError[] = []
  const parsed = parse(source, errors, { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined
  if (errors.length > 0) {
    throw new Error("existing config is not valid JSON; left it untouched")
  }
  const section = parsed?.[configKey]
  const alreadyExists =
    typeof section === "object" && section !== null && serverName in section
  const edits = modify(source, [configKey, serverName], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const content = applyEdits(source, edits)
  return { content: content.endsWith("\n") ? content : content + "\n", alreadyExists }
}

// The server entry at configKey.serverName, or null when absent. A present
// but non-object value (a hand-broken entry) comes back as {} so the caller
// still sees "exists" and can overwrite it. Throws on invalid JSON — same
// contract as upsertJsonServer: never build on a file we can't parse.
export const getJsonServerEntry = (
  raw: string,
  configKey: string,
  serverName: string,
): Record<string, unknown> | null => {
  const source = raw.trim() === "" ? "{}" : raw
  const errors: ParseError[] = []
  const parsed = parse(source, errors, { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined
  if (errors.length > 0) {
    throw new Error("existing config is not valid JSON; left it untouched")
  }
  const section = parsed?.[configKey]
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return null
  }
  const entry = (section as Record<string, unknown>)[serverName]
  if (entry === undefined || entry === null) return null
  return typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : {}
}

export const readRawFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf-8")
  } catch {
    return ""
  }
}

// Like readRawFile, but distinguishes the two reasons a read can come up empty:
// a missing file (ENOENT → null; the agent simply isn't configured) versus a
// real read error (permissions, a directory in the path), which is rethrown so
// the caller can report a failure instead of silently skipping a config that
// may still pin the bridge.
export const readRawFileOrNull = async (
  filePath: string,
): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

export const writeRawFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf-8")
}
