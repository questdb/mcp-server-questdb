import type { Log } from "./types.js"

export type ShutdownDeps = {
  stopMcp: () => Promise<void>
  settleWs: () => Promise<void>
  getStopWs: () => (() => Promise<void>) | null
  exit: (code: number) => void
  log: Log
  stepBudgetMs: number
  hardBudgetMs: number
}

export type ShutdownController = {
  // `reason` says why the bridge stops, for the log.
  shutdown: (reason: string) => Promise<void>
  requestFatal: (kind: string, err: Error) => Promise<void>
}

const TIMED_OUT = Symbol("timed out")

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const createShutdownController = (
  deps: ShutdownDeps,
): ShutdownController => {
  const { stepBudgetMs, hardBudgetMs, log } = deps
  let shuttingDown = false
  let exitCode = 0

  // Runs one step within its budget. A step that fails or runs out of time is
  // logged and the shutdown goes on.
  const runStep = async (
    name: string,
    step: () => Promise<unknown>,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        step(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), stepBudgetMs)
          timer.unref()
        }),
      ])
      if (outcome === TIMED_OUT) {
        log("WARN", `shutdown: ${name} did not finish within ${stepBudgetMs}ms`)
      }
    } catch (err) {
      log("WARN", `shutdown: ${name} failed: ${errorText(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  const exit = (code: number): void => {
    log(code === 0 ? "INFO" : "WARN", `exiting with code ${code}`)
    deps.exit(code)
  }

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      log("DEBUG", `shutdown already in progress (also: ${reason})`)
      return
    }
    shuttingDown = true
    log("INFO", `shutting down: ${reason}`)
    const safety = setTimeout(() => {
      log(
        "ERROR",
        `shutdown did not finish within ${hardBudgetMs}ms; exiting anyway`,
      )
      exit(1)
    }, hardBudgetMs)
    safety.unref()
    await runStep("stopping the MCP server", deps.stopMcp)
    await runStep("settling the WebSocket server", deps.settleWs)
    const stopWs = deps.getStopWs()
    if (stopWs) await runStep("stopping the WebSocket server", stopWs)
    clearTimeout(safety)
    exit(exitCode)
  }

  const requestFatal = (kind: string, err: Error): Promise<void> => {
    log("ERROR", `fatal (${kind}):`, err.message)
    if (kind === "fd-exhaustion") {
      exitCode = 3
    }
    return shutdown(`fatal error (${kind}): ${err.message}`)
  }

  return { shutdown, requestFatal }
}
