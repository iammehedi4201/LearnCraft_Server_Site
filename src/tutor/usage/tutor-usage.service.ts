import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  getCurrentUtcDateKey,
  getNextUtcMidnightIso,
  UserDailyLimitReachedError,
  type SafeProviderId,
} from "../errors/tutor.errors";

export function getConfiguredUserDailyLimit(): number {
  const raw = process.env.TUTOR_USER_DAILY_LIMIT?.trim();
  if (!raw) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5;
  }
  return parsed;
}

export interface UserUsageReservation {
  userId: string;
  usageDate: string;
  requestCount: number;
  limit: number;
  remaining: number;
  resetAtUtc: string;
}

export interface ProviderReservationResult {
  allowed: boolean;
  reason?: "daily_budget_exhausted" | "rpm_budget_exhausted";
  requestCount: number;
  dailyBudget: number;
  resetAtMs?: number;
}

export interface TutorUsageStore {
  reserveUserRequest(
    userId: string,
    limit: number,
    now?: Date,
  ): Promise<UserUsageReservation>;
  getUserRequestCount(userId: string, now?: Date): Promise<number>;
  reserveProviderRequest(
    provider: SafeProviderId,
    dailyBudget: number,
    rpmBudget: number,
    now?: Date,
  ): Promise<ProviderReservationResult>;
  getProviderRequestCount(
    provider: SafeProviderId,
    now?: Date,
  ): Promise<number>;
  clearAll?(): Promise<void>;
}

const keyLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current);
  keyLocks.set(key, chained);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(key) === chained) {
      keyLocks.delete(key);
    }
  }
}

interface MemoryProviderState {
  usageDate: string;
  requestCount: number;
  dailyBudget: number;
  minuteBucket: number;
  minuteCount: number;
}

const globalForTutorUsage = globalThis as unknown as {
  __learncraftTutorUserCounts?: Map<string, number>;
  __learncraftTutorProviderCounts?: Map<string, MemoryProviderState>;
};

const memoryUserCounts =
  globalForTutorUsage.__learncraftTutorUserCounts ??
  (globalForTutorUsage.__learncraftTutorUserCounts = new Map<string, number>());
const memoryProviderCounts =
  globalForTutorUsage.__learncraftTutorProviderCounts ??
  (globalForTutorUsage.__learncraftTutorProviderCounts = new Map<
    string,
    MemoryProviderState
  >());

export class InMemoryTutorUsageStore implements TutorUsageStore {
  async reserveUserRequest(
    userId: string,
    limit: number,
    now: Date = new Date(),
  ): Promise<UserUsageReservation> {
    const usageDate = getCurrentUtcDateKey(now);
    const key = `user:${userId}:${usageDate}`;

    return withKeyLock(key, async () => {
      const current = memoryUserCounts.get(key) ?? 0;
      const resetAtUtc = getNextUtcMidnightIso(now);

      if (current >= limit) {
        throw new UserDailyLimitReachedError(limit, resetAtUtc);
      }

      const nextCount = current + 1;
      memoryUserCounts.set(key, nextCount);

      return {
        userId,
        usageDate,
        requestCount: nextCount,
        limit,
        remaining: Math.max(0, limit - nextCount),
        resetAtUtc,
      };
    });
  }

  async getUserRequestCount(
    userId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const usageDate = getCurrentUtcDateKey(now);
    return memoryUserCounts.get(`user:${userId}:${usageDate}`) ?? 0;
  }

  async reserveProviderRequest(
    provider: SafeProviderId,
    dailyBudget: number,
    rpmBudget: number,
    now: Date = new Date(),
  ): Promise<ProviderReservationResult> {
    const usageDate = getCurrentUtcDateKey(now);
    const key = `provider:${provider}:${usageDate}`;
    const minuteBucket = Math.floor(now.getTime() / 60000);

    return withKeyLock(key, async () => {
      const state = memoryProviderCounts.get(key) ?? {
        usageDate,
        requestCount: 0,
        dailyBudget,
        minuteBucket,
        minuteCount: 0,
      };

      if (state.minuteBucket !== minuteBucket) {
        state.minuteBucket = minuteBucket;
        state.minuteCount = 0;
      }

      if (state.requestCount >= dailyBudget) {
        const nextMidnightMs = Date.parse(getNextUtcMidnightIso(now));
        return {
          allowed: false,
          reason: "daily_budget_exhausted",
          requestCount: state.requestCount,
          dailyBudget,
          resetAtMs: nextMidnightMs,
        };
      }

      if (rpmBudget > 0 && state.minuteCount >= rpmBudget) {
        const nextMinuteMs = (minuteBucket + 1) * 60000;
        return {
          allowed: false,
          reason: "rpm_budget_exhausted",
          requestCount: state.requestCount,
          dailyBudget,
          resetAtMs: nextMinuteMs,
        };
      }

      state.requestCount += 1;
      state.minuteCount += 1;
      state.dailyBudget = dailyBudget;
      memoryProviderCounts.set(key, state);

      return {
        allowed: true,
        requestCount: state.requestCount,
        dailyBudget,
      };
    });
  }

  async getProviderRequestCount(
    provider: SafeProviderId,
    now: Date = new Date(),
  ): Promise<number> {
    const usageDate = getCurrentUtcDateKey(now);
    return (
      memoryProviderCounts.get(`provider:${provider}:${usageDate}`)
        ?.requestCount ?? 0
    );
  }

  async clearAll(): Promise<void> {
    memoryUserCounts.clear();
    memoryProviderCounts.clear();
  }
}

@Injectable()
export class TutorUsageService implements TutorUsageStore {
  private readonly fallback = new InMemoryTutorUsageStore();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async reserveUserRequest(
    userId: string,
    limit: number,
    now: Date = new Date(),
  ): Promise<UserUsageReservation> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.reserveUserRequest(userId, limit, now);
    }

    const usageDate = getCurrentUtcDateKey(now);
    const lockKey = `db:user:${userId}:${usageDate}`;
    const resetAtUtc = getNextUtcMidnightIso(now);

    return withKeyLock(lockKey, async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.tutorDailyUsage.upsert({
            where: { userId_usageDate: { userId, usageDate } },
            update: {},
            create: { userId, usageDate, requestCount: 0 },
          });

          const updated = await tx.tutorDailyUsage.updateMany({
            where: {
              userId,
              usageDate,
              requestCount: { lt: limit },
            },
            data: {
              requestCount: { increment: 1 },
            },
          });

          if (updated.count === 0) {
            throw new UserDailyLimitReachedError(limit, resetAtUtc);
          }

          const record = await tx.tutorDailyUsage.findUnique({
            where: { userId_usageDate: { userId, usageDate } },
          });

          const count = record?.requestCount ?? limit;
          return {
            userId,
            usageDate,
            requestCount: count,
            limit,
            remaining: Math.max(0, limit - count),
            resetAtUtc,
          };
        });
      } catch (err) {
        if (err instanceof UserDailyLimitReachedError) {
          throw err;
        }
        return this.fallback.reserveUserRequest(userId, limit, now);
      }
    });
  }

  async getUserRequestCount(
    userId: string,
    now: Date = new Date(),
  ): Promise<number> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.getUserRequestCount(userId, now);
    }
    const usageDate = getCurrentUtcDateKey(now);
    try {
      const row = await this.prisma.tutorDailyUsage.findUnique({
        where: { userId_usageDate: { userId, usageDate } },
      });
      return row?.requestCount ?? 0;
    } catch {
      return this.fallback.getUserRequestCount(userId, now);
    }
  }

  async reserveProviderRequest(
    provider: SafeProviderId,
    dailyBudget: number,
    rpmBudget: number,
    now: Date = new Date(),
  ): Promise<ProviderReservationResult> {
    const memRes = await this.fallback.reserveProviderRequest(
      provider,
      dailyBudget,
      rpmBudget,
      now,
    );
    if (!memRes.allowed || !this.prisma.isRealDatabaseConfigured) {
      return memRes;
    }

    const usageDate = getCurrentUtcDateKey(now);
    const lockKey = `db:provider:${provider}:${usageDate}`;

    return withKeyLock(lockKey, async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.tutorProviderUsage.upsert({
            where: { provider_usageDate: { provider, usageDate } },
            update: { dailyBudget },
            create: {
              provider,
              usageDate,
              requestCount: 0,
              dailyBudget,
            },
          });

          const updated = await tx.tutorProviderUsage.updateMany({
            where: {
              provider,
              usageDate,
              requestCount: { lt: dailyBudget },
            },
            data: {
              requestCount: { increment: 1 },
            },
          });

          if (updated.count === 0) {
            return {
              allowed: false,
              reason: "daily_budget_exhausted" as const,
              requestCount: dailyBudget,
              dailyBudget,
              resetAtMs: Date.parse(getNextUtcMidnightIso(now)),
            };
          }

          const row = await tx.tutorProviderUsage.findUnique({
            where: { provider_usageDate: { provider, usageDate } },
          });

          return {
            allowed: true,
            requestCount: row?.requestCount ?? memRes.requestCount,
            dailyBudget,
          };
        });
      } catch {
        return memRes;
      }
    });
  }

  async getProviderRequestCount(
    provider: SafeProviderId,
    now: Date = new Date(),
  ): Promise<number> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.getProviderRequestCount(provider, now);
    }
    const usageDate = getCurrentUtcDateKey(now);
    try {
      const row = await this.prisma.tutorProviderUsage.findUnique({
        where: { provider_usageDate: { provider, usageDate } },
      });
      return row?.requestCount ?? 0;
    } catch {
      return this.fallback.getProviderRequestCount(provider, now);
    }
  }

  async clearAll(): Promise<void> {
    await this.fallback.clearAll();
  }
}

let activeUsageStore: TutorUsageStore = new InMemoryTutorUsageStore();

export function setTutorUsageStore(store: TutorUsageStore): void {
  activeUsageStore = store;
}

export function getTutorUsageStore(): TutorUsageStore {
  return activeUsageStore;
}

export async function resetTutorUsageForTests(): Promise<void> {
  if (activeUsageStore.clearAll) {
    await activeUsageStore.clearAll();
  }
  memoryUserCounts.clear();
  memoryProviderCounts.clear();
}

export async function reserveAuthenticatedUserDailyAllowance(
  userId: string,
  now: Date = new Date(),
  store: TutorUsageStore = activeUsageStore,
): Promise<UserUsageReservation> {
  const limit = getConfiguredUserDailyLimit();
  return store.reserveUserRequest(userId, limit, now);
}
