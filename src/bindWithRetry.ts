import type { Log } from "./types.js"

export type AttemptListenFn = (
  port: number,
) => Promise<{ stop: () => Promise<void> }>

const isEaddrInUse = (err: unknown): boolean =>
  err instanceof Error &&
  (err as Error & { code?: string }).code === "EADDRINUSE"

// The setting that pinned the port, for the error when it is taken.
export type PortPin = { name: string; unpin: string }

export const ENV_PORT_PIN: PortPin = {
  name: "MCP_BRIDGE_PORT",
  unpin: "unset MCP_BRIDGE_PORT",
}

export const bindWithRetry = async (params: {
  port: number
  isPinned: boolean
  pinnedBy?: PortPin
  attemptListen: AttemptListenFn
  findFreePort: () => Promise<number>
  log?: Log
}): Promise<{ stop: () => Promise<void>; port: number }> => {
  const { port, isPinned, attemptListen, findFreePort, log: logger } = params
  const pin = params.pinnedBy ?? ENV_PORT_PIN
  try {
    const handle = await attemptListen(port)
    return { ...handle, port }
  } catch (err) {
    if (!isEaddrInUse(err)) throw err
    if (isPinned) {
      const tagged = new Error(
        `could not bind ${pin.name}=${port} (EADDRINUSE). ` +
          `Pick a different port or ${pin.unpin} to auto-allocate.`,
      )
      ;(tagged as Error & { code?: string }).code = "port-pinned-in-use"
      throw tagged
    }
    logger?.(
      "WARN",
      `port ${port} taken before bind; retrying with a fresh port`,
    )
    const nextPort = await findFreePort()
    try {
      const handle = await attemptListen(nextPort)
      return { ...handle, port: nextPort }
    } catch (retryErr) {
      const tagged = new Error(
        `auto-allocated port ${nextPort} also taken (${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }). Restart the MCP server to pick another.`,
      )
      ;(tagged as Error & { code?: string }).code = "port-exhausted"
      throw tagged
    }
  }
}
