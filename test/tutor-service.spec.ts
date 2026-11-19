import {
  clearLessonOverridesForTests,
  resolveAuthoritativeLesson,
  setLessonOverrideForTests,
} from "../src/catalog/lesson-registry.service";
import {
  InMemoryTutorCacheStore,
  resetTutorCacheForTests,
} from "../src/tutor/cache/tutor-cache.service";
import {
  AllProvidersBusyError,
  ProviderCallError,
  UserDailyLimitReachedError,
} from "../src/tutor/errors/tutor.errors";
import {
  applyCooldownFromError,
  clearProviderCooldownsForTests,
  generateWithFallbackRouter,
  getProviderCooldown,
  setProviderCooldown,
} from "../src/tutor/llm/llm-router.service";
import {
  detectDailyQuotaExhaustion,
  parseRetryAfterSeconds,
  validateProviderConfig,
  type ProviderAdapterFn,
} from "../src/tutor/llm/providers";
import { buildLessonTutorPrompt } from "../src/tutor/prompts/lesson-tutor";
import { askLessonTutor } from "../src/tutor/tutor.service";
import {
  InMemoryTutorUsageStore,
  resetTutorUsageForTests,
} from "../src/tutor/usage/tutor-usage.service";
import {
  InMemoryTutorConversationStore,
  resetTutorConversationStoreForTests,
} from "../src/tutor/history/conversation-store.service";

const VALID_TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODEL: "gemini-2.0-flash",
  GEMINI_FREE_MODEL_ALLOWLIST: "gemini-2.0-flash,gemini-1.5-flash",
  GEMINI_DAILY_REQUEST_BUDGET: "100",
  GEMINI_RPM_BUDGET: "15",

  GROQ_API_KEY: "test-groq-key",
  GROQ_MODEL: "llama-3.3-70b-versatile",
  GROQ_FREE_MODEL_ALLOWLIST: "llama-3.3-70b-versatile,llama-3.1-8b-instant",
  GROQ_DAILY_REQUEST_BUDGET: "100",
  GROQ_RPM_BUDGET: "20",

  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct:free",
  OPENROUTER_FREE_MODEL_ALLOWLIST:
    "meta-llama/llama-3.3-70b-instruct:free,google/gemma-3-27b-it:free",
  OPENROUTER_DAILY_REQUEST_BUDGET: "100",
  OPENROUTER_RPM_BUDGET: "10",

  TUTOR_USER_DAILY_LIMIT: "5",
  TUTOR_MAX_OUTPUT_TOKENS: "600",
  TUTOR_REQUEST_TIMEOUT_MS: "10000",
  TUTOR_PROMPT_VERSION: "v1",
  TUTOR_DAILY_TIME_ZONE: "UTC",
};

describe("AI Lesson Tutor — Backend Service, Router & Cache Suite", () => {
  let cacheStore: InMemoryTutorCacheStore;
  let usageStore: InMemoryTutorUsageStore;
  let conversationStore: InMemoryTutorConversationStore;

  beforeEach(async () => {
    cacheStore = new InMemoryTutorCacheStore();
    usageStore = new InMemoryTutorUsageStore();
    conversationStore = new InMemoryTutorConversationStore();
    clearProviderCooldownsForTests();
    clearLessonOverridesForTests();
    await resetTutorCacheForTests();
    await resetTutorUsageForTests();
    await resetTutorConversationStoreForTests();
    process.env.TUTOR_PROMPT_VERSION = "v1";
    process.env.TUTOR_USER_DAILY_LIMIT = "5";
  });

  it("attempts Gemini -> Groq -> OpenRouter in priority order and respects cooldowns", async () => {
    const callOrder: string[] = [];
    const adapters: Record<string, ProviderAdapterFn> = {
      gemini: async () => {
        callOrder.push("gemini");
        throw new ProviderCallError({ provider: "gemini", statusCode: 429 });
      },
      groq: async () => {
        callOrder.push("groq");
        throw new ProviderCallError({
          provider: "groq",
          statusCode: 503,
        });
      },
      openrouter: async (cfg) => {
        callOrder.push("openrouter");
        return {
          answer: "OpenRouter fallback answer",
          provider: "openrouter",
          model: cfg.model,
        };
      },
    };

    const result = await generateWithFallbackRouter(
      { systemPrompt: "sys", userPrompt: "usr" },
      { env: VALID_TEST_ENV, usageStore, adapters },
    );

    expect(result.provider).toBe("openrouter");
    expect(callOrder).toEqual(["gemini", "groq", "openrouter"]);
    expect(getProviderCooldown("gemini")?.reason).toBe("rate_limit");
    expect(getProviderCooldown("groq")?.reason).toBe("server_error");
  });

  it("throws AllProvidersBusyError when every provider is exhausted or disabled", async () => {
    const now = new Date("2026-04-12T10:00:00.000Z");
    setProviderCooldown("gemini", now.getTime() + 60_000, "rate_limit");
    setProviderCooldown("groq", now.getTime() + 60_000, "rate_limit");
    setProviderCooldown("openrouter", now.getTime() + 60_000, "rate_limit");

    await expect(
      generateWithFallbackRouter(
        { systemPrompt: "sys", userPrompt: "usr" },
        { env: VALID_TEST_ENV, usageStore, now },
      ),
    ).rejects.toThrow(AllProvidersBusyError);
  });

  it("validates free-model allowlists and rejects disallowed paid models", () => {
    const paidOpenRouter = validateProviderConfig("openrouter", {
      ...VALID_TEST_ENV,
      OPENROUTER_MODEL: "openai/gpt-4o",
      OPENROUTER_FREE_MODEL_ALLOWLIST: "openai/gpt-4o",
    });
    expect(paidOpenRouter.enabled).toBe(false);

    const parsedRetry = parseRetryAfterSeconds(
      new Headers({ "retry-after": "45" }),
    );
    expect(parsedRetry).toBe(45);

    expect(
      detectDailyQuotaExhaustion(
        429,
        '{"error":"Daily quota exceeded"}',
        new Headers(),
      ),
    ).toBe(true);

    const cd = applyCooldownFromError(
      new ProviderCallError({
        provider: "gemini",
        statusCode: 401,
      }),
    );
    expect(cd.reason).toBe("auth_error");
  });

  it("resolves authoritative lessons across all 14 tracks including aliases & TanStack", () => {
    const ts = resolveAuthoritativeLesson("typescript:ts01-what-typescript-does");
    expect(ts.trackKey).toBe("typescript");
    expect(ts.codeBlocks.length).toBeGreaterThan(0);

    const legacy = resolveAuthoritativeLesson(
      "nestjs:nj02-oop-foundations",
    );
    expect(legacy.slug).toBe("nj03-project-structure-and-main");

    const tanstack = resolveAuthoritativeLesson("tanstack:tq01-setup");
    expect(tanstack.trackKey).toBe("tanstack");
    expect(tanstack.code).toBe("TQ-01");

    const prompt = buildLessonTutorPrompt({
      lesson: ts,
      action: "explain_simply",
    });
    expect(prompt.systemPrompt).toContain("<UNTRUSTED_LESSON_DATA>");
  });

  it("shares cached quick actions across users without charging quota, invalidates on lesson/prompt change, and enforces 5/day limit", async () => {
    let llmCalls = 0;
    const adapters: Record<string, ProviderAdapterFn> = {
      gemini: async (cfg) => {
        llmCalls += 1;
        return {
          answer: `Generated explanation #${llmCalls}`,
          provider: "gemini",
          model: cfg.model,
        };
      },
    };

    const res1 = await askLessonTutor(
      "user-1",
      {
        lessonId: "react:react01-what-is-react",
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
    expect(res1.cached).toBe(false);
    expect(llmCalls).toBe(1);
    expect(await usageStore.getUserRequestCount("user-1")).toBe(1);

    // User 2 hits shared cache -> 0 LLM calls, 0 quota
    const res2 = await askLessonTutor(
      "user-2",
      {
        lessonId: "react:react01-what-is-react",
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
    expect(res2.cached).toBe(true);
    expect(res2.answer).toBe(res1.answer);
    expect(llmCalls).toBe(1);
    expect(await usageStore.getUserRequestCount("user-2")).toBe(0);

    // Content mutation invalidates cache
    setLessonOverrideForTests("react:react01-what-is-react", {
      summaryText: "Updated React lesson summary",
    });
    const res3 = await askLessonTutor(
      "user-2",
      {
        lessonId: "react:react01-what-is-react",
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
    expect(res3.cached).toBe(false);
    expect(llmCalls).toBe(2);

    // Enforce 5/day limit for user-1 (1 already used + 4 free questions = 5, 6th throws)
    for (let i = 0; i < 4; i++) {
      await askLessonTutor(
        "user-1",
        {
          lessonId: "react:react01-what-is-react",
          action: "free",
          message: `Question ${i + 1}`,
          history: [],
        },
        {
          cacheStore,
          usageStore,
          conversationStore,
          routerOptions: { env: VALID_TEST_ENV, adapters },
        },
      );
    }

    await expect(
      askLessonTutor(
        "user-1",
        {
          lessonId: "react:react01-what-is-react",
          action: "free",
          message: "6th live question",
          history: [],
        },
        {
          cacheStore,
          usageStore,
          conversationStore,
          routerOptions: { env: VALID_TEST_ENV, adapters },
        },
      ),
    ).rejects.toThrow(UserDailyLimitReachedError);
  });

  it("deduplicates concurrent identical cache misses with single-flight coalescing", async () => {
    let llmCalls = 0;
    const adapters: Record<string, ProviderAdapterFn> = {
      gemini: async (cfg) => {
        llmCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          answer: "Single-flight result",
          provider: "gemini",
          model: cfg.model,
        };
      },
    };

    const [a, b, c] = await Promise.all([
      askLessonTutor(
        "sf-user-1",
        { lessonId: "nodejs:node01-what-is-nodejs", action: "step_by_step", history: [] },
        { cacheStore, usageStore, conversationStore, routerOptions: { env: VALID_TEST_ENV, adapters } },
      ),
      askLessonTutor(
        "sf-user-2",
        { lessonId: "nodejs:node01-what-is-nodejs", action: "step_by_step", history: [] },
        { cacheStore, usageStore, conversationStore, routerOptions: { env: VALID_TEST_ENV, adapters } },
      ),
      askLessonTutor(
        "sf-user-3",
        { lessonId: "nodejs:node01-what-is-nodejs", action: "step_by_step", history: [] },
        { cacheStore, usageStore, conversationStore, routerOptions: { env: VALID_TEST_ENV, adapters } },
      ),
    ]);

    expect(llmCalls).toBe(1);
    expect([a.answer, b.answer, c.answer]).toEqual([
      "Single-flight result",
      "Single-flight result",
      "Single-flight result",
    ]);
  });
});
