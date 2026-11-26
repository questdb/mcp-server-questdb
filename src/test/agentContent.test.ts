import { describe, expect, it } from "vitest"
import {
  MAX_EMBEDDED_TEXT_CHARS,
  MAX_INLINE_IMAGE_CHARS,
  contentMarkdown,
} from "../agent/agentContent.js"

describe("contentMarkdown", () => {
  it("shows an image the agent sends inline", () => {
    expect(
      contentMarkdown({ type: "image", mimeType: "image/png", data: "AAAA" }),
    ).toBe("\n\n![Image from the agent](data:image/png;base64,AAAA)\n\n")
  })

  it("links a remote image instead of loading it, and says when one is too large", () => {
    const tooLarge = "A".repeat(MAX_INLINE_IMAGE_CHARS + 1)
    expect(
      contentMarkdown({
        type: "image",
        mimeType: "image/png",
        data: tooLarge,
        uri: "https://example.com/chart.png",
      }),
    ).toBe("\n\n[Image](https://example.com/chart.png)\n\n")
    expect(
      contentMarkdown({ type: "image", mimeType: "image/png", data: tooLarge }),
    ).toContain("too large")
  })

  it("names a local file link by its path, and links a web one", () => {
    expect(
      contentMarkdown({
        type: "resource_link",
        name: "notes.txt",
        uri: "file:///tmp/my%20notes.txt",
      }),
    ).toBe(" notes.txt (`/tmp/my notes.txt`) ")
    expect(
      contentMarkdown({
        type: "resource_link",
        name: "Docs [v2]",
        uri: "https://questdb.com/docs",
      }),
    ).toBe(" [Docs \\[v2\\]](https://questdb.com/docs) ")
  })

  it("shows an embedded file as a code block that its text cannot close", () => {
    // When
    const markdown = contentMarkdown({
      type: "resource",
      resource: { uri: "file:///tmp/a.sql", text: "select '```'" },
    })

    // Then
    expect(markdown).toBe("\n\n`a.sql`\n\n````sql\nselect '```'\n````\n\n")
  })

  it("cuts a long embedded file, and does not show a binary one", () => {
    const long = contentMarkdown({
      type: "resource",
      resource: {
        uri: "file:///tmp/big.txt",
        text: "x".repeat(MAX_EMBEDDED_TEXT_CHARS + 10),
      },
    })
    expect(long).toContain("x".repeat(MAX_EMBEDDED_TEXT_CHARS) + "\n…")
    expect(
      contentMarkdown({
        type: "resource",
        resource: { uri: "file:///tmp/data.parquet", blob: "AAAA" },
      }),
    ).toBe("\n\n`data.parquet` *(a binary file, not shown)*\n\n")
  })

  it("says audio cannot be played", () => {
    expect(
      contentMarkdown({ type: "audio", mimeType: "audio/wav", data: "AAAA" }),
    ).toContain("cannot play")
  })
})
