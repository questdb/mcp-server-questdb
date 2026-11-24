import { describe, expect, it } from "vitest"
import { toolResultSummary } from "../toolLog.js"

describe("toolResultSummary", () => {
  it("says a call went through, with how long it took", () => {
    // When
    const line = toolResultSummary(
      "get_cell",
      { content: [{ type: "text", text: "{}" }] },
      42,
    )

    // Then
    expect(line).toBe("tool_result: get_cell (42ms) ok")
  })

  it("gives the reason a call failed on one line", () => {
    // When
    const line = toolResultSummary(
      "apply_notebook_state",
      {
        content: [
          { type: "text", text: "VALIDATION_ERROR: cell 3 has\n  no query" },
        ],
        isError: true,
      },
      1730,
    )

    // Then
    expect(line).toBe(
      "tool_result: apply_notebook_state (1730ms) failed: VALIDATION_ERROR: cell 3 has no query",
    )
  })

  it("cuts a long reason short", () => {
    // When
    const line = toolResultSummary(
      "run_query",
      { content: [{ type: "text", text: "x".repeat(2000) }], isError: true },
      5,
    )

    // Then
    expect(line).toBe(
      `tool_result: run_query (5ms) failed: ${"x".repeat(500)}…`,
    )
  })
})
