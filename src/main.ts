import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { TutorExceptionFilter } from "./common/filters/tutor-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new TutorExceptionFilter());

  const allowedOrigins = (
    process.env.FRONTEND_URL || "http://localhost:3000"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cookie",
      "X-Auth-Salt",
    ],
  });

  const port = Number.parseInt(process.env.PORT || "4000", 10) || 4000;
  await app.listen(port);
  console.log(`LearnCraft NestJS backend listening on http://localhost:${port}/api`);
}

void bootstrap();
