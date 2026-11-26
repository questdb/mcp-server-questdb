import { describe, expect, it, vi } from "vitest"

// The bridge on Windows: paths follow win32 rules, and every file the bridge
// would open is recorded instead of opened.
const opened: string[] = []

vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path")
  return { ...path.win32, default: path.win32 }
})

vi.mock("node:fs", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...fs,
    statSync: (path: string) => {
      opened.push(path)
      return { size: 3, isFile: () => true }
    },
    readFileSync: (path: string) => {
      opened.push(path)
      return Buffer.from("png")
    },
  }
})

describe("inlineLocalImages on Windows", () => {
  it("never opens a path on another machine, which would hand it the user's credentials", async () => {
    // Given
    const { inlineLocalImages } = await import("../agent/localImages.js")
    const references = [
      "[a](\\\\attacker.example\\share\\a.png)",
      "[b](//attacker.example/share/b.png)",
      "![c](file://attacker.example/share/c.png)",
      "![d](%5C%5Cattacker.example%5Cshare%5Cd.png)",
    ].join(" ")

    // When a reply repeats them
    opened.length = 0
    const text = inlineLocalImages(references, "C:\\work")

    // Then none is opened, and they stay as written
    expect(opened).toEqual([])
    expect(text).toBe(references)
  })

  it("reads an image the reply shows by its path from a drive's root", async () => {
    // Given
    const { inlineLocalImages } = await import("../agent/localImages.js")

    // When
    opened.length = 0
    const text = inlineLocalImages(
      "![a](C:\\work\\a.png) ![b](C:/work/b.png) ![c](C:relative.png)",
      "D:\\agent",
    )

    // Then both rooted paths are written in; one relative to a drive is not
    expect(opened.filter((path) => path.endsWith(".png"))).toEqual([
      "C:\\work\\a.png",
      "C:\\work\\a.png",
      "C:/work/b.png",
      "C:/work/b.png",
    ])
    expect(text).toMatch(/^!\[a\]\(data:image\/png;base64,\S+\) !\[b\]\(data:/)
    expect(text).toMatch(/!\[c\]\(C:relative\.png\)$/)
  })

  it("still reads an image in the agent's folder", async () => {
    // Given
    const { inlineLocalImages } = await import("../agent/localImages.js")

    // When
    opened.length = 0
    const text = inlineLocalImages("![chart](out/chart.png)", "C:\\work")

    // Then
    expect(opened).toContain("C:\\work\\out\\chart.png")
    expect(text).toBe(
      `![chart](data:image/png;base64,${Buffer.from("png").toString("base64")})`,
    )
  })
})
