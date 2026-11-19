import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { HealthModule } from "./health/health.module";
import { InterviewAiModule } from "./interview-ai/interview-ai.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProgressModule } from "./progress/progress.module";
import { TutorModule } from "./tutor/tutor.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
    }),
    PrismaModule,
    AuthModule,
    CatalogModule,
    HealthModule,
    ProgressModule,
    TutorModule,
    InterviewAiModule,
  ],
})
export class AppModule {}
