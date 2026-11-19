export type SafeProviderId = "gemini" | "groq" | "openrouter";

export class TutorError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class TutorValidationError extends TutorError {
  public readonly details?: unknown;

  constructor(message = "Invalid tutor request.", details?: unknown) {
    super("INVALID_REQUEST", message, 400);
    this.details = details;
  }
}

export class InvalidLessonError extends TutorError {
  constructor(lessonId: string) {
    super(
      "INVALID_LESSON_ID",
      `Unknown or unsupported lesson identifier: "${lessonId}".`,
      400,
    );
  }
}

export class TutorAuthenticationError extends TutorError {
  constructor(message = "Authentication is required to use the AI Lesson Tutor.") {
    super("AUTH_REQUIRED", message, 401);
  }
}

export class ConversationNotFoundError extends TutorError {
  constructor(message = "Conversation not found or not accessible.") {
    super("CONVERSATION_NOT_FOUND", message, 404);
  }
}

export class InterviewQuestionNotFoundError extends TutorError {
  constructor(questionId: string) {
    super(
      "INTERVIEW_QUESTION_NOT_FOUND",
      `Interview question "${questionId}" was not found.`,
      404,
    );
  }
}

export class UserDailyLimitReachedError extends TutorError {
  public readonly limit: number;
  public readonly resetAtUtc: string;

  constructor(limit = 5, resetAtUtc?: string) {
    const nextMidnight = resetAtUtc || getNextUtcMidnightIso();
    super(
      "TUTOR_DAILY_LIMIT_REACHED",
      `You've used all ${limit} of your live AI tutor questions for today. Your daily allowance resets at 00:00 UTC (${nextMidnight}). Note: cached quick-action explanations remain free to view!`,
      429,
    );
    this.limit = limit;
    this.resetAtUtc = nextMidnight;
  }
}

export class AllProvidersBusyError extends TutorError {
  constructor() {
    super(
      "TUTOR_BUSY",
      "The tutor is busy right now. Please try again in a few minutes.",
      503,
    );
  }
}

export interface ProviderCallErrorOptions {
  provider: SafeProviderId;
  statusCode?: number;
  retryAfterSeconds?: number;
  isDailyQuotaExhausted?: boolean;
  isTimeout?: boolean;
  isNetworkError?: boolean;
  causeMessage?: string;
}

/**
 * Internal error representing a provider failure.
 * Never serialize or expose `causeMessage` to the client.
 */
export class ProviderCallError extends Error {
  public readonly provider: SafeProviderId;
  public readonly statusCode?: number;
  public readonly retryAfterSeconds?: number;
  public readonly isDailyQuotaExhausted: boolean;
  public readonly isTimeout: boolean;
  public readonly isNetworkError: boolean;
  public readonly causeMessage?: string;

  constructor(opts: ProviderCallErrorOptions) {
    super(`Provider "${opts.provider}" request failed.`);
    this.name = "ProviderCallError";
    this.provider = opts.provider;
    this.statusCode = opts.statusCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.isDailyQuotaExhausted = Boolean(opts.isDailyQuotaExhausted);
    this.isTimeout = Boolean(opts.isTimeout);
    this.isNetworkError = Boolean(opts.isNetworkError);
    this.causeMessage = opts.causeMessage;
  }
}

export function getNextUtcMidnightIso(now: Date = new Date()): string {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return new Date(nextMidnight).toISOString();
}

export function getCurrentUtcDateKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
