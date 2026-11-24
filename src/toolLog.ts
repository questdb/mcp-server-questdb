import type { ToolResultPayload } from "./types.js"

// Long enough for a QuestDB error with its position, short enough for a log
// line. The full content is logged at DEBUG.
const MAX_REASON_CHARS = 500

// The log line for a tool's result: "ok", or why it failed.
export const toolResultSummary = (
  name: string,
  result: ToolResultPayload,
  elapsedMs: number,
): string => {
  const head = `tool_result: ${name} (${elapsedMs}ms)`
  if (result.isError !== true) return `${head} ok`
  const reason = result.content
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (reason === "") return `${head} failed`
  return reason.length > MAX_REASON_CHARS
    ? `${head} failed: ${reason.slice(0, MAX_REASON_CHARS)}…`
    : `${head} failed: ${reason}`
}
