import crypto from "node:crypto";
import { promisify } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { base64url, calculateJwkThumbprint, jwtDecrypt } from "jose";
import { PrismaService } from "../prisma/prisma.service";

const hkdfAsync = promisify(crypto.hkdf);

const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

export interface AdapterUserRecord {
  id: string;
  name: string | null;
  email: string;
  emailVerified: Date | string | null;
  image: string | null;
}

export interface AdapterAccountRecord {
  userId: string;
  type: string;
  provider: string;
  providerAccountId: string;
  refresh_token?: string | null;
  access_token?: string | null;
  expires_at?: number | null;
  token_type?: string | null;
  scope?: string | null;
  id_token?: string | null;
  session_state?: string | null;
}

async function deriveAuthJsEncryptionKey(
  enc: string,
  secret: string,
  salt: string,
): Promise<Uint8Array> {
  const length = enc === "A256GCM" ? 32 : enc === "A256CBC-HS512" ? 64 : 0;
  if (!length) {
    throw new Error(`Unsupported JWT content encryption algorithm: ${enc}`);
  }
  const derived = await hkdfAsync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(salt, "utf8"),
    Buffer.from(`Auth.js Generated Encryption Key (${salt})`, "utf8"),
    length,
  );
  return new Uint8Array(derived);
}

/**
 * Decrypts a NextAuth v5 / Auth.js encrypted JWT (`A256CBC-HS512` JWE) using the shared `AUTH_SECRET`.
 */
export async function decodeNextAuthJwt(params: {
  token: string;
  secret: string;
  salt: string;
}): Promise<Record<string, unknown> | null> {
  const { token, secret, salt } = params;
  if (!token || !secret || !salt) return null;

  try {
    const { payload } = await jwtDecrypt(
      token,
      async ({ kid, enc }) => {
        const encAlg = enc || "A256CBC-HS512";
        const encryptionSecret = await deriveAuthJsEncryptionKey(
          encAlg,
          secret,
          salt,
        );
        if (kid === undefined) return encryptionSecret;
        const thumbprint = await calculateJwkThumbprint(
          { kty: "oct", k: base64url.encode(encryptionSecret) },
          `sha${encryptionSecret.byteLength << 3}` as "sha256" | "sha512",
        );
        if (kid === thumbprint) return encryptionSecret;
        throw new Error("No matching decryption secret");
      },
      {
        clockTolerance: 15,
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256CBC-HS512", "A256GCM"],
      },
    );
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function computeInternalAuthSignature(
  payloadText: string,
  timestamp: string,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payloadText}`, "utf8")
    .digest("hex");
}

export function verifyInternalAuthSignature(params: {
  payloadText: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowMs?: number;
}): boolean {
  const { payloadText, timestamp, signature, secret, nowMs = Date.now() } = params;
  if (!secret || !timestamp || !signature) return false;

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > 5 * 60_000) {
    return false;
  }

  const expectedHex = computeInternalAuthSignature(payloadText, timestamp, secret);
  const actualBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  if (actualBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

@Injectable()
export class AuthService {
  // Offline/placeholder-DB in-memory user/account store so local dev works cleanly even without Postgres
  private readonly memoryUsers = new Map<string, AdapterUserRecord>();
  private readonly memoryEmailIndex = new Map<string, string>();
  private readonly memoryAccounts = new Map<string, AdapterAccountRecord>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private extractBearerToken(req: Request): string | null {
    const rawHeader = req.headers.authorization;
    if (typeof rawHeader !== "string") return null;
    const match = rawHeader.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1].trim());
    } catch {
      return match[1].trim();
    }
  }

  private extractSessionCookies(
    req: Request,
  ): Array<{ name: string; value: string }> {
    const cookies = (req as Request & { cookies?: Record<string, unknown> })
      .cookies;
    const result: Array<{ name: string; value: string }> = [];

    if (cookies && typeof cookies === "object") {
      for (const name of SESSION_COOKIE_CANDIDATES) {
        const val = cookies[name];
        if (typeof val === "string" && val.trim().length > 0) {
          result.push({ name, value: val.trim() });
        }
      }
      if (result.length > 0) return result;
    }

    // Fallback parse from raw Cookie header if middleware wasn't mounted
    const rawCookieHeader = req.headers.cookie;
    if (typeof rawCookieHeader === "string" && rawCookieHeader.length > 0) {
      const pairs = rawCookieHeader.split(";");
      for (const pair of pairs) {
        const idx = pair.indexOf("=");
        if (idx <= 0) continue;
        const name = pair.slice(0, idx).trim();
        const rawVal = pair.slice(idx + 1).trim();
        if (
          (SESSION_COOKIE_CANDIDATES as readonly string[]).includes(name) &&
          rawVal
        ) {
          try {
            result.push({ name, value: decodeURIComponent(rawVal) });
          } catch {
            result.push({ name, value: rawVal });
          }
        }
      }
    }

    return result;
  }

  async getAuthenticatedUserId(req: Request): Promise<string | null> {
    const secret = process.env.AUTH_SECRET?.trim() || "";
    const sessionCookies = this.extractSessionCookies(req);

    // 1. Check PostgreSQL Session table if real DB configured
    if (this.prisma.isRealDatabaseConfigured) {
      for (const cookie of sessionCookies) {
        try {
          const dbSession = await this.prisma.session.findUnique({
            where: { sessionToken: cookie.value },
            select: { userId: true, expires: true },
          });
          if (dbSession && dbSession.expires > new Date()) {
            return dbSession.userId;
          }
        } catch {
          // Fall through to JWE decode
        }
      }
    }

    // 2. Decrypt NextAuth v5 JWE cookie using shared AUTH_SECRET
    if (secret) {
      for (const cookie of sessionCookies) {
        const payload = await decodeNextAuthJwt({
          token: cookie.value,
          secret,
          salt: cookie.name,
        });
        const userId =
          (typeof payload?.id === "string" && payload.id) ||
          (typeof payload?.sub === "string" && payload.sub) ||
          null;
        if (userId) return userId;
      }

      // 3. Support Authorization: Bearer <nextauth-jwt>
      const bearerToken = this.extractBearerToken(req);
      if (bearerToken) {
        const explicitSalt =
          typeof req.headers["x-auth-salt"] === "string"
            ? req.headers["x-auth-salt"].trim()
            : null;
        const saltsToTry = explicitSalt
          ? [explicitSalt, ...SESSION_COOKIE_CANDIDATES]
          : [...SESSION_COOKIE_CANDIDATES];

        for (const salt of saltsToTry) {
          const payload = await decodeNextAuthJwt({
            token: bearerToken,
            secret,
            salt,
          });
          const userId =
            (typeof payload?.id === "string" && payload.id) ||
            (typeof payload?.sub === "string" && payload.sub) ||
            null;
          if (userId) return userId;
        }
      }
    }

    return null;
  }

  async handleAdapterOperation(
    op: string,
    payload: Record<string, unknown>,
  ): Promise<{ result: unknown }> {
    const useDb = this.prisma.isRealDatabaseConfigured;

    switch (op) {
      case "createUser": {
        const data = {
          name: (payload.name as string | null) ?? null,
          email: String(payload.email ?? ""),
          emailVerified: payload.emailVerified
            ? new Date(String(payload.emailVerified))
            : null,
          image: (payload.image as string | null) ?? null,
        };
        if (useDb) {
          const user = await this.prisma.user.create({ data });
          return { result: user };
        }
        const id = crypto.randomUUID();
        const user: AdapterUserRecord = { id, ...data };
        this.memoryUsers.set(id, user);
        if (data.email) this.memoryEmailIndex.set(data.email.toLowerCase(), id);
        return { result: user };
      }

      case "getUser": {
        const id = String(payload.id ?? "");
        if (!id) return { result: null };
        if (useDb) {
          const user = await this.prisma.user.findUnique({ where: { id } });
          return { result: user };
        }
        return { result: this.memoryUsers.get(id) ?? null };
      }

      case "getUserByEmail": {
        const email = String(payload.email ?? "");
        if (!email) return { result: null };
        if (useDb) {
          const user = await this.prisma.user.findUnique({ where: { email } });
          return { result: user };
        }
        const id = this.memoryEmailIndex.get(email.toLowerCase());
        return { result: id ? this.memoryUsers.get(id) ?? null : null };
      }

      case "getUserByAccount": {
        const provider = String(payload.provider ?? "");
        const providerAccountId = String(payload.providerAccountId ?? "");
        if (!provider || !providerAccountId) return { result: null };
        if (useDb) {
          const account = await this.prisma.account.findUnique({
            where: {
              provider_providerAccountId: { provider, providerAccountId },
            },
            include: { user: true },
          });
          return { result: account?.user ?? null };
        }
        const account = this.memoryAccounts.get(
          `${provider}:${providerAccountId}`,
        );
        return {
          result: account ? this.memoryUsers.get(account.userId) ?? null : null,
        };
      }

      case "updateUser": {
        const id = String(payload.id ?? "");
        if (!id) return { result: null };
        const updateData: Record<string, unknown> = {};
        if (payload.name !== undefined) updateData.name = payload.name;
        if (payload.email !== undefined) updateData.email = payload.email;
        if (payload.image !== undefined) updateData.image = payload.image;
        if (payload.emailVerified !== undefined) {
          updateData.emailVerified = payload.emailVerified
            ? new Date(String(payload.emailVerified))
            : null;
        }
        if (useDb) {
          const user = await this.prisma.user.update({
            where: { id },
            data: updateData,
          });
          return { result: user };
        }
        const existing = this.memoryUsers.get(id);
        if (!existing) return { result: null };
        const updated = { ...existing, ...updateData } as AdapterUserRecord;
        this.memoryUsers.set(id, updated);
        return { result: updated };
      }

      case "deleteUser": {
        const id = String(payload.id ?? "");
        if (!id) return { result: null };
        if (useDb) {
          const user = await this.prisma.user.delete({ where: { id } });
          return { result: user };
        }
        const existing = this.memoryUsers.get(id) ?? null;
        this.memoryUsers.delete(id);
        return { result: existing };
      }

      case "linkAccount": {
        const account = payload as unknown as AdapterAccountRecord;
        if (useDb) {
          const created = await this.prisma.account.create({
            data: {
              userId: account.userId,
              type: account.type,
              provider: account.provider,
              providerAccountId: account.providerAccountId,
              refresh_token: account.refresh_token ?? null,
              access_token: account.access_token ?? null,
              expires_at: account.expires_at ?? null,
              token_type: account.token_type ?? null,
              scope: account.scope ?? null,
              id_token: account.id_token ?? null,
              session_state: account.session_state ?? null,
            },
          });
          return { result: created };
        }
        this.memoryAccounts.set(
          `${account.provider}:${account.providerAccountId}`,
          account,
        );
        return { result: account };
      }

      case "unlinkAccount": {
        const provider = String(payload.provider ?? "");
        const providerAccountId = String(payload.providerAccountId ?? "");
        if (useDb) {
          const deleted = await this.prisma.account.delete({
            where: {
              provider_providerAccountId: { provider, providerAccountId },
            },
          });
          return { result: deleted };
        }
        const key = `${provider}:${providerAccountId}`;
        const existing = this.memoryAccounts.get(key) ?? null;
        this.memoryAccounts.delete(key);
        return { result: existing };
      }

      default:
        throw new Error(`Unsupported adapter operation: ${op}`);
    }
  }
}
