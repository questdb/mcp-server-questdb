# Changelog

All notable changes to `@questdb/mcp-server-questdb` (formerly
`@questdb/mcp-bridge`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 - 2026-08-11
### Changed

- Renamed the package to `@questdb/mcp-server-questdb`. Every release from
  0.3.0 on is published under both names with identical code, so commands
  printed by shipped consoles keep resolving. Versions below 0.3.0 exist
  only as `@questdb/mcp-bridge`, and rendered upgrade commands for those
  versions keep using the old name.
- `setup` and `upgrade` now pin agent configs to
  `@questdb/mcp-server-questdb`; `upgrade` still recognizes old-name pins
  and rewrites them.
- Renamed the executable to `mcp-server-questdb` (was `questdb-mcp-bridge`).
- Added the `mcpName` field for the official MCP Registry.
- The config key (`questdb`), the `MCP_BRIDGE_PORT` variable, and the log
  directory are unchanged.

## 0.2.0 - 2026-07-23
### Added

- `setup` command: interactive wizard that registers the bridge as an MCP
  server for Claude Code, Codex, Cursor, OpenCode, and Gemini CLI.
- `upgrade` command: updates the installed bridge and refreshes previously
  written agent configs, with dedicated handling for the Codex CLI.
- `version` and `help` CLI commands.
- File-based logging to `/tmp/questdb-mcp-bridge`, configurable via the
  `LOG_LEVEL` and `LOG_PATH` environment variables.
- Agents can abort in-flight query runs.
- `apply_notebook_state` supports notebook variables.
- The bridge now informs the user when the paired Web Console version does
  not match the bridge version.

### Changed

- The WebSocket server starts lazily on the first pairing request instead of
  at bridge launch.
- Renamed the `connect_web_console` tool to `get_pairing_credentials`.
- Synced the notebook tool surface with the Web Console and clarified tool
  definitions throughout; `apply_notebook_state` skips previously-run
  DDL/DML cells and its timeout was adjusted.
- Browser disconnects get a grace period before in-flight tool calls fail,
  and a reconnecting tab resumes its session immediately.
- Agent payloads are validated against the advertised tool schemas before
  being forwarded, with per-pairing validators, argument byte-size caps, and
  ReDoS-prone schema keywords stripped.
- Raised the minimum supported Node.js version to 22.

### Fixed

- Hardened the session lifecycle: grace timers are cleared on reconnect so a
  long call spanning a brief disconnect keeps its original deadline, and
  timed-out data-modifying calls carry verify-before-retry guidance instead
  of being blindly retried.
- Ping timeout no longer overrides a received pong; oversized payloads are
  handled gracefully; incompatible console connections are cleaned up before
  a new connection is accepted.
- Frames buffered behind a hello-timeout close can no longer pair a
  connection that already timed out.
- Pairing enforces a valid permission schema and no longer validates the
  schema reference itself.
- Falls back gracefully when synchronous writes to stdout/stderr fail.
- Corrected the published binary path.

## 0.1.0 - 2026-06-23

### Added
- Initial release
