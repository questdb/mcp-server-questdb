import { describe, expect, it, vi } from "vitest"
import { createWsListener, type WsListenerDeps } from "../wsListener.js"

// A controllable attemptListen: each call resolves to a fresh stop stub, unless
// scripted to reject. Records how many times the bridge tried to bind.
const makeAttempt = () => {
  const stops: Array<() => Promise<void>> = []
  const attempt = vi.fn((_port: number) => {
    const stop = vi.fn(() => Promise.resolve())
    stops.push(stop)
    return Promise.resolve({ stop })
  })
  return { attempt, stops }
}

const makeDeps = (over: Partial<WsListenerDeps> = {}): WsListenerDeps => ({
  pinnedPort: null,
  attemptListen: makeAttempt().attempt,
  findFreePort: () => Promise.resolve(50_000),
  onListening: () => {},
  ...over,
})

describe("createWsListener — single-flight bind memo", () => {
  it("binds exactly once when two callers race, and reports the bound port", async () => {
    const { attempt } = makeAttempt()
    const findFreePort = vi.fn(() => Promise.resolve(50_000))
    const onListening = vi.fn()
    const { ensureListening } = createWsListener(
      makeDeps({ attemptListen: attempt, findFreePort, onListening }),
    )

    // Two concurrent callers before either resolves.
    await Promise.all([ensureListening(), ensureListening()])

    expect(findFreePort).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(50_000)
    expect(onListening).toHaveBeenCalledTimes(1)
    expect(onListening).toHaveBeenCalledWith(expect.any(Function), 50_000)
  })

  it("does not re-bind once successfully listening", async () => {
    const { attempt } = makeAttempt()
    const onListening = vi.fn()
    const { ensureListening } = createWsListener(
      makeDeps({ attemptListen: attempt, onListening }),
    )

    await ensureListening()
    await ensureListening()
    await ensureListening()

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onListening).toHaveBeenCalledTimes(1)
  })

  it("uses the pinned port and skips findFreePort", async () => {
    const { attempt } = makeAttempt()
    const findFreePort = vi.fn(() => Promise.resolve(50_000))
    const { ensureListening } = createWsListener(
      makeDeps({
        pinnedPort: 9999,
        attemptListen: attempt,
        findFreePort,
      }),
    )

    await ensureListening()

    expect(findFreePort).not.toHaveBeenCalled()
    expect(attempt).toHaveBeenCalledWith(9999)
  })

  it("clears the memo on failure so a later call retries, and logs the cause", async () => {
    // First bind rejects (non-EADDRINUSE → bindWithRetry rethrows); second wins.
    let call = 0
    const attempt = vi.fn((_port: number) => {
      call += 1
      if (call === 1) return Promise.reject(new Error("EACCES: denied"))
      return Promise.resolve({ stop: () => Promise.resolve() })
    })
    const logged: string[] = []
    const log = (level: string, ...a: unknown[]) => {
      if (level === "ERROR") logged.push(a.join(" "))
    }
    const onListening = vi.fn()
    const { ensureListening } = createWsListener(
      makeDeps({ attemptListen: attempt, onListening, log }),
    )

    await expect(ensureListening()).rejects.toThrow("EACCES")
    expect(onListening).not.toHaveBeenCalled()
    expect(logged.some((l) => l.includes("EACCES"))).toBe(true)

    // The memo was cleared, so a fresh attempt is made and succeeds.
    await ensureListening()
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onListening).toHaveBeenCalledTimes(1)
  })
})

describe("createWsListener — settle", () => {
  it("resolves immediately without binding when nothing is in flight", async () => {
    const { attempt } = makeAttempt()
    const { settle } = createWsListener(makeDeps({ attemptListen: attempt }))

    await settle()

    expect(attempt).not.toHaveBeenCalled()
  })

  it("awaits an in-flight bind so onListening has run by the time it resolves", async () => {
    let release: (v: { stop: () => Promise<void> }) => void = () => {}
    const attempt = vi.fn(
      () =>
        new Promise<{ stop: () => Promise<void> }>((res) => {
          release = res
        }),
    )
    const onListening = vi.fn()
    // Pin the port so attemptListen fires synchronously (no findFreePort await);
    // otherwise `release` isn't assigned yet when we call it below.
    const { ensureListening, settle } = createWsListener(
      makeDeps({
        pinnedPort: 9999,
        attemptListen: attempt,
        onListening,
      }),
    )

    // Kick off the bind but do not await it.
    void ensureListening()
    expect(onListening).not.toHaveBeenCalled()

    // settle must not resolve until the bind completes.
    const settled = settle()
    release({ stop: () => Promise.resolve() })
    await settled

    expect(onListening).toHaveBeenCalledTimes(1)
  })

  it("swallows a failed in-flight bind (does not reject)", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("boom")))
    const { ensureListening, settle } = createWsListener(
      makeDeps({ attemptListen: attempt, log: () => {} }),
    )

    void ensureListening().catch(() => {})
    await expect(settle()).resolves.toBeUndefined()
  })
})
