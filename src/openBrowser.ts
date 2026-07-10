import open from "open"
import type { Log } from "./types.js"

export const openInBrowser = async (
  url: string,
  log?: Log,
): Promise<boolean> => {
  try {
    await open(url, { wait: false })
    log?.("INFO", "openInBrowser: launched pairing deep link")
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log?.("WARN", `openInBrowser failed: ${msg}`)
    return false
  }
}
