// Agent contract: each pinned adapter, installed and started the way
// `connect` does, still speaks ACP the way the MCP server reads it. Runs
// without any sign-in, as in CI, so it covers what an agent does before one:
// the capabilities it reports, whether a session opens, the sign-in error it
// gives otherwise, and, when a session opens, its settings and its use of the
// QuestDB MCP server.
//
// Not part of `yarn test`: it installs every adapter from npm. Run it with
// `yarn test:contract`; CONTRACT_AGENT=<id> runs one agent. Cursor is left
// out: it runs the user's own Cursor CLI, nothing the MCP server pins.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AcpAgentProcess } from "../../agent/acpAgentProcess.js"
import { toAgentConfig } from "../../agent/agentConfig.js"
import { isAuthError } from "../../agent/agentErrors.js"
import {
  resolveAgentLaunch,
  type AgentPresetId,
} from "../../agent/agentPresets.js"
import {
  QUESTDB_MCP_SERVER_NAME,
  startQuestdbMcpHttpServer,
} from "../../agent/questdbMcpHttpServer.js"
import { BridgeSession } from "../../bridgeSession.js"

type Expectation = {
  // The session can be picked up again after a restart with session/resume
  // rather than session/load.
  resumes: boolean
  // What session/new does without a sign-in.
  newSession: "opens" | "asks to sign in"
  // With a session open: the settings the composer shows.
  settings?: { model: boolean; effort: boolean }
  // With a session open: a prompt asks to sign in (agents whose prompt
  // reaches a model without one are not prompted).
  promptAsksToSignIn?: boolean
}

const AGENTS: Record<Exclude<AgentPresetId, "cursor">, Expectation> = {
  claude: {
    resumes: true,
    newSession: "opens",
    settings: { model: true, effort: true },
    promptAsksToSignIn: true,
  },
  codex: { resumes: true, newSession: "asks to sign in" },
  gemini: { resumes: false, newSession: "asks to sign in" },
  copilot: { resumes: false, newSession: "asks to sign in" },
  // OpenCode answers without a sign-in, from a free model: its prompt would
  // depend on a service outside the test.
  opencode: {
    resumes: true,
    newSession: "opens",
    settings: { model: true, effort: false },
  },
  pi: { resumes: true, newSession: "asks to sign in" },
}

const INSTALL_TIMEOUT_MS = 5 * 60_000
const MCP_TIMEOUT_MS = 15_000
const PROMPT_TIMEOUT_MS = 90_000
const MCP_TOKEN = "contract-token"
const ROUTE = "contract-route"

const only = process.env.CONTRACT_AGENT
const agents = (Object.keys(AGENTS) as (keyof typeof AGENTS)[]).filter(
  (id) => !only || id === only,
)

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms),
    ),
  ])

const waitFor = async (check: () => boolean, ms: number) => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 200))
  return check()
}

// The agents run as on a machine where nobody signed in: their own home and
// no credentials in the environment. Adapters install into a folder of their
// own.
const scratch = mkdtempSync(join(tmpdir(), "agent-contract-"))
const saved = { ...process.env }

beforeAll(() => {
  process.env.HOME = join(scratch, "home")
  process.env.USERPROFILE = process.env.HOME
  process.env.QUESTDB_MCP_SERVER_HOME = join(scratch, "mcp-server")
  for (const key of Object.keys(process.env))
    if (
      /API_KEY|TOKEN|SECRET|^ANTHROPIC|^OPENAI|^GEMINI|^GOOGLE|^COPILOT|^GH_|^GITHUB_/i.test(
        key,
      )
    )
      delete process.env[key]
})

afterAll(() => {
  process.env = saved
  rmSync(scratch, { recursive: true, force: true })
})

describe.each(agents)("%s", (id) => {
  const expected = AGENTS[id]

  it(
    "speaks ACP the way the MCP server reads it",
    async () => {
      // Given the agent, installed and started as connect does, and the
      // QuestDB MCP server it is given
      const logs: string[] = []
      const log = (level: string, ...parts: unknown[]) =>
        logs.push(`${level} ${parts.map(String).join(" ")}`)
      const trail = () => `\n--- log ---\n${logs.slice(-40).join("\n")}`
      const launch = await resolveAgentLaunch(
        { kind: "preset", id },
        { log, notify: () => undefined },
      )
      let mcpRequests = 0
      const mcp = await startQuestdbMcpHttpServer({
        session: new BridgeSession({
          token: "browser-token",
          getPort: () => 1,
          consoleOrigin: "http://127.0.0.1:9000",
          getDeadlineMs: () => 1_000,
        }),
        token: MCP_TOKEN,
        routeOf: (route) => {
          if (route !== ROUTE) return null
          mcpRequests++
          return { conversationId: "contract-conversation" }
        },
        log,
      })
      const agent = new AcpAgentProcess({
        launch,
        cwd: scratch,
        log,
        handlers: {
          onSessionUpdate: () => undefined,
          requestPermission: () =>
            Promise.resolve({ outcome: { outcome: "cancelled" } }),
          elicit: () => Promise.resolve({ action: "cancel" }),
          onElicitationComplete: () => undefined,
          onExit: () => undefined,
        },
      })

      try {
        // When it starts
        const connection = await agent.connection()

        // Then it takes the QuestDB tools as an HTTP MCP server, reads
        // images, and can reopen its sessions
        const capabilities = connection.capabilities
        expect(capabilities.mcpCapabilities?.http, trail()).toBe(true)
        expect(capabilities.promptCapabilities?.image, trail()).toBe(true)
        expect(capabilities.loadSession, trail()).toBe(true)
        expect(Boolean(capabilities.sessionCapabilities?.resume), trail()).toBe(
          expected.resumes,
        )

        // When a conversation opens a session with the QuestDB MCP server
        const opening = connection.agent.request("session/new", {
          cwd: scratch,
          mcpServers: [
            {
              type: "http",
              name: QUESTDB_MCP_SERVER_NAME,
              url: mcp.urlFor(ROUTE),
              headers: [
                { name: "Authorization", value: `Bearer ${MCP_TOKEN}` },
              ],
            },
          ],
        })

        if (expected.newSession === "asks to sign in") {
          // Then it asks to sign in, in a way the MCP server recognizes
          const error = await opening.then(
            () => null,
            (err: unknown) => err,
          )
          expect(error, `session/new opened a session${trail()}`).not.toBe(null)
          expect(isAuthError(error), `${String(error)}${trail()}`).toBe(true)
          return
        }

        // Then it opens, with the settings the composer shows
        const session: acp.NewSessionResponse = await opening
        expect(session.sessionId, trail()).toEqual(expect.any(String))
        const config = toAgentConfig(session)
        expect(Boolean(config.model), trail()).toBe(expected.settings?.model)
        expect(Boolean(config.effort), trail()).toBe(expected.settings?.effort)

        // And it connects to the QuestDB MCP server with the token it got
        expect(
          await waitFor(() => mcpRequests > 0, MCP_TIMEOUT_MS),
          `no request reached the QuestDB MCP server${trail()}`,
        ).toBe(true)
        expect(
          logs.filter((line) => /mcp http (401|403|404)/.test(line)),
          trail(),
        ).toEqual([])

        if (expected.promptAsksToSignIn) {
          // When the user sends a message
          const error = await within(
            connection.agent.request("session/prompt", {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Reply with OK." }],
            }),
            PROMPT_TIMEOUT_MS,
            "session/prompt",
          ).then(
            () => null,
            (err: unknown) => err,
          )

          // Then it asks to sign in, in a way the MCP server recognizes
          expect(error, `the prompt was answered${trail()}`).not.toBe(null)
          expect(isAuthError(error), `${String(error)}${trail()}`).toBe(true)
        }
      } finally {
        await agent.stop()
        await mcp.stop()
      }
    },
    INSTALL_TIMEOUT_MS,
  )
})
