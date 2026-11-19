import { z } from "zod";
import { TutorValidationError } from "../errors/tutor.errors";

export const TUTOR_ACTIONS = [
  "explain_simply",
  "step_by_step",
  "explain_code",
  "another_example",
  "free",
] as const;

export type TutorAction = (typeof TUTOR_ACTIONS)[number];

export const CACHEABLE_TUTOR_ACTIONS: ReadonlySet<TutorAction> = new Set<TutorAction>([
  "explain_simply",
  "step_by_step",
  "explain_code",
]);

export function isCacheableTutorAction(action: TutorAction): boolean {
  return CACHEABLE_TUTOR_ACTIONS.has(action);
}

export const TUTOR_HISTORY_ROLES = ["user", "assistant"] as const;
export type TutorHistoryRole = (typeof TUTOR_HISTORY_ROLES)[number];

export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_HISTORY_MESSAGES = 6;
export const MAX_HISTORY_ITEM_LENGTH = 2000;
export const MAX_TOTAL_HISTORY_CHARS = 6000;

export const TutorHistoryMessageSchema = z
  .object({
    role: z.enum(TUTOR_HISTORY_ROLES, {
      message: "History role must be 'user' or 'assistant'.",
    }),
    content: z
      .string()
      .trim()
      .min(1, "History message content cannot be empty.")
      .max(
        MAX_HISTORY_ITEM_LENGTH,
        `History message content cannot exceed ${MAX_HISTORY_ITEM_LENGTH} characters.`,
      ),
  })
  .strict();

export type TutorHistoryMessage = z.infer<typeof TutorHistoryMessageSchema>;

export const LessonIdSchema = z
  .string()
  .trim()
  .min(1, "lessonId is required.")
  .max(160, "lessonId cannot exceed 160 characters.")
  .regex(/^[a-zA-Z0-9_:\/-]+$/, "lessonId contains invalid characters.");

export const ConversationIdSchema = z
  .string()
  .trim()
  .min(1, "conversationId cannot be empty.")
  .max(100, "conversationId cannot exceed 100 characters.")
  .regex(/^[a-zA-Z0-9_-]+$/, "conversationId contains invalid characters.");

export const TutorAskRequestSchema = z
  .object({
    lessonId: LessonIdSchema,
    conversationId: ConversationIdSchema.nullable().optional(),
    action: z.enum(TUTOR_ACTIONS, {
      message:
        "Invalid action. Must be one of: explain_simply, step_by_step, explain_code, another_example, free.",
    }),
    message: z
      .string()
      .max(
        MAX_MESSAGE_LENGTH,
        `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
      )
      .optional(),
    codeBlockId: z
      .string()
      .trim()
      .min(1)
      .max(100, "codeBlockId cannot exceed 100 characters.")
      .regex(/^[a-zA-Z0-9_:-]+$/, "codeBlockId contains invalid characters.")
      .nullable()
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

export type TutorAskRequest = Omit<
  z.infer<typeof TutorAskRequestSchema>,
  "conversationId" | "codeBlockId"
> & {
  conversationId?: string;
  codeBlockId?: string;
};

export function validateTutorAskRequest(payload: unknown): TutorAskRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TutorValidationError("Request body must be a JSON object.");
  }

  const parsed = TutorAskRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.length ? `${firstIssue.path.join(".")}: ` : ""}${firstIssue.message}`
      : "Invalid tutor request payload.";
    throw new TutorValidationError(message, parsed.error.flatten());
  }

  return {
    ...parsed.data,
    conversationId: parsed.data.conversationId || undefined,
    codeBlockId: parsed.data.codeBlockId || undefined,
    message: parsed.data.message?.trim() || undefined,
  };
}

export function validateLessonIdParam(lessonId: unknown): string {
  const parsed = LessonIdSchema.safeParse(lessonId);
  if (!parsed.success) {
    throw new TutorValidationError(
      parsed.error.issues[0]?.message || "Valid lessonId is required.",
    );
  }
  return parsed.data;
}

export function validateConversationIdParam(conversationId: unknown): string {
  const parsed = ConversationIdSchema.safeParse(conversationId);
  if (!parsed.success) {
    throw new TutorValidationError(
      parsed.error.issues[0]?.message || "Valid conversationId is required.",
    );
  }
  return parsed.data;
}
