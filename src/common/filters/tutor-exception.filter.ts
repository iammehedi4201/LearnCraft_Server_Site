import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  AllProvidersBusyError,
  ConversationNotFoundError,
  InterviewQuestionNotFoundError,
  InvalidLessonError,
  TutorAuthenticationError,
  TutorError,
  TutorValidationError,
  UserDailyLimitReachedError,
} from "../../tutor/errors/tutor.errors";

export function formatTutorErrorPayload(
  err: unknown,
  context: "tutor" | "history" | "interview" = "tutor",
): { status: number; body: Record<string, unknown> } {
  if (err instanceof TutorAuthenticationError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      body: {
        error: err.code,
        message:
          context === "interview"
            ? "Authentication is required to use the AI Interview Question Explainer."
            : err.message,
      },
    };
  }

  if (err instanceof TutorValidationError || err instanceof InvalidLessonError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: {
        error: err.code,
        message: err.message,
      },
    };
  }

  if (
    err instanceof ConversationNotFoundError ||
    err instanceof InterviewQuestionNotFoundError
  ) {
    return {
      status: HttpStatus.NOT_FOUND,
      body: {
        error: err.code,
        message: err.message,
      },
    };
  }

  if (err instanceof UserDailyLimitReachedError) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: {
        error: "TUTOR_DAILY_LIMIT_REACHED",
        message: err.message,
        ...(context === "interview" ? { limit: err.limit } : {}),
        resetAtUtc: err.resetAtUtc,
      },
    };
  }

  if (err instanceof AllProvidersBusyError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: {
        error: "TUTOR_BUSY",
        message:
          context === "interview"
            ? "The AI explainer is busy right now. Please try again in a few minutes."
            : "The tutor is busy right now. Please try again in a few minutes.",
      },
    };
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    if (
      err instanceof BadRequestException &&
      (context === "tutor" || context === "interview" || context === "history") &&
      typeof response === "object" &&
      response !== null &&
      typeof (response as Record<string, unknown>).error === "string" &&
      (response as Record<string, unknown>).error === "Bad Request"
    ) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: "INVALID_REQUEST",
          message: "Request body must be valid JSON.",
        },
      };
    }
    return {
      status,
      body:
        typeof response === "object" && response !== null
          ? (response as Record<string, unknown>)
          : { error: "HTTP_ERROR", message: String(response) },
    };
  }

  if (err instanceof SyntaxError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body:
        context === "tutor" || context === "interview" || context === "history"
          ? {
              error: "INVALID_REQUEST",
              message: "Request body must be valid JSON.",
            }
          : { error: "Invalid JSON payload" },
    };
  }

  if (context === "history") {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: "INTERNAL_ERROR",
        message: "Unable to process conversation history request right now.",
      },
    };
  }

  return {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    body: {
      error: "TUTOR_BUSY",
      message:
        context === "interview"
          ? "The AI explainer is busy right now. Please try again in a few minutes."
          : "The tutor is busy right now. Please try again in a few minutes.",
    },
  };
}

@Catch(TutorError, HttpException, SyntaxError)
export class TutorExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const path = req.url || "";
    const context = path.includes("/interview/")
      ? "interview"
      : path.includes("/conversations") || path.includes("/history")
        ? "history"
        : "tutor";

    const formatted = formatTutorErrorPayload(exception, context);
    res.status(formatted.status).json(formatted.body);
  }
}
