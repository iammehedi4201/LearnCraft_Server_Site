import fs from "node:fs";
import path from "node:path";
import {
  ProviderCallError,
  type SafeProviderId,
} from "../errors/tutor.errors";
import type { TutorHistoryMessage } from "../schemas/tutor-request";

export function getEffectiveTutorEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (
    env !== process.env ||
    process.env.VITEST ||
    process.env.JEST_WORKER_ID
  ) {
    return env;
  }
  try {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const fileName of [".env", ".env.local"]) {
      const envPath = path.join(process.cwd(), fileName);
      if (!fs.existsSync(envPath)) continue;
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (/^(GEMINI|GROQ|OPENROUTER|TUTOR|INTERVIEW_EXPLAINER)_/.test(key)) {
          merged[key] = val;
          process.env[key] = val;
        }
      }
    }
    return merged;
  } catch {
    return env;
  }
}

export const PROVIDER_PRIORITY_ORDER: readonly SafeProviderId[] = [
  "gemini",
  "groq",
  "openrouter",
] as const;

export interface ProviderConfig {
  id: SafeProviderId;
  apiKey: string;
  model: string;
  allowlist: string[];
  dailyBudget: number;
  rpmBudget: number;
}

export interface ProviderValidationResult {
  enabled: boolean;
  config?: ProviderConfig;
  reason?: string;
}

export interface LlmGenerationInput {
  systemPrompt: string;
  userPrompt: string;
  historyMessages?: TutorHistoryMessage[];
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface LlmGenerationOutput {
  answer: string;
  provider: SafeProviderId;
  model: string;
}

export type ProviderAdapterFn = (
  config: ProviderConfig,
  input: LlmGenerationInput,
  fetchImpl?: typeof fetch,
) => Promise<LlmGenerationOutput>;

const KNOWN_PAID_MODEL_PATTERNS = [
  /^openai\/gpt-4/i,
  /^gpt-4/i,
  /^o1/i,
  /^o3/i,
  /^anthropic\/claude/i,
  /^claude-/i,
  /^gemini-1\.5-pro/i,
  /^gemini-2\.5-pro/i,
  /^gemini-ultra/i,
];

function isExplicitlyDisallowedPaidModel(
  provider: SafeProviderId,
  model: string,
): boolean {
  const clean = model.trim().toLowerCase();
  if (!clean) return true;

  if (KNOWN_PAID_MODEL_PATTERNS.some((re) => re.test(clean))) {
    return true;
  }

  if (provider === "openrouter" && !clean.endsWith(":free")) {
    return true;
  }

  return false;
}

export function validateProviderConfig(
  provider: SafeProviderId,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ProviderValidationResult {
  const env = getEffectiveTutorEnv(rawEnv);
  const prefix = provider.toUpperCase();
  const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? "";
  const model = env[`${prefix}_MODEL`]?.trim() ?? "";
  const allowlistRaw = env[`${prefix}_FREE_MODEL_ALLOWLIST`]?.trim() ?? "";
  const dailyBudgetRaw = env[`${prefix}_DAILY_REQUEST_BUDGET`]?.trim() ?? "";
  const rpmBudgetRaw = env[`${prefix}_RPM_BUDGET`]?.trim() ?? "";

  if (!apiKey) {
    return { enabled: false, reason: `${prefix}_API_KEY is missing.` };
  }
  if (!model) {
    return { enabled: false, reason: `${prefix}_MODEL is missing.` };
  }
  if (!allowlistRaw) {
    return {
      enabled: false,
      reason: `${prefix}_FREE_MODEL_ALLOWLIST is missing.`,
    };
  }

  const allowlist = allowlistRaw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (allowlist.length === 0 || !allowlist.includes(model)) {
    return {
      enabled: false,
      reason: `Configured model "${model}" is not in ${prefix}_FREE_MODEL_ALLOWLIST.`,
    };
  }

  if (isExplicitlyDisallowedPaidModel(provider, model)) {
    return {
      enabled: false,
      reason: `Configured model "${model}" for ${provider} is not verified as free-tier eligible.`,
    };
  }

  const dailyBudget = Number.parseInt(dailyBudgetRaw, 10);
  const rpmBudget = Number.parseInt(rpmBudgetRaw, 10);

  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
    return {
      enabled: false,
      reason: `${prefix}_DAILY_REQUEST_BUDGET must be a positive integer.`,
    };
  }

  if (!Number.isFinite(rpmBudget) || rpmBudget <= 0) {
    return {
      enabled: false,
      reason: `${prefix}_RPM_BUDGET must be a positive integer.`,
    };
  }

  return {
    enabled: true,
    config: {
      id: provider,
      apiKey,
      model,
      allowlist,
      dailyBudget,
      rpmBudget,
    },
  };
}

export function getConfiguredMaxOutputTokens(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.TUTOR_MAX_OUTPUT_TOKENS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 600;
  if (!Number.isFinite(parsed) || parsed <= 0) return 600;
  return Math.min(parsed, 1200);
}

export function getConfiguredRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.TUTOR_REQUEST_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 15000;
  if (!Number.isFinite(parsed) || parsed < 1000) return 15000;
  return Math.min(parsed, 30000);
}

export function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const asNumber = Number.parseFloat(retryAfter);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.ceil(asNumber);
    }
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const diffSec = Math.ceil((asDate - Date.now()) / 1000);
      if (diffSec > 0) return diffSec;
    }
  }

  const resetRequests = headers.get("x-ratelimit-reset-requests")?.trim();
  if (resetRequests) {
    const mMin = resetRequests.match(/(\d+)m/i);
    const mSec = resetRequests.match(/(\d+(?:\.\d+)?)s/i);
    let total = 0;
    if (mMin) total += Number.parseInt(mMin[1], 10) * 60;
    if (mSec) total += Math.ceil(Number.parseFloat(mSec[1]));
    if (total > 0) return total;
    const rawNum = Number.parseFloat(resetRequests);
    if (Number.isFinite(rawNum) && rawNum > 0) return Math.ceil(rawNum);
  }

  return undefined;
}

export function detectDailyQuotaExhaustion(
  statusCode: number,
  bodyText: string,
  headers: Headers,
): boolean {
  if (statusCode !== 429) return false;
  const lower = bodyText.toLowerCase();

  const dailyIndicators = [
    "daily quota",
    "quota exceeded for quota metric",
    "requests per day",
    "per_day",
    "per day",
    "rpd",
    "daily limit",
    "day limit",
    "free_models_per_day",
    "free-models-per-day",
  ];

  if (dailyIndicators.some((kw) => lower.includes(kw))) {
    return true;
  }

  const remainingRequests = headers
    .get("x-ratelimit-remaining-requests")
    ?.trim();
  const retryAfterSec = parseRetryAfterSeconds(headers);
  if (remainingRequests === "0" && retryAfterSec && retryAfterSec >= 3600) {
    return true;
  }

  return false;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: SafeProviderId,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.message.toLowerCase().includes("abort") ||
        err.message.toLowerCase().includes("timeout"));
    throw new ProviderCallError({
      provider,
      isTimeout: isAbort,
      isNetworkError: !isAbort,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleNonOkResponse(
  provider: SafeProviderId,
  res: Response,
): Promise<never> {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }

  const retryAfterSeconds = parseRetryAfterSeconds(res.headers);
  const isDailyQuotaExhausted = detectDailyQuotaExhaustion(
    res.status,
    bodyText,
    res.headers,
  );

  throw new ProviderCallError({
    provider,
    statusCode: res.status,
    retryAfterSeconds,
    isDailyQuotaExhausted,
  });
}

export async function callGeminiProvider(
  config: ProviderConfig,
  input: LlmGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmGenerationOutput> {
  const timeoutMs = input.timeoutMs ?? getConfiguredRequestTimeoutMs();
  const maxOutputTokens =
    input.maxOutputTokens ?? getConfiguredMaxOutputTokens();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    config.model,
  )}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const contents = [
    ...(input.historyMessages ?? []).map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    })),
    {
      role: "user",
      parts: [{ text: input.userPrompt }],
    },
  ];

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: input.systemPrompt }],
        },
        contents,
        generationConfig: {
          maxOutputTokens,
          temperature: 0.3,
        },
      }),
    },
    timeoutMs,
    "gemini",
    fetchImpl,
  );

  if (!res.ok) {
    await handleNonOkResponse("gemini", res);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";

  if (!text) {
    throw new ProviderCallError({
      provider: "gemini",
      statusCode: 502,
    });
  }

  return {
    answer: text,
    provider: "gemini",
    model: config.model,
  };
}

export async function callGroqProvider(
  config: ProviderConfig,
  input: LlmGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmGenerationOutput> {
  const timeoutMs = input.timeoutMs ?? getConfiguredRequestTimeoutMs();
  const maxOutputTokens =
    input.maxOutputTokens ?? getConfiguredMaxOutputTokens();

  const messages = [
    { role: "system", content: input.systemPrompt },
    ...(input.historyMessages ?? []).map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user", content: input.userPrompt },
  ];

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: Math.max(maxOutputTokens, 1024),
        temperature: 0.3,
      }),
    },
    timeoutMs,
    "groq",
    fetchImpl,
  );

  if (!res.ok) {
    await handleNonOkResponse("groq", res);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new ProviderCallError({
      provider: "groq",
      statusCode: 502,
    });
  }

  return {
    answer: text,
    provider: "groq",
    model: config.model,
  };
}

export async function callOpenRouterProvider(
  config: ProviderConfig,
  input: LlmGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmGenerationOutput> {
  const timeoutMs = input.timeoutMs ?? getConfiguredRequestTimeoutMs();
  const maxOutputTokens =
    input.maxOutputTokens ?? getConfiguredMaxOutputTokens();

  const messages = [
    { role: "system", content: input.systemPrompt },
    ...(input.historyMessages ?? []).map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user", content: input.userPrompt },
  ];

  const siteUrl =
    process.env.FRONTEND_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000";

  const res = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "HTTP-Referer": siteUrl,
        "X-Title": "LearnCraft AI Lesson Tutor",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: Math.max(maxOutputTokens, 1024),
        temperature: 0.3,
      }),
    },
    timeoutMs,
    "openrouter",
    fetchImpl,
  );

  if (!res.ok) {
    await handleNonOkResponse("openrouter", res);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new ProviderCallError({
      provider: "openrouter",
      statusCode: 502,
    });
  }

  return {
    answer: text,
    provider: "openrouter",
    model: config.model,
  };
}

export const DEFAULT_PROVIDER_ADAPTERS: Record<
  SafeProviderId,
  ProviderAdapterFn
> = {
  gemini: callGeminiProvider,
  groq: callGroqProvider,
  openrouter: callOpenRouterProvider,
};
