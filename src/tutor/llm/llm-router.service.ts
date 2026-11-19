import { Inject, Injectable } from "@nestjs/common";
import {
  AllProvidersBusyError,
  getNextUtcMidnightIso,
  ProviderCallError,
  type SafeProviderId,
} from "../errors/tutor.errors";
import {
  getTutorUsageStore,
  TutorUsageService,
  type TutorUsageStore,
} from "../usage/tutor-usage.service";
import {
  DEFAULT_PROVIDER_ADAPTERS,
  PROVIDER_PRIORITY_ORDER,
  validateProviderConfig,
  type LlmGenerationInput,
  type LlmGenerationOutput,
  type ProviderAdapterFn,
} from "./providers";

export type CooldownReason =
  | "rate_limit"
  | "daily_quota_exhausted"
  | "server_error"
  | "network_error"
  | "auth_error";

export interface ProviderCooldownState {
  provider: SafeProviderId;
  untilMs: number;
  reason: CooldownReason;
  model?: string;
}

export interface CooldownConfig {
  serverErrorMs: number;
  networkErrorMs: number;
  authErrorMs: number;
  defaultRateLimitMs: number;
}

export const DEFAULT_COOLDOWN_CONFIG: CooldownConfig = {
  serverErrorMs: 30_000,
  networkErrorMs: 30_000,
  authErrorMs: 10 * 60_000,
  defaultRateLimitMs: 60_000,
};

const providerCooldowns = new Map<SafeProviderId, ProviderCooldownState>();

export function getProviderCooldown(
  provider: SafeProviderId,
  nowMs: number = Date.now(),
): ProviderCooldownState | null {
  const entry = providerCooldowns.get(provider);
  if (!entry) return null;
  if (nowMs >= entry.untilMs) {
    providerCooldowns.delete(provider);
    return null;
  }
  return entry;
}

export function setProviderCooldown(
  provider: SafeProviderId,
  untilMs: number,
  reason: CooldownReason,
): void {
  providerCooldowns.set(provider, { provider, untilMs, reason });
}

export function clearProviderCooldownsForTests(): void {
  providerCooldowns.clear();
}

export function applyCooldownFromError(
  error: ProviderCallError,
  now: Date = new Date(),
  cooldownConfig: CooldownConfig = DEFAULT_COOLDOWN_CONFIG,
): ProviderCooldownState {
  const nowMs = now.getTime();
  const status = error.statusCode;

  if (status === 401 || status === 403) {
    console.warn(
      `[Tutor LLM Router] Configuration warning: Provider "${error.provider}" returned HTTP ${status}. Check API key and model permissions. Cooling down for ${Math.round(
        cooldownConfig.authErrorMs / 1000,
      )}s.`,
    );
    const state: ProviderCooldownState = {
      provider: error.provider,
      untilMs: nowMs + cooldownConfig.authErrorMs,
      reason: "auth_error",
    };
    providerCooldowns.set(error.provider, state);
    return state;
  }

  if (status === 429) {
    if (error.isDailyQuotaExhausted) {
      const nextMidnightMs = Date.parse(getNextUtcMidnightIso(now));
      const retryMs = error.retryAfterSeconds
        ? nowMs + error.retryAfterSeconds * 1000
        : 0;
      const untilMs = Math.max(nextMidnightMs, retryMs);
      const state: ProviderCooldownState = {
        provider: error.provider,
        untilMs,
        reason: "daily_quota_exhausted",
      };
      providerCooldowns.set(error.provider, state);
      return state;
    }

    const waitMs =
      error.retryAfterSeconds && error.retryAfterSeconds > 0
        ? error.retryAfterSeconds * 1000
        : cooldownConfig.defaultRateLimitMs;
    const state: ProviderCooldownState = {
      provider: error.provider,
      untilMs: nowMs + waitMs,
      reason: "rate_limit",
    };
    providerCooldowns.set(error.provider, state);
    return state;
  }

  if (status && status >= 500) {
    const state: ProviderCooldownState = {
      provider: error.provider,
      untilMs: nowMs + cooldownConfig.serverErrorMs,
      reason: "server_error",
    };
    providerCooldowns.set(error.provider, state);
    return state;
  }

  const state: ProviderCooldownState = {
    provider: error.provider,
    untilMs: nowMs + cooldownConfig.networkErrorMs,
    reason: "network_error",
  };
  providerCooldowns.set(error.provider, state);
  return state;
}

export interface LlmRouterOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  usageStore?: TutorUsageStore;
  adapters?: Partial<Record<SafeProviderId, ProviderAdapterFn>>;
  fetchImpl?: typeof fetch;
  cooldownConfig?: CooldownConfig;
}

export async function generateWithFallbackRouter(
  input: LlmGenerationInput,
  options: LlmRouterOptions = {},
): Promise<LlmGenerationOutput> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const usageStore = options.usageStore ?? getTutorUsageStore();
  const cooldownConfig = options.cooldownConfig ?? DEFAULT_COOLDOWN_CONFIG;

  for (const providerId of PROVIDER_PRIORITY_ORDER) {
    const validation = validateProviderConfig(providerId, env);
    if (!validation.enabled || !validation.config) {
      continue;
    }

    const activeCooldown = getProviderCooldown(providerId, nowMs);
    if (activeCooldown) {
      continue;
    }

    const reservation = await usageStore.reserveProviderRequest(
      providerId,
      validation.config.dailyBudget,
      validation.config.rpmBudget,
      now,
    );

    if (!reservation.allowed) {
      if (reservation.resetAtMs) {
        setProviderCooldown(
          providerId,
          reservation.resetAtMs,
          reservation.reason === "daily_budget_exhausted"
            ? "daily_quota_exhausted"
            : "rate_limit",
        );
      }
      continue;
    }

    const adapter =
      options.adapters?.[providerId] ?? DEFAULT_PROVIDER_ADAPTERS[providerId];

    try {
      const result = await adapter(
        validation.config,
        input,
        options.fetchImpl,
      );
      return result;
    } catch (err: unknown) {
      const callError =
        err instanceof ProviderCallError
          ? err
          : new ProviderCallError({
              provider: providerId,
              isNetworkError: true,
            });
      applyCooldownFromError(callError, now, cooldownConfig);
    }
  }

  throw new AllProvidersBusyError();
}

@Injectable()
export class LlmRouterService {
  constructor(
    @Inject(TutorUsageService) private readonly defaultUsageStore: TutorUsageService,
  ) {}

  async generate(
    input: LlmGenerationInput,
    options: LlmRouterOptions = {},
  ): Promise<LlmGenerationOutput> {
    return generateWithFallbackRouter(input, {
      usageStore: options.usageStore ?? this.defaultUsageStore,
      ...options,
    });
  }
}
