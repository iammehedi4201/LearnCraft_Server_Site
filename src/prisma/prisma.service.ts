import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

export function checkRealDatabaseConfigured(
  dbUrl: string | undefined = process.env.DATABASE_URL,
): boolean {
  return Boolean(dbUrl && !dbUrl.includes("user:password@localhost"));
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  get isRealDatabaseConfigured(): boolean {
    return checkRealDatabaseConfigured();
  }

  async onModuleInit(): Promise<void> {
    if (this.isRealDatabaseConfigured) {
      await this.$connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.isRealDatabaseConfigured) {
      await this.$disconnect();
    }
  }
}
