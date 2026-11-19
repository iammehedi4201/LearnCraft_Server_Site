import { Inject, Injectable } from "@nestjs/common";
import {
  resolveAuthoritativeLesson,
  resolveLessonRouteMetadata,
  TOPICS_META,
} from "../catalog/lesson-registry.service";
import {
  QuestionRegistryService,
  resolveAuthoritativeInterviewQuestion,
} from "../catalog/question-registry.service";
import { ConversationNotFoundError } from "./errors/tutor.errors";
import {
  ConversationStoreService,
  getTutorConversationStore,
  type GlobalListConversationsOptions,
  type TutorConversationDetail,
  type TutorConversationStore,
  type TutorConversationSummary,
} from "./history/conversation-store.service";
import { normalizeGenericTitle } from "./history/title-generator";

export interface HistoryServiceDependencies {
  conversationStore?: TutorConversationStore;
}

export interface TutorGlobalConversationSummary extends TutorConversationSummary {
  trackKey: string;
  trackTitle: string;
  lessonCode?: string;
  lessonUrl: string | null;
  lessonAvailable: boolean;
}

export interface GlobalConversationListResult {
  conversations: TutorGlobalConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

function resolveCanonicalHistoryLesson(rawLessonId: string): {
  lessonId: string;
  title?: string;
} {
  if (rawLessonId.startsWith("interview:")) {
    const questionId = rawLessonId.replace(/^interview:/, "");
    const question = resolveAuthoritativeInterviewQuestion(questionId);
    return {
      lessonId: `interview:${question.id}`,
      title: question.question,
    };
  }

  const lesson = resolveAuthoritativeLesson(rawLessonId);
  return {
    lessonId: lesson.lessonId,
    title: lesson.title,
  };
}

export async function listUserLessonConversations(
  userId: string,
  rawLessonId: string,
  options: { limit?: number } = {},
  deps: HistoryServiceDependencies = {},
): Promise<TutorConversationSummary[]> {
  const store = deps.conversationStore ?? getTutorConversationStore();
  const resolved = resolveCanonicalHistoryLesson(rawLessonId);
  const items = await store.listConversations(userId, resolved.lessonId, options);
  return items.map((conv) => ({
    ...conv,
    title: normalizeGenericTitle(conv.title, resolved.title),
  }));
}

export async function listUserGlobalConversations(
  userId: string,
  options: GlobalListConversationsOptions = {},
  deps: HistoryServiceDependencies = {},
): Promise<GlobalConversationListResult> {
  const store = deps.conversationStore ?? getTutorConversationStore();
  const page = await store.listGlobalConversations(userId, options);

  const enriched: TutorGlobalConversationSummary[] = page.conversations.map(
    (conv) => {
      if (conv.lessonId.startsWith("interview:")) {
        const questionId = conv.lessonId.replace(/^interview:/, "");
        try {
          const question = resolveAuthoritativeInterviewQuestion(questionId);
          return {
            ...conv,
            title: normalizeGenericTitle(conv.title, question.question),
            lessonId: `interview:${question.id}`,
            lessonTitle: question.question,
            lessonCode: question.id,
            trackKey: question.trackKey,
            trackTitle: question.trackTitle,
            lessonUrl: `/interview/${question.trackKey}/browse?questionId=${question.id}`,
            lessonAvailable: true,
          };
        } catch {
          return {
            ...conv,
            title: normalizeGenericTitle(
              conv.title,
              conv.lessonTitle || undefined,
            ),
            lessonTitle: conv.lessonTitle || "Archived Interview Question",
            trackKey: "interview",
            trackTitle: "Interview Preparation",
            lessonUrl: null,
            lessonAvailable: false,
          };
        }
      }

      const meta = resolveLessonRouteMetadata(conv.lessonId);
      if (meta) {
        return {
          ...conv,
          title: normalizeGenericTitle(conv.title, meta.lessonTitle),
          lessonId: meta.lessonId,
          lessonTitle: meta.lessonTitle,
          lessonCode: meta.code,
          trackKey: meta.trackKey,
          trackTitle: meta.trackTitle,
          lessonUrl: meta.lessonUrl,
          lessonAvailable: true,
        };
      }

      const rawTrack = conv.lessonId.includes(":")
        ? conv.lessonId.split(":", 2)[0].toLowerCase()
        : "unknown";
      const fallbackTrackTitle = TOPICS_META[rawTrack]?.title || "Archived Track";

      return {
        ...conv,
        title: normalizeGenericTitle(
          conv.title,
          conv.lessonTitle || undefined,
        ),
        lessonTitle: conv.lessonTitle || "Unavailable Lesson",
        trackKey: rawTrack,
        trackTitle: fallbackTrackTitle,
        lessonUrl: null,
        lessonAvailable: false,
      };
    },
  );

  return {
    conversations: enriched,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getUserConversationDetail(
  userId: string,
  conversationId: string,
  rawLessonId?: string,
  deps: HistoryServiceDependencies = {},
): Promise<TutorConversationDetail> {
  const store = deps.conversationStore ?? getTutorConversationStore();
  const canonicalLessonId = rawLessonId
    ? resolveCanonicalHistoryLesson(rawLessonId).lessonId
    : undefined;

  const conversation = await store.getConversationWithMessages({
    conversationId,
    userId,
    lessonId: canonicalLessonId,
  });

  if (!conversation) {
    throw new ConversationNotFoundError();
  }

  return conversation;
}

export async function deleteUserConversation(
  userId: string,
  conversationId: string,
  rawLessonId?: string,
  deps: HistoryServiceDependencies = {},
): Promise<{ success: true; deletedConversationId: string }> {
  const store = deps.conversationStore ?? getTutorConversationStore();
  const canonicalLessonId = rawLessonId
    ? resolveCanonicalHistoryLesson(rawLessonId).lessonId
    : undefined;

  const deleted = await store.deleteConversation({
    conversationId,
    userId,
    lessonId: canonicalLessonId,
  });

  if (!deleted) {
    throw new ConversationNotFoundError();
  }

  return {
    success: true,
    deletedConversationId: conversationId,
  };
}

export async function clearUserLessonHistory(
  userId: string,
  rawLessonId: string,
  deps: HistoryServiceDependencies = {},
): Promise<{ success: true; lessonId: string; deletedCount: number }> {
  const store = deps.conversationStore ?? getTutorConversationStore();
  const resolved = resolveCanonicalHistoryLesson(rawLessonId);

  const deletedCount = await store.clearLessonHistory({
    userId,
    lessonId: resolved.lessonId,
  });

  return {
    success: true,
    lessonId: resolved.lessonId,
    deletedCount,
  };
}

@Injectable()
export class HistoryService {
  constructor(
    @Inject(ConversationStoreService)
    private readonly conversationStore: ConversationStoreService,
    @Inject(QuestionRegistryService)
    private readonly questionRegistry: QuestionRegistryService,
  ) {}

  listLessonConversations(
    userId: string,
    rawLessonId: string,
    options: { limit?: number } = {},
  ) {
    void this.questionRegistry;
    return listUserLessonConversations(userId, rawLessonId, options, {
      conversationStore: this.conversationStore,
    });
  }

  listGlobalConversations(
    userId: string,
    options: GlobalListConversationsOptions = {},
  ) {
    return listUserGlobalConversations(userId, options, {
      conversationStore: this.conversationStore,
    });
  }

  getConversationDetail(
    userId: string,
    conversationId: string,
    rawLessonId?: string,
  ) {
    return getUserConversationDetail(userId, conversationId, rawLessonId, {
      conversationStore: this.conversationStore,
    });
  }

  deleteConversation(
    userId: string,
    conversationId: string,
    rawLessonId?: string,
  ) {
    return deleteUserConversation(userId, conversationId, rawLessonId, {
      conversationStore: this.conversationStore,
    });
  }

  clearLessonHistory(userId: string, rawLessonId: string) {
    return clearUserLessonHistory(userId, rawLessonId, {
      conversationStore: this.conversationStore,
    });
  }
}
