import { readFileSync, statSync } from "node:fs"
import { extname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_INLINE_IMAGE_CHARS } from "./agentContent.js"

// Agents show an image the way they would in a terminal: they save it and
// write its path into the reply, `![chart](/tmp/chart.png)`. The browser
// cannot load a file from the user's disk, so the bridge reads the image and
// writes it into the reply instead.

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

// Base64 grows a file by a third.
const MAX_IMAGE_BYTES = Math.floor((MAX_INLINE_IMAGE_CHARS * 3) / 4)

// An image, or a link: agents link the image files they save as often as they
// show them.
const IMAGE_OR_LINK =
  /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g

// A path on another machine: \\host\share or //host/share. Opening one on
// Windows connects to that host and can hand it the user's credentials, and
// a reply can carry one the agent merely repeated from a table or a page.
const isNetworkPath = (path: string): boolean => /^[\\/]{2}/.test(path)

// A Windows path from a drive's root, C:\x.png or C:/x.png. Its drive letter
// reads like a URL scheme.
const isDrivePath = (ref: string): boolean => /^[a-z]:[\\/]/i.test(ref)

// The file a markdown image or link points at on this machine; null for a web,
// an inline or a network one.
const localPathOf = (target: string, cwd: string): string | null => {
  const ref = target.startsWith("<") ? target.slice(1, -1) : target
  if (/^(https?|data):/i.test(ref)) return null
  if (/^file:/i.test(ref)) {
    try {
      const url = new URL(ref)
      if (url.hostname !== "" && url.hostname !== "localhost") return null
      const path = fileURLToPath(url)
      return isNetworkPath(path) ? null : path
    } catch {
      return null
    }
  }
  if (isNetworkPath(ref)) return null
  const isUrl = !isDrivePath(ref) && /^[a-z][\w+.-]*:/i.test(ref)
  if (isUrl || ref.startsWith("#")) return null
  try {
    const path = decodeURIComponent(ref)
    if (isNetworkPath(path)) return null
    return isAbsolute(path) ? path : resolve(cwd, path)
  } catch {
    return null
  }
}

// The image a local file holds, as a data URL; null when it is missing, too
// large or not an image. Only a regular file is read: a FIFO or a device
// would block the bridge or never end.
const imageDataOf = (path: string): string | null => {
  const type = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!type) return null
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null
    return `data:${type};base64,${readFileSync(path).toString("base64")}`
  } catch {
    return null
  }
}

// The reply with each local image it shows or links written in as data. One
// that is missing, too large or not an image stays as the agent wrote it.
export const inlineLocalImages = (text: string, cwd: string): string =>
  text.replace(
    IMAGE_OR_LINK,
    (whole, _bang: string, label: string, target: string) => {
      const path = localPathOf(target, cwd)
      const data = path ? imageDataOf(path) : null
      return data ? `![${label}](${data})` : whole
    },
  )

// How much of a reply's tail may wait for an image's closing parenthesis.
const MAX_HELD_CHARS = 4_000

// Whether the tail of a reply from its last "[" may still become an image or
// a link; one that is complete, or cannot be one, need not wait.
const mayBecomeLink = (tail: string): boolean =>
  tail.length < MAX_HELD_CHARS &&
  !/^!?\[[^\]\n]*\]\([^)\n]*\)/.test(tail) &&
  !/^!?\[[^\]\n]*(\n|\][^(]|\]\([^)]*\n)/.test(tail)

// Replies stream in pieces, and an image's markdown can be split between
// them; the piece that may still be an image waits for the next.
export class LocalImageStream {
  private held = ""

  constructor(private cwd: string) {}

  push(text: string): string {
    const all = this.held + text
    const bracket = all.lastIndexOf("[")
    const start =
      bracket > 0 && all[bracket - 1] === "!" ? bracket - 1 : bracket
    // A lone "!" at the end may start an image.
    const cut =
      bracket >= 0 && mayBecomeLink(all.slice(start))
        ? start
        : all.endsWith("!")
          ? all.length - 1
          : all.length
    this.held = all.slice(cut)
    return inlineLocalImages(all.slice(0, cut), this.cwd)
  }

  flush(): string {
    const rest = this.held
    this.held = ""
    return inlineLocalImages(rest, this.cwd)
  }
}
