import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { AuthErrorFormat, AuthGuard } from "../auth/auth.guard";
import { CurrentUserId } from "../auth/current-user.decorator";
import { TutorExceptionFilter } from "../common/filters/tutor-exception.filter";
import { TutorValidationError } from "./errors/tutor.errors";
import { HistoryService } from "./history.service";
import {
  validateConversationIdParam,
  validateLessonIdParam,
} from "./schemas/tutor-request";

@Controller("tutor")
@UseFilters(TutorExceptionFilter)
@UseGuards(AuthGuard)
@AuthErrorFormat("tutor")
export class HistoryController {
  constructor(
    @Inject(HistoryService) private readonly historyService: HistoryService,
  ) {}

  @Get("conversations")
  async listConversations(
    @CurrentUserId() userId: string,
    @Query("scope") scope?: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") rawCursor?: string,
    @Query("lessonId") rawLessonId?: string,
  ) {
    const resolvedScope = scope?.trim() || "lesson";
    if (resolvedScope !== "lesson" && resolvedScope !== "all") {
      throw new TutorValidationError("scope must be 'lesson' or 'all'.");
    }

    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit.trim() !== "") {
      const parsed = Number.parseInt(rawLimit, 10);
      const maxAllowed = resolvedScope === "all" ? 50 : 100;
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > maxAllowed) {
        throw new TutorValidationError(
          `limit must be an integer between 1 and ${maxAllowed}.`,
        );
      }
      limit = parsed;
    }

    if (resolvedScope === "all") {
      const cursor =
        rawCursor && rawCursor.trim().length > 0
          ? rawCursor.trim()
          : undefined;
      return this.historyService.listGlobalConversations(userId, {
        limit: limit ?? 20,
        cursor,
      });
    }

    const lessonId = validateLessonIdParam(rawLessonId ?? null);
    const conversations = await this.historyService.listLessonConversations(
      userId,
      lessonId,
      { limit },
    );
    return { conversations };
  }

  @Get("conversations/:conversationId")
  async getConversation(
    @CurrentUserId() userId: string,
    @Param("conversationId") rawConversationId: string,
    @Query("lessonId") rawLessonId?: string,
  ) {
    const conversationId = validateConversationIdParam(rawConversationId);
    const lessonId =
      rawLessonId !== undefined && rawLessonId.trim() !== ""
        ? validateLessonIdParam(rawLessonId)
        : undefined;

    const conversation = await this.historyService.getConversationDetail(
      userId,
      conversationId,
      lessonId,
    );
    return { conversation };
  }

  @Delete("conversations/:conversationId")
  async deleteConversation(
    @CurrentUserId() userId: string,
    @Param("conversationId") rawConversationId: string,
    @Query("lessonId") rawLessonId?: string,
  ) {
    const conversationId = validateConversationIdParam(rawConversationId);
    const lessonId =
      rawLessonId !== undefined && rawLessonId.trim() !== ""
        ? validateLessonIdParam(rawLessonId)
        : undefined;

    return this.historyService.deleteConversation(
      userId,
      conversationId,
      lessonId,
    );
  }

  @Delete("history")
  async clearLessonHistory(
    @CurrentUserId() userId: string,
    @Query("lessonId") rawLessonId?: string,
  ) {
    const lessonId = validateLessonIdParam(rawLessonId ?? null);
    return this.historyService.clearLessonHistory(userId, lessonId);
  }
}
