import { Inject, Injectable } from "@nestjs/common";
import {
  QuestionRegistryService,
  resolveAuthoritativeInterviewQuestion,
  type InterviewRelatedLesson,
} from "../catalog/question-registry.service";
import {
  buildTutorCacheKey,
  getCachedTutorAnswer,
  getInFlightCacheGeneration,
  getOrCreateInFlightCacheGeneration,
  getTutorCacheStore,
  setCachedTutorAnswer,
  TutorCacheService,
  type TutorCacheStore,
} from "../tutor/cache/tutor-cache.service";
import {
  TutorValidationError,
  type SafeProviderId,
} from "../tutor/errors/tutor.errors";
import {
  ConversationStoreService,
  getTutorConversationStore,
  type TutorConversationStore,
} from "../tutor/history/conversation-store.service";
import {
  generateConversationTitle,
  generateInterviewQuickActionTitle,
} from "../tutor/history/title-generator";
import {
  generateWithFallbackRouter,
  LlmRouterService,
  type LlmRouterOptions,
} from "../tutor/llm/llm-router.service";
import {
  getTutorUsageStore,
  reserveAuthenticatedUserDailyAllowance,
  TutorUsageService,
  type TutorUsageStore,
} from "../tutor/usage/tutor-usage.service";
import { buildInterviewExplainerPrompt } from "./prompts";
import {
  isCacheableInterviewExplainAction,
  MAX_HISTORY_MESSAGES,
  type InterviewExplainAction,
  type InterviewExplainRequest,
} from "./schemas";

export const INTERVIEW_ACTION_DISPLAY_LABELS: Record<
  InterviewExplainAction,
  string
> = {
  explain_question: "Explain the Question",
  explain_concept: "Explain the Concept",
  break_down_answer: "Break Down the Answer",
  practical_example: "Give a Practical Example",
  explain_code: "Explain Code",
  free: "Follow-up Question",
};

export interface InterviewExplainResponse {
  answer: string;
  cached: boolean;
  provider?: SafeProviderId;
  relatedLesson: InterviewRelatedLesson | null;
  conversationId?: string;
  conversationTitle?: string;
}

export interface InterviewExplainerServiceDeps {
  cacheStore?: TutorCacheStore;
  usageStore?: TutorUsageStore;
  conversationStore?: TutorConversationStore;
  routerOptions?: LlmRouterOptions;
  now?: Date;
}

export async function explainInterviewQuestion(
  userId: string,
  request: InterviewExplainRequest,
  deps: InterviewExplainerServiceDeps = {},
): Promise<InterviewExplainResponse> {
  const cacheStore = deps.cacheStore ?? getTutorCacheStore();
  const usageStore = deps.usageStore ?? getTutorUsageStore();
  const conversationStore =
    deps.conversationStore ?? getTutorConversationStore();
  const now = deps.now ?? new Date();

  const question = resolveAuthoritativeInterviewQuestion(request.questionId);
  const canonicalLessonId = `interview:${question.id}`;

  if (request.action === "explain_code" && !question.hasRelevantCode) {
    throw new TutorValidationError(
      "This interview question does not contain a code snippet to explain.",
    );
  }

  const authoritativeHistory = request.conversationId
    ? await conversationStore.getRecentContextMessages({
        conversationId: request.conversationId,
        userId,
        lessonId: canonicalLessonId,
        limit: MAX_HISTORY_MESSAGES,
      })
    : [];

  const effectiveHistory =
    authoritativeHistory.length > 0
      ? authoritativeHistory
      : request.history ?? [];

  const prompt = buildInterviewExplainerPrompt({
    question,
    action: request.action,
    message: request.message,
    history: effectiveHistory,
  });

  const cacheable = isCacheableInterviewExplainAction(request.action);

  let rawResult: {
    answer: string;
    cached: boolean;
    provider?: SafeProviderId;
  };

  if (cacheable) {
    const cacheParams = {
      namespace: "interview_question" as const,
      lessonId: canonicalLessonId,
      action: request.action,
      contentHash: question.contentHash,
      promptVersion: prompt.promptVersion,
      codeHash: question.codeHash,
    };

    const cacheKey = buildTutorCacheKey(cacheParams);
    if (cacheKey) {
      const preInFlight = getInFlightCacheGeneration(cacheKey);
      if (preInFlight) {
        const sharedResult = await preInFlight;
        rawResult = {
          answer: sharedResult.answer,
          cached: true,
          provider: sharedResult.provider,
        };
      } else {
        const cachedEntry = await getCachedTutorAnswer(cacheParams, cacheStore);
        if (cachedEntry) {
          rawResult = {
            answer: cachedEntry.answer,
            cached: true,
            provider: cachedEntry.provider,
          };
        } else {
          const { promise, isLeader } = getOrCreateInFlightCacheGeneration(
            cacheKey,
            async () => {
              await reserveAuthenticatedUserDailyAllowance(
                userId,
                now,
                usageStore,
              );

              const generated = await generateWithFallbackRouter(
                {
                  systemPrompt: prompt.systemPrompt,
                  userPrompt: prompt.userPrompt,
                  historyMessages: [],
                },
                {
                  ...deps.routerOptions,
                  now,
                  usageStore,
                },
              );

              await setCachedTutorAnswer(
                {
                  ...cacheParams,
                  answer: generated.answer,
                  provider: generated.provider,
                  model: generated.model,
                },
                cacheStore,
              );

              return generated;
            },
          );

          const result = await promise;
          rawResult = {
            answer: result.answer,
            cached: !isLeader,
            provider: result.provider,
          };
        }
      }
    } else {
      await reserveAuthenticatedUserDailyAllowance(userId, now, usageStore);
      const generated = await generateWithFallbackRouter(
        {
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          historyMessages: [],
        },
        {
          ...deps.routerOptions,
          now,
          usageStore,
        },
      );
      rawResult = {
        answer: generated.answer,
        cached: false,
        provider: generated.provider,
      };
    }
  } else {
    await reserveAuthenticatedUserDailyAllowance(userId, now, usageStore);

    const generated = await generateWithFallbackRouter(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        historyMessages: prompt.historyMessages,
      },
      {
        ...deps.routerOptions,
        now,
        usageStore,
      },
    );

    rawResult = {
      answer: generated.answer,
      cached: false,
      provider: generated.provider,
    };
  }

  const persistedUserContent =
    request.action === "free"
      ? request.message!
      : request.message?.trim() ||
        INTERVIEW_ACTION_DISPLAY_LABELS[request.action];

  if (request.conversationId) {
    const appended = await conversationStore.appendExchangeToConversation({
      conversationId: request.conversationId,
      userId,
      lessonId: canonicalLessonId,
      userContent: persistedUserContent,
      assistantContent: rawResult.answer,
      now,
    });

    return {
      answer: rawResult.answer,
      cached: rawResult.cached,
      provider: rawResult.provider,
      relatedLesson: question.relatedLesson,
      conversationId: appended.conversationId,
      conversationTitle: appended.title,
    };
  }

  const generatedTitle =
    request.action === "free"
      ? generateConversationTitle(persistedUserContent, question.question)
      : generateInterviewQuickActionTitle(request.action, question.question);

  const created = await conversationStore.createConversationWithExchange({
    userId,
    lessonId: canonicalLessonId,
    lessonTitle: question.question,
    title: generatedTitle,
    userContent: persistedUserContent,
    assistantContent: rawResult.answer,
    now,
  });

  return {
    answer: rawResult.answer,
    cached: rawResult.cached,
    provider: rawResult.provider,
    relatedLesson: question.relatedLesson,
    conversationId: created.conversation.id,
    conversationTitle: created.conversation.title,
  };
}

@Injectable()
export class InterviewAiService {
  constructor(
    @Inject(QuestionRegistryService)
    private readonly questionRegistry: QuestionRegistryService,
    @Inject(TutorCacheService) private readonly cacheService: TutorCacheService,
    @Inject(TutorUsageService) private readonly usageService: TutorUsageService,
    @Inject(ConversationStoreService)
    private readonly conversationStore: ConversationStoreService,
    @Inject(LlmRouterService) private readonly llmRouter: LlmRouterService,
  ) {}

  async explain(
    userId: string,
    request: InterviewExplainRequest,
    deps: InterviewExplainerServiceDeps = {},
  ): Promise<InterviewExplainResponse> {
    void this.questionRegistry;
    void this.llmRouter;
    return explainInterviewQuestion(userId, request, {
      cacheStore: deps.cacheStore ?? this.cacheService,
      usageStore: deps.usageStore ?? this.usageService,
      conversationStore: deps.conversationStore ?? this.conversationStore,
      routerOptions: deps.routerOptions,
      now: deps.now,
    });
  }
}
