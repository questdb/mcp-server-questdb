import type * as acp from "@agentclientprotocol/sdk"

// The exact tool names agents give our MCP server's tools: Claude Code and Pi
// use `mcp__<server>__<tool>`, Codex `mcp.<server>.<tool>`.
const QUESTDB_TOOL_NAME =
  /^(mcp__questdb_console__|mcp\.questdb_console\.)[a-z_]+$/
const LOCAL_ACTION_KINDS = new Set(["execute", "edit", "delete", "move"])

// Only the structured tool name identifies a QuestDB tool. The title is free
// text the agent writes (often the command or file path), so it never counts.
export const isQuestdbToolCall = (toolCall: acp.ToolCallUpdate): boolean => {
  if (toolCall.kind && LOCAL_ACTION_KINDS.has(toolCall.kind)) return false
  const metaToolName = (
    toolCall._meta as { toolName?: unknown } | null | undefined
  )?.toolName
  return [toolCall.name, metaToolName].some(
    (name) => typeof name === "string" && QUESTDB_TOOL_NAME.test(name),
  )
}

const allowOptionOf = (
  request: acp.RequestPermissionRequest,
  preferredKind: "allow_always" | "allow_once",
): acp.RequestPermissionResponse | null => {
  const fallbackKind =
    preferredKind === "allow_always" ? "allow_once" : "allow_always"
  const option =
    request.options.find(({ kind }) => kind === preferredKind) ??
    request.options.find(({ kind }) => kind === fallbackKind)
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : null
}

// QuestDB tools are allowed for the whole session. The agent's own tools are
// allowed one call at a time, so the bridge never writes a lasting rule into
// the agent's own settings.
export const autoApprovalOf = (
  request: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse | null =>
  allowOptionOf(
    request,
    isQuestdbToolCall(request.toolCall) ? "allow_always" : "allow_once",
  )
