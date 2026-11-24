#!/usr/bin/env node
// A scripted ACP agent for tests. It speaks real ACP over stdio and reacts to
// a few prompt keywords:
//   "approve" — asks permission for a shell command, then reports the choice
//   "slow"    — streams slowly until cancelled
//   "link"    — asks the user to open a sign-in page, and replies with the
//               choice
//   "notice"  — sends a warning notice in the middle of its reply
//   "limit"   — stops at its output limit, mid-answer
//   "edits"   — follows a plan: runs a command that prints, edits a file and
//               creates one, reporting how full its context gets
//   "asyncask"— asks the way Codex does while it keeps working
//   "/review" — sends its findings twice, as Codex does
//   "mdimages"— writes images into its reply as markdown: inline, local, remote
//   "files"   — replies with an image, a file link and an embedded file
//   "steps"   — thinks, runs a shell command and writes a line, many times,
//               now and then working silently for a moment after the command
//   "auth"    — fails with the ACP auth_required error
//   "tool"    — calls the questdb_console get_tables tool over MCP HTTP
//   "model"   — replies with the session's model, for the session-model mode
//   "question"— asks the user which database to use, as a form, and replies
//               with the answer it got
// Anything else is echoed back.
//
// Environment switches for agent behaviors the bridge adapts to:
//   FAKE_AGENT_AUTH_METHOD     — offers this auth method and refuses sessions
//                                until the client authenticates with it
//   FAKE_AGENT_AUTH_REJECTS    — refuses to authenticate, like an agent whose
//                                CLI is not signed in
//   FAKE_AGENT_SESSION_MODELS  — reports models in the session's `models`
//                                field and switches with session/set_model
//   FAKE_AGENT_SHARED_MCP      — sends every session's tool calls to the MCP
//                                servers registered last, like OpenCode
//   FAKE_AGENT_START_DELAY_MS  — waits this long before it reads `initialize`
//   FAKE_AGENT_PID_FILE        — appends its process id to this file
import { appendFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

// A command longer than the chat is wide, over several lines.
const LONG_COMMAND = [
  `node -e 'const p=require("./src/components/modules/dashboard/panels.json")`,
  `const picked=p.panels.filter((x)=>[27,13,11,26].includes(x.id))`,
  `console.log(JSON.stringify({id:picked.map((x)=>x.id),options:picked.map((x)=>x.options)}))'`,
].join("\n")

const CONFIG = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast", description: "Fast · Quick answers" },
      { value: "deep", name: "Deep", description: "Thorough answers" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
]

const AUTH_METHOD = process.env.FAKE_AGENT_AUTH_METHOD
const SESSION_MODELS = process.env.FAKE_AGENT_SESSION_MODELS === "1"
const SHARED_MCP = process.env.FAKE_AGENT_SHARED_MCP === "1"

let authenticated = !AUTH_METHOD
let canAskQuestions = false
let canOpenLinks = false
let canShowNotices = false
let sessionModel = "auto"
let latestMcpServers = []

const MODELS = () => ({
  currentModelId: sessionModel,
  availableModels: [
    { modelId: "auto", name: "Auto" },
    { modelId: "pro", name: "Pro", description: "The largest model" },
  ],
})

const sessionSettings = () =>
  SESSION_MODELS ? { models: MODELS() } : { configOptions: CONFIG() }

const registerMcpServers = (sessionId, servers) => {
  if (!authenticated) throw acp.RequestError.authRequired()
  sessions.set(sessionId, servers)
  latestMcpServers = servers
}

const mcpServersOf = (sessionId) =>
  SHARED_MCP ? latestMcpServers : sessions.get(sessionId)

let effort = "high"
let sessionCount = 0
const sessions = new Map()
const cancelled = new Set()

const text = (sessionId, chunk, messageId) => ({
  sessionId,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: chunk },
    ...(messageId ? { messageId } : {}),
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const callQuestdbTool = async (server, name = "get_tables", args = {}) => {
  const auth = server.headers.find((header) => header.name === "Authorization")
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      authorization: auth.value,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const body = await response.json()
  return body.result?.content?.[0]?.text ?? JSON.stringify(body)
}

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", ({ params }) => {
    canAskQuestions = !!params.clientCapabilities?.elicitation?.form
    canOpenLinks = !!params.clientCapabilities?.elicitation?.url
    canShowNotices = !!params.clientCapabilities?.session?.notices
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
      agentInfo: { name: "fake-agent", title: "Fake Agent", version: "1.0.0" },
      authMethods: AUTH_METHOD ? [{ id: AUTH_METHOD, name: "Fake login" }] : [],
    }
  })
  .onRequest("authenticate", ({ params }) => {
    if (params.methodId !== AUTH_METHOD) throw acp.RequestError.invalidParams()
    if (process.env.FAKE_AGENT_AUTH_REJECTS === "1") {
      throw acp.RequestError.authRequired()
    }
    authenticated = true
    return {}
  })
  .onRequest("session/new", ({ params, client }) => {
    const sessionId = `fake-${++sessionCount}`
    registerMcpServers(sessionId, params.mcpServers)
    // Like real agents, list its commands once the session is open.
    setTimeout(() => {
      void client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "[focus]" },
            },
            { name: "compact", description: "Summarize the conversation" },
            { name: "model", description: "Switch the model" },
            { name: "status", description: "Show the session status" },
          ],
        },
      })
    }, 0)
    return { sessionId, ...sessionSettings() }
  })
  .onRequest("session/resume", ({ params, client }) => {
    registerMcpServers(params.sessionId, params.mcpServers)
    // Like Codex, warn about the reopened session, as a notice when the
    // client takes notices and as reply text otherwise.
    setTimeout(() => {
      void client.notify("session/update", {
        sessionId: params.sessionId,
        update: canShowNotices
          ? {
              sessionUpdate: "notice",
              severity: "warning",
              title: "Resumed with another model",
            }
          : {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Warning: resumed with another model. ",
              },
            },
      })
    }, 0)
    return sessionSettings()
  })
  // Not in the stable ACP schema, so it needs its own params parser.
  .onRequest(
    "session/set_model",
    (params) => params,
    ({ params }) => {
      sessionModel = params.modelId
      return {}
    },
  )
  .onRequest("session/set_config_option", ({ params }) => {
    if (params.configId === "effort") effort = params.value
    return { configOptions: CONFIG() }
  })
  .onNotification("session/cancel", ({ params }) => {
    cancelled.add(params.sessionId)
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params
    // The user's message is the last block; the bridge may put its
    // instructions before it.
    const images = params.prompt.filter((block) => block.type === "image")
    if (images.length > 0) {
      await client.notify(
        "session/update",
        text(
          sessionId,
          `I see ${images.length} image${images.length === 1 ? "" : "s"} (${images
            .map((image) => image.mimeType)
            .join(", ")}).`,
        ),
      )
      return { stopReason: "end_turn" }
    }
    const blocks = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
    const prompt = blocks[blocks.length - 1] ?? ""
    if (prompt.includes("blocks")) {
      const first = blocks[0].split("\n")[0]
      await client.notify(
        "session/update",
        text(sessionId, `blocks:${blocks.length}:${first}`),
      )
      return { stopReason: "end_turn" }
    }
    cancelled.delete(sessionId)

    if (prompt.includes("auth")) {
      throw acp.RequestError.authRequired()
    }
    // A long answer that grows line by line, for following the output.
    if (prompt.includes("lines")) {
      for (let i = 1; i <= 80 && !cancelled.has(sessionId); i++) {
        await client.notify("session/update", text(sessionId, `Line ${i}\n\n`))
        await sleep(100)
      }
      return { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" }
    }
    if (prompt.includes("steps")) {
      for (let i = 1; i <= 12 && !cancelled.has(sessionId); i++) {
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: `Step ${i}: look at the files.` },
          },
        })
        await sleep(300)
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `step-${i}`,
            title: i === 1 ? LONG_COMMAND : `ls step-${i}`,
            kind: "execute",
            status: "in_progress",
          },
        })
        await sleep(300)
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: `step-${i}`,
            status: "completed",
          },
        })
        // Now and then works silently for a moment after a tool.
        if (i % 3 === 0) await sleep(1500)
        await client.notify(
          "session/update",
          text(
            sessionId,
            `Step ${i} done.\n\n${"More detail. ".repeat(20)}\n\n`,
          ),
        )
        await sleep(400)
      }
      return { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" }
    }
    if (prompt.includes("slow")) {
      for (let i = 0; i < 200 && !cancelled.has(sessionId); i++) {
        await client.notify("session/update", text(sessionId, "."))
        await sleep(50)
      }
      return { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" }
    }
    if (prompt.includes("approve")) {
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "rm -rf build",
          kind: "execute",
          status: "pending",
          rawInput: { command: "rm -rf build" },
        },
      })
      const answer = await client.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "rm -rf build",
          kind: "execute",
          rawInput: { command: "rm -rf build" },
        },
        options: [
          { optionId: "always", name: "Always allow rm", kind: "allow_always" },
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      })
      const choice =
        answer.outcome.outcome === "selected"
          ? answer.outcome.optionId
          : "cancelled"
      await client.notify(
        "session/update",
        text(sessionId, `permission:${choice}`),
      )
      return { stopReason: "end_turn" }
    }
    // Validates a query, an invalid one, then runs one, through the console.
    if (prompt.includes("queries")) {
      const [server] = sessions.get(sessionId)
      await callQuestdbTool(server, "validate_query", {
        query: "select symbol, avg(price) from trades sample by 1h",
      })
      await callQuestdbTool(server, "validate_query", {
        query: "select no_such_column from trades",
      })
      // Announced first, like a model writing the call's arguments
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-run",
          title: "mcp__questdb_console__run_query",
          kind: "other",
          status: "pending",
        },
      })
      await sleep(1000)
      await callQuestdbTool(server, "run_query", {
        sql: "select count() from trades",
        limit: null,
      })
      await sleep(1500)
      await client.notify(
        "session/update",
        text(sessionId, "Checked the queries."),
      )
      return { stopReason: "end_turn" }
    }
    // A QuestDB tool that fails in the console, then a command that fails.
    if (prompt.includes("fail")) {
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-q",
          title: "mcp__questdb_console__get_table_details",
          kind: "other",
          status: "pending",
        },
      })
      await sleep(400)
      await callQuestdbTool(sessions.get(sessionId)[0], "get_table_details", {
        table_name: "no_such_table",
      })
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-c",
          title: "yarn test",
          kind: "execute",
          status: "in_progress",
        },
      })
      await sleep(300)
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-c",
          status: "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "zsh: command not found: yarn" },
            },
          ],
        },
      })
      await client.notify(
        "session/update",
        text(sessionId, "Both steps failed."),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("asyncask")) {
      // As Codex asks while it keeps working: the adapter marks the question.
      const answer = await client.request("elicitation/create", {
        mode: "form",
        sessionId,
        message: "Codex keeps working while you answer.",
        _meta: { codex: { delivery: "async" } },
        requestedSchema: {
          type: "object",
          properties: {
            question_0: {
              type: "string",
              title: "Which table should I analyze?",
              oneOf: [
                { const: "trades", title: "trades" },
                { const: "None of the above", title: "None of the above" },
              ],
            },
            question_0_note: {
              type: "string",
              title: "Additional answer or note",
            },
          },
        },
      })
      await client.notify(
        "session/update",
        text(sessionId, `answer:${JSON.stringify(answer)}`),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("question")) {
      if (!canAskQuestions) {
        await client.notify("session/update", text(sessionId, "cannot ask"))
        return { stopReason: "end_turn" }
      }
      const answer = await client.request("elicitation/create", {
        mode: "form",
        sessionId,
        message: "Which database should we use?",
        requestedSchema: {
          type: "object",
          properties: {
            database: {
              type: "string",
              title: "Database",
              oneOf: [
                {
                  const: "questdb",
                  title: "QuestDB",
                  description: "Time series",
                },
                { const: "postgres", title: "Postgres" },
              ],
            },
            database_custom: { type: "string", title: "Other" },
            features: {
              type: "array",
              title: "Features",
              items: {
                anyOf: [
                  { const: "sql", title: "SQL" },
                  { const: "ilp", title: "ILP" },
                ],
              },
            },
            sure: { type: "boolean", title: "Are you sure?" },
            replicas: { type: "integer", title: "Replicas" },
          },
          required: ["database"],
        },
      })
      // Works silently for a moment, as agents do after an answer.
      await sleep(Number(process.env.FAKE_AGENT_ANSWER_DELAY_MS ?? 0))
      await client.notify(
        "session/update",
        text(sessionId, `answer:${JSON.stringify(answer)}`),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("link")) {
      if (!canOpenLinks) {
        await client.notify("session/update", text(sessionId, "cannot link"))
        return { stopReason: "end_turn" }
      }
      const answer = await client.request("elicitation/create", {
        mode: "url",
        sessionId,
        elicitationId: "sign-in-1",
        url: "https://auth.example.com/authorize?client=questdb",
        message: "Sign in to Example Analytics so I can read your dashboards.",
      })
      await client.notify(
        "session/update",
        text(sessionId, `link:${answer.action}`),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("notice")) {
      await client.notify("session/update", text(sessionId, "Before. "))
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "notice",
          severity: "warning",
          title: "Rate limit close",
          description: "Slow down.",
        },
      })
      await client.notify("session/update", text(sessionId, "After."))
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("limit")) {
      await client.notify("session/update", text(sessionId, "The answer is"))
      return { stopReason: "max_tokens" }
    }
    if (prompt.includes("edits")) {
      const update = (u) =>
        client.notify("session/update", { sessionId, update: u })
      const plan = (statuses) =>
        update({
          sessionUpdate: "plan",
          entries: [
            "List the workspace files",
            "Fix line 20 in notes.txt",
            "Write the hourly query",
          ].map((content, i) => ({
            content,
            priority: "medium",
            status: statuses[i],
          })),
        })
      await plan(["in_progress", "pending", "pending"])
      await update({
        sessionUpdate: "usage_update",
        used: 42_000,
        size: 200_000,
      })
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "run-1",
        title: "ls -la",
        kind: "execute",
        status: "in_progress",
      })
      for (const output of ["total 8", "total 8\n-rw-r--r--  notes.txt"]) {
        await sleep(200)
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "run-1",
          content: [
            { type: "content", content: { type: "text", text: output } },
          ],
        })
      }
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "run-1",
        status: "completed",
      })
      await plan(["completed", "in_progress", "pending"])
      const original = Array.from(
        { length: 40 },
        (_, i) => `line ${i + 1}`,
      ).join("\n")
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Edit notes.txt",
        kind: "edit",
        status: "pending",
        content: [
          {
            type: "diff",
            path: "/tmp/qdb-agent/notes.txt",
            oldText: original,
            newText: original
              .replace("line 20", "line twenty")
              .replace("line 21\n", ""),
          },
        ],
      })
      await sleep(200)
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
      })
      await plan(["completed", "completed", "in_progress"])
      await sleep(300)
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "write-1",
        title: "Write query.sql",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/tmp/qdb-agent/query.sql",
            oldText: null,
            newText: "SELECT symbol, avg(price)\nFROM trades\nSAMPLE BY 1h;\n",
          },
        ],
      })
      await plan(["completed", "completed", "completed"])
      await update({
        sessionUpdate: "usage_update",
        used: 172_000,
        size: 200_000,
        cost: { amount: 0.4231, currency: "USD" },
      })
      await client.notify("session/update", text(sessionId, "Edited."))
      return { stopReason: "end_turn" }
    }
    if (prompt.startsWith("/review")) {
      // As Codex does: the findings arrive twice, the second time as a
      // message of their own.
      const findings =
        "Review comment:\n\n- [P1] Close the string literal in trades.sql:3"
      await client.notify("session/update", text(sessionId, findings))
      await client.notify("session/update", text(sessionId, findings, "msg_2"))
      await client.notify(
        "session/update",
        text(sessionId, "\n\nNo other issues.", "msg_2"),
      )
      await client.notify("session/update", text(sessionId, "Done", "msg_3"))
      await client.notify("session/update", text(sessionId, "Done", "msg_4"))
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("mdimages")) {
      // Images written as markdown in the reply text, as models do; the
      // local one arrives split between pieces.
      const local = process.env.FAKE_AGENT_IMAGE_PATH ?? "/tmp/pw/heat.png"
      for (const piece of [
        "Inline: ![chart](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAK0lEQVR4nGPofvkXji66FcIRqeIMw9ggSjQjiw9ngwZfrA0+gwZfrA06gwBjBPrfuMvWDQAAAABJRU5ErkJggg==)\n\nLocal: ![he",
        "at](",
        local,
        ")\n\nRemote: ![logo](https://questdb.com/img/logo.png)",
        `\n\nLinked, as Codex does: [Open the chart](${local})`,
        "\n\nA file: [Open data-url.txt](/private/tmp/data-url.txt)",
      ]) {
        await client.notify("session/update", text(sessionId, piece))
      }
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("files")) {
      const content = [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAK0lEQVR4nGPofvkXji66FcIRqeIMw9ggSjQjiw9ngwZfrA0+gwZfrA06gwBjBPrfuMvWDQAAAABJRU5ErkJggg==",
        },
        {
          type: "resource_link",
          name: "notes.txt",
          uri: "file:///tmp/notes.txt",
        },
        {
          type: "resource",
          resource: { uri: "file:///tmp/q.sql", text: "select 1" },
        },
      ]
      for (const block of content) {
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: block },
        })
      }
      // Text that points at a remote image, as an injected prompt might.
      await client.notify(
        "session/update",
        text(
          sessionId,
          "\n\nAlso see ![usage report](https://tracker.example.com/pixel.png?d=secret)",
        ),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("model")) {
      await client.notify(
        "session/update",
        text(sessionId, `model:${sessionModel}`),
      )
      return { stopReason: "end_turn" }
    }
    if (prompt.includes("tool")) {
      const result = await callQuestdbTool(mcpServersOf(sessionId)[0])
      await client.notify("session/update", text(sessionId, `tables:${result}`))
      return { stopReason: "end_turn" }
    }
    await client.notify("session/update", text(sessionId, `echo:${prompt}`))
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    }
  })

if (process.env.FAKE_AGENT_PID_FILE) {
  appendFileSync(process.env.FAKE_AGENT_PID_FILE, `${process.pid}\n`)
}
await sleep(Number(process.env.FAKE_AGENT_START_DELAY_MS ?? 0))

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)
