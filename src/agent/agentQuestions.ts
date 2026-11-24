import type * as acp from "@agentclientprotocol/sdk"
import type {
  AgentQuestionField,
  AgentQuestionOption,
} from "../agentProtocol.js"

// Agents ask the user questions through ACP form elicitation: a message and a
// flat JSON Schema of fields. The console shows each field as a choice or a
// text box; booleans become a Yes/No choice and numbers a text box, and the
// answers are turned back into the types the schema asked for.
//
// Agents also offer the user's own answer to a choice as a text field right
// after it, whose id starts with the choice's: Claude Code's
// `question_0_custom`, Codex's `question_0_note`. The console shows it as the
// choice's "Type your own answer" row. Codex also adds a "None of the above"
// option that only says the note is the answer; that row replaces it, and the
// bridge picks it when the user types their own answer.

type TitledOption = {
  const: string
  title: string
  description?: string | null
}

type PropertySchema = acp.ElicitationPropertySchema & {
  title?: string | null
  description?: string | null
  enum?: string[] | null
  oneOf?: TitledOption[] | null
  items?: { enum?: string[] | null; anyOf?: TitledOption[] | null }
}

const YES = "true"
const NO = "false"
const NONE_OF_THE_ABOVE = "None of the above"

type Pairing = {
  // The choice's own-answer field, by choice id.
  otherOf: Map<string, string>
  // Options that only stand for "my own answer", by choice id.
  noneOf: Map<string, string>
}

const propertiesOf = (schema: acp.ElicitationSchema) =>
  Object.entries(schema.properties ?? {}) as [string, PropertySchema][]

const optionsOf = (
  titled: TitledOption[] | null | undefined,
  plain: string[] | null | undefined,
): AgentQuestionOption[] | null => {
  if (titled?.length) {
    return titled.map((option) => ({
      value: option.const,
      label: option.title,
      description: option.description ?? null,
    }))
  }
  if (plain?.length) {
    return plain.map((value) => ({ value, label: value, description: null }))
  }
  return null
}

const isChoice = (property: PropertySchema): boolean =>
  (property.type === "string" &&
    !!(property.oneOf?.length || property.enum?.length)) ||
  (property.type === "array" &&
    !!(property.items?.anyOf?.length || property.items?.enum?.length))

const isPlainText = (property: PropertySchema): boolean =>
  property.type === "string" &&
  !property.oneOf?.length &&
  !property.enum?.length

const pairingOf = (schema: acp.ElicitationSchema): Pairing => {
  const pairing: Pairing = { otherOf: new Map(), noneOf: new Map() }
  const properties = propertiesOf(schema)
  properties.forEach(([id, property], index) => {
    const next = properties[index + 1]
    if (!next || !isChoice(property) || !isPlainText(next[1])) return
    if (!next[0].startsWith(`${id}_`)) return
    pairing.otherOf.set(id, next[0])
    const none = property.oneOf?.find(
      (option) => option.const === NONE_OF_THE_ABOVE,
    )
    if (none) pairing.noneOf.set(id, none.const)
  })
  return pairing
}

const fieldOf = (
  id: string,
  property: PropertySchema,
  required: boolean,
  pairing: Pairing,
): AgentQuestionField | null => {
  const title = property.title ?? null
  const prompt = property.description ?? null
  const otherFieldId = pairing.otherOf.get(id) ?? null
  const none = pairing.noneOf.get(id)
  const choice = (options: AgentQuestionOption[], multiple: boolean) =>
    ({
      id,
      kind: "choice",
      title,
      prompt,
      options: options.filter((option) => option.value !== none),
      multiple,
      required,
      otherFieldId,
    }) satisfies AgentQuestionField
  switch (property.type) {
    case "string": {
      const options = optionsOf(property.oneOf, property.enum)
      return options
        ? choice(options, false)
        : { id, kind: "text", title, prompt, required }
    }
    case "array": {
      const options = optionsOf(property.items?.anyOf, property.items?.enum)
      return options ? choice(options, true) : null
    }
    case "boolean":
      return choice(
        [
          { value: YES, label: "Yes", description: null },
          { value: NO, label: "No", description: null },
        ],
        false,
      )
    case "number":
    case "integer":
      return { id, kind: "text", title, prompt, required }
    default:
      return null
  }
}

// The fields the console shows for a form, or null for a form it cannot show
// (a field type it does not know), which the agent is told was cancelled.
export const questionFieldsOf = (
  schema: acp.ElicitationSchema,
): AgentQuestionField[] | null => {
  const required = new Set(schema.required ?? [])
  const pairing = pairingOf(schema)
  const ownAnswerFields = new Set(pairing.otherOf.values())
  const fields: AgentQuestionField[] = []
  for (const [id, property] of propertiesOf(schema)) {
    if (ownAnswerFields.has(id)) continue
    const field = fieldOf(id, property, required.has(id), pairing)
    if (!field) return null
    fields.push(field)
  }
  return fields
}

// The user's answers as the form's content. Fields left empty are left out.
export const elicitationContentOf = (
  schema: acp.ElicitationSchema,
  answers: Record<string, string | string[]>,
): Record<string, acp.ElicitationContentValue> => {
  const content: Record<string, acp.ElicitationContentValue> = {}
  for (const [id, property] of propertiesOf(schema)) {
    const answer = answers[id]
    if (answer === undefined) continue
    const values = (Array.isArray(answer) ? answer : [answer]).filter(
      (value) => value.trim() !== "",
    )
    const text = values[0]?.trim() ?? ""
    switch (property.type) {
      case "array":
        if (values.length > 0) content[id] = values
        break
      case "boolean":
        if (text === YES || text === NO) content[id] = text === YES
        break
      case "number":
      case "integer": {
        const number = Number(text)
        if (text !== "" && Number.isFinite(number)) content[id] = number
        break
      }
      default:
        if (text !== "") content[id] = text
    }
  }
  // An own answer to a choice whose agent marks it with an option of its own.
  const pairing = pairingOf(schema)
  for (const [choiceId, none] of pairing.noneOf) {
    const otherId = pairing.otherOf.get(choiceId)
    if (otherId && content[otherId] !== undefined && !(choiceId in content)) {
      content[choiceId] = none
    }
  }
  return content
}

// What the agent reads for each question the user skipped, where a skip has to
// be sent as an answer.
export const SKIPPED_ANSWER =
  "The user skipped this question without answering."

// A skip written as an answer: the skip in every free-text field and in every
// choice's own-answer field, and nothing chosen.
export const skippedContentOf = (
  schema: acp.ElicitationSchema,
): Record<string, acp.ElicitationContentValue> => {
  const pairing = pairingOf(schema)
  const ownAnswerFields = new Set(pairing.otherOf.values())
  const answers: Record<string, string> = {}
  for (const [id, property] of propertiesOf(schema)) {
    const own = pairing.otherOf.get(id)
    if (own) {
      answers[own] = SKIPPED_ANSWER
    } else if (
      !ownAnswerFields.has(id) &&
      property.type === "string" &&
      !property.enum?.length &&
      !property.oneOf?.length
    ) {
      answers[id] = SKIPPED_ANSWER
    }
  }
  return elicitationContentOf(schema, answers)
}
