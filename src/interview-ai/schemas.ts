import { z } from "zod";
import { TutorValidationError } from "../tutor/errors/tutor.errors";
import {
  ConversationIdSchema,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_LENGTH,
  MAX_TOTAL_HISTORY_CHARS,
  TutorHistoryMessageSchema,
  type TutorHistoryMessage,
} from "../tutor/schemas/tutor-request";

export const INTERVIEW_EXPLAIN_ACTIONS = [
  "explain_question",
  "explain_concept",
  "break_down_answer",
  "practical_example",
  "explain_code",
  "free",
] as const;

export type InterviewExplainAction =
  (typeof INTERVIEW_EXPLAIN_ACTIONS)[number];

export const CACHEABLE_INTERVIEW_EXPLAIN_ACTIONS: ReadonlySet<InterviewExplainAction> =
  new Set<InterviewExplainAction>([
    "explain_question",
    "explain_concept",
    "break_down_answer",
    "practical_example",
    "explain_code",
  ]);

export function isCacheableInterviewExplainAction(
  action: InterviewExplainAction,
): boolean {
  return CACHEABLE_INTERVIEW_EXPLAIN_ACTIONS.has(action);
}

export { MAX_HISTORY_MESSAGES, MAX_MESSAGE_LENGTH, MAX_TOTAL_HISTORY_CHARS };
export type InterviewHistoryMessage = TutorHistoryMessage;

export const QuestionIdSchema = z
  .string()
  .trim()
  .min(1, "questionId is required.")
  .max(120, "questionId cannot exceed 120 characters.")
  .regex(/^[a-zA-Z0-9_-]+$/, "questionId contains invalid characters.");

export const InterviewExplainRequestSchema = z
  .object({
    questionId: QuestionIdSchema,
    action: z.enum(INTERVIEW_EXPLAIN_ACTIONS, {
      message:
        "Invalid action. Must be one of: explain_question, explain_concept, break_down_answer, practical_example, explain_code, free.",
    }),
    conversationId: ConversationIdSchema.nullable().optional(),
    message: z
      .string()
      .max(
        MAX_MESSAGE_LENGTH,
        `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
      )
      .optional(),
    history: z
      .array(TutorHistoryMessageSchema)
      .max(
        MAX_HISTORY_MESSAGES,
        `History cannot exceed ${MAX_HISTORY_MESSAGES} messages.`,
      )
      .optional()
      .default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    const trimmedMessage = data.message?.trim() ?? "";

    if (data.action === "free" && trimmedMessage.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "A non-empty message is required when action is 'free'.",
      });
    }

    if (data.history && data.history.length > 0) {
      const totalChars = data.history.reduce(
        (sum, item) => sum + item.content.length,
        0,
      );
      if (totalChars > MAX_TOTAL_HISTORY_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["history"],
          message: `Total history content cannot exceed ${MAX_TOTAL_HISTORY_CHARS} characters.`,
        });
      }
    }
  });

export type InterviewExplainRequest = Omit<
  z.infer<typeof InterviewExplainRequestSchema>,
  "conversationId"
> & {
  conversationId?: string;
};

export function validateInterviewExplainRequest(
  payload: unknown,
): InterviewExplainRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TutorValidationError("Request body must be a JSON object.");
  }

  const parsed = InterviewExplainRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.length ? `${firstIssue.path.join(".")}: ` : ""}${firstIssue.message}`
      : "Invalid interview explanation request.";
    throw new TutorValidationError(message, parsed.error.flatten());
  }

  return {
    ...parsed.data,
    conversationId: parsed.data.conversationId || undefined,
    message: parsed.data.message?.trim() || undefined,
  };
}
