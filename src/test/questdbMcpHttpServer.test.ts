import { request } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { BridgeSession } from "../bridgeSession.js"
import {
  AGENT_MODE_NOT_PAIRED_RECOVERY,
  startQuestdbMcpHttpServer,
} from "../agent/questdbMcpHttpServer.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import type { AnyMessage } from "../types.js"

const TOKEN = "mcp-test-token"
const ROUTE = "route-1"
const UNCLAIMED_ROUTE = "route-of-a-warm-session"

const servers: { stop: () => Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

const startServer = async (
  session = new BridgeSession({
    token: "browser-token",
    getPort: () => 1,
    consoleOrigin: "http://127.0.0.1:9000",
    getDeadlineMs: () => 1_000,
  }),
) => {
  const server = await startQuestdbMcpHttpServer({
    session,
    token: TOKEN,
    routeOf: (route) =>
      route === ROUTE
        ? { conversationId: "conversation-1" }
        : route === UNCLAIMED_ROUTE
          ? { conversationId: null }
          : null,
    log: () => undefined,
  })
  servers.push(server)
  return server
}

const listTools = (
  url: string,
  headers: Record<string, string> = {},
  body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }),
) =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body,
  })

// fetch never sends a custom Host header, so a rebinding page is simulated
// with a raw request.
const statusWithHost = (url: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.once("error", reject)
    req.end()
  })

describe("questdb MCP HTTP server", () => {
  it("lists the console tools with review hints for the conversation's route", async () => {
    // Given
    const server = await startServer()

    // When
    const response = await listTools(server.urlFor(ROUTE))

    // Then
    expect(response.status).toBe(200)
    const { result } = (await response.json()) as {
      result: {
        tools: { name: string; annotations: Record<string, boolean> }[]
      }
    }
    const byName = new Map(
      result.tools.map((tool) => [tool.name, tool.annotations]),
    )
    expect(byName.get("get_tables")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    expect(byName.get("run_query")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    expect(byName.get("apply_notebook_state")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
  })

  it("serves a warm session's route before a conversation claims it", async () => {
    // Given
    const server = await startServer()

    // When
    const response = await listTools(server.urlFor(UNCLAIMED_ROUTE))

    // Then
    expect(response.status).toBe(200)
  })

  it("refuses an unknown route, a wrong token, a foreign host name and an oversized body", async () => {
    // Given
    const server = await startServer()
    const url = server.urlFor(ROUTE)

    // When
    const unknownRoute = await listTools(server.urlFor("someone-else"))
    const wrongToken = await listTools(url, { authorization: "Bearer nope" })
    const foreignHost = await statusWithHost(url, "evil.example")
    const oversized = await listTools(url, {}, "x".repeat(5 * 1024 * 1024))

    // Then
    expect(unknownRoute.status).toBe(404)
    expect(wrongToken.status).toBe(401)
    expect(foreignHost).toBe(403)
    expect(oversized.status).toBe(413)
  })

  it("names the conversation of its route on the tool calls it forwards", async () => {
    // Given a paired console
    const session = new BridgeSession({
      token: "browser-token",
      getPort: () => 1,
      consoleOrigin: "http://127.0.0.1:9000",
      getDeadlineMs: () => 5_000,
    })
    const sent: AnyMessage[] = []
    session.attachBrowser({
      send: (msg) => {
        sent.push(msg)
        if (msg.type === "tool_call") {
          setImmediate(() =>
            session.handleMessage({
              v: MCP_BRIDGE_VERSION,
              type: "tool_result",
              requestId: msg.requestId,
              content: [{ type: "text", text: "tables" }],
            }),
          )
        }
        return true
      },
      close: () => undefined,
      terminate: () => undefined,
    })
    session.handleMessage({
      v: MCP_BRIDGE_VERSION,
      type: "hello",
      token: "browser-token",
      userAgent: "test",
      expectedBridgeVersion: MCP_BRIDGE_VERSION,
      consoleOrigin: "http://127.0.0.1:9000",
      tools: [
        {
          name: "get_tables",
          description: "x",
          inputSchema: { type: "object" },
        },
      ],
      permissions: { grantSchemaAccess: true, read: true, write: true },
    })
    const server = await startServer(session)

    // When the agent calls a tool on the conversation's route
    const response = await callTool(server.urlFor(ROUTE), "get_tables")

    // Then the console learns which conversation called it
    expect(await response.json()).toMatchObject({
      result: { content: [{ type: "text", text: "tables" }], isError: false },
    })
    expect(sent.find((msg) => msg.type === "tool_call")).toMatchObject({
      name: "get_tables",
      conversationId: "conversation-1",
    })
  })

  it("tells an agent to wait for the console, not to pair, while the console is away", async () => {
    // Given an agent mode session with no console
    const server = await startServer(
      new BridgeSession({
        token: "browser-token",
        getPort: () => 1,
        consoleOrigin: "http://127.0.0.1:9000",
        getDeadlineMs: () => 1_000,
        notPairedRecovery: AGENT_MODE_NOT_PAIRED_RECOVERY,
      }),
    )

    // When the agent lists the tools and calls one
    const listed = (await (await listTools(server.urlFor(ROUTE))).json()) as {
      result: { tools: { name: string }[] }
    }
    const called = (await (
      await callTool(server.urlFor(ROUTE), "get_tables")
    ).json()) as { result: { content: { text: string }[]; isError: boolean } }

    // Then the error names no tool the agent does not have
    const names = listed.result.tools.map((tool) => tool.name)
    const text = called.result.content[0].text
    expect(called.result.isError).toBe(true)
    expect(text).toMatch(/^BRIDGE_NOT_PAIRED: /)
    for (const tool of text.match(/`([a-z_]+)`/g) ?? []) {
      expect(names).toContain(tool.slice(1, -1))
    }
    expect(text).not.toMatch(/get_pairing_credentials|wait_for_pairing/)
  })
})

const callTool = (url: string, name: string) =>
  listTools(
    url,
    {},
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  )
