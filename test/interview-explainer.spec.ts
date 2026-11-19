import {
  ALL_INTERVIEW_QUESTIONS,
  clearInterviewQuestionOverridesForTests,
  resolveAuthoritativeInterviewQuestion,
  resolveAuthoritativeRelatedLesson,
  setInterviewQuestionOverrideForTests,
} from "../src/catalog/question-registry.service";
import {
  extractQuestionCodeBlocks,
  questionHasRelevantCode,
} from "../src/interview-ai/code-utils";
import { explainInterviewQuestion } from "../src/interview-ai/interview-ai.service";
import { buildInterviewExplainerPrompt } from "../src/interview-ai/prompts";
import { validateInterviewExplainRequest } from "../src/interview-ai/schemas";
import {
  InMemoryTutorCacheStore,
  resetTutorCacheForTests,
} from "../src/tutor/cache/tutor-cache.service";
import {
  InterviewQuestionNotFoundError,
  TutorValidationError,
} from "../src/tutor/errors/tutor.errors";
import {
  InMemoryTutorConversationStore,
  resetTutorConversationStoreForTests,
} from "../src/tutor/history/conversation-store.service";
import { listUserGlobalConversations } from "../src/tutor/history.service";
import { clearProviderCooldownsForTests } from "../src/tutor/llm/llm-router.service";
import type { ProviderAdapterFn } from "../src/tutor/llm/providers";
import { askLessonTutor } from "../src/tutor/tutor.service";
import {
  InMemoryTutorUsageStore,
  resetTutorUsageForTests,
} from "../src/tutor/usage/tutor-usage.service";

const VALID_TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODEL: "gemini-2.0-flash",
  GEMINI_FREE_MODEL_ALLOWLIST: "gemini-2.0-flash,gemini-1.5-flash",
  GEMINI_DAILY_REQUEST_BUDGET: "100",
  GEMINI_RPM_BUDGET: "15",
  TUTOR_USER_DAILY_LIMIT: "5",
  TUTOR_MAX_OUTPUT_TOKENS: "600",
  TUTOR_REQUEST_TIMEOUT_MS: "10000",
  TUTOR_PROMPT_VERSION: "v1",
  INTERVIEW_EXPLAINER_PROMPT_VERSION: "interview-v1",
};

describe("AI Interview Question Explainer — Catalog & Service Suite", () => {
  let cacheStore: InMemoryTutorCacheStore;
  let usageStore: InMemoryTutorUsageStore;
  let conversationStore: InMemoryTutorConversationStore;

  beforeEach(async () => {
    cacheStore = new InMemoryTutorCacheStore();
    usageStore = new InMemoryTutorUsageStore();
    conversationStore = new InMemoryTutorConversationStore();
    clearProviderCooldownsForTests();
    clearInterviewQuestionOverridesForTests();
    await resetTutorCacheForTests();
    await resetTutorUsageForTests();
    await resetTutorConversationStoreForTests();
  });

  it("loads all 224 curated interview questions and resolves related lessons safely", () => {
    expect(ALL_INTERVIEW_QUESTIONS.length).toBe(224);

    const nextQ = resolveAuthoritativeInterviewQuestion("next-q01");
    expect(nextQ.trackKey).toBe("nextjs");
    expect(nextQ.relatedLesson?.lessonUrl).toContain("/learn/nextjs/");

    const tanstackLink = resolveAuthoritativeRelatedLesson(
      "/learn/tanstack/tq02-use-query",
    );
    expect(tanstackLink?.trackKey).toBe("tanstack");
    expect(tanstackLink?.lessonCode).toBe("TQ-02");

    expect(
      resolveAuthoritativeRelatedLesson("/learn/fake/missing-slug"),
    ).toBeNull();
    expect(() =>
      resolveAuthoritativeInterviewQuestion("missing-q999"),
    ).toThrow(InterviewQuestionNotFoundError);
  });

  it("extracts deduplicated code blocks accurately and validates requests strictly", () => {
    const jsCodeQ = resolveAuthoritativeInterviewQuestion("js-q02");
    expect(questionHasRelevantCode(jsCodeQ)).toBe(true);
    expect(extractQuestionCodeBlocks(jsCodeQ).length).toBeGreaterThan(0);

    expect(() =>
      validateInterviewExplainRequest({
        questionId: "next-q01",
        action: "free",
        message: "   ",
      }),
    ).toThrow(TutorValidationError);
  });

  it("builds structured prompt context with untrusted boundaries and isolates cache from lesson tutor", async () => {
    const q = resolveAuthoritativeInterviewQuestion("next-q01");
    const built = buildInterviewExplainerPrompt({
      question: q,
      action: "explain_question",
    });
    expect(built.systemPrompt).toContain("<UNTRUSTED_QUESTION_DATA>");

    let llmCalls = 0;
    const adapters: Record<string, ProviderAdapterFn> = {
      gemini: async (cfg) => {
        llmCalls += 1;
        return {
          answer: `Mocked answer #${llmCalls}`,
          provider: "gemini",
          model: cfg.model,
        };
      },
    };

    const exp1 = await explainInterviewQuestion(
      "user-int-1",
      { questionId: "next-q01", action: "explain_concept", history: [] },
      {
        cacheStore,
        usageStore,
        conversationStore,
        routerOptions: { env: VALID_TEST_ENV, adapters },
      },
    );
    expect(exp1.cached).toBe(false);
    expect(exp1.conversationId).toBeTruthy();

    // Shared cache hit for second user
    const exp2 = await explainInterviewQuestion(
      "user-int-2",
      { questionId: "next-q01", action: "explain_concept", history: [] },
      {
        cacheStore,
        usageStore,
        conversationStore,
        routerOptions: { env: VALID_TEST_ENV, adapters },
      },
    );
    expect(exp2.cached).toBe(true);
    expect(exp2.answer).toBe(exp1.answer);
    expect(llmCalls).toBe(1);

    // Content change invalidates interview explainer cache
    setInterviewQuestionOverrideForTests("next-q01", {
      answer: "Updated model answer text",
    });
    const exp3 = await explainInterviewQuestion(
      "user-int-2",
      { questionId: "next-q01", action: "explain_concept", history: [] },
      {
        cacheStore,
        usageStore,
        conversationStore,
        routerOptions: { env: VALID_TEST_ENV, adapters },
      },
    );
    expect(exp3.cached).toBe(false);
    expect(llmCalls).toBe(2);

    // Lesson Tutor remains completely separate in cache & global history
    await askLessonTutor(
      "user-int-1",
      {
        lessonId: "nextjs:nx01-what-is-nextjs",
        action: "explain_simply",
        history: [],
      },
      {
        cacheStore,
        usageStore,
        conversationStore,
        routerOptions: { env: VALID_TEST_ENV, adapters },
      },
    );

    const global = await listUserGlobalConversations(
      "user-int-1",
      {},
      { conversationStore },
    );
    expect(global.conversations).toHaveLength(2);
    expect(
      global.conversations.some((c) =>
        c.lessonUrl?.startsWith("/interview/nextjs/browse?questionId="),
      ),
    ).toBe(true);
    expect(
      global.conversations.some(
        (c) => c.lessonUrl === "/learn/nextjs/nx01-what-is-nextjs",
      ),
    ).toBe(true);
  });
});
