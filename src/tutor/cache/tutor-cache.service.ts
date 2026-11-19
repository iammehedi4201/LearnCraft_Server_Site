import { Inject, Injectable } from "@nestjs/common";
import { computeSha256Hex } from "../../catalog/lesson-registry.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { SafeProviderId } from "../errors/tutor.errors";
import { isCacheableTutorAction, type TutorAction } from "../schemas/tutor-request";

export type TutorCacheNamespace = "lesson" | "interview_question";

const CACHEABLE_INTERVIEW_EXPLAIN_ACTIONS = new Set<string>([
  "explain_question",
  "explain_concept",
  "break_down_answer",
  "practical_example",
  "explain_code",
]);

function isCacheableActionForNamespace(
  action: string,
  namespace: TutorCacheNamespace = "lesson",
): boolean {
  if (namespace === "interview_question") {
    return CACHEABLE_INTERVIEW_EXPLAIN_ACTIONS.has(action);
  }
  return isCacheableTutorAction(action as TutorAction);
}

export interface TutorCacheKeyParams {
  namespace?: TutorCacheNamespace;
  lessonId: string;
  action: string;
  contentHash: string;
  promptVersion: string;
  codeHash?: string | null;
}

export interface TutorCacheEntry {
  id: string;
  cacheKey: string;
  lessonId: string;
  action: string;
  contentHash: string;
  promptVersion: string;
  codeHash: string | null;
  answer: string;
  provider: SafeProviderId;
  model: string;
  createdAt: Date;
}

export interface TutorCacheStore {
  findByKey(cacheKey: string): Promise<TutorCacheEntry | null>;
  upsertEntry(
    entry: Omit<TutorCacheEntry, "id" | "createdAt">,
  ): Promise<TutorCacheEntry>;
  deleteOutdatedForLesson(
    lessonId: string,
    currentContentHash: string,
    currentPromptVersion: string,
  ): Promise<number>;
  clearAll?(): Promise<void>;
}

export function buildTutorCacheKey(params: TutorCacheKeyParams): string | null {
  const namespace = params.namespace ?? "lesson";
  if (!isCacheableActionForNamespace(params.action, namespace)) {
    return null;
  }

  const effectiveCodeHash =
    params.action === "explain_code" ? params.codeHash || "no-code" : "none";

  const keyParts =
    namespace === "lesson"
      ? [
          params.lessonId.trim().toLowerCase(),
          params.action,
          params.contentHash,
          params.promptVersion,
          effectiveCodeHash,
        ]
      : [
          namespace,
          params.lessonId.trim().toLowerCase(),
          params.action,
          params.contentHash,
          params.promptVersion,
          effectiveCodeHash,
        ];

  return computeSha256Hex(keyParts.join("|"));
}

const globalForTutorCache = globalThis as unknown as {
  __learncraftTutorCacheMap?: Map<string, TutorCacheEntry>;
};
const memoryCacheMap =
  globalForTutorCache.__learncraftTutorCacheMap ??
  (globalForTutorCache.__learncraftTutorCacheMap = new Map<
    string,
    TutorCacheEntry
  >());

export class InMemoryTutorCacheStore implements TutorCacheStore {
  async findByKey(cacheKey: string): Promise<TutorCacheEntry | null> {
    return memoryCacheMap.get(cacheKey) ?? null;
  }

  async upsertEntry(
    data: Omit<TutorCacheEntry, "id" | "createdAt">,
  ): Promise<TutorCacheEntry> {
    const record: TutorCacheEntry = {
      ...data,
      id: `cache_${data.cacheKey.slice(0, 16)}`,
      createdAt: new Date(),
    };
    memoryCacheMap.set(data.cacheKey, record);
    return record;
  }

  async deleteOutdatedForLesson(
    lessonId: string,
    currentContentHash: string,
    currentPromptVersion: string,
  ): Promise<number> {
    let removed = 0;
    for (const [key, entry] of memoryCacheMap.entries()) {
      if (
        entry.lessonId === lessonId &&
        (entry.contentHash !== currentContentHash ||
          entry.promptVersion !== currentPromptVersion)
      ) {
        memoryCacheMap.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async clearAll(): Promise<void> {
    memoryCacheMap.clear();
  }
}

@Injectable()
export class TutorCacheService implements TutorCacheStore {
  private readonly fallback = new InMemoryTutorCacheStore();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByKey(cacheKey: string): Promise<TutorCacheEntry | null> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.findByKey(cacheKey);
    }
    try {
      const row = await this.prisma.tutorAnswerCache.findUnique({
        where: { cacheKey },
      });
      if (!row) return null;
      return {
        id: row.id,
        cacheKey: row.cacheKey,
        lessonId: row.lessonId,
        action: row.action as TutorAction,
        contentHash: row.contentHash,
        promptVersion: row.promptVersion,
        codeHash: row.codeHash,
        answer: row.answer,
        provider: row.provider as SafeProviderId,
        model: row.model,
        createdAt: row.createdAt,
      };
    } catch {
      return this.fallback.findByKey(cacheKey);
    }
  }

  async upsertEntry(
    data: Omit<TutorCacheEntry, "id" | "createdAt">,
  ): Promise<TutorCacheEntry> {
    await this.fallback.upsertEntry(data);
    if (!this.prisma.isRealDatabaseConfigured) {
      return (await this.fallback.findByKey(data.cacheKey))!;
    }
    try {
      const row = await this.prisma.tutorAnswerCache.upsert({
        where: { cacheKey: data.cacheKey },
        update: {
          answer: data.answer,
          provider: data.provider,
          model: data.model,
          contentHash: data.contentHash,
          promptVersion: data.promptVersion,
          codeHash: data.codeHash,
        },
        create: {
          cacheKey: data.cacheKey,
          lessonId: data.lessonId,
          action: data.action,
          contentHash: data.contentHash,
          promptVersion: data.promptVersion,
          codeHash: data.codeHash,
          answer: data.answer,
          provider: data.provider,
          model: data.model,
        },
      });
      return {
        id: row.id,
        cacheKey: row.cacheKey,
        lessonId: row.lessonId,
        action: row.action as TutorAction,
        contentHash: row.contentHash,
        promptVersion: row.promptVersion,
        codeHash: row.codeHash,
        answer: row.answer,
        provider: row.provider as SafeProviderId,
        model: row.model,
        createdAt: row.createdAt,
      };
    } catch {
      return (await this.fallback.findByKey(data.cacheKey))!;
    }
  }

  async deleteOutdatedForLesson(
    lessonId: string,
    currentContentHash: string,
    currentPromptVersion: string,
  ): Promise<number> {
    const memRemoved = await this.fallback.deleteOutdatedForLesson(
      lessonId,
      currentContentHash,
      currentPromptVersion,
    );
    if (!this.prisma.isRealDatabaseConfigured) {
      return memRemoved;
    }
    try {
      const res = await this.prisma.tutorAnswerCache.deleteMany({
        where: {
          lessonId,
          OR: [
            { contentHash: { not: currentContentHash } },
            { promptVersion: { not: currentPromptVersion } },
          ],
        },
      });
      return res.count;
    } catch {
      return memRemoved;
    }
  }

  async clearAll(): Promise<void> {
    await this.fallback.clearAll();
  }
}

const inFlightGenerations = new Map<
  string,
  Promise<{ answer: string; provider: SafeProviderId; model: string }>
>();

let defaultCacheStore: TutorCacheStore = new InMemoryTutorCacheStore();

export function setTutorCacheStore(store: TutorCacheStore): void {
  defaultCacheStore = store;
}

export function getTutorCacheStore(): TutorCacheStore {
  return defaultCacheStore;
}

export async function resetTutorCacheForTests(): Promise<void> {
  inFlightGenerations.clear();
  if (defaultCacheStore.clearAll) {
    await defaultCacheStore.clearAll();
  }
  memoryCacheMap.clear();
}

export function getInFlightCacheGeneration(
  cacheKey: string,
): Promise<{ answer: string; provider: SafeProviderId; model: string }> | undefined {
  return inFlightGenerations.get(cacheKey);
}

export function getOrCreateInFlightCacheGeneration(
  cacheKey: string,
  factory: () => Promise<{ answer: string; provider: SafeProviderId; model: string }>,
): {
  promise: Promise<{ answer: string; provider: SafeProviderId; model: string }>;
  isLeader: boolean;
} {
  const existing = inFlightGenerations.get(cacheKey);
  if (existing) {
    return { promise: existing, isLeader: false };
  }
  const promise = factory();
  inFlightGenerations.set(cacheKey, promise);
  const cleanup = () => {
    if (inFlightGenerations.get(cacheKey) === promise) {
      inFlightGenerations.delete(cacheKey);
    }
  };
  promise.then(cleanup, cleanup);
  return { promise, isLeader: true };
}

export async function getCachedTutorAnswer(
  params: TutorCacheKeyParams,
  store: TutorCacheStore = defaultCacheStore,
): Promise<TutorCacheEntry | null> {
  const cacheKey = buildTutorCacheKey(params);
  if (!cacheKey) return null;

  const entry = await store.findByKey(cacheKey);
  if (!entry) return null;

  if (
    entry.contentHash !== params.contentHash ||
    entry.promptVersion !== params.promptVersion
  ) {
    return null;
  }

  return entry;
}

export async function setCachedTutorAnswer(
  params: TutorCacheKeyParams & {
    answer: string;
    provider: SafeProviderId;
    model: string;
  },
  store: TutorCacheStore = defaultCacheStore,
): Promise<TutorCacheEntry | null> {
  const cacheKey = buildTutorCacheKey(params);
  if (!cacheKey) return null;

  const effectiveCodeHash =
    params.action === "explain_code" ? params.codeHash ?? null : null;

  const saved = await store.upsertEntry({
    cacheKey,
    lessonId: params.lessonId,
    action: params.action,
    contentHash: params.contentHash,
    promptVersion: params.promptVersion,
    codeHash: effectiveCodeHash,
    answer: params.answer,
    provider: params.provider,
    model: params.model,
  });

  void store
    .deleteOutdatedForLesson(
      params.lessonId,
      params.contentHash,
      params.promptVersion,
    )
    .catch(() => {});

  return saved;
}
