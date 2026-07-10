import { describe, expect, it, vi } from "vitest"
import { dispatchToolCall, safePairingCredentialsSummary } from "../mcpServer.js"
import type { Log, ToolResultPayload } from "../types.js"

const okText = (text: string): ToolResultPayload => ({
  content: [{ type: "text", text }],
})

const pairingThatReturns = (
  credentials: ToolResultPayload,
  waitResult: ToolResultPayload = okText("{}"),
) => ({
  handleConnectWebConsole: () => Promise.resolve(credentials),
  handleWaitForPairing: () => Promise.resolve(waitResult),
})

describe("safePairingCredentialsSummary — token/credential redaction", () => {
  it("keeps paired/consoleOrigin/permissions but drops token, wsUrl and deepLink", () => {
    const token = "SUPER_SECRET_TOKEN_abc123"
    const wsUrl = "ws://127.0.0.1:57123"
    const content = [
      {
        type: "text" as const,
        text: JSON.stringify({
          paired: false,
          deepLink: `http://127.0.0.1:9000/?mcp-token=${token}`,
          wsUrl,
          token,
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { grantSchemaAccess: true, read: true, write: true },
          nextStep: "wait_for_pairing",
        }),
      },
    ]

    const summary = safePairingCredentialsSummary(content)

    expect(summary).not.toBeNull()
    // The whole point: secrets must never appear in the loggable summary.
    expect(summary).not.toContain(token)
    expect(summary).not.toContain(wsUrl)
    expect(summary).not.toContain("deepLink")
    const parsed = JSON.parse(summary as string) as Record<string, unknown>
    expect(parsed).toHaveProperty("paired", false)
    expect(parsed).toHaveProperty("consoleOrigin", "http://127.0.0.1:9000")
    expect(parsed).toHaveProperty("permissions")
  })

  it("returns null for non-JSON or empty content so the caller logs nothing", () => {
    expect(
      safePairingCredentialsSummary([{ type: "text", text: "not json" }]),
    ).toBeNull()
    expect(safePairingCredentialsSummary([])).toBeNull()
  })
})

describe("dispatchToolCall — request handler", () => {
  it("forwards a functional tool through the session and mirrors its result", async () => {
    // Given a session that returns a successful payload
    const session = { callBrowserTool: vi.fn(() => Promise.resolve(okText("rows"))) }

    // When a functional tool is dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      { a: 1 },
    )

    // Then the session is called with the args and the result is mirrored
    expect(session.callBrowserTool).toHaveBeenCalledWith(
      "list_cells",
      { a: 1 },
      undefined,
    )
    expect(out).toEqual({ content: [{ type: "text", text: "rows" }], isError: false })
  })

  it("mirrors an error payload from the session as isError:true", async () => {
    // Given a session that returns an error payload
    const session = {
      callBrowserTool: (): Promise<ToolResultPayload> =>
        Promise.resolve({
          content: [{ type: "text", text: "BRIDGE_NOT_PAIRED: ..." }],
          isError: true,
        }),
    }

    // When dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      {},
    )

    // Then the error flag is preserved
    expect(out.isError).toBe(true)
  })

  it("converts a thrown error into INTERNAL_ERROR instead of escaping the handler", async () => {
    // Given a session whose callBrowserTool rejects (e.g. send failure)
    const session = {
      callBrowserTool: (): Promise<ToolResultPayload> =>
        Promise.reject(new Error("socket dead")),
    }

    // When dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      {},
    )

    // Then the caller gets a machine-recognizable INTERNAL_ERROR, not a crash
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/^INTERNAL_ERROR:/)
  })

  it("routes pairing tools to the pairing handlers, not the session", async () => {
    // Given a session that must never be called for a pairing tool
    const session = { callBrowserTool: vi.fn(() => Promise.resolve(okText("nope"))) }

    // When get_pairing_credentials and wait_for_pairing are dispatched
    const creds = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("CREDS"), okText("WAIT")) },
      "get_pairing_credentials",
      {},
    )
    const wait = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("CREDS"), okText("WAIT")) },
      "wait_for_pairing",
      {},
    )

    // Then the pairing handlers answer and the session is untouched
    expect(creds.content[0].text).toBe("CREDS")
    expect(wait.content[0].text).toBe("WAIT")
    expect(session.callBrowserTool).not.toHaveBeenCalled()
  })

  it("redacts realistic pairing credentials from the DEBUG log but logs functional content verbatim", async () => {
    // Given a log spy and a real-shaped credentials payload with secrets in
    // multiple fields, including the pre-rendered message shown to the user.
    const lines: string[] = []
    const log: Log = (_level, ...args) => {
      lines.push(args.join(" "))
    }
    const token = "SUPER_SECRET_TOKEN_xyz"
    const wsUrl = "ws://127.0.0.1:57123"
    const deepLink = `http://127.0.0.1:9000/?mcp-pair=1&mcp-token=${token}`
    const userMessage =
      `To pair with the QuestDB Web Console:\n\n` +
      `  Option 1 — click this link and follow the instructions: ${deepLink}\n\n` +
      `  Option 2 — enter these values manually:\n` +
      `    WebSocket URL: ${wsUrl}\n` +
      `    Token:         ${token}\n`
    const credentials = okText(
      JSON.stringify({
        paired: false,
        deepLink,
        wsUrl,
        token,
        browserOpened:
          "Browser automatically opened with the pairing deep link — the user may already see the pairing dialog.",
        consoleOrigin: "http://127.0.0.1:9000",
        permissions: { grantSchemaAccess: true, read: true, write: false },
        nextStep: "wait_for_pairing",
        userMessage,
        assistantNextActions: [
          "Write a message to the user containing the `userMessage` text above.",
          "Then, in the SAME turn, call wait_for_pairing.",
        ],
      }),
    )

    // When get_pairing_credentials is dispatched (with debug logging)
    await dispatchToolCall(
      { session: { callBrowserTool: () => Promise.resolve(okText("x")) }, pairing: pairingThatReturns(credentials), log },
      "get_pairing_credentials",
      {},
    )

    const pairingLog = lines.join("\n")
    expect(pairingLog).not.toContain(token)
    expect(pairingLog).not.toContain(wsUrl)
    expect(pairingLog).not.toContain(deepLink)
    expect(pairingLog).not.toContain(userMessage)
    expect(pairingLog).not.toContain("assistantNextActions")
    expect(pairingLog).toContain("browserOpened")

    // And a functional tool's content is logged verbatim
    lines.length = 0
    await dispatchToolCall(
      { session: { callBrowserTool: () => Promise.resolve(okText("VISIBLE_CONTENT")) }, pairing: pairingThatReturns(credentials), log },
      "list_cells",
      {},
    )
    expect(lines.some((l) => l.includes("VISIBLE_CONTENT"))).toBe(true)
  })
})
