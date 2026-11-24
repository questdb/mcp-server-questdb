import { AcpAgentProcess, type AcpAgentHandlers } from "./acpAgentProcess.js"
import type { AgentLaunch } from "./agentPresets.js"
import type { Log } from "../types.js"

// How many conversations keep their own agent process when the agent runs one
// per conversation. Past that, the least recently used idle one is stopped;
// its session is reopened from the store on its next message.
export const MAX_CONVERSATION_PROCESSES = 4

type AgentProcessesConfig = {
  launch: AgentLaunch
  cwd: string
  handlers: AcpAgentHandlers
  log: Log
  // Whether a conversation's turn is running, so its process is kept.
  isBusy: (conversationId: string) => boolean
  // Called when a conversation's process is stopped to make room.
  onRetired: (conversationId: string) => void
}

// The agent processes behind a chat. Most agents serve every conversation
// from one process. An agent that shares its sessions' MCP servers would send
// one conversation's QuestDB tool calls to another's route, so it gets a
// process per conversation instead.
export class AgentProcesses {
  private readonly shared: AcpAgentProcess | null
  // Most recently used last.
  private readonly byConversation = new Map<string, AcpAgentProcess>()
  // Started before the first message; the first conversation adopts it.
  private spare: AcpAgentProcess | null = null

  constructor(private readonly config: AgentProcessesConfig) {
    this.shared = config.launch.processPerConversation ? null : this.create()
  }

  get perConversation(): boolean {
    return this.shared === null
  }

  // The process that opens the session started before the first message.
  forWarmSession(): AcpAgentProcess {
    if (this.shared) return this.shared
    this.spare ??= this.create()
    return this.spare
  }

  forConversation(conversationId: string): AcpAgentProcess {
    if (this.shared) return this.shared
    const existing = this.byConversation.get(conversationId)
    if (existing) {
      this.byConversation.delete(conversationId)
      this.byConversation.set(conversationId, existing)
      return existing
    }
    const agentProcess = this.spare ?? this.create()
    this.spare = null
    this.byConversation.set(conversationId, agentProcess)
    this.retireExtra()
    return agentProcess
  }

  async stopAll(): Promise<void> {
    const all = [
      ...(this.shared ? [this.shared] : []),
      ...(this.spare ? [this.spare] : []),
      ...this.byConversation.values(),
    ]
    this.spare = null
    this.byConversation.clear()
    await Promise.all(all.map((agentProcess) => agentProcess.stop()))
  }

  private create(): AcpAgentProcess {
    const { launch, cwd, handlers, log } = this.config
    return new AcpAgentProcess({ launch, cwd, handlers, log })
  }

  private retireExtra(): void {
    for (const [conversationId, agentProcess] of this.byConversation) {
      if (this.byConversation.size <= MAX_CONVERSATION_PROCESSES) return
      if (this.config.isBusy(conversationId)) continue
      this.byConversation.delete(conversationId)
      void agentProcess.stop()
      this.config.onRetired(conversationId)
      this.config.log(
        "INFO",
        `stopped the idle agent process of conversation ${conversationId}`,
      )
    }
  }
}
