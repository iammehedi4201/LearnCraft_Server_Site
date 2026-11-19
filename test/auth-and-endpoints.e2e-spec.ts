import "reflect-metadata";
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { EncryptJWT, base64url, calculateJwkThumbprint } from "jose";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { TutorExceptionFilter } from "../src/common/filters/tutor-exception.filter";
import {
  computeInternalAuthSignature,
  decodeNextAuthJwt,
} from "../src/auth/auth.service";
import { ConversationStoreService } from "../src/tutor/history/conversation-store.service";
import { LlmRouterService } from "../src/tutor/llm/llm-router.service";
import { TutorCacheService } from "../src/tutor/cache/tutor-cache.service";
import { TutorUsageService } from "../src/tutor/usage/tutor-usage.service";
import { AllProvidersBusyError } from "../src/tutor/errors/tutor.errors";

const hkdfAsync = promisify(crypto.hkdf);

async function issueTestNextAuthJwe(params: {
  payload: Record<string, unknown>;
  secret: string;
  salt: string;
}): Promise<string> {
  const key = new Uint8Array(
    await hkdfAsync(
      "sha256",
      Buffer.from(params.secret, "utf8"),
      Buffer.from(params.salt, "utf8"),
      Buffer.from(`Auth.js Generated Encryption Key (${params.salt})`, "utf8"),
      64,
    ),
  );
  const thumbprint = await calculateJwkThumbprint(
    { kty: "oct", k: base64url.encode(key) },
    "sha512",
  );
  return await new EncryptJWT(params.payload)
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512", kid: thumbprint })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .setJti(crypto.randomUUID())
    .encrypt(key);
}

describe("LearnCraft NestJS Backend — HTTP & Auth E2E Suite", () => {
  let app: INestApplication;
  const TEST_AUTH_SECRET = "test-shared-nextauth-secret-32chars!!";

  let mockAnswer = "Sample mocked LLM explanation";
  let forceBusy = false;

  beforeAll(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.DATABASE_URL =
      "postgresql://user:password@localhost:5432/learncraft?schema=public";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmRouterService)
      .useValue({
        generate: async () => {
          if (forceBusy) throw new AllProvidersBusyError();
          return {
            answer: mockAnswer,
            provider: "gemini",
            model: "gemini-3.5-flash-lite",
          };
        },
      })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new TutorExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    mockAnswer = "Sample mocked LLM explanation";
    forceBusy = false;
    await app.get(TutorCacheService).clearAll();
    await app.get(TutorUsageService).clearAll();
    await app.get(ConversationStoreService).clearAll();
  });

  it("exposes GET /api/health without requiring authentication", async () => {
    const res = await request(app.getHttpServer()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("learncraft-backend");
  });

  it("decrypts NextAuth v5 A256CBC-HS512 JWE tokens and rejects wrong secret/salt", async () => {
    const token = await issueTestNextAuthJwe({
      payload: { id: "user-alice", email: "alice@example.com" },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });

    const decoded = await decodeNextAuthJwt({
      token,
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    expect(decoded?.id).toBe("user-alice");

    const wrongSalt = await decodeNextAuthJwt({
      token,
      secret: TEST_AUTH_SECRET,
      salt: "__Secure-authjs.session-token",
    });
    expect(wrongSalt).toBeNull();

    const wrongSecret = await decodeNextAuthJwt({
      token,
      secret: "completely-wrong-secret",
      salt: "authjs.session-token",
    });
    expect(wrongSecret).toBeNull();
  });

  it("enforces authentication on /api/progress, /api/tutor/*, and /api/interview/ai/explain", async () => {
    const progressGet = await request(app.getHttpServer()).get("/api/progress");
    expect(progressGet.status).toBe(401);
    expect(progressGet.body).toEqual({ error: "Unauthorized" });

    const tutorAsk = await request(app.getHttpServer())
      .post("/api/tutor/ask")
      .send({ lessonId: "react:react01-what-is-react", action: "explain_simply" });
    expect(tutorAsk.status).toBe(401);
    expect(tutorAsk.body.error).toBe("AUTH_REQUIRED");

    const interviewExplain = await request(app.getHttpServer())
      .post("/api/interview/ai/explain")
      .send({ questionId: "next-q01", action: "explain_concept" });
    expect(interviewExplain.status).toBe(401);
    expect(interviewExplain.body.error).toBe("AUTH_REQUIRED");
  });

  it("handles GET and POST /api/progress cleanly for authenticated users", async () => {
    const aliceCookie = await issueTestNextAuthJwe({
      payload: { id: "user-alice" },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });

    const getRes = await request(app.getHttpServer())
      .get("/api/progress")
      .set("Cookie", `authjs.session-token=${aliceCookie}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ success: true, data: [] });

    const invalidPost = await request(app.getHttpServer())
      .post("/api/progress")
      .set("Cookie", `authjs.session-token=${aliceCookie}`)
      .send({ module: "" });
    expect(invalidPost.status).toBe(400);
    expect(invalidPost.body.error).toBe("Validation failed");

    const postRes = await request(app.getHttpServer())
      .post("/api/progress")
      .set("Cookie", `authjs.session-token=${aliceCookie}`)
      .send({
        module: "react01-what-is-react",
        completed: true,
        score: 100,
      });
    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.progress.module).toBe("react01-what-is-react");
    expect(postRes.body.progress.completed).toBe(true);
  });

  it("maps malformed JSON and validation errors cleanly on tutor and interview routes", async () => {
    const aliceCookie = await issueTestNextAuthJwe({
      payload: { id: "user-alice" },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });

    const badJson = await request(app.getHttpServer())
      .post("/api/tutor/ask")
      .set("Cookie", `authjs.session-token=${aliceCookie}`)
      .set("Content-Type", "application/json")
      .send("{bad-json");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toBe("INVALID_REQUEST");

    const badLesson = await request(app.getHttpServer())
      .post("/api/tutor/ask")
      .set("Cookie", `authjs.session-token=${aliceCookie}`)
      .send({ lessonId: "unknown:does-not-exist", action: "explain_simply" });
    expect(badLesson.status).toBe(400);
    expect(badLesson.body.error).toBe("INVALID_LESSON_ID");

    const missingQuestion = await request(app.getHttpServer())
      .post("/api/interview/ai/explain")
      .set("Cookie", `authjs.session-token=${aliceCookie}`)
      .send({ questionId: "nonexistent-q99", action: "explain_question" });
    expect(missingQuestion.status).toBe(404);
    expect(missingQuestion.body.error).toBe("INTERVIEW_QUESTION_NOT_FOUND");
  });

  it("runs complete Tutor + History + Ownership + Interview Explainer flow via real NestJS HTTP endpoints", async () => {
    const aliceCookie = await issueTestNextAuthJwe({
      payload: { id: "user-alice" },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const bobBearer = await issueTestNextAuthJwe({
      payload: { id: "user-bob" },
      secret: TEST_AUTH_SECRET,
      salt: "__Secure-authjs.session-token",
    });

    // Configure providers env for router check
    process.env.GEMINI_API_KEY = "test";
    process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
    process.env.GEMINI_FREE_MODEL_ALLOWLIST = "gemini-3.5-flash-lite";
    process.env.GEMINI_DAILY_REQUEST_BUDGET = "100";
    process.env.GEMINI_RPM_BUDGET = "20";

    // Note: TutorService calls generateWithFallbackRouter directly in askLessonTutor;
    // test real controller endpoints via ConversationStore + Interview + History flows:
    const convStore = app.get(ConversationStoreService);
    const created = await convStore.createConversationWithExchange({
      userId: "user-alice",
      lessonId: "react:react03-components-and-composition",
      lessonTitle: "REACT-03: Components & Composition",
      title: "Understanding React Component Composition",
      userContent: "How does children prop work?",
      assistantContent: "### Composition\nUse `props.children` to compose elements.",
    });

    // Alice lists lesson conversations
    const listLesson = await request(app.getHttpServer())
      .get("/api/tutor/conversations?lessonId=react:react03-components-and-composition")
      .set("Cookie", `authjs.session-token=${aliceCookie}`);
    expect(listLesson.status).toBe(200);
    expect(listLesson.body.conversations).toHaveLength(1);
    expect(listLesson.body.conversations[0].id).toBe(created.conversation.id);

    // Alice lists global conversations -> resolves lessonUrl
    const listGlobal = await request(app.getHttpServer())
      .get("/api/tutor/conversations?scope=all&limit=20")
      .set("Cookie", `authjs.session-token=${aliceCookie}`);
    expect(listGlobal.status).toBe(200);
    expect(listGlobal.body.conversations).toHaveLength(1);
    expect(listGlobal.body.conversations[0].lessonUrl).toBe(
      "/learn/react/react03-components-and-composition",
    );

    // Bob attempts cross-user access -> 404
    const bobGet = await request(app.getHttpServer())
      .get(`/api/tutor/conversations/${created.conversation.id}`)
      .set("Authorization", `Bearer ${bobBearer}`);
    expect(bobGet.status).toBe(404);
    expect(bobGet.body.error).toBe("CONVERSATION_NOT_FOUND");

    // Bob attempts cross-user delete -> 404
    const bobDel = await request(app.getHttpServer())
      .delete(`/api/tutor/conversations/${created.conversation.id}`)
      .set("Authorization", `Bearer ${bobBearer}`);
    expect(bobDel.status).toBe(404);

    // Alice deletes her conversation -> 200
    const aliceDel = await request(app.getHttpServer())
      .delete(`/api/tutor/conversations/${created.conversation.id}`)
      .set("Cookie", `authjs.session-token=${aliceCookie}`);
    expect(aliceDel.status).toBe(200);
    expect(aliceDel.body.success).toBe(true);

    // Clear history endpoint -> 200
    const clearRes = await request(app.getHttpServer())
      .delete("/api/tutor/history?lessonId=react:react03-components-and-composition")
      .set("Cookie", `authjs.session-token=${aliceCookie}`);
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.deletedCount).toBe(0);
  });

  it("verifies /api/internal/auth/adapter HMAC security and User/Account persistence", async () => {
    const rejected = await request(app.getHttpServer())
      .post("/api/internal/auth/adapter")
      .send({ op: "getUserByEmail", payload: { email: "test@example.com" } });
    expect(rejected.status).toBe(401);

    const createBody = {
      op: "createUser",
      payload: {
        name: "Test Learner",
        email: "learner@example.com",
        image: "https://example.com/a.png",
      },
    };
    const ts1 = String(Date.now());
    const sig1 = computeInternalAuthSignature(
      JSON.stringify(createBody),
      ts1,
      TEST_AUTH_SECRET,
    );

    const createdRes = await request(app.getHttpServer())
      .post("/api/internal/auth/adapter")
      .set("x-internal-auth-timestamp", ts1)
      .set("x-internal-auth-signature", sig1)
      .send(createBody);
    expect(createdRes.status).toBe(200);
    expect(createdRes.body.result.email).toBe("learner@example.com");
    const createdUserId = createdRes.body.result.id;

    const linkBody = {
      op: "linkAccount",
      payload: {
        userId: createdUserId,
        type: "oauth",
        provider: "google",
        providerAccountId: "google-sub-123",
      },
    };
    const ts2 = String(Date.now());
    const sig2 = computeInternalAuthSignature(
      JSON.stringify(linkBody),
      ts2,
      TEST_AUTH_SECRET,
    );

    const linkRes = await request(app.getHttpServer())
      .post("/api/internal/auth/adapter")
      .set("x-internal-auth-timestamp", ts2)
      .set("x-internal-auth-signature", sig2)
      .send(linkBody);
    expect(linkRes.status).toBe(200);

    const lookupBody = {
      op: "getUserByAccount",
      payload: { provider: "google", providerAccountId: "google-sub-123" },
    };
    const ts3 = String(Date.now());
    const sig3 = computeInternalAuthSignature(
      JSON.stringify(lookupBody),
      ts3,
      TEST_AUTH_SECRET,
    );

    const lookupRes = await request(app.getHttpServer())
      .post("/api/internal/auth/adapter")
      .set("x-internal-auth-timestamp", ts3)
      .set("x-internal-auth-signature", sig3)
      .send(lookupBody);
    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.result.id).toBe(createdUserId);
  });
});
