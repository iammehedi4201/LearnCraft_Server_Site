import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ConversationNotFoundError,
  TutorValidationError,
} from "../errors/tutor.errors";
import type { TutorHistoryMessage } from "../schemas/tutor-request";

export interface TutorConversationSummary {
  id: string;
  lessonId: string;
  lessonTitle?: string | null;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TutorPersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface TutorConversationDetail {
  id: string;
  lessonId: string;
  lessonTitle?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: TutorPersistedMessage[];
}

export interface ListConversationsOptions {
  limit?: number;
}

export interface GlobalListConversationsOptions {
  limit?: number;
  cursor?: string;
}

export interface GlobalConversationPageResult {
  conversations: TutorConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function encodeConversationCursor(
  updatedAt: string | Date,
  id: string,
): string {
  const iso = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
  return Buffer.from(JSON.stringify({ u: iso, i: id }), "utf8").toString(
    "base64url",
  );
}

export function decodeConversationCursor(
  cursor: string,
): { updatedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { u?: unknown; i?: unknown };
    if (
      !parsed ||
      typeof parsed.u !== "string" ||
      typeof parsed.i !== "string" ||
      !parsed.i.trim()
    ) {
      return null;
    }
    const date = new Date(parsed.u);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return { updatedAt: date, id: parsed.i };
  } catch {
    return null;
  }
}

export interface CreateConversationExchangeParams {
  userId: string;
  lessonId: string;
  lessonTitle?: string;
  title: string;
  userContent: string;
  assistantContent: string;
  now?: Date;
}

export interface AppendConversationExchangeParams {
  conversationId: string;
  userId: string;
  lessonId: string;
  userContent: string;
  assistantContent: string;
  now?: Date;
}

export interface TutorConversationStore {
  listConversations(
    userId: string,
    lessonId: string,
    options?: ListConversationsOptions,
  ): Promise<TutorConversationSummary[]>;

  listGlobalConversations(
    userId: string,
    options?: GlobalListConversationsOptions,
  ): Promise<GlobalConversationPageResult>;

  getConversationWithMessages(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<TutorConversationDetail | null>;

  getRecentContextMessages(params: {
    conversationId: string;
    userId: string;
    lessonId: string;
    limit?: number;
  }): Promise<TutorHistoryMessage[]>;

  createConversationWithExchange(
    params: CreateConversationExchangeParams,
  ): Promise<{
    conversation: TutorConversationDetail;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }>;

  appendExchangeToConversation(
    params: AppendConversationExchangeParams,
  ): Promise<{
    conversationId: string;
    title: string;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }>;

  deleteConversation(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<boolean>;

  clearLessonHistory(params: {
    userId: string;
    lessonId: string;
  }): Promise<number>;

  clearAll?(): Promise<void>;
}

const PREVIEW_MAX_LENGTH = 120;

export function formatConversationPreview(content: string): string {
  if (!content) return "";

  const lines = content
    .replace(/```[\s\S]*?```/g, " [code] ")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return "";
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(trimmed)) {
        return "";
      }

      const isHeading = /^#{1,6}\s+/.test(trimmed);
      const cleaned = trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\|/g, " ")
        .replace(/\*\*|__|[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!cleaned) return "";
      return isHeading ? `${cleaned.replace(/[:.]+$/, "")}:` : cleaned;
    })
    .filter(Boolean);

  const normalized = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

interface MemoryConversationRecord {
  id: string;
  userId: string;
  lessonId: string;
  lessonTitle: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryMessageRecord {
  id: string;
  conversationId: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: Date;
  seq: number;
}

const globalForTutorHistory = globalThis as unknown as {
  __learncraftTutorConversations?: Map<string, MemoryConversationRecord>;
  __learncraftTutorMessages?: Map<string, MemoryMessageRecord[]>;
  __learncraftTutorHistoryCounter?: number;
};

const memoryConversations =
  globalForTutorHistory.__learncraftTutorConversations ??
  (globalForTutorHistory.__learncraftTutorConversations = new Map<
    string,
    MemoryConversationRecord
  >());

const memoryMessages =
  globalForTutorHistory.__learncraftTutorMessages ??
  (globalForTutorHistory.__learncraftTutorMessages = new Map<
    string,
    MemoryMessageRecord[]
  >());

function nextSeq(): number {
  const current = globalForTutorHistory.__learncraftTutorHistoryCounter ?? 1;
  globalForTutorHistory.__learncraftTutorHistoryCounter = current + 1;
  return current;
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${nextSeq()}`;
}

export class InMemoryTutorConversationStore implements TutorConversationStore {
  async listConversations(
    userId: string,
    lessonId: string,
    options: ListConversationsOptions = {},
  ): Promise<TutorConversationSummary[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));

    const matching = Array.from(memoryConversations.values())
      .filter((c) => c.userId === userId && c.lessonId === lessonId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);

    return matching.map((conv) => {
      const msgs = memoryMessages.get(conv.id) ?? [];
      const sortedMsgs = [...msgs].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
      );
      const lastMsg = sortedMsgs[sortedMsgs.length - 1];
      return {
        id: conv.id,
        lessonId: conv.lessonId,
        lessonTitle: conv.lessonTitle,
        title: conv.title,
        preview: lastMsg ? formatConversationPreview(lastMsg.content) : "",
        messageCount: sortedMsgs.length,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
      };
    });
  }

  async listGlobalConversations(
    userId: string,
    options: GlobalListConversationsOptions = {},
  ): Promise<GlobalConversationPageResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));

    let decodedCursor: { updatedAt: Date; id: string } | null = null;
    if (options.cursor) {
      decodedCursor = decodeConversationCursor(options.cursor);
      if (!decodedCursor) {
        throw new TutorValidationError("Invalid pagination cursor.");
      }
    }

    const sorted = Array.from(memoryConversations.values())
      .filter((c) => c.userId === userId)
      .sort(
        (a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          b.id.localeCompare(a.id),
      );

    const afterCursor = decodedCursor
      ? sorted.filter(
          (c) =>
            c.updatedAt.getTime() < decodedCursor!.updatedAt.getTime() ||
            (c.updatedAt.getTime() === decodedCursor!.updatedAt.getTime() &&
              c.id.localeCompare(decodedCursor!.id) < 0),
        )
      : sorted;

    const pageSlice = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit;
    const lastItem = pageSlice[pageSlice.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? encodeConversationCursor(lastItem.updatedAt, lastItem.id)
        : null;

    const conversations: TutorConversationSummary[] = pageSlice.map((conv) => {
      const msgs = memoryMessages.get(conv.id) ?? [];
      const sortedMsgs = [...msgs].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
      );
      const lastMsg = sortedMsgs[sortedMsgs.length - 1];
      return {
        id: conv.id,
        lessonId: conv.lessonId,
        lessonTitle: conv.lessonTitle,
        title: conv.title,
        preview: lastMsg ? formatConversationPreview(lastMsg.content) : "",
        messageCount: sortedMsgs.length,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
      };
    });

    return {
      conversations,
      nextCursor,
      hasMore,
    };
  }

  async getConversationWithMessages(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<TutorConversationDetail | null> {
    const conv = memoryConversations.get(params.conversationId);
    if (!conv || conv.userId !== params.userId) {
      return null;
    }
    if (params.lessonId && conv.lessonId !== params.lessonId) {
      return null;
    }

    const msgs = [...(memoryMessages.get(conv.id) ?? [])].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
    );

    return {
      id: conv.id,
      lessonId: conv.lessonId,
      lessonTitle: conv.lessonTitle,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role === "USER" ? "user" : "assistant",
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async getRecentContextMessages(params: {
    conversationId: string;
    userId: string;
    lessonId: string;
    limit?: number;
  }): Promise<TutorHistoryMessage[]> {
    const conv = memoryConversations.get(params.conversationId);
    if (
      !conv ||
      conv.userId !== params.userId ||
      conv.lessonId !== params.lessonId
    ) {
      throw new ConversationNotFoundError();
    }

    const limit = Math.max(1, Math.min(params.limit ?? 6, 20));
    const msgs = [...(memoryMessages.get(conv.id) ?? [])].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
    );

    return msgs.slice(-limit).map((m) => ({
      role: m.role === "USER" ? "user" : "assistant",
      content: m.content,
    }));
  }

  async createConversationWithExchange(
    params: CreateConversationExchangeParams,
  ): Promise<{
    conversation: TutorConversationDetail;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }> {
    const t0 = params.now ? new Date(params.now.getTime()) : new Date();
    const t1 = new Date(t0.getTime() + 1);
    const convId = nextId("conv");

    const conv: MemoryConversationRecord = {
      id: convId,
      userId: params.userId,
      lessonId: params.lessonId,
      lessonTitle: params.lessonTitle ?? null,
      title: params.title,
      createdAt: t0,
      updatedAt: t1,
    };

    const userMsg: MemoryMessageRecord = {
      id: nextId("msg"),
      conversationId: convId,
      role: "USER",
      content: params.userContent,
      createdAt: t0,
      seq: nextSeq(),
    };

    const assistantMsg: MemoryMessageRecord = {
      id: nextId("msg"),
      conversationId: convId,
      role: "ASSISTANT",
      content: params.assistantContent,
      createdAt: t1,
      seq: nextSeq(),
    };

    memoryConversations.set(convId, conv);
    memoryMessages.set(convId, [userMsg, assistantMsg]);

    const persistedUser: TutorPersistedMessage = {
      id: userMsg.id,
      role: "user",
      content: userMsg.content,
      createdAt: userMsg.createdAt.toISOString(),
    };
    const persistedAssistant: TutorPersistedMessage = {
      id: assistantMsg.id,
      role: "assistant",
      content: assistantMsg.content,
      createdAt: assistantMsg.createdAt.toISOString(),
    };

    return {
      conversation: {
        id: conv.id,
        lessonId: conv.lessonId,
        lessonTitle: conv.lessonTitle,
        title: conv.title,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
        messages: [persistedUser, persistedAssistant],
      },
      userMessage: persistedUser,
      assistantMessage: persistedAssistant,
    };
  }

  async appendExchangeToConversation(
    params: AppendConversationExchangeParams,
  ): Promise<{
    conversationId: string;
    title: string;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }> {
    const conv = memoryConversations.get(params.conversationId);
    if (
      !conv ||
      conv.userId !== params.userId ||
      conv.lessonId !== params.lessonId
    ) {
      throw new ConversationNotFoundError();
    }

    const t0 = params.now ? new Date(params.now.getTime()) : new Date();
    const t1 = new Date(t0.getTime() + 1);

    const userMsg: MemoryMessageRecord = {
      id: nextId("msg"),
      conversationId: conv.id,
      role: "USER",
      content: params.userContent,
      createdAt: t0,
      seq: nextSeq(),
    };

    const assistantMsg: MemoryMessageRecord = {
      id: nextId("msg"),
      conversationId: conv.id,
      role: "ASSISTANT",
      content: params.assistantContent,
      createdAt: t1,
      seq: nextSeq(),
    };

    const existing = memoryMessages.get(conv.id) ?? [];
    existing.push(userMsg, assistantMsg);
    memoryMessages.set(conv.id, existing);
    conv.updatedAt = t1;

    return {
      conversationId: conv.id,
      title: conv.title,
      userMessage: {
        id: userMsg.id,
        role: "user",
        content: userMsg.content,
        createdAt: userMsg.createdAt.toISOString(),
      },
      assistantMessage: {
        id: assistantMsg.id,
        role: "assistant",
        content: assistantMsg.content,
        createdAt: assistantMsg.createdAt.toISOString(),
      },
    };
  }

  async deleteConversation(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<boolean> {
    const conv = memoryConversations.get(params.conversationId);
    if (!conv || conv.userId !== params.userId) {
      return false;
    }
    if (params.lessonId && conv.lessonId !== params.lessonId) {
      return false;
    }

    memoryConversations.delete(params.conversationId);
    memoryMessages.delete(params.conversationId);
    return true;
  }

  async clearLessonHistory(params: {
    userId: string;
    lessonId: string;
  }): Promise<number> {
    let deletedCount = 0;
    for (const [id, conv] of memoryConversations.entries()) {
      if (conv.userId === params.userId && conv.lessonId === params.lessonId) {
        memoryConversations.delete(id);
        memoryMessages.delete(id);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async clearAll(): Promise<void> {
    memoryConversations.clear();
    memoryMessages.clear();
    globalForTutorHistory.__learncraftTutorHistoryCounter = 1;
  }
}

@Injectable()
export class ConversationStoreService implements TutorConversationStore {
  private readonly fallback = new InMemoryTutorConversationStore();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listConversations(
    userId: string,
    lessonId: string,
    options: ListConversationsOptions = {},
  ): Promise<TutorConversationSummary[]> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.listConversations(userId, lessonId, options);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));

    const rows = await this.prisma.tutorConversation.findMany({
      where: {
        userId,
        lessonId,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        lessonId: true,
        lessonTitle: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { messages: true },
        },
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            content: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      lessonId: row.lessonId,
      lessonTitle: row.lessonTitle,
      title: row.title,
      preview: row.messages[0]
        ? formatConversationPreview(row.messages[0].content)
        : "",
      messageCount: row._count.messages,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async listGlobalConversations(
    userId: string,
    options: GlobalListConversationsOptions = {},
  ): Promise<GlobalConversationPageResult> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.listGlobalConversations(userId, options);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));

    let decodedCursor: { updatedAt: Date; id: string } | null = null;
    if (options.cursor) {
      decodedCursor = decodeConversationCursor(options.cursor);
      if (!decodedCursor) {
        throw new TutorValidationError("Invalid pagination cursor.");
      }
    }

    const rows = await this.prisma.tutorConversation.findMany({
      where: {
        userId,
        ...(decodedCursor
          ? {
              OR: [
                { updatedAt: { lt: decodedCursor.updatedAt } },
                {
                  updatedAt: decodedCursor.updatedAt,
                  id: { lt: decodedCursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        lessonId: true,
        lessonTitle: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { messages: true },
        },
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            content: true,
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeConversationCursor(lastRow.updatedAt, lastRow.id)
        : null;

    return {
      conversations: pageRows.map((row) => ({
        id: row.id,
        lessonId: row.lessonId,
        lessonTitle: row.lessonTitle,
        title: row.title,
        preview: row.messages[0]
          ? formatConversationPreview(row.messages[0].content)
          : "",
        messageCount: row._count.messages,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  }

  async getConversationWithMessages(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<TutorConversationDetail | null> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.getConversationWithMessages(params);
    }

    const conv = await this.prisma.tutorConversation.findFirst({
      where: {
        id: params.conversationId,
        userId: params.userId,
        ...(params.lessonId ? { lessonId: params.lessonId } : {}),
      },
      select: {
        id: true,
        lessonId: true,
        lessonTitle: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
        },
      },
    });

    if (!conv) return null;

    return {
      id: conv.id,
      lessonId: conv.lessonId,
      lessonTitle: conv.lessonTitle,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      messages: conv.messages.map((m) => ({
        id: m.id,
        role: m.role === "USER" ? "user" : "assistant",
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async getRecentContextMessages(params: {
    conversationId: string;
    userId: string;
    lessonId: string;
    limit?: number;
  }): Promise<TutorHistoryMessage[]> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.getRecentContextMessages(params);
    }

    const conv = await this.prisma.tutorConversation.findFirst({
      where: {
        id: params.conversationId,
        userId: params.userId,
        lessonId: params.lessonId,
      },
      select: { id: true },
    });

    if (!conv) {
      throw new ConversationNotFoundError();
    }

    const limit = Math.max(1, Math.min(params.limit ?? 6, 20));
    const latestDesc = await this.prisma.tutorMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        role: true,
        content: true,
      },
    });

    return latestDesc.reverse().map((m) => ({
      role: m.role === "USER" ? "user" : "assistant",
      content: m.content,
    }));
  }

  async createConversationWithExchange(
    params: CreateConversationExchangeParams,
  ): Promise<{
    conversation: TutorConversationDetail;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.createConversationWithExchange(params);
    }

    const t0 = params.now ? new Date(params.now.getTime()) : new Date();
    const t1 = new Date(t0.getTime() + 1);

    const created = await this.prisma.$transaction(async (tx) => {
      const conv = await tx.tutorConversation.create({
        data: {
          userId: params.userId,
          lessonId: params.lessonId,
          lessonTitle: params.lessonTitle ?? null,
          title: params.title,
          createdAt: t0,
          updatedAt: t1,
        },
      });

      const userMsg = await tx.tutorMessage.create({
        data: {
          conversationId: conv.id,
          role: "USER",
          content: params.userContent,
          createdAt: t0,
        },
      });

      const assistantMsg = await tx.tutorMessage.create({
        data: {
          conversationId: conv.id,
          role: "ASSISTANT",
          content: params.assistantContent,
          createdAt: t1,
        },
      });

      return { conv, userMsg, assistantMsg };
    });

    const userMessage: TutorPersistedMessage = {
      id: created.userMsg.id,
      role: "user",
      content: created.userMsg.content,
      createdAt: created.userMsg.createdAt.toISOString(),
    };
    const assistantMessage: TutorPersistedMessage = {
      id: created.assistantMsg.id,
      role: "assistant",
      content: created.assistantMsg.content,
      createdAt: created.assistantMsg.createdAt.toISOString(),
    };

    return {
      conversation: {
        id: created.conv.id,
        lessonId: created.conv.lessonId,
        lessonTitle: created.conv.lessonTitle,
        title: created.conv.title,
        createdAt: created.conv.createdAt.toISOString(),
        updatedAt: created.conv.updatedAt.toISOString(),
        messages: [userMessage, assistantMessage],
      },
      userMessage,
      assistantMessage,
    };
  }

  async appendExchangeToConversation(
    params: AppendConversationExchangeParams,
  ): Promise<{
    conversationId: string;
    title: string;
    userMessage: TutorPersistedMessage;
    assistantMessage: TutorPersistedMessage;
  }> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.appendExchangeToConversation(params);
    }

    const t0 = params.now ? new Date(params.now.getTime()) : new Date();
    const t1 = new Date(t0.getTime() + 1);

    const appended = await this.prisma.$transaction(async (tx) => {
      const conv = await tx.tutorConversation.findFirst({
        where: {
          id: params.conversationId,
          userId: params.userId,
          lessonId: params.lessonId,
        },
        select: { id: true, title: true },
      });

      if (!conv) {
        throw new ConversationNotFoundError();
      }

      const userMsg = await tx.tutorMessage.create({
        data: {
          conversationId: conv.id,
          role: "USER",
          content: params.userContent,
          createdAt: t0,
        },
      });

      const assistantMsg = await tx.tutorMessage.create({
        data: {
          conversationId: conv.id,
          role: "ASSISTANT",
          content: params.assistantContent,
          createdAt: t1,
        },
      });

      await tx.tutorConversation.update({
        where: { id: conv.id },
        data: { updatedAt: t1 },
      });

      return { conv, userMsg, assistantMsg };
    });

    return {
      conversationId: appended.conv.id,
      title: appended.conv.title,
      userMessage: {
        id: appended.userMsg.id,
        role: "user",
        content: appended.userMsg.content,
        createdAt: appended.userMsg.createdAt.toISOString(),
      },
      assistantMessage: {
        id: appended.assistantMsg.id,
        role: "assistant",
        content: appended.assistantMsg.content,
        createdAt: appended.assistantMsg.createdAt.toISOString(),
      },
    };
  }

  async deleteConversation(params: {
    conversationId: string;
    userId: string;
    lessonId?: string;
  }): Promise<boolean> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.deleteConversation(params);
    }

    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.tutorConversation.deleteMany({
        where: {
          id: params.conversationId,
          userId: params.userId,
          ...(params.lessonId ? { lessonId: params.lessonId } : {}),
        },
      });
      return deleted.count > 0;
    });
  }

  async clearLessonHistory(params: {
    userId: string;
    lessonId: string;
  }): Promise<number> {
    if (!this.prisma.isRealDatabaseConfigured) {
      return this.fallback.clearLessonHistory(params);
    }

    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.tutorConversation.deleteMany({
        where: {
          userId: params.userId,
          lessonId: params.lessonId,
        },
      });
      return deleted.count;
    });
  }

  async clearAll(): Promise<void> {
    await this.fallback.clearAll();
  }
}

let defaultConversationStore: TutorConversationStore =
  new InMemoryTutorConversationStore();

export function getTutorConversationStore(): TutorConversationStore {
  return defaultConversationStore;
}

export function setTutorConversationStoreForTests(
  store: TutorConversationStore,
): void {
  defaultConversationStore = store;
}

export async function resetTutorConversationStoreForTests(): Promise<void> {
  if (defaultConversationStore.clearAll) {
    await defaultConversationStore.clearAll();
  }
  await new InMemoryTutorConversationStore().clearAll();
}
