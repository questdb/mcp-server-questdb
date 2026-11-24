import type * as acp from "@agentclientprotocol/sdk"
import type {
  AgentNoticeSeverity,
  AgentTokenUsage,
  AgentToolContent,
  AgentUpdate,
} from "../agentProtocol.js"
import { contentMarkdown } from "./agentContent.js"

const NOTICE_SEVERITIES: ReadonlySet<string> = new Set([
  "info",
  "warning",
  "error",
])

// What the console gets of each session update. Every kind ACP defines is
// listed: one added to ACP fails to compile here until it is handled or
// dropped on purpose.
export const toAgentUpdate = (
  update: acp.SessionUpdate,
): AgentUpdate | null => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentMarkdown(update.content)
      return text === null
        ? null
        : { kind: "message_chunk", messageId: update.messageId ?? null, text }
    }
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? { kind: "thought_chunk", text: update.content.text }
        : null
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        name: update.name ?? null,
        toolKind: update.kind ?? null,
        status: update.status ?? null,
        content: toolContentOf(update.content),
      }
    case "tool_call_update":
      return {
        kind: "tool_call_update",
        toolCallId: update.toolCallId,
        title: update.title ?? null,
        status: update.status ?? null,
        error: update.status === "failed" ? failureOf(update) : null,
        content: toolContentOf(update.content),
      }
    case "usage_update":
      // Agents report cost each their own way, some per model call, some
      // for the session, so only how full the context is goes on.
      return { kind: "usage", used: update.used, size: update.size }
    case "plan":
      return {
        kind: "plan",
        entries: update.entries.map(({ content, status }) => ({
          content,
          status,
        })),
      }
    case "notice":
      return {
        kind: "notice",
        severity: NOTICE_SEVERITIES.has(update.severity)
          ? (update.severity as AgentNoticeSeverity)
          : "info",
        title: update.title,
        description: update.description ?? null,
      }
    // Dropped on purpose:
    // - user_message_chunk: the user's own message, replayed when a session
    //   is reopened;
    // - config_option_update, current_mode_update: the console picks the
    //   model and effort, and the bridge keeps the agent's choices itself;
    // - available_commands_update: AgentChat keeps the commands for the
    //   console, for every session;
    // - session_info_update: not shown;
    // - compaction_update, compaction_summary_chunk: sent only to clients
    //   that advertise compaction support.
    case "user_message_chunk":
    case "config_option_update":
    case "current_mode_update":
    case "available_commands_update":
    case "session_info_update":
    case "compaction_update":
    case "compaction_summary_chunk":
      return null
    default: {
      const unhandled: never = update
      void unhandled
      return null
    }
  }
}

// A tool's output is shown up to this many characters; a diff whose texts
// are larger is named but not shown.
export const MAX_TOOL_OUTPUT_CHARS = 8_000
export const MAX_DIFF_CHARS = 200_000

// Some agents wrap a command's output in a markdown code fence; the chat
// shows it as output already.
const FENCED = /^(`{3,})[\w-]*\n([\s\S]*?)\n?\1\s*$/

const unfenced = (text: string): string => FENCED.exec(text)?.[2] ?? text

const cut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n…` : text

// What the chat shows of a call's content: its text and its diffs. A
// terminal's output lives in the agent, which runs its own commands. Null
// when the update carries no content, which leaves what the call showed.
const toolContentOf = (
  content: acp.ToolCallContent[] | null | undefined,
): AgentToolContent[] | null => {
  if (!content) return null
  const shown: AgentToolContent[] = []
  for (const item of content) {
    if (item.type === "diff") {
      const size = (item.oldText?.length ?? 0) + item.newText.length
      shown.push(
        size > MAX_DIFF_CHARS
          ? {
              type: "diff",
              path: item.path,
              oldText: null,
              newText: "",
              truncated: true,
            }
          : {
              type: "diff",
              path: item.path,
              oldText: item.oldText ?? null,
              newText: item.newText,
            },
      )
    } else if (item.type === "content" && item.content.type === "text") {
      const text = unfenced(item.content.text.trim())
      if (text)
        shown.push({ type: "text", text: cut(text, MAX_TOOL_OUTPUT_CHARS) })
    }
  }
  return shown
}

const FAILURE_LIMIT = 500

// What a failed tool call reported: its text output, else its raw output.
const failureOf = (update: acp.ToolCallUpdate): string | null => {
  const text = (update.content ?? [])
    .map((item) =>
      item.type === "content" && item.content.type === "text"
        ? item.content.text
        : "",
    )
    .join("\n")
    .trim()
  const raw =
    typeof update.rawOutput === "string"
      ? update.rawOutput
      : update.rawOutput == null
        ? ""
        : JSON.stringify(update.rawOutput)
  const failure = text || raw.trim()
  if (!failure) return null
  return failure.length > FAILURE_LIMIT
    ? `${failure.slice(0, FAILURE_LIMIT - 1)}…`
    : failure
}

type PromptResponseWithUsage = acp.PromptResponse & {
  usage?: { inputTokens?: unknown; outputTokens?: unknown } | null
}

export const toTokenUsage = (
  response: PromptResponseWithUsage,
): AgentTokenUsage | null => {
  const inputTokens = response.usage?.inputTokens
  const outputTokens = response.usage?.outputTokens
  return typeof inputTokens === "number" && typeof outputTokens === "number"
    ? { inputTokens, outputTokens }
    : null
}
