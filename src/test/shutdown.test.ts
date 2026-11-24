import { afterEach, describe, expect, it, vi } from "vitest"
import { createShutdownController } from "../shutdown.js"

afterEach(() => {
  vi.useRealTimers()
})

const defaults = {
  log: () => {},
  settleWs: () => Promise.resolve(),
  stepBudgetMs: 2_000,
  hardBudgetMs: 5_000,
}

describe("createShutdownController", () => {
  it("stops the MCP server then the WS server once, and exits 0", async () => {
    // Given a controller over recording stubs
    const order: string[] = []
    const exit = vi.fn()
    const stopMcp = vi.fn(() => {
      order.push("mcp")
      return Promise.resolve()
    })
    const stopWs = vi.fn(() => {
      order.push("ws")
      return Promise.resolve()
    })
    const controller = createShutdownController({
      ...defaults,
      stopMcp,
      getStopWs: () => stopWs,
      exit,
    })

    // When shutdown runs
    await controller.shutdown("test")

    // Then both stops run in order and the process exits 0
    expect(order).toEqual(["mcp", "ws"])
    expect(stopMcp).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("is idempotent — a second shutdown does nothing", async () => {
    // Given a controller already asked to shut down
    const exit = vi.fn()
    const stopMcp = vi.fn(() => Promise.resolve())
    const controller = createShutdownController({
      ...defaults,
      stopMcp,
      getStopWs: () => null,
      exit,
    })

    // When shutdown is invoked twice
    await Promise.all([
      controller.shutdown("test"),
      controller.shutdown("test"),
    ])

    // Then the stop and exit happen exactly once
    expect(stopMcp).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it("skips the WS step when no server is bound", async () => {
    // Given a controller with no WS server
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When shutdown runs
    await controller.shutdown("test")

    // Then it still exits cleanly
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("closes a WS server that finishes binding during shutdown", async () => {
    // A shutdown racing the first pairing: getStopWs() is null until the
    // in-flight bind resolves. settleWs awaits that bind, after which getStopWs
    // returns the freshly-bound server so it actually gets closed.
    const exit = vi.fn()
    const stopWs = vi.fn(() => Promise.resolve())
    let bound: (() => Promise<void>) | null = null
    const settleWs = vi.fn(() => {
      bound = stopWs // the bind completed mid-shutdown
      return Promise.resolve()
    })
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      settleWs,
      getStopWs: () => bound,
      exit,
    })

    await controller.shutdown("test")

    // settle ran before getStopWs, so the mid-bind socket was observed + closed.
    expect(settleWs).toHaveBeenCalledTimes(1)
    expect(stopWs).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("exits 3 on an fd-exhaustion fatal", async () => {
    // Given a controller
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When a fatal fd-exhaustion is reported
    await controller.requestFatal("fd-exhaustion", new Error("EMFILE"))

    // Then the process exits with code 3
    expect(exit).toHaveBeenCalledWith(3)
  })

  it("exits 0 on a non-fd-exhaustion fatal", async () => {
    // Given a controller
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => Promise.resolve(),
      getStopWs: () => null,
      exit,
    })

    // When some other fatal is reported
    await controller.requestFatal("other", new Error("boom"))

    // Then the default exit code 0 is used
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("does not let a hanging stop step block the exit", async () => {
    // Given a stopMcp that never resolves and a short step budget
    vi.useFakeTimers()
    const exit = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      stopMcp: () => new Promise<void>(() => {}),
      getStopWs: () => null,
      exit,
      stepBudgetMs: 50,
      hardBudgetMs: 1_000,
    })

    // When shutdown runs and the step budget elapses
    const done = controller.shutdown("test")
    await vi.advanceTimersByTimeAsync(60)
    await done

    // Then the budget timeout lets shutdown complete and exit
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("logs why it shuts down, what went wrong on the way, and the exit code", async () => {
    // Given a WebSocket server that hangs and an MCP server that fails to stop
    vi.useFakeTimers()
    const log = vi.fn()
    const controller = createShutdownController({
      ...defaults,
      log,
      stopMcp: () => Promise.reject(new Error("agent did not exit")),
      getStopWs: () => () => new Promise<void>(() => {}),
      exit: vi.fn(),
    })

    // When
    const done = controller.shutdown("received SIGTERM")
    await vi.advanceTimersByTimeAsync(defaults.stepBudgetMs)
    await done

    // Then
    expect(log.mock.calls).toEqual([
      ["INFO", "shutting down: received SIGTERM"],
      ["WARN", "shutdown: stopping the MCP server failed: agent did not exit"],
      [
        "WARN",
        `shutdown: stopping the WebSocket server did not finish within ${defaults.stepBudgetMs}ms`,
      ],
      ["INFO", "exiting with code 0"],
    ])
  })
})
