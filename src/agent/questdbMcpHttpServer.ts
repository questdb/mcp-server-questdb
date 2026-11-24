import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { BridgeSession } from "../bridgeSession.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { tokensMatch } from "../sessionStore.js"
import { toolResultSummary } from "../toolLog.js"
import type { Log, ToolResultPayload, ToolSchema } from "../types.js"

const MCP_PATH_PREFIX = "/mcp/"
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export const AGENT_MODE_INSTRUCTIONS = [
  "QuestDB Web Console tools. The user talks to you from the chat panel",
  "inside the QuestDB Web Console. The console is already paired: every",
  "tool works without a pairing step.",
  "",
  "Each user message can start with <workspace>, <notebook_context> and",
  "<user_events> blocks. They describe the open notebooks, the notebook",
  "bound to this chat, and the user's recent edits. Read them first.",
  "",
  "Rules:",
  "  • buffer_id is internal. Refer to notebooks by label, never by id.",
  "  • Before you change a notebook, read it (get_notebook_state or",
  "    get_workspace_state) unless the message carried its",
  "    <notebook_context>.",
  "  • Validate SQL with validate_query before you put it in a cell.",
  "  • Check your changes with these tools: get_notebook_state, get_cell",
  "    and list_cells show notebooks and cells with their results, and",
  "    run_query shows query results. Think about whether they can show",
  "    what you need before you reach for screenshots, a browser or other",
  "    computer-use tools: those take far longer. Use them only for what",
  "    these tools cannot show, like how a chart looks, or when the user",
  "    asks for them.",
  "  • Permission scopes (schema, read, write) gate the database only.",
  "    PERMISSION_DENIED names the missing scope: tell the user, do not",
  "    retry.",
  "  • Your reply text shows in the console chat. Keep it short and do not",
  "    repeat SQL that you already put into cells.",
  "  • To show the user an image, save it as a PNG, JPEG, GIF or WebP file",
  "    under 5 MB and write it into your reply as a markdown image with its",
  "    absolute path: ![Price chart](/tmp/price-chart.png). The console",
  "    cannot open other local files: name their path instead of linking",
  "    them. Images from the web are only linked, never loaded.",
].join("\n")

// What a tool call made while the console is away tells the agent. Agent
// mode has no pairing tools: the console reconnects on its own.
export const AGENT_MODE_NOT_PAIRED_RECOVERY =
  `Recovery: the Web Console lost its connection to this MCP server, for ` +
  `example because its page reloaded. It usually reconnects within a few ` +
  `seconds. ` +
  `Retry this tool once after a short wait; if it fails again, stop and tell ` +
  `the user that the Web Console is disconnected.`

type QuestdbMcpHttpServerConfig = {
  session: BridgeSession
  token: string
  // Resolves the route segment of a session's MCP URL; null for an unknown
  // route. A known route has no conversation until one claims its session.
  routeOf: (route: string) => { conversationId: string | null } | null
  log: Log
}

const createQuestdbMcpServer = (
  { session, log }: QuestdbMcpHttpServerConfig,
  conversationId: string | null,
) => {
  const server = new Server(
    { name: "questdb", version: MCP_BRIDGE_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: AGENT_MODE_INSTRUCTIONS,
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: session.getAdvertisedTools().map(withAnnotations),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name } = req.params
    const args = req.params.arguments ?? {}
    log("INFO", `agent tool_call: ${name}`)
    log("DEBUG", `  args: ${JSON.stringify(args)}`)
    const startedAt = Date.now()
    let result: ToolResultPayload
    try {
      result = await session.callBrowserTool(
        name,
        args,
        extra.signal,
        conversationId ?? undefined,
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log("ERROR", `agent tool_result: ${name} internal_error ${reason}`)
      throw err
    }
    // A failed call is the agent's to handle, like a query with a typo: WARN
    // with the reason, not ERROR.
    log(
      result.isError === true ? "WARN" : "INFO",
      `agent ${toolResultSummary(name, result, Date.now() - startedAt)}`,
    )
    log("DEBUG", `  content: ${JSON.stringify(result.content)}`)
    return { content: result.content, isError: result.isError === true }
  })
  return server
}

// Agents decide from these hints whether a call needs review. Reads never
// change anything; notebook edits change only the console's own state. The
// calls that can delete or write data stay marked as destructive.
const READ_ONLY_TOOLS = new Set([
  "get_tables",
  "get_table_schema",
  "get_table_details",
  "validate_query",
  "get_questdb_toc",
  "get_questdb_documentation",
  "list_cells",
  "get_cell",
  "get_notebook_state",
  "get_workspace_state",
  "get_recent_user_actions",
])
const DESTRUCTIVE_TOOLS = new Set([
  "run_query",
  "run_cell",
  "delete_notebook",
  "delete_cell",
])

const withAnnotations = (
  tool: ToolSchema,
): ToolSchema & {
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    openWorldHint: boolean
  }
} => ({
  ...tool,
  annotations: {
    readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
    destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
    openWorldHint: false,
  },
})

const hasValidBearer = (req: IncomingMessage, token: string): boolean => {
  const header = req.headers.authorization ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  return tokensMatch(presented, token)
}

const respondWith = (
  res: ServerResponse,
  status: number,
  message: string,
  log?: Log,
) => {
  log?.("DEBUG", `mcp http ${status}: ${message}`)
  res.writeHead(status, { "content-type": "text/plain" }).end(`${message}\n`)
}

export const startQuestdbMcpHttpServer = (
  config: QuestdbMcpHttpServerConfig,
): Promise<{
  urlFor: (route: string) => string
  stop: () => Promise<void>
}> => {
  let allowedHosts: string[] = []

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // A DNS-rebinding page reaches 127.0.0.1 under its own host name.
    if (!allowedHosts.includes(req.headers.host ?? "")) {
      return respondWith(res, 403, "Host not allowed", config.log)
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
    const route = path.startsWith(MCP_PATH_PREFIX)
      ? config.routeOf(path.slice(MCP_PATH_PREFIX.length))
      : null
    if (!route) return respondWith(res, 404, "Not found", config.log)
    if (!hasValidBearer(req, config.token)) {
      return respondWith(res, 401, "Unauthorized", config.log)
    }
    if (req.method !== "POST")
      return respondWith(res, 405, "Method not allowed", config.log)
    if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
      return respondWith(res, 413, "Request too large")
    }

    const server = createQuestdbMcpServer(config, route.conversationId)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      config.log("ERROR", "mcp http request failed:", err)
      if (!res.headersSent) respondWith(res, 500, "Internal error")
    })
  })

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address()
      const port = typeof address === "object" && address ? address.port : 0
      allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
      resolve({
        urlFor: (route) => `http://127.0.0.1:${port}${MCP_PATH_PREFIX}${route}`,
        stop: () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections()
            httpServer.close(() => done())
          }),
      })
    })
  })
}
