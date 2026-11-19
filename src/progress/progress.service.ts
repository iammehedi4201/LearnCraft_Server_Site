import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

export const ProgressPayloadSchema = z.object({
  module: z.string().trim().min(1, "Module ID is required").max(100),
  completed: z.boolean().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  force: z.boolean().optional(),
  activeModule: z.string().nullable().optional(),
  completedModules: z.array(z.string()).optional(),
  totalModules: z.number().int().nonnegative().optional(),
});

export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

@Injectable()
export class ProgressService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listUserProgress(userId: string) {
    if (!this.prisma.isRealDatabaseConfigured) {
      return { success: true, data: [] };
    }

    try {
      const progress = await this.prisma.progress.findMany({
        where: {
          userId,
          module: {
            notIn: ["__user_notes__", "__user_bookmarks__", "__gamification__"],
          },
        },
        select: {
          module: true,
          completed: true,
          score: true,
          activeModule: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });

      return { success: true, data: progress };
    } catch (dbError) {
      console.warn(
        "Database unreachable in /api/progress GET, returning empty list:",
        dbError,
      );
      return { success: true, data: [] };
    }
  }

  async saveUserProgress(userId: string, rawBody: unknown) {
    const parseResult = ProgressPayloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const {
      module,
      completed,
      score,
      force,
      activeModule,
      completedModules,
      totalModules,
    } = parseResult.data;

    let existing: {
      completed: boolean;
      score: number | null;
      activeModule: string | null;
      completedModules: string[];
    } | null = null;

    if (this.prisma.isRealDatabaseConfigured) {
      try {
        existing = await this.prisma.progress.findUnique({
          where: {
            userId_module: {
              userId,
              module,
            },
          },
          select: {
            completed: true,
            score: true,
            activeModule: true,
            completedModules: true,
          },
        });
      } catch {
        existing = null;
      }
    }

    let mergedCompletedModules: string[] = existing?.completedModules || [];
    if (Array.isArray(completedModules)) {
      mergedCompletedModules = Array.from(
        new Set([...mergedCompletedModules, ...completedModules]),
      );
    }

    const allModulesCompleted = Boolean(
      totalModules &&
        totalModules > 0 &&
        mergedCompletedModules.length >= totalModules,
    );

    let shouldBeCompleted = completed ?? false;
    if (allModulesCompleted) {
      shouldBeCompleted = true;
    } else if (existing?.completed && completed === false && !force) {
      shouldBeCompleted = true;
    } else if (completed === true) {
      shouldBeCompleted = true;
    } else if (force && completed === false) {
      shouldBeCompleted = false;
    }

    let calculatedScore = score;
    if (calculatedScore === undefined || calculatedScore === null) {
      if (shouldBeCompleted) {
        calculatedScore = 100;
      } else if (totalModules && totalModules > 0) {
        calculatedScore = Math.round(
          (mergedCompletedModules.length / totalModules) * 100,
        );
      } else {
        calculatedScore = existing?.score ?? null;
      }
    }

    if (!this.prisma.isRealDatabaseConfigured) {
      return {
        success: true,
        progress: {
          module,
          completed: shouldBeCompleted,
          score: calculatedScore,
          activeModule: activeModule ?? null,
          updatedAt: new Date().toISOString(),
        },
        localOnly: true,
      };
    }

    try {
      const progress = await this.prisma.progress.upsert({
        where: {
          userId_module: {
            userId,
            module,
          },
        },
        update: {
          completed: shouldBeCompleted,
          score: calculatedScore,
          activeModule:
            activeModule !== undefined
              ? activeModule
              : existing?.activeModule ?? null,
          completedModules: mergedCompletedModules,
        },
        create: {
          userId,
          module,
          completed: shouldBeCompleted,
          score: calculatedScore,
          activeModule: activeModule ?? null,
          completedModules: mergedCompletedModules,
        },
        select: {
          module: true,
          completed: true,
          score: true,
          activeModule: true,
          updatedAt: true,
        },
      });

      return { success: true, progress };
    } catch (dbError) {
      console.warn(
        "Database unreachable in /api/progress POST, saved locally:",
        dbError,
      );
      return {
        success: true,
        progress: {
          module,
          completed: shouldBeCompleted,
          score: calculatedScore,
          activeModule: activeModule ?? null,
          updatedAt: new Date().toISOString(),
        },
        localOnly: true,
      };
    }
  }
}
