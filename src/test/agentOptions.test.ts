import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  configChanges,
  SESSION_MODEL_ID,
  toAgentConfig,
} from "../agent/agentConfig.js"
import {
  elicitationContentOf,
  questionFieldsOf,
  skippedContentOf,
  SKIPPED_ANSWER,
} from "../agent/agentQuestions.js"
import { describeAgentError } from "../agent/agentErrors.js"
import { resolveAgentLaunch } from "../agent/agentPresets.js"
import { autoApprovalOf, isQuestdbToolCall } from "../agent/agentPermissions.js"
import { spawnCommandOf } from "../agent/acpAgentProcess.js"
import {
  parseInboundAgentMessage,
  rejectionOf,
} from "../agent/inboundMessages.js"
import {
  connectUsage,
  parseConnectOptions,
  type ConnectOptions,
} from "../agent/connectOptions.js"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"

// The options of a `connect` command line that parsed.
const connectOptionsOf = (
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = "/",
): ConnectOptions => {
  const parsed = parseConnectOptions(args, env, cwd)
  if (parsed.kind !== "options") throw new Error(JSON.stringify(parsed))
  return parsed.options
}

describe("parseConnectOptions", () => {
  it("leaves the agent to ask for, in the MCP server's own workspace, for the local console by default", () => {
    // When
    const options = connectOptionsOf([], {}, "/home/me/project")

    // Then
    expect(options.agent).toBeNull()
    expect(options.workspace).toMatch(
      /[/\\]\.questdb[/\\]mcp-server[/\\]workspace$/,
    )
    expect(options.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(options.openBrowser).toBe(true)
  })

  it("takes the console URL as its argument, with the path it is served under, before CONSOLE_ORIGIN", () => {
    // When
    const fromArgument = connectOptionsOf(
      ["https://questdb.acme.io/console/?tab=1"],
      { CONSOLE_ORIGIN: "http://localhost:9000" },
    )
    const fromEnv = connectOptionsOf([], {
      CONSOLE_ORIGIN: "http://localhost:9000/",
    })

    // Then
    expect(fromArgument.consoleOrigin).toBe("https://questdb.acme.io")
    expect(fromArgument.consoleUrl).toBe("https://questdb.acme.io/console")
    expect(fromEnv.consoleOrigin).toBe("http://localhost:9000")
    expect(fromEnv.consoleUrl).toBe("http://localhost:9000")
  })

  it("rejects a console URL that is not a web address, and a second one", () => {
    // When
    const notUrl = parseConnectOptions(["questdb.acme.io"], {}, "/")
    const notWeb = parseConnectOptions(["ftp://questdb.acme.io"], {}, "/")
    const badEnv = parseConnectOptions([], { CONSOLE_ORIGIN: "nope" }, "/")
    const two = parseConnectOptions(
      ["https://a.example", "https://b.example"],
      {},
      "/",
    )

    // Then
    expect(notUrl).toEqual({
      kind: "error",
      error:
        "The console URL 'questdb.acme.io' is not a URL. Use the Web Console's address, like https://questdb.example.com.",
    })
    expect(notWeb).toEqual({
      kind: "error",
      error:
        "The console URL 'ftp://questdb.acme.io' must start with http:// or https://.",
    })
    expect(badEnv.kind === "error" && badEnv.error).toContain(
      "CONSOLE_ORIGIN 'nope' is not a URL",
    )
    expect(two).toEqual({
      kind: "error",
      error:
        "connect takes one Web Console URL, but got 2: https://a.example https://b.example",
    })
  })

  it("runs a custom command under the name it is given, in the workspace it is given", () => {
    // When
    const options = connectOptionsOf(
      [
        "--agent-command",
        "node agent.mjs --flag",
        "--agent-name",
        "My agent",
        "--workspace",
        "work",
      ],
      {},
      "/home/me",
    )

    // Then
    expect(options.agent).toEqual({
      kind: "custom",
      launch: {
        id: "custom",
        label: "My agent",
        command: "node",
        args: ["agent.mjs", "--flag"],
        env: {},
      },
    })
    expect(options.workspace).toBe("/home/me/work")
  })

  it("asks for help with --help or -h, and rejects the options it does not know", () => {
    // When
    const help = parseConnectOptions(["https://a.example", "--help"], {}, "/")
    const short = parseConnectOptions(["-h"], {}, "/")
    const cwd = parseConnectOptions(["--cwd", "work"], {}, "/")

    // Then
    expect(help).toEqual({ kind: "help" })
    expect(short).toEqual({ kind: "help" })
    expect(cwd.kind === "error" && cwd.error).toContain("--cwd")
  })

  it("names --port, not MCP_BRIDGE_PORT, when --port is not a port", () => {
    // When
    const parsed = parseConnectOptions(["--port", "abc"], {}, "/")

    // Then
    expect(parsed).toEqual({
      kind: "error",
      error: "--port abc must be an integer",
    })
  })

  it("rejects an unknown agent with the list of known ones", () => {
    // When
    const parsed = parseConnectOptions(["--agent", "kiro"], {}, "/")

    // Then
    expect(parsed).toEqual({
      kind: "error",
      error:
        "unknown agent 'kiro'. Use one of: claude, codex, gemini, copilot, cursor, opencode, pi",
    })
  })

  it("remembers whether --port or MCP_BRIDGE_PORT fixed the port, --port first", () => {
    // When
    const byOption = connectOptionsOf(["--port", "9123"], {
      MCP_BRIDGE_PORT: "9456",
    })
    const byEnv = connectOptionsOf([], { MCP_BRIDGE_PORT: "9456" })
    const free = connectOptionsOf([])

    // Then
    expect(byOption.pinnedPort).toEqual({
      port: 9123,
      by: { name: "--port", unpin: "leave out --port" },
    })
    expect(byEnv.pinnedPort).toEqual({
      port: 9456,
      by: { name: "MCP_BRIDGE_PORT", unpin: "unset MCP_BRIDGE_PORT" },
    })
    expect(free.pinnedPort).toBeNull()
  })
})

describe("connectUsage", () => {
  it("lists every argument of connect, with its default", () => {
    // When
    const usage = connectUsage("npx @questdb/mcp-server-questdb")

    // Then
    for (const text of [
      "npx @questdb/mcp-server-questdb connect [console-url] [options]",
      "Default console-url: $CONSOLE_ORIGIN, or http://127.0.0.1:9000",
      "--agent <name>",
      "claude, codex, gemini, copilot,",
      "cursor, opencode, pi.",
      "Asks when left out.",
      "--workspace <dir>",
      "--agent-command",
      "--agent-name <name>",
      "--port <n>",
      "--no-open",
      "-h, --help",
    ]) {
      expect(usage).toContain(text)
    }
    expect(usage).not.toMatch(/bridge|--cwd|--console-origin|\bserve\b/)
    for (const line of usage.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })
})

describe("parseInboundAgentMessage", () => {
  it("takes a few images in a prompt, and rejects others", () => {
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
    const promptWith = (...blocks: unknown[]) =>
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_prompt",
        conversationId: "c1",
        turnId: "t1",
        prompt: [{ type: "text", text: "hi" }, ...blocks],
      })
    expect(promptWith(image)).not.toBeNull()
    expect(promptWith({ ...image, mimeType: "image/svg+xml" })).toBeNull()
    expect(promptWith({ ...image, data: "not base64!" })).toBeNull()
    expect(promptWith(image, image, image, image, image)).toBeNull()
  })

  it("accepts well formed frames and rejects malformed ones", () => {
    expect(
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_settings",
        model: null,
        effort: "high",
      }),
    ).not.toBeNull()
    expect(
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_settings",
        model: 5,
        effort: null,
      }),
    ).toBeNull()
    expect(
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_prompt",
        conversationId: "",
        turnId: "t1",
        prompt: [{ type: "text", text: "hi" }],
      }),
    ).toBeNull()
    expect(
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_prompt",
        conversationId: "c1",
        turnId: "t1",
        prompt: [{ type: "image", data: "…" }],
      }),
    ).toBeNull()
  })

  it("takes text and images up to their limits, and nothing past them", () => {
    const promptWith = (...blocks: unknown[]) =>
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_prompt",
        conversationId: "c1",
        turnId: "t1",
        prompt: blocks,
      })
    const text = (length: number) => ({
      type: "text",
      text: "x".repeat(length),
    })
    const image = (length: number) => ({
      type: "image",
      mimeType: "image/png",
      data: "A".repeat(length),
    })
    expect(promptWith(text(600_000), text(400_000))).not.toBeNull()
    expect(promptWith(text(600_000), text(400_001))).toBeNull()
    expect(promptWith(text(1), image(7_000_000))).not.toBeNull()
    expect(promptWith(text(1), image(7_000_001))).toBeNull()
  })

  it("takes long answers to a question, up to a million characters in all", () => {
    const answerWith = (answers: Record<string, string | string[]>) =>
      parseInboundAgentMessage({
        v: MCP_BRIDGE_VERSION,
        type: "agent_question_answer",
        requestId: "r1",
        answers,
      })
    const fields = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`f${i}`, "a"]),
      )
    expect(answerWith({ note: "x".repeat(10_001) })).not.toBeNull()
    expect(answerWith({ note: "x".repeat(1_000_000) })).not.toBeNull()
    expect(
      answerWith({ a: "x".repeat(600_000), b: ["y".repeat(400_001)] }),
    ).toBeNull()
    expect(answerWith(fields(50))).not.toBeNull()
    expect(answerWith(fields(51))).toBeNull()
  })
})

describe("rejectionOf", () => {
  it("names the prompt or the question a rejected frame was for, and nothing else", () => {
    const prompt = rejectionOf({
      type: "agent_prompt",
      conversationId: "c1",
      turnId: "t1",
    })
    const answer = rejectionOf({
      type: "agent_question_answer",
      requestId: "r1",
    })
    expect(prompt).toMatchObject({
      type: "agent_prompt",
      conversationId: "c1",
      turnId: "t1",
    })
    expect(prompt?.reason).toMatch(/could not be sent to the agent/)
    expect(answer).toMatchObject({
      type: "agent_question_answer",
      requestId: "r1",
    })
    expect(answer?.reason).toMatch(/could not be sent to the agent/)
    expect(
      rejectionOf({ type: "agent_prompt", conversationId: "c1" }),
    ).toBeNull()
    expect(rejectionOf({ type: "agent_settings" })).toBeNull()
    expect(rejectionOf("agent_prompt")).toBeNull()
  })
})

describe("spawnCommandOf", () => {
  it("quotes a command run through the shell, so a path with a space stays whole", () => {
    const command =
      "C:\\Users\\John Doe\\AppData\\Local\\cursor-agent\\cursor-agent.cmd"
    expect(spawnCommandOf({ command, shell: true })).toBe(`"${command}"`)
    expect(spawnCommandOf({ command: `"${command}"`, shell: true })).toBe(
      `"${command}"`,
    )
    expect(spawnCommandOf({ command: "/usr/bin/node" })).toBe("/usr/bin/node")
  })
})

describe("agent config", () => {
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: "opus",
      options: [
        {
          group: "anthropic",
          name: "Anthropic",
          options: [
            { value: "opus", name: "Opus" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Effort",
      type: "select" as const,
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ]

  it("finds the model by category and the effort by its well known id, flattening groups", () => {
    // When
    const config = toAgentConfig({ configOptions: options })

    // Then
    expect(config.model).toEqual({
      id: "model",
      current: "opus",
      choices: [
        { value: "opus", name: "Opus", description: null, group: "Anthropic" },
        {
          value: "sonnet",
          name: "Sonnet",
          description: null,
          group: "Anthropic",
        },
      ],
    })
    expect(config.effort?.id).toBe("reasoning_effort")
  })

  it("keeps the first entry for each model ID rather than each label", () => {
    // Given a model ID repeated across groups and two distinct IDs with the same label
    const model = {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: "auto",
      options: [
        {
          group: "recommended",
          name: "Recommended",
          options: [
            {
              value: "auto",
              name: "Auto",
              description: "Let Copilot pick the best model",
            },
          ],
        },
        {
          group: "models",
          name: "Models",
          options: [
            { value: "auto", name: "Auto", description: "Auto" },
            { value: "agent-auto", name: "Auto" },
          ],
        },
      ],
    }

    // When
    const config = toAgentConfig({ configOptions: [model] })

    // Then
    expect(config.model).toEqual({
      id: "model",
      current: "auto",
      choices: [
        {
          value: "auto",
          name: "Auto",
          description: "Let Copilot pick the best model",
          group: "Recommended",
        },
        {
          value: "agent-auto",
          name: "Auto",
          description: null,
          group: "Models",
        },
      ],
    })
  })

  it("changes only settings that differ and that the agent offers", () => {
    // Given
    const config = toAgentConfig({ configOptions: options })

    // When
    const changes = configChanges(config, {
      model: "sonnet",
      effort: "extreme",
    })

    // Then
    expect(changes).toEqual([{ configId: "model", value: "sonnet" }])
  })
})

describe("agent permissions", () => {
  const request = (toolCall: Record<string, unknown>) => ({
    sessionId: "s1",
    toolCall: { toolCallId: "t1", ...toolCall },
    options: [
      {
        optionId: "always",
        name: "Always allow",
        kind: "allow_always" as const,
      },
      { optionId: "once", name: "Allow once", kind: "allow_once" as const },
    ],
  })

  it("recognises a QuestDB tool only by its structured name, never by a title the agent writes", () => {
    expect(
      isQuestdbToolCall({
        toolCallId: "t",
        name: "mcp__questdb_console__get_tables",
      }),
    ).toBe(true)
    expect(
      isQuestdbToolCall({
        toolCallId: "t",
        name: "mcp.questdb_console.run_query",
      }),
    ).toBe(true)
    expect(
      isQuestdbToolCall({
        toolCallId: "t",
        title: "grep -r questdb_console .",
        kind: "execute",
      }),
    ).toBe(false)
    expect(
      isQuestdbToolCall({
        toolCallId: "t",
        title: "mcp__questdb_console__get_tables",
      }),
    ).toBe(false)
    expect(
      isQuestdbToolCall({
        toolCallId: "t",
        name: "mcp__questdb_console__get_tables",
        kind: "execute",
      }),
    ).toBe(false)
  })

  it("allows QuestDB tools for the session and the agent's own tools one call at a time", () => {
    expect(
      autoApprovalOf(request({ name: "mcp__questdb_console__get_tables" })),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    })
    expect(
      autoApprovalOf(request({ title: "rm -rf build", kind: "execute" })),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    })
  })
})

describe("agent models outside config options", () => {
  it("deduplicates the session's models field by model ID too", () => {
    // Given the same model ID twice in the legacy list
    const models = {
      currentModelId: "auto",
      availableModels: [
        { modelId: "auto", name: "Auto", description: "Pick a model" },
        { modelId: "auto", name: "Auto" },
      ],
    }

    // When
    const config = toAgentConfig({ models })

    // Then
    expect(config.model?.choices).toEqual([
      { value: "auto", name: "Auto", description: "Pick a model", group: null },
    ])
  })

  it("offers the models of a session's models field, switched with session/set_model", () => {
    // Given a session that lists its models the way Gemini CLI does
    const config = toAgentConfig({
      configOptions: [],
      models: {
        currentModelId: "auto",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        ],
      },
    })

    // When
    const changes = configChanges(config, {
      model: "gemini-2.5-pro",
      effort: null,
    })

    // Then
    expect(config.model?.choices.map((choice) => choice.name)).toEqual([
      "Auto",
      "Gemini 2.5 Pro",
    ])
    expect(changes).toEqual([
      { configId: SESSION_MODEL_ID, value: "gemini-2.5-pro" },
    ])
  })
})

describe("agent errors", () => {
  const launch = (id: string, label: string) => ({
    id,
    label,
    command: "agent",
    args: [],
    env: {},
  })

  it("tells the user how to sign in to each agent, and when the account may not use it", () => {
    // When
    const gemini = describeAgentError(
      Object.assign(new Error("Gemini API key is missing or not configured."), {
        code: -32000,
      }),
      launch("gemini", "Gemini CLI"),
    )
    const copilot = describeAgentError(
      new Error(
        '403 "unauthorized: not authorized to use this Copilot feature"',
      ),
      launch("copilot", "GitHub Copilot"),
    )

    // Then
    expect(gemini).toBe(
      "Sign in to Gemini CLI: run `npx @google/gemini-cli` in your terminal and sign in with Google. Then send your message again.",
    )
    expect(copilot).toMatch(/cannot use Copilot CLI/)
  })

  it("shows the innermost message of an API error passed on as JSON", () => {
    // Given
    const apiError = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: { code: 400, message: "API key not valid." },
        }),
      },
    })

    // When
    const message = describeAgentError(
      new Error(apiError),
      launch("gemini", "Gemini CLI"),
    )

    // Then
    expect(message).toBe("API key not valid.")
  })
})

describe("the Cursor preset", () => {
  const folders: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  const emptyHome = () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-home-"))
    folders.push(home)
    vi.stubEnv("HOME", home)
    vi.stubEnv("USERPROFILE", home)
    return home
  }

  // A Cursor CLI in ~/.local/bin, where its installer puts it, answering
  // `help acp` with `helpAcp`.
  const installCursor = (home: string, helpAcp: string): string => {
    const bin = join(home, ".local", "bin")
    mkdirSync(bin, { recursive: true })
    const command = join(bin, "cursor-agent")
    writeFileSync(
      command,
      `#!/bin/sh\nif [ "$1 $2" = "help acp" ]; then\n${helpAcp}\nfi\n`,
    )
    chmodSync(command, 0o755)
    return command
  }

  const resolveCursor = (log = vi.fn()) =>
    resolveAgentLaunch(
      { kind: "preset", id: "cursor" },
      { log, notify: vi.fn() },
    )

  it.skipIf(process.platform === "win32")(
    "runs the user's own Cursor CLI from ~/.local/bin, signing in with cursor_login",
    async () => {
      // Given a Cursor CLI that has ACP
      const home = emptyHome()
      vi.stubEnv("PATH", "")
      const command = installCursor(home, `echo "Usage: agent acp [options]"`)

      // When
      const resolved = await resolveCursor()

      // Then
      expect(resolved).toMatchObject({
        id: "cursor",
        label: "Cursor",
        command,
        args: ["acp"],
        authMethodId: "cursor_login",
      })
    },
  )

  it.skipIf(process.platform === "win32")(
    "asks to update a Cursor CLI too old to have ACP",
    async () => {
      // Given a Cursor CLI that answers `help acp` with its general help
      const home = emptyHome()
      vi.stubEnv("PATH", "")
      installCursor(home, `echo "Usage: agent [options] [command] [prompt...]"`)

      // When
      const resolving = resolveCursor()

      // Then
      await expect(resolving).rejects.toThrow(
        "Your Cursor CLI is too old to work with the QuestDB Web Console. Update it with `cursor-agent update`, then run the connect command again.",
      )
    },
  )

  it.skipIf(process.platform === "win32")(
    "starts a Cursor CLI whose version cannot be checked, and logs why",
    async () => {
      // Given a Cursor CLI that fails to answer `help acp`
      const home = emptyHome()
      vi.stubEnv("PATH", "")
      const command = installCursor(home, "exit 3")
      const log = vi.fn()

      // When
      const resolved = await resolveCursor(log)

      // Then
      expect(resolved.command).toBe(command)
      expect(log).toHaveBeenCalledWith(
        "WARN",
        expect.stringContaining(`could not check ${command}`),
      )
    },
  )

  it("explains how to install the Cursor CLI when it is missing", async () => {
    // Given
    emptyHome()
    vi.stubEnv("PATH", "")

    // When
    const resolving = resolveCursor()

    // Then
    await expect(resolving).rejects.toThrow(/Install the Cursor CLI/)
  })
})

describe("agent questions", () => {
  it("turns Claude Code's per-question Other box into the question's own answer", () => {
    // Given a question the way Claude Code asks it
    const schema = {
      type: "object" as const,
      properties: {
        question_0: {
          type: "string" as const,
          title: "Database",
          oneOf: [
            { const: "QuestDB", title: "QuestDB" },
            { const: "Postgres", title: "Postgres" },
          ],
        },
        question_0_custom: { type: "string" as const, title: "Other" },
      },
    }

    // When
    const fields = questionFieldsOf(schema)
    const content = elicitationContentOf(schema, {
      question_0_custom: "SQLite",
    })

    // Then
    expect(fields).toHaveLength(1)
    expect(fields?.[0]).toMatchObject({
      id: "question_0",
      otherFieldId: "question_0_custom",
    })
    expect(content).toEqual({ question_0_custom: "SQLite" })
  })

  it("replaces Codex's None of the above with the own answer and picks it when the user types one", () => {
    // Given a question the way Codex asks it
    const schema = {
      type: "object" as const,
      properties: {
        question_0: {
          type: "string" as const,
          title: "Which database should we use?",
          oneOf: [
            { const: "QuestDB", title: "QuestDB" },
            { const: "None of the above", title: "None of the above" },
          ],
        },
        question_0_note: {
          type: "string" as const,
          title: "Additional answer or note",
        },
      },
      required: ["question_0"],
    }

    // When
    const fields = questionFieldsOf(schema)
    const ownAnswer = elicitationContentOf(schema, {
      question_0_note: "SQLite",
    })
    const pick = elicitationContentOf(schema, { question_0: "QuestDB" })

    // Then
    expect(fields).toHaveLength(1)
    expect(fields?.[0]).toMatchObject({
      otherFieldId: "question_0_note",
      options: [{ value: "QuestDB", label: "QuestDB", description: null }],
    })
    expect(ownAnswer).toEqual({
      question_0: "None of the above",
      question_0_note: "SQLite",
    })
    expect(pick).toEqual({ question_0: "QuestDB" })
  })

  it("writes a skip as an answer in every own-answer and free-text field", () => {
    // Given a choice the way Codex asks it, and a free-text question
    const schema = {
      type: "object" as const,
      properties: {
        question_0: {
          type: "string" as const,
          title: "Which table should I analyze?",
          oneOf: [
            { const: "trades", title: "trades" },
            { const: "None of the above", title: "None of the above" },
          ],
        },
        question_0_note: {
          type: "string" as const,
          title: "Additional answer or note",
        },
        question_1: { type: "string" as const, title: "Anything else?" },
      },
      required: ["question_0"],
    }

    // When
    const content = skippedContentOf(schema)

    // Then nothing is chosen, and the agent reads that the user skipped
    expect(content).toEqual({
      question_0: "None of the above",
      question_0_note: SKIPPED_ANSWER,
      question_1: SKIPPED_ANSWER,
    })
  })
})
