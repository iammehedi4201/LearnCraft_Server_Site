import { Inject, Injectable } from "@nestjs/common";
import {
  LessonRegistryService,
  resolveAuthoritativeLesson,
  type ResolvedTutorLesson,
} from "../catalog/lesson-registry.service";
import {
  buildTutorCacheKey,
  getCachedTutorAnswer,
  getInFlightCacheGeneration,
  getOrCreateInFlightCacheGeneration,
  getTutorCacheStore,
  setCachedTutorAnswer,
  TutorCacheService,
  type TutorCacheStore,
} from "./cache/tutor-cache.service";
import type { SafeProviderId } from "./errors/tutor.errors";
import {
  ConversationStoreService,
  getTutorConversationStore,
  type TutorConversationStore,
} from "./history/conversation-store.service";
import {
  generateConversationTitle,
  generateQuickActionTitle,
} from "./history/title-generator";
import {
  generateWithFallbackRouter,
  LlmRouterService,
  type LlmRouterOptions,
} from "./llm/llm-router.service";
import {
  buildLessonTutorPrompt,
  type BuiltTutorPrompt,
} from "./prompts/lesson-tutor";
import {
  isCacheableTutorAction,
  MAX_HISTORY_MESSAGES,
  type TutorAction,
  type TutorAskRequest,
} from "./schemas/tutor-request";
import {
  getTutorUsageStore,
  reserveAuthenticatedUserDailyAllowance,
  TutorUsageService,
  type TutorUsageStore,
} from "./usage/tutor-usage.service";

export interface TutorAskResponse {
  answer: string;
  cached: boolean;
  provider?: SafeProviderId;
  conversationId: string;
  conversationTitle: string;
}

export interface TutorServiceDependencies {
  cacheStore?: TutorCacheStore;
  usageStore?: TutorUsageStore;
  conversationStore?: TutorConversationStore;
  routerOptions?: LlmRouterOptions;
  now?: Date;
}

const ACTION_DISPLAY_LABELS: Record<TutorAction, string> = {
  explain_simply: "Explain simply",
  step_by_step: "Step by step",
  explain_code: "Explain code",
  another_example: "Another example",
  free: "Help me understand this lesson",
};

async function resolveAnswerWithCacheAndRouter(params: {
  userId: string;
  lesson: ResolvedTutorLesson;
  action: TutorAction;
  prompt: BuiltTutorPrompt;
  cacheable: boolean;
  cacheStore: TutorCacheStore;
  usageStore: TutorUsageStore;
  routerOptions?: LlmRouterOptions;
  now: Date;
}): Promise<{ answer: string; cached: boolean; provider?: SafeProviderId }> {
  const {
    userId,
    lesson,
    action,
    prompt,
    cacheable,
    cacheStore,
    usageStore,
    routerOptions,
    now,
  } = params;

  const cacheParams = {
    lessonId: lesson.lessonId,
    action,
    contentHash: lesson.contentHash,
    promptVersion: prompt.promptVersion,
    codeHash: lesson.codeHash,
  };

  const cacheKey = cacheable ? buildTutorCacheKey(cacheParams) : null;
  if (cacheable && cacheKey) {
    const preInFlight = getInFlightCacheGeneration(cacheKey);
    if (preInFlight) {
      const sharedResult = await preInFlight;
      return {
        answer: sharedResult.answer,
        cached: true,
        provider: sharedResult.provider,
      };
    }

    const cachedEntry = await getCachedTutorAnswer(cacheParams, cacheStore);
    if (cachedEntry) {
      return {
        answer: cachedEntry.answer,
        cached: true,
        provider: cachedEntry.provider,
      };
    }

    const { promise, isLeader } = getOrCreateInFlightCacheGeneration(
      cacheKey,
      async () => {
        await reserveAuthenticatedUserDailyAllowance(userId, now, usageStore);

        const generated = await generateWithFallbackRouter(
          {
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            historyMessages: prompt.historyMessages,
          },
          {
            ...routerOptions,
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
    return {
      answer: result.answer,
      cached: !isLeader,
      provider: result.provider,
    };
  }

  await reserveAuthenticatedUserDailyAllowance(userId, now, usageStore);

  const generated = await generateWithFallbackRouter(
    {
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      historyMessages: prompt.historyMessages,
    },
    {
      ...routerOptions,
      now,
      usageStore,
    },
  );

  return {
    answer: generated.answer,
    cached: false,
    provider: generated.provider,
  };
}

export async function askLessonTutor(
  userId: string,
  request: TutorAskRequest,
  deps: TutorServiceDependencies = {},
): Promise<TutorAskResponse> {
  const cacheStore = deps.cacheStore ?? getTutorCacheStore();
  const usageStore = deps.usageStore ?? getTutorUsageStore();
  const conversationStore =
    deps.conversationStore ?? getTutorConversationStore();
  const now = deps.now ?? new Date();

  const lesson = resolveAuthoritativeLesson(
    request.lessonId,
    request.codeBlockId,
  );

  const authoritativeHistory = request.conversationId
    ? await conversationStore.getRecentContextMessages({
        conversationId: request.conversationId,
        userId,
        lessonId: lesson.lessonId,
        limit: MAX_HISTORY_MESSAGES,
      })
    : [];

  const cacheable = isCacheableTutorAction(request.action);
  const prompt = buildLessonTutorPrompt({
    lesson,
    action: request.action,
    message: request.message,
    history: cacheable ? [] : authoritativeHistory,
  });

  const resolved = await resolveAnswerWithCacheAndRouter({
    userId,
    lesson,
    action: request.action,
    prompt,
    cacheable,
    cacheStore,
    usageStore,
    routerOptions: deps.routerOptions,
    now,
  });

  const persistedUserContent =
    request.action === "free"
      ? request.message!
      : request.message?.trim() || ACTION_DISPLAY_LABELS[request.action];

  if (request.conversationId) {
    const appended = await conversationStore.appendExchangeToConversation({
      conversationId: request.conversationId,
      userId,
      lessonId: lesson.lessonId,
      userContent: persistedUserContent,
      assistantContent: resolved.answer,
      now,
    });

    return {
      ...resolved,
      conversationId: appended.conversationId,
      conversationTitle: appended.title,
    };
  }

  const generatedTitle =
    request.action === "free"
      ? generateConversationTitle(persistedUserContent, lesson.title)
      : generateQuickActionTitle(request.action, lesson.title);

  const created = await conversationStore.createConversationWithExchange({
    userId,
    lessonId: lesson.lessonId,
    lessonTitle: `${lesson.code}: ${lesson.title}`,
    title: generatedTitle,
    userContent: persistedUserContent,
    assistantContent: resolved.answer,
    now,
  });

  return {
    ...resolved,
    conversationId: created.conversation.id,
    conversationTitle: created.conversation.title,
  };
}

@Injectable()
export class TutorService {
  constructor(
    @Inject(LessonRegistryService)
    private readonly lessonRegistry: LessonRegistryService,
    @Inject(TutorCacheService) private readonly cacheService: TutorCacheService,
    @Inject(TutorUsageService) private readonly usageService: TutorUsageService,
    @Inject(ConversationStoreService)
    private readonly conversationStore: ConversationStoreService,
    @Inject(LlmRouterService) private readonly llmRouter: LlmRouterService,
  ) {}

  async ask(
    userId: string,
    request: TutorAskRequest,
    deps: TutorServiceDependencies = {},
  ): Promise<TutorAskResponse> {
    // Ensure catalog registry & NestJS router service are initialized cleanly
    void this.lessonRegistry;
    void this.llmRouter;
    return askLessonTutor(userId, request, {
      cacheStore: deps.cacheStore ?? this.cacheService,
      usageStore: deps.usageStore ?? this.usageService,
      conversationStore: deps.conversationStore ?? this.conversationStore,
      routerOptions: deps.routerOptions,
      now: deps.now,
    });
  }
}
