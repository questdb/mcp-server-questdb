import { z } from "zod"
import type { AgentInboundMessage } from "../agentProtocol.js"

const MAX_ID_LENGTH = 200
const MAX_PROMPT_CHARS = 1_000_000
const MAX_SETTING_LENGTH = 200
// An answer is the user's own text, as long as a message can be: a pasted
// query, log or stack trace must reach the agent.
const MAX_ANSWER_CHARS = MAX_PROMPT_CHARS
const MAX_ANSWER_FIELDS = 50
const MAX_ANSWER_CHOICES = 50
// Images the user attaches to a message: a few, each a few megabytes.
export const MAX_PROMPT_IMAGES = 4
export const MAX_IMAGE_DATA_CHARS = 7_000_000
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]

const id = z.string().min(1).max(MAX_ID_LENGTH)
const setting = z.string().min(1).max(MAX_SETTING_LENGTH).nullable()

const inboundMessage = z.discriminatedUnion("type", [
  z.object({
    v: z.string(),
    type: z.literal("agent_prompt"),
    conversationId: id,
    turnId: id,
    prompt: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("image"),
            mimeType: z.enum(IMAGE_TYPES as [string, ...string[]]),
            data: z
              .string()
              .min(1)
              .max(MAX_IMAGE_DATA_CHARS)
              .regex(/^[A-Za-z0-9+/]+=*$/, "not base64"),
          }),
        ]),
      )
      .min(1)
      .refine(
        (blocks) =>
          blocks.reduce(
            (total, block) =>
              total + (block.type === "text" ? block.text.length : 0),
            0,
          ) <= MAX_PROMPT_CHARS,
        "prompt is too large",
      )
      .refine(
        (blocks) =>
          blocks.filter((block) => block.type === "image").length <=
          MAX_PROMPT_IMAGES,
        "too many images",
      ),
  }),
  z.object({
    v: z.string(),
    type: z.literal("agent_cancel"),
    conversationId: id,
  }),
  z.object({
    v: z.string(),
    type: z.literal("agent_question_answer"),
    requestId: id,
    answers: z
      .record(
        id,
        z.union([
          z.string().max(MAX_ANSWER_CHARS),
          z.array(z.string().max(MAX_ANSWER_CHARS)).max(MAX_ANSWER_CHOICES),
        ]),
      )
      .refine(
        (answers) => Object.keys(answers).length <= MAX_ANSWER_FIELDS,
        "too many answers",
      )
      .refine(
        (answers) =>
          Object.values(answers)
            .flat()
            .reduce((total, answer) => total + answer.length, 0) <=
          MAX_ANSWER_CHARS,
        "answers are too large",
      )
      .nullable(),
  }),
  z.object({
    v: z.string(),
    type: z.literal("agent_settings"),
    model: setting,
    effort: setting,
  }),
  z.object({ v: z.string(), type: z.literal("agent_restart") }),
])

export const parseInboundAgentMessage = (
  raw: unknown,
): AgentInboundMessage | null => {
  const parsed = inboundMessage.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// A rejected frame the console waits on an answer to: a prompt waits for the
// end of its turn, an answer for the agent to go on.
export type InboundRejection =
  | {
      type: "agent_prompt"
      conversationId: string
      turnId: string
      reason: string
    }
  | { type: "agent_question_answer"; requestId: string; reason: string }

const PROMPT_REJECTED =
  `The message could not be sent to the agent. A message can have up to ` +
  `${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters of text and ` +
  `${MAX_PROMPT_IMAGES} PNG, JPEG, GIF or WebP images of up to 5 MB.`

const ANSWER_REJECTED =
  `The answer could not be sent to the agent. Answers can have up to ` +
  `${MAX_ANSWER_CHARS.toLocaleString("en-US")} characters in all.`

const isId = (value: unknown): value is string => id.safeParse(value).success

// What the console waits on for a frame that failed validation; null for one
// it waits on nothing for.
export const rejectionOf = (raw: unknown): InboundRejection | null => {
  if (typeof raw !== "object" || raw === null) return null
  const frame = raw as Record<string, unknown>
  if (
    frame.type === "agent_prompt" &&
    isId(frame.conversationId) &&
    isId(frame.turnId)
  ) {
    return {
      type: "agent_prompt",
      conversationId: frame.conversationId,
      turnId: frame.turnId,
      reason: PROMPT_REJECTED,
    }
  }
  if (frame.type === "agent_question_answer" && isId(frame.requestId)) {
    return {
      type: "agent_question_answer",
      requestId: frame.requestId,
      reason: ANSWER_REJECTED,
    }
  }
  return null
}
