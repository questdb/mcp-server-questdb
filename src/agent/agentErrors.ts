import type { AgentLaunch } from "./agentPresets.js"

const AUTH_REQUIRED_CODE = -32000

// How to sign in, as a command the user runs in a terminal; npx runs it even
// without the agent's own CLI installed. The agent picks the sign-in up on
// the next message (see AgentChat), so the user just sends it again.
const SIGN_IN_HINTS: Record<string, string> = {
  claude:
    "Sign in to Claude Code: run `npx @anthropic-ai/claude-code` in your terminal and use /login. Then send your message again.",
  codex:
    "Sign in to Codex: run `npx @openai/codex login` in your terminal. Then send your message again.",
  pi: "Sign in to Pi: run `npx @earendil-works/pi-coding-agent` in your terminal and use /login. Then send your message again.",
  cursor:
    "Sign in to Cursor: run `cursor-agent login` in your terminal. Then send your message again.",
  gemini:
    "Sign in to Gemini CLI: run `npx @google/gemini-cli` in your terminal and sign in with Google. Then send your message again.",
  copilot:
    "Sign in to GitHub Copilot: run `npx @github/copilot login` in your terminal. Then send your message again.",
  opencode:
    "Sign in to OpenCode: run `npx opencode-ai auth login` in your terminal. Then send your message again.",
}

// Signed in, but the account may not use the agent.
const NOT_ALLOWED_HINTS: Record<string, string> = {
  copilot:
    "Your GitHub account cannot use Copilot CLI. Check your Copilot plan, or ask your organization to allow Copilot CLI.",
}

const isNotAllowedError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err)
  return /not authorized to use this copilot feature/i.test(message)
}

export const isAuthError = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  return (
    code === AUTH_REQUIRED_CODE ||
    /auth(entication)? required|not (signed|logged) in|please (sign|log) in|oauth session expired/i.test(
      message,
    )
  )
}

// Some agents pass on an API error as JSON, sometimes JSON inside JSON, like
// {"error":{"message":"{\"error\":{\"message\":\"API key not valid\"}}"}}.
// The innermost message is the one for the user.
const readableMessage = (message: string): string => {
  let current = message
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      return current
    }
    const inner = (parsed as { error?: { message?: unknown } } | null)?.error
      ?.message
    if (typeof inner !== "string") return current
    current = inner
  }
  return current
}

// Turns an agent failure into a message the console can show as is.
export const describeAgentError = (
  err: unknown,
  launch: AgentLaunch,
): string => {
  const notAllowed = NOT_ALLOWED_HINTS[launch.id]
  if (notAllowed && isNotAllowedError(err)) return notAllowed
  if (isAuthError(err)) {
    return (
      SIGN_IN_HINTS[launch.id] ??
      `${launch.label} needs you to sign in. Sign in with its own command line tool, then send your message again.`
    )
  }
  const message = readableMessage(
    err instanceof Error ? err.message : String(err),
  )
  return message || `${launch.label} failed without an error message.`
}
