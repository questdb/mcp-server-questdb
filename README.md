# QuestDB MCP Server

An MCP server that connects coding agents (Claude Code, Codex, Cursor, OpenCode, Gemini CLI) to a
running QuestDB Web Console. The agent gets tools to create notebook
cells, run queries, and build charts. Every action executes in the
browser against your already-established QuestDB session.

## Setup

### Quick setup (recommended)

The interactive wizard detects your installed coding agents and
writes the MCP server into each one's MCP config:

```bash
npx @questdb/mcp-server-questdb setup
```

It walks you through two steps:

1. **Pick agents**: multi-select from the ones it detects (Claude Code,
   Codex, Cursor, OpenCode, Gemini CLI).
2. **Review settings**: optionally override `CONSOLE_ORIGIN` and
   `MCP_BRIDGE_PORT`; press Enter to keep the defaults.

The wizard pins each agent's config to the MCP server version that ran it. Your
QuestDB Web Console expects a specific MCP server version. If you're on an older
console, run the matching version: `npx @questdb/mcp-server-questdb@<version> setup`. The config it writes will launch that same version. (When unsure, pair first; on a version mismatch the agent is told which version to switch to.)
For versions earlier than 0.3.0, use the former package name instead:
`npx @questdb/mcp-bridge@<version> setup`.

### Manual setup

Or add it to your MCP client's config by hand (e.g. `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "questdb": {
      "command": "npx",
      "args": ["-y", "@questdb/mcp-server-questdb"]
    }
  }
}
```

### Offline / restricted install (no npx)

Environments that can't run `npx` (no npm registry access, vet-then-vendor
policies) can use the standalone bundle attached to each supported version's
[GitHub Release](https://github.com/questdb/mcp-server-questdb/releases):
a single self-contained `.mjs` file needing only Node ≥ 22, making no
network connections except the local WebSocket to your Web Console.

Standalone bundles are available starting with version 0.4.0. All
supported QuestDB Web Console versions request version 0.4.0 or later.

Download the bundle (`mcp-server-questdb-<version>.mjs`) and
`THIRD_PARTY_NOTICES.txt` from the release, then move the bundle to a
permanent location before setup—do not configure it from
a downloads or temporary directory—and invoke that exact path:

```bash
node /permanent/absolute/path/mcp-server-questdb-<version>.mjs setup
```

Setup writes agent configs that launch the bundle file directly (no npx
involved), so moving or deleting that exact path will prevent the MCP server
from starting. To switch versions, put the matching bundle beside the current
one and run `node /permanent/absolute/path/mcp-server-questdb-<new-version>.mjs upgrade`;
it re-points your agent configs at the new file while keeping env
settings. If a configured file was already moved, run `upgrade` from its new
absolute path. `setup` and `upgrade` always write the install style of the
binary you run: a bundle writes file-path configs; npx writes npx configs.

### Environment variables

| Label             | Value                               | Default Value                                | Description                                                                                                                                                             |
| ----------------- | ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSOLE_ORIGIN`  | origin URL                          | `http://127.0.0.1:9000`                      | QuestDB Web Console origin. `127.0.0.1` and `localhost` are interchangeable.                                                                                            |
| `MCP_BRIDGE_PORT` | `1`–`65535`                         | auto-allocated                               | When specified, the MCP server uses a fixed port. The port is bound on the first pairing attempt, pairing fails with a `bridge_bind_failed` error if the port is taken. |
| `LOG_PATH`        | file path                           | `/tmp/questdb-mcp-bridge/<ISO-ts>-<pid>.log` | Override the log file location.                                                                                                                                         |
| `LOG_LEVEL`       | `ERROR` / `WARN` / `INFO` / `DEBUG` | `INFO`                                       | `DEBUG` adds heartbeats and full tool payloads.                                                                                                                         |

## Commands

Your coding agent starts the MCP server for you from the config above, so
you rarely run it by hand. The commands you run:

| Command                                                 | Description                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npx @questdb/mcp-server-questdb setup`                 | Configure QuestDB MCP Server for your coding agents (interactive).     |
| `npx @questdb/mcp-server-questdb upgrade`               | Update QuestDB MCP Server version.                                     |
| `npx @questdb/mcp-server-questdb connect [console-url]` | Run your coding agent for the Web Console at `console-url`. See below. |
| `npx @questdb/mcp-server-questdb --version`             | Print the version and exit. Alias: `-v`.                               |
| `npx @questdb/mcp-server-questdb --help`                | Print the commands and their options, and exit. Alias: `-h`.           |

An unknown command exits non-zero with a short error. Pin a version with
`npx @questdb/mcp-server-questdb@<version>`. (Installed on your `PATH`, the
executable is named `mcp-server-questdb`.)

## Pairing

Before any notebook / chart / SQL tool works, your browser has to pair
with the MCP server. The agent drives the flow.

When the agent needs to pair, it calls `get_pairing_credentials` and
shows you **both**:

- A one-click deep link — open it in the tab showing your Web Console.
- A WebSocket URL + token — paste into the **MCP pill** at the bottom
  of the Web Console if the deep link doesn't land in the right tab.

Either path lands you on a consent prompt. Accept it and the agent's
next tool call goes through.

Each MCP server run generates a fresh port and pairing token, held only in
memory. On restart the old credentials stop working — the agent will
surface new ones the next time it needs to pair.

## Chat with your coding agent in the Web Console (`connect`)

`connect` turns the direction around: you chat with your coding agent in the
AI Assistant of the Web Console, and the agent works on your notebooks.

```bash
npx @questdb/mcp-server-questdb connect https://questdb.example.com
```

1. The MCP server installs the agent's pinned [ACP](https://agentclientprotocol.com)
   package on first use, into `~/.questdb/mcp-server/agents`. The versions
   and the full dependency trees are locked in
   `src/consts/agent-installs.json`; `npm ci` installs exactly that tree.
   This first run needs npm, which comes with Node.js, and internet access.
   An install whose files go missing is installed again.
2. It starts the agent and prints a pairing link. Open it and accept the
   prompt; the AI Assistant opens with the agent selected.
3. Pick the agent's model and effort in the chat, next to the message box.

The agent runs in `~/.questdb/mcp-server/workspace` unless you pass
`--workspace`. Each agent signs in with its own login:

| `--agent`  | Agent          | Runs                                    | Sign in                                                |
| ---------- | -------------- | --------------------------------------- | ------------------------------------------------------ |
| `claude`   | Claude Code    | `@agentclientprotocol/claude-agent-acp` | `claude`, then /login; or `ANTHROPIC_API_KEY`          |
| `codex`    | Codex          | `@agentclientprotocol/codex-acp`        | `codex login`; or `OPENAI_API_KEY`                     |
| `cursor`   | Cursor         | your own Cursor CLI, `cursor-agent acp` | `cursor-agent login`; or `CURSOR_API_KEY`              |
| `pi`       | Pi             | `@openma/pi-acp`                        | `pi`, then /login; or its provider's API key           |
| `gemini`   | Gemini CLI     | `@google/gemini-cli --acp`              | `npx @google/gemini-cli` once; or `GEMINI_API_KEY`     |
| `copilot`  | GitHub Copilot | `@github/copilot --acp`                 | `npx @github/copilot login`                            |
| `opencode` | OpenCode       | `opencode-ai`, `opencode acp`           | none for its free models; `npx opencode-ai auth login` |

The agent works like it does in its own CLI: whatever it asks permission for,
the MCP server approves, so file edits and commands run without asking you.
Questions the agent asks you, such as which of a few options to take, appear
in the chat in place of the message box.

Cursor is not installed by the MCP server: install the
[Cursor CLI](https://cursor.com/cli) yourself. It needs a Cursor CLI from
March 2026 or later, which has ACP; `cursor-agent update` updates an older
one.

OpenCode shares the MCP servers of all its sessions, so the MCP server runs
one OpenCode process per conversation (at most four at a time; an idle one is
stopped and its session picked up again on its next message).

| Argument                  | Description                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `[console-url]`           | The Web Console's address. Default: `$CONSOLE_ORIGIN`, or `http://127.0.0.1:9000`.             |
| `--agent <name>`          | The agent to run, from the table above. Default: `claude`.                                     |
| `--workspace <dir>`       | The folder the agent works in. Default: `~/.questdb/mcp-server/workspace`.                     |
| `--agent-command "<cmd>"` | Advanced: run another ACP agent instead, named with `--agent-name <name>`.                     |
| `--port <n>`              | Advanced: fixed port for the console's connection. Default: `$MCP_BRIDGE_PORT`, or a free one. |
| `--no-open`               | Advanced: print the console link without opening it.                                           |
| `-h`, `--help`            | Print these arguments and exit.                                                                |

The QuestDB tools reach the agent as an MCP server named `questdb_console`
on a loopback port, with a separate route per conversation. Conversations
keep their agent session across MCP server restarts. If the agent's own
configuration also has a QuestDB MCP server (for example from `setup`), the
agent may pick that one instead; remove it from the agent's configuration
when you use `connect`. To update the pinned packages, edit
`src/scripts/lock-agents.js` and run it; it refuses versions with high or
critical advisories.

## Logs

The MCP server writes to stderr and to a log file. Tail the newest:

```bash
tail -F "$(ls -t /tmp/questdb-mcp-bridge/*.log | head -1)"
```

At default `INFO`:

```
2026-05-15T12:29:27.142Z [INFO] tool_call: run_query
2026-05-15T12:29:27.318Z [INFO] tool_result: run_query ok
2026-05-15T12:29:28.011Z [ERROR] tool_result: update_cell internal_error timeout after 15000ms
```

At `DEBUG` (full payloads as continuation lines):

```
2026-05-15T12:29:27.142Z [INFO] tool_call: run_query
2026-05-15T12:29:27.142Z [DEBUG]   args: {"query":"SELECT count() FROM trades"}
2026-05-15T12:29:27.318Z [INFO] tool_result: run_query ok
2026-05-15T12:29:27.318Z [DEBUG]   content: [{"type":"text","text":"..."}]
```

## License

Apache-2.0.
