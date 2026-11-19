import {
  InMemoryTutorCacheStore,
  resetTutorCacheForTests,
} from "../src/tutor/cache/tutor-cache.service";
import { ConversationNotFoundError, TutorValidationError } from "../src/tutor/errors/tutor.errors";
import {
  formatConversationPreview,
  InMemoryTutorConversationStore,
  resetTutorConversationStoreForTests,
} from "../src/tutor/history/conversation-store.service";
import {
  generateConversationTitle,
  generateQuickActionTitle,
  normalizeGenericTitle,
} from "../src/tutor/history/title-generator";
import {
  clearUserLessonHistory,
  deleteUserConversation,
  getUserConversationDetail,
  listUserGlobalConversations,
  listUserLessonConversations,
} from "../src/tutor/history.service";
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
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  GEMINI_FREE_MODEL_ALLOWLIST: "gemini-3.5-flash-lite",
  GEMINI_DAILY_REQUEST_BUDGET: "100",
  GEMINI_RPM_BUDGET: "15",
  TUTOR_USER_DAILY_LIMIT: "5",
  TUTOR_MAX_OUTPUT_TOKENS: "600",
  TUTOR_REQUEST_TIMEOUT_MS: "10000",
  TUTOR_PROMPT_VERSION: "v1",
};

describe("AI Lesson Tutor — History Service & Title Generation Suite", () => {
  let cacheStore: InMemoryTutorCacheStore;
  let usageStore: InMemoryTutorUsageStore;
  let conversationStore: InMemoryTutorConversationStore;

  beforeEach(async () => {
    cacheStore = new InMemoryTutorCacheStore();
    usageStore = new InMemoryTutorUsageStore();
    conversationStore = new InMemoryTutorConversationStore();
    await resetTutorCacheForTests();
    await resetTutorUsageForTests();
    await resetTutorConversationStoreForTests();
    clearProviderCooldownsForTests();
  });

  it("generates concise deterministic conversation titles without calling AI", () => {
    expect(
      generateConversationTitle("Can you explain React component composition?"),
    ).toBe("Understanding React Component Composition");

    expect(generateConversationTitle("   what   is   JSX   in   react???  ")).toBe(
      "Understanding JSX in React",
    );

    expect(
      generateQuickActionTitle("explain_simply", "Components & Composition"),
    ).toBe("Components & Composition: Simple Explanation");

    expect(
      normalizeGenericTitle("Understanding This Concept in Simple Words", "Closures"),
    ).toBe("Closures: Simple Explanation");
  });

  it("sanitizes Markdown into clean conversation previews", () => {
    const preview = formatConversationPreview(
      "### Heading\nUse `useState` cleanly:\n```ts\nconst x = 1;\n```\nGreat!",
    );
    expect(preview).toContain("Heading:");
    expect(preview).toContain("useState");
    expect(preview).toContain("[code]");
    expect(preview.length).toBeLessThanOrEqual(120);
  });

  it("supports cursor-based global history pagination and gracefully handles archived lessons", async () => {
    await conversationStore.createConversationWithExchange({
      userId: "user-p",
      lessonId: "react:react01-what-is-react",
      lessonTitle: "REACT-01: What Is React?",
      title: "React Intro",
      userContent: "Explain React",
      assistantContent: "React builds UIs.",
      now: new Date("2026-06-01T10:00:00Z"),
    });
    await conversationStore.createConversationWithExchange({
      userId: "user-p",
      lessonId: "javascript:js15-closures",
      lessonTitle: "JS-15: Closures",
      title: "JS Closures",
      userContent: "Explain closures",
      assistantContent: "Closures capture scope.",
      now: new Date("2026-06-02T10:00:00Z"),
    });
    await conversationStore.createConversationWithExchange({
      userId: "user-p",
      lessonId: "react:retired-deleted-lesson",
      lessonTitle: "Legacy Removed Module",
      title: "Archived Discussion",
      userContent: "Old question",
      assistantContent: "Old answer",
      now: new Date("2026-06-03T10:00:00Z"),
    });

    const page1 = await listUserGlobalConversations(
      "user-p",
      { limit: 2 },
      { conversationStore },
    );
    expect(page1.conversations).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    // Newest first (retired archived lesson)
    expect(page1.conversations[0].lessonAvailable).toBe(false);
    expect(page1.conversations[0].lessonUrl).toBeNull();
    expect(page1.conversations[0].trackTitle).toBe("React.js");

    expect(page1.conversations[1].lessonAvailable).toBe(true);
    expect(page1.conversations[1].lessonUrl).toBe("/learn/javascript/js15-closures");

    const page2 = await listUserGlobalConversations(
      "user-p",
      { limit: 2, cursor: page1.nextCursor! },
      { conversationStore },
    );
    expect(page2.conversations).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.conversations[0].lessonUrl).toBe("/learn/react/react01-what-is-react");

    await expect(
      listUserGlobalConversations(
        "user-p",
        { cursor: "invalid-cursor" },
        { conversationStore },
      ),
    ).rejects.toThrow(TutorValidationError);
  });

  it("enforces user isolation and lesson scoping across list, get, delete, and clear operations", async () => {
    const adapters: Record<string, ProviderAdapterFn> = {
      gemini: async (cfg) => ({
        answer: "Isolated answer",
        provider: "gemini",
        model: cfg.model,
      }),
    };

    const created = await askLessonTutor(
      "alice",
      {
        lessonId: "react:react01-what-is-react",
        action: "free",
        message: "Alice question",
        history: [],
      },
      {
        cacheStore,
        usageStore,
        conversationStore,
        routerOptions: { env: VALID_TEST_ENV, adapters },
      },
    );

    expect(
      await listUserLessonConversations(
        "bob",
        "react:react01-what-is-react",
        {},
        { conversationStore },
      ),
    ).toEqual([]);

    await expect(
      getUserConversationDetail("bob", created.conversationId, undefined, {
        conversationStore,
      }),
    ).rejects.toThrow(ConversationNotFoundError);

    await expect(
      deleteUserConversation("bob", created.conversationId, undefined, {
        conversationStore,
      }),
    ).rejects.toThrow(ConversationNotFoundError);

    const cleared = await clearUserLessonHistory(
      "alice",
      "react:react01-what-is-react",
      { conversationStore },
    );
    expect(cleared.deletedCount).toBe(1);
  });
});
