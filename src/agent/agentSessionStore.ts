import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Log } from "../types.js"

const MAX_SESSIONS_PER_AGENT = 200

type StoreFile = Record<string, Record<string, string>>

// Remembers which agent session belongs to which console conversation, so a
// conversation picks up its agent context again after the bridge restarts.
// Keyed by agent id and working folder, since a session only resumes there.
export class AgentSessionStore {
  private sessions = new Map<string, string>()
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly agentKey: string,
    private readonly log: Log,
  ) {}

  async load(): Promise<void> {
    const file = await this.readFile()
    this.sessions = new Map(Object.entries(file[this.agentKey] ?? {}))
  }

  get(conversationId: string): string | undefined {
    return this.sessions.get(conversationId)
  }

  async set(conversationId: string, sessionId: string): Promise<void> {
    this.sessions.delete(conversationId)
    this.sessions.set(conversationId, sessionId)
    while (this.sessions.size > MAX_SESSIONS_PER_AGENT) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    await this.save()
  }

  async delete(conversationId: string): Promise<void> {
    if (this.sessions.delete(conversationId)) await this.save()
  }

  private async readFile(): Promise<StoreFile> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as StoreFile
    } catch {
      return {}
    }
  }

  // Saves run one after another, each re-reading the file, so concurrent
  // sessions never interleave writes and other agents' entries survive.
  private save(): Promise<void> {
    this.saving = this.saving.then(() => this.writeStore())
    return this.saving
  }

  private async writeStore(): Promise<void> {
    try {
      const file = await this.readFile()
      file[this.agentKey] = Object.fromEntries(this.sessions)
      await mkdir(dirname(this.path), { recursive: true })
      const staging = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
      await writeFile(staging, JSON.stringify(file))
      await rename(staging, this.path)
    } catch (err) {
      this.log(
        "WARN",
        `could not save agent sessions: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
