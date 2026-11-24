import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MAX_INLINE_IMAGE_CHARS } from "../agent/agentContent.js"
import { inlineLocalImages, LocalImageStream } from "../agent/localImages.js"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DATA = `data:image/png;base64,${PNG.toString("base64")}`

describe("inlineLocalImages", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-images-"))
    mkdirSync(join(dir, "out"))
    writeFileSync(join(dir, "out", "chart.png"), PNG)
    writeFileSync(join(dir, "notes.txt"), "not an image")
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("writes in an image the reply shows by its path", () => {
    // Given
    const path = join(dir, "out", "chart.png")

    // When
    const text = inlineLocalImages(`Here: ![Chart](${path}) done`, "/")

    // Then
    expect(text).toBe(`Here: ![Chart](${PNG_DATA}) done`)
  })

  it("reads file URLs and paths relative to the agent's folder", () => {
    // Given
    const url = pathToFileURL(join(dir, "out", "chart.png")).href

    // When
    const text = inlineLocalImages(
      `![a](${url}) ![b](out/chart.png) ![c](<out/chart.png> "title")`,
      dir,
    )

    // Then
    expect(text).toBe(`![a](${PNG_DATA}) ![b](${PNG_DATA}) ![c](${PNG_DATA})`)
  })

  it("shows an image the reply links to", () => {
    // Given
    const path = join(dir, "out", "chart.png")

    // When
    const text = inlineLocalImages(`[Open the chart](${path})`, "/")

    // Then
    expect(text).toBe(`![Open the chart](${PNG_DATA})`)
  })

  it.skipIf(process.platform === "win32")(
    "reads only regular files, never a FIFO that would block the bridge",
    () => {
      // Given a FIFO named like an image, with a writer waiting on it
      const fifo = join(dir, "pipe.png")
      execFileSync("mkfifo", [fifo])
      const writer = spawn("sh", ["-c", `printf png > "${fifo}"`])
      try {
        // When a reply shows it
        const text = inlineLocalImages(`![pipe](${fifo})`, dir)

        // Then it stays as written
        expect(text).toBe(`![pipe](${fifo})`)
      } finally {
        writer.kill()
      }
    },
  )

  it("leaves web, inline, missing and non-image references as written", () => {
    // Given
    const reply = [
      "![web](https://example.com/a.png)",
      `![inline](${PNG_DATA})`,
      "![missing](out/none.png)",
      "![text](notes.txt)",
      "[notes](notes.txt)",
      "[web](https://example.com/out/chart.png)",
      "[anchor](#out)",
    ].join("\n")

    // When
    const text = inlineLocalImages(reply, dir)

    // Then
    expect(text).toBe(reply)
  })

  it("leaves an image too large to keep with the conversation", () => {
    // Given
    writeFileSync(
      join(dir, "big.png"),
      Buffer.alloc(Math.ceil(MAX_INLINE_IMAGE_CHARS * 0.75) + 1),
    )

    // When
    const text = inlineLocalImages("![big](big.png)", dir)

    // Then
    expect(text).toBe("![big](big.png)")
  })
})

describe("LocalImageStream", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-images-"))
    writeFileSync(join(dir, "chart.png"), PNG)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("holds an image split between pieces until it is complete", () => {
    // Given
    const stream = new LocalImageStream(dir)

    // When
    const pieces = ["See !", "[Chart](cha", "rt.png", ") below"].map((piece) =>
      stream.push(piece),
    )

    // Then
    expect(pieces).toEqual(["See ", "", "", `![Chart](${PNG_DATA}) below`])
    expect(stream.flush()).toBe("")
  })

  it("passes text through and lets an unfinished image out at the end", () => {
    // Given
    const stream = new LocalImageStream(dir)

    // When
    const first = stream.push("Plain text, ")
    const second = stream.push("then ![half](chart")
    const rest = stream.flush()

    // Then
    expect(first).toBe("Plain text, ")
    expect(second).toBe("then ")
    expect(rest).toBe("![half](chart")
  })

  it("holds a link split between pieces until it is complete", () => {
    // Given
    const stream = new LocalImageStream(dir)

    // When
    const pieces = ["Saved: [the ch", "art](chart.png", ")."].map((piece) =>
      stream.push(piece),
    )

    // Then
    expect(pieces).toEqual(["Saved: ", "", `![the chart](${PNG_DATA}).`])
  })

  it("does not hold text after a bracket that is not an image or a link", () => {
    // Given
    const stream = new LocalImageStream(dir)

    // When
    const pieces = ["Wow![not an image] and ", "rows[0", "] more\n", "[x"].map(
      (piece) => stream.push(piece),
    )

    // Then
    expect(pieces).toEqual([
      "Wow![not an image] and ",
      "rows",
      "[0] more\n",
      "",
    ])
    expect(stream.flush()).toBe("[x")
  })
})
