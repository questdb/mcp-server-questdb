import { describe, expect, it } from "vitest"
import {
  MAX_DIFF_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  toAgentUpdate,
} from "../agent/agentUpdates.js"

describe("agent tool call updates", () => {
  it("passes on what a failed tool call reported", () => {
    // Given
    const update = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "call-1",
      status: "failed" as const,
      content: [
        {
          type: "content" as const,
          content: { type: "text" as const, text: "yarn: command not found" },
        },
      ],
    }

    // When
    const result = toAgentUpdate(update)

    // Then
    expect(result).toEqual({
      kind: "tool_call_update",
      toolCallId: "call-1",
      title: null,
      status: "failed",
      error: "yarn: command not found",
      content: [{ type: "text", text: "yarn: command not found" }],
    })
  })

  it("falls back to the raw output, and reports nothing for calls that did not fail", () => {
    // When
    const failed = toAgentUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "failed",
      rawOutput: { exitCode: 1 },
    })
    const completed = toAgentUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-3",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "All good" } },
      ],
    })

    // Then
    expect(failed).toMatchObject({ error: '{"exitCode":1}' })
    expect(completed).toMatchObject({ error: null })
  })
})

describe("what a tool call shows", () => {
  it("passes on its text output and the files it changed, and leaves out its terminal", () => {
    // When
    const result = toAgentUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Edit notes.txt",
      kind: "edit",
      content: [
        {
          type: "content",
          content: { type: "text", text: "  Replaced 1 block.\n" },
        },
        {
          type: "diff",
          path: "/tmp/notes.txt",
          oldText: "alpha\nbeta\n",
          newText: "alpha\ngamma\n",
        },
        { type: "diff", path: "/tmp/new.sql", newText: "select 1" },
        { type: "terminal", terminalId: "exec-1" },
      ],
    })

    // Then
    expect(result).toMatchObject({
      kind: "tool_call",
      content: [
        { type: "text", text: "Replaced 1 block." },
        {
          type: "diff",
          path: "/tmp/notes.txt",
          oldText: "alpha\nbeta\n",
          newText: "alpha\ngamma\n",
        },
        {
          type: "diff",
          path: "/tmp/new.sql",
          oldText: null,
          newText: "select 1",
        },
      ],
    })
  })

  it("cuts long output, names a diff too large to show, and leaves the content alone when an update has none", () => {
    // When
    const result = toAgentUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 5),
          },
        },
        {
          type: "diff",
          path: "/tmp/big.csv",
          oldText: null,
          newText: "y".repeat(MAX_DIFF_CHARS + 1),
        },
      ],
    })
    const statusOnly = toAgentUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
    })

    // Then
    expect(result).toMatchObject({
      content: [
        { type: "text", text: `${"x".repeat(MAX_TOOL_OUTPUT_CHARS)}\n…` },
        { type: "diff", path: "/tmp/big.csv", newText: "", truncated: true },
      ],
    })
    expect(statusOnly).toMatchObject({ content: null })
  })
})

describe("a command's output", () => {
  it("is shown without the code fence an agent wraps it in", () => {
    expect(
      toAgentUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        content: [
          {
            type: "content",
            content: { type: "text", text: "```sh\nSELECT 2\n```\n" },
          },
        ],
      }),
    ).toMatchObject({ content: [{ type: "text", text: "SELECT 2" }] })
  })
})

describe("context usage", () => {
  it("passes on how full the agent's context is, and not what it says it cost", () => {
    expect(
      toAgentUpdate({
        sessionUpdate: "usage_update",
        used: 20_100,
        size: 1_000_000,
        cost: { amount: 0.1, currency: "USD" },
      }),
    ).toEqual({ kind: "usage", used: 20_100, size: 1_000_000 })
  })
})
