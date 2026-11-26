import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { select } from "@inquirer/prompts"
import { render } from "@inquirer/testing"
import { describe, expect, it } from "vitest"
import {
  agentOptionsOf,
  agentQuestionOf,
  installedAgents,
  readLastAgent,
  writeLastAgent,
} from "../agent/chooseAgent.js"

const homeWith = (...folders: string[]): string => {
  const home = mkdtempSync(join(tmpdir(), "choose-agent-"))
  for (const folder of folders)
    mkdirSync(join(home, folder), { recursive: true })
  return home
}

describe("choosing the agent connect runs", () => {
  it("finds the installed agents by the folders their CLI creates", () => {
    // Given
    const home = homeWith(".codex", ".gemini", ".local/share/opencode")

    // When
    const found = installedAgents(home, {})

    // Then
    expect([...found]).toEqual(["codex", "gemini", "opencode"])
  })

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    // Given
    const home = homeWith("elsewhere/claude")

    // When
    const found = installedAgents(home, {
      CLAUDE_CONFIG_DIR: join(home, "elsewhere/claude"),
      CODEX_HOME: join(home, "missing"),
    })

    // Then
    expect([...found]).toEqual(["claude"])
  })

  it("offers the installed agents first, and preselects the last choice", () => {
    // When
    const firstRun = agentOptionsOf(new Set(["gemini", "codex"]), null)
    const later = agentOptionsOf(new Set(["gemini", "codex"]), "pi")

    // Then
    expect(firstRun.options.map((o) => o.id)).toEqual([
      "codex",
      "gemini",
      "claude",
      "copilot",
      "cursor",
      "opencode",
      "pi",
    ])
    expect(firstRun.options[0]).toEqual({
      id: "codex",
      label: "Codex",
      installed: true,
    })
    expect(firstRun.preselected).toBe("codex")
    expect(later.preselected).toBe("pi")
  })

  it("remembers the last agent, and ignores anything else in its file", async () => {
    // Given
    const path = join(homeWith(), "mcp-server", "last-agent")

    // When
    const before = await readLastAgent(path)
    await writeLastAgent("codex", path)
    const after = await readLastAgent(path)

    // Then
    expect(before).toBeNull()
    expect(after).toBe("codex")
  })

  it("asks with the installed agents first, and Enter takes the preselected one", async () => {
    // Given
    const { answer, events, getScreen } = await render(
      select,
      agentQuestionOf(new Set(["codex", "gemini"]), null),
    )

    // When
    const screen = getScreen()
    events.keypress("enter")

    // Then
    expect(screen).toContain(
      "Select an agent to use in QuestDB Web Console",
    )
    expect(screen.indexOf("Codex")).toBeLessThan(screen.indexOf("Claude Code"))
    expect(screen).toContain("installed")
    expect(await answer).toBe("codex")
  })
})
