import type * as acp from "@agentclientprotocol/sdk"
import type {
  AgentConfig,
  AgentConfigChoice,
  AgentConfigSetting,
} from "../agentProtocol.js"

// Agents name the same setting differently. The ACP category is preferred;
// these ids cover adapters that leave it out.
const MODEL_IDS = ["model"]
const EFFORT_IDS = [
  "effort",
  "reasoning_effort",
  "thinkingLevel",
  "thought_level",
]

type SelectOption = Extract<acp.SessionConfigOption, { type: "select" }>

const isSelect = (option: acp.SessionConfigOption): option is SelectOption =>
  option.type === "select"

const choicesOf = (option: SelectOption): AgentConfigChoice[] =>
  option.options.flatMap((entry): AgentConfigChoice[] =>
    "group" in entry
      ? entry.options.map((choice) => ({
          value: choice.value,
          name: choice.name,
          description: choice.description ?? null,
          group: entry.name,
        }))
      : [
          {
            value: entry.value,
            name: entry.name,
            description: entry.description ?? null,
            group: null,
          },
        ],
  )

const findSetting = (
  options: acp.SessionConfigOption[],
  category: string,
  ids: string[],
): AgentConfigSetting | null => {
  const option =
    options
      .filter(isSelect)
      .find((candidate) => candidate.category === category) ??
    options.filter(isSelect).find((candidate) => ids.includes(candidate.id))
  return option
    ? {
        id: option.id,
        current: option.currentValue,
        choices: choicesOf(option),
      }
    : null
}

// The id of a model setting that comes from a session's `models` field rather
// than its config options. It is switched with session/set_model.
export const SESSION_MODEL_ID = "session/set_model"

// The `models` field some agents, like Gemini CLI, report instead of a model
// config option. It is not part of the stable ACP schema.
export type SessionModels = {
  currentModelId: string
  availableModels: {
    modelId: string
    name: string
    description?: string | null
  }[]
}

const sessionModelSetting = (
  models: SessionModels | null | undefined,
): AgentConfigSetting | null =>
  models && models.availableModels.length > 0
    ? {
        id: SESSION_MODEL_ID,
        current: models.currentModelId,
        choices: models.availableModels.map((model) => ({
          value: model.modelId,
          name: model.name,
          description: model.description ?? null,
          group: null,
        })),
      }
    : null

// A session's response or update, as far as the console's settings go.
export type SessionSettings = {
  configOptions?: acp.SessionConfigOption[] | null
  models?: SessionModels | null
}

export const toAgentConfig = ({
  configOptions,
  models,
}: SessionSettings): AgentConfig => {
  const options = configOptions ?? []
  const model =
    findSetting(options, "model", MODEL_IDS) ?? sessionModelSetting(models)

  // The protocol selects by value, so duplicate IDs are the same choice.
  // Keep the first entry's label, description, and position.
  const seen = new Set<string>()
  if (model)
    model.choices = model.choices.filter(({ value }) => {
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })

  return {
    model,
    effort: findSetting(options, "thought_level", EFFORT_IDS),
  }
}

export type DesiredAgentConfig = {
  model: string | null
  effort: string | null
}

// The set_config_option calls that move a session to the console's choices.
// A choice the agent does not offer is skipped, so a stale preference never
// fails a turn.
export const configChanges = (
  config: AgentConfig,
  desired: DesiredAgentConfig,
): { configId: string; value: string }[] => {
  const changes: { configId: string; value: string }[] = []
  for (const [setting, value] of [
    [config.model, desired.model],
    [config.effort, desired.effort],
  ] as const) {
    if (!setting || value === null || setting.current === value) continue
    if (!setting.choices.some((choice) => choice.value === value)) continue
    changes.push({ configId: setting.id, value })
  }
  return changes
}
