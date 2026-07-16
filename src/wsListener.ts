import { bindWithRetry, type AttemptListenFn } from "./bindWithRetry.js"
import type { Log } from "./types.js"

export type WsListenerDeps = {
  pinnedPort: number | null
  attemptListen: AttemptListenFn
  findFreePort: () => Promise<number>
  onListening: (stop: () => Promise<void>, port: number) => void
  log?: Log
}

export type WsListener = {
  ensureListening: () => Promise<void>
  settle: () => Promise<void>
}

export const createWsListener = (deps: WsListenerDeps): WsListener => {
  const { pinnedPort, attemptListen, findFreePort, onListening, log } = deps
  const isPinned = pinnedPort !== null
  let listeningPromise: Promise<void> | null = null

  const ensureListening = (): Promise<void> => {
    if (!listeningPromise) {
      listeningPromise = (async () => {
        const startPort = pinnedPort ?? (await findFreePort())
        const bound = await bindWithRetry({
          port: startPort,
          isPinned,
          attemptListen,
          findFreePort,
          log,
        })
        onListening(bound.stop, bound.port)
        log?.("INFO", `listening on ws://127.0.0.1:${bound.port}`)
      })().catch((err: unknown) => {
        // Reset the memo so a later get_pairing_credentials retries the bind…
        listeningPromise = null
        // …and surface the cause: the pinned-port / non-EADDRINUSE paths are
        // otherwise swallowed into the tool payload and never hit the log.
        log?.(
          "ERROR",
          `ws bind failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      })
    }
    return listeningPromise
  }

  const settle = async (): Promise<void> => {
    if (listeningPromise) await listeningPromise.catch(() => {})
  }

  return { ensureListening, settle }
}
