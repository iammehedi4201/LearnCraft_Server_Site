import fs from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import {
  extractQuestionCodeBlocks,
  type ExtractedQuestionCodeBlock,
} from "../interview-ai/code-utils";
import { InterviewQuestionNotFoundError } from "../tutor/errors/tutor.errors";
import {
  computeSha256Hex,
  KNOWN_LESSONS,
  resolveLessonRouteMetadata,
  TOPICS_META,
} from "./lesson-registry.service";

export interface CatalogInterviewQuestion {
  id: string;
  trackKey: string;
  topic?: string;
  subtopic?: string;
  category?: string;
  type: "conceptual" | "coding" | "system-design" | string;
  difficulty: string;
  question: string;
  answer: string;
  explanation?: string;
  example?: string;
  codeSnippet?: string;
  expectedOutput?: string;
  keyPoints?: string[];
  followUps?: string[];
  followUpAnswers?: string[] | Record<string, string>;
  tags?: string[];
  relatedLessonSlug?: string;
}

export interface InterviewRelatedLesson {
  trackKey: string;
  trackTitle: string;
  lessonCode: string;
  lessonTitle: string;
  lessonUrl: string;
}

export type DifficultyTier = "beginner" | "intermediate" | "advanced";

export interface ResolvedInterviewQuestion {
  id: string;
  trackKey: string;
  trackTitle: string;
  topic: string;
  subtopic?: string;
  category: string;
  type: CatalogInterviewQuestion["type"];
  difficulty: string;
  difficultyTier: DifficultyTier;
  question: string;
  answer: string;
  explanation?: string;
  example?: string;
  codeSnippet?: string;
  expectedOutput?: string;
  keyPoints: string[];
  followUps: string[];
  followUpNotes: string[];
  tags: string[];
  codeBlocks: ExtractedQuestionCodeBlock[];
  hasRelevantCode: boolean;
  contentHash: string;
  codeHash: string | null;
  relatedLesson: InterviewRelatedLesson | null;
}

interface InterviewCatalogFile {
  questions: CatalogInterviewQuestion[];
}

function loadInterviewCatalog(): InterviewCatalogFile {
  const candidates = [
    path.join(__dirname, "data", "interview-catalog.json"),
    path.join(process.cwd(), "src", "catalog", "data", "interview-catalog.json"),
    path.join(process.cwd(), "dist", "catalog", "data", "interview-catalog.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as InterviewCatalogFile;
    }
  }
  throw new Error(
    "Missing interview-catalog.json. Run `npm run sync:catalog` to generate backend catalog data.",
  );
}

const INTERVIEW_CATALOG = loadInterviewCatalog();
export const ALL_INTERVIEW_QUESTIONS = INTERVIEW_CATALOG.questions;

const questionByIdMap = new Map<string, CatalogInterviewQuestion>(
  ALL_INTERVIEW_QUESTIONS.map((q) => [q.id, q]),
);

const FALLBACK_TRACK_TITLES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  react: "React.js",
  nextjs: "Next.js",
  nodejs: "Node.js",
  express: "Express.js",
  nestjs: "NestJS",
  oop: "Object-Oriented Programming",
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  prisma: "Prisma ORM",
  redux: "Redux Toolkit",
  tanstack: "TanStack Query",
  "system-design": "System Design",
};

const testQuestionOverrides = new Map<
  string,
  Partial<CatalogInterviewQuestion>
>();

export function setInterviewQuestionOverrideForTests(
  questionId: string,
  override: Partial<CatalogInterviewQuestion>,
): void {
  testQuestionOverrides.set(questionId.trim(), override);
}

export function clearInterviewQuestionOverridesForTests(): void {
  testQuestionOverrides.clear();
}

export function getQuestionById(
  questionId: string,
): CatalogInterviewQuestion | undefined {
  return questionByIdMap.get(questionId);
}

export function resolveTrackDisplayTitle(trackKey: string): string {
  const normalized = trackKey.trim().toLowerCase();
  if (normalized === "oop") {
    return "Object-Oriented Programming";
  }
  const metaTitle = TOPICS_META[normalized]?.title;
  if (metaTitle) {
    return metaTitle;
  }
  if (FALLBACK_TRACK_TITLES[normalized]) {
    return FALLBACK_TRACK_TITLES[normalized];
  }
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function mapDifficultyToTier(difficulty: string): DifficultyTier {
  const normalized = difficulty.trim().toLowerCase();
  if (normalized === "easy" || normalized === "beginner") {
    return "beginner";
  }
  if (normalized === "hard" || normalized === "advanced") {
    return "advanced";
  }
  return "intermediate";
}

export function resolveAuthoritativeRelatedLesson(
  relatedLessonSlug?: string,
): InterviewRelatedLesson | null {
  const raw = relatedLessonSlug?.trim();
  if (!raw) {
    return null;
  }

  const cleanPath = raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const match = cleanPath.match(/^\/learn\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }

  const trackKey = match[1].toLowerCase();
  const slug = match[2];

  const registryMeta = resolveLessonRouteMetadata(cleanPath);
  if (registryMeta) {
    return {
      trackKey: registryMeta.trackKey,
      trackTitle: registryMeta.trackTitle,
      lessonCode: registryMeta.code,
      lessonTitle: registryMeta.lessonTitle,
      lessonUrl: `/learn/${registryMeta.trackKey}/${registryMeta.slug}`,
    };
  }

  if (trackKey === "tanstack" && /^tq\d{2}-/.test(slug)) {
    const known = KNOWN_LESSONS[cleanPath];
    if (known) {
      return {
        trackKey: "tanstack",
        trackTitle: resolveTrackDisplayTitle("tanstack"),
        lessonCode: known.code,
        lessonTitle: known.name,
        lessonUrl: cleanPath,
      };
    }
  }

  return null;
}

function normalizeFollowUpNotes(
  followUps: string[] | undefined,
  followUpAnswers: CatalogInterviewQuestion["followUpAnswers"],
): string[] {
  if (!followUpAnswers) {
    return [];
  }

  if (Array.isArray(followUpAnswers)) {
    return followUpAnswers
      .map((entry, idx) => {
        if (typeof entry === "string") {
          const label = followUps?.[idx] ? `Q: ${followUps[idx]}\nA: ` : "";
          return `${label}${entry}`.trim();
        }
        return "";
      })
      .filter(Boolean);
  }

  if (typeof followUpAnswers === "object") {
    return Object.entries(followUpAnswers)
      .map(([k, v]) =>
        typeof v === "string" && v.trim() ? `Q: ${k}\nA: ${v.trim()}` : "",
      )
      .filter(Boolean);
  }

  return [];
}

export function resolveAuthoritativeInterviewQuestion(
  questionId: string,
): ResolvedInterviewQuestion {
  const normalizedId = questionId.trim();
  const baseQuestion = getQuestionById(normalizedId);

  if (!baseQuestion) {
    throw new InterviewQuestionNotFoundError(questionId);
  }

  const override = testQuestionOverrides.get(normalizedId);
  const question: CatalogInterviewQuestion = override
    ? { ...baseQuestion, ...override }
    : baseQuestion;

  const trackKey = question.trackKey.trim().toLowerCase();
  const trackTitle = resolveTrackDisplayTitle(trackKey);
  const codeBlocks = extractQuestionCodeBlocks(question);
  const hasRelevantCode = codeBlocks.length > 0;

  const codeHash = hasRelevantCode
    ? computeSha256Hex(
        codeBlocks.map((b) => `${b.language}:${b.code}`).join("\n---\n"),
      )
    : null;

  const keyPoints = (question.keyPoints ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const followUps = (question.followUps ?? [])
    .map((f) => f.trim())
    .filter(Boolean);
  const followUpNotes = normalizeFollowUpNotes(
    followUps,
    question.followUpAnswers,
  );
  const tags = (question.tags ?? []).map((t) => t.trim()).filter(Boolean);

  const hashPayload = JSON.stringify({
    id: question.id,
    trackKey,
    difficulty: question.difficulty,
    question: question.question,
    answer: question.answer,
    explanation: question.explanation ?? "",
    example: question.example ?? "",
    codeSnippet: question.codeSnippet ?? "",
    expectedOutput: question.expectedOutput ?? "",
    keyPoints,
    followUps,
  });

  const contentHash = computeSha256Hex(hashPayload);

  return {
    id: question.id,
    trackKey,
    trackTitle,
    topic: question.topic || question.category || trackTitle,
    subtopic: question.subtopic,
    category: question.category || "Conceptual",
    type: question.type || "conceptual",
    difficulty: question.difficulty,
    difficultyTier: mapDifficultyToTier(question.difficulty),
    question: question.question,
    answer: question.answer,
    explanation: question.explanation,
    example: question.example,
    codeSnippet: question.codeSnippet,
    expectedOutput: question.expectedOutput,
    keyPoints,
    followUps,
    followUpNotes,
    tags,
    codeBlocks,
    hasRelevantCode,
    contentHash,
    codeHash,
    relatedLesson: resolveAuthoritativeRelatedLesson(question.relatedLessonSlug),
  };
}

@Injectable()
export class QuestionRegistryService {
  resolveQuestion(questionId: string): ResolvedInterviewQuestion {
    return resolveAuthoritativeInterviewQuestion(questionId);
  }

  resolveRelatedLesson(
    relatedLessonSlug?: string,
  ): InterviewRelatedLesson | null {
    return resolveAuthoritativeRelatedLesson(relatedLessonSlug);
  }
}
