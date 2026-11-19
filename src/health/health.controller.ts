import { Controller, Get, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "learncraft-backend",
      databaseConfigured: this.prisma.isRealDatabaseConfigured,
      timestamp: new Date().toISOString(),
    };
  }
}
