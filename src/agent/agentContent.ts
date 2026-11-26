import type * as acp from "@agentclientprotocol/sdk"

// Agents reply in content blocks; the console shows a reply as markdown.
// Everything other than text becomes the markdown that shows it, so nothing
// the agent sends is lost on the way.

// Inline images are kept with the conversation; larger ones are not shown.
// The same size as an image the user can attach: 5 MB, in base64.
export const MAX_INLINE_IMAGE_CHARS = 7_000_000
// An embedded file is shown as a code block up to this many characters.
export const MAX_EMBEDDED_TEXT_CHARS = 20_000

const isHttpUrl = (uri: string): boolean => /^https?:\/\//i.test(uri)

const pathOf = (uri: string): string =>
  uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri

const baseName = (uri: string): string => {
  const path = pathOf(uri).replace(/[\\/]+$/, "")
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
}

// Markdown text cannot break out of a label or a code span.
const escapeLabel = (text: string): string =>
  text.replace(/([[\]\\`*_])/g, "\\$1")
const codeSpan = (text: string): string =>
  text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``

const paragraph = (text: string): string => `\n\n${text}\n\n`

const imageMarkdown = (
  mimeType: string,
  data: string,
  uri: string | null | undefined,
): string => {
  if (
    /^image\//i.test(mimeType) &&
    data &&
    data.length <= MAX_INLINE_IMAGE_CHARS
  )
    return paragraph(`![Image from the agent](data:${mimeType};base64,${data})`)
  // A remote image is linked, not loaded: the chat does not fetch from
  // addresses an agent picks.
  if (uri && isHttpUrl(uri)) return paragraph(`[Image](${uri})`)
  return paragraph("*The agent sent an image too large to show here.*")
}

const fenceFor = (text: string): string => {
  const longest = Math.max(
    2,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  )
  return "`".repeat(longest + 1)
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sql: "sql",
  json: "json",
  md: "markdown",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
}

const languageOf = (uri: string): string => {
  const extension = /\.([a-z0-9]+)$/i.exec(baseName(uri))?.[1]?.toLowerCase()
  return (extension && LANGUAGES[extension]) ?? ""
}

const embeddedMarkdown = (
  resource: acp.EmbeddedResource["resource"],
): string => {
  const name = baseName(resource.uri) || resource.uri
  if ("text" in resource) {
    const cut = resource.text.length > MAX_EMBEDDED_TEXT_CHARS
    const text = cut
      ? `${resource.text.slice(0, MAX_EMBEDDED_TEXT_CHARS)}\n…`
      : resource.text
    const fence = fenceFor(text)
    return paragraph(
      `${codeSpan(name)}\n\n${fence}${languageOf(resource.uri)}\n${text}\n${fence}`,
    )
  }
  if (resource.mimeType && /^image\//i.test(resource.mimeType))
    return imageMarkdown(resource.mimeType, resource.blob, resource.uri)
  return paragraph(`${codeSpan(name)} *(a binary file, not shown)*`)
}

const linkMarkdown = (link: acp.ResourceLink): string => {
  const label = link.title ?? link.name
  if (isHttpUrl(link.uri)) return ` [${escapeLabel(label)}](${link.uri}) `
  const path = pathOf(link.uri)
  return label && label !== baseName(link.uri)
    ? ` ${escapeLabel(label)} (${codeSpan(path)}) `
    : ` ${codeSpan(path)} `
}

// The markdown that shows a content block; null for an empty one.
export const contentMarkdown = (content: acp.ContentBlock): string | null => {
  switch (content.type) {
    case "text":
      return content.text || null
    case "image":
      return imageMarkdown(content.mimeType, content.data, content.uri)
    case "audio":
      return paragraph("*The agent sent audio, which the chat cannot play.*")
    case "resource_link":
      return linkMarkdown(content)
    case "resource":
      return embeddedMarkdown(content.resource)
    default:
      return null
  }
}
