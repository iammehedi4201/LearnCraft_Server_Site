import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const clientRoot = path.resolve(serverRoot, "../LearnCraft_client_site");

if (!fs.existsSync(clientRoot)) {
  console.error(`Client directory not found at: ${clientRoot}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const outDataDir = path.join(serverRoot, "src/catalog/data");
fs.mkdirSync(outDataDir, { recursive: true });

const tmpDir = path.join(serverRoot, ".catalog-tmp");
fs.mkdirSync(tmpDir, { recursive: true });

const extractorEntry = path.join(tmpDir, "extract.ts");
fs.writeFileSync(
  extractorEntry,
  `
import { createHash } from "node:crypto";
import { TOPICS_META, KNOWN_LESSONS } from "@/lib/topic-registry";
import { ALL_INTERVIEW_QUESTIONS } from "@/lib/interview-questions";

import {
  getAllLessons as getAllTSLessons,
  getStageByLessonSlug as getTSStage,
  TYPESCRIPT_LEGACY_SLUG_MAP,
} from "@/app/learn/typescript/data/typescript-curriculum";
import { getTypeScriptLessonContent } from "@/app/learn/typescript/data/typescript-lesson-content";

import {
  getAllLessons as getAllJSLessons,
  getStageByLessonSlug as getJSStage,
  JAVASCRIPT_LEGACY_SLUG_MAP,
} from "@/app/learn/javascript/data/javascript-curriculum";
import { getJSLessonContent } from "@/app/learn/javascript/data/javascript-lesson-content";

import {
  getAllLessons as getAllReactLessons,
  getStageByLessonSlug as getReactStage,
} from "@/app/learn/react/data/react-curriculum";
import { getReactLessonContent } from "@/app/learn/react/data/react-lesson-content";

import {
  getAllNextjsLessons,
  getNextjsStageByLessonSlug as getNextjsStage,
  NEXTJS_LEGACY_SLUG_MAP,
} from "@/app/learn/nextjs/data/nextjs-curriculum";
import { getNextjsLessonContent } from "@/app/learn/nextjs/data/nextjs-lesson-content";

import {
  getAllLessons as getAllNodeLessons,
  getStageByLessonSlug as getNodeStage,
  NODEJS_LEGACY_SLUG_MAP,
} from "@/app/learn/nodejs/data/nodejs-curriculum";
import { getNodejsLessonContent } from "@/app/learn/nodejs/data/nodejs-lesson-content";

import {
  getAllLessons as getAllExpressLessons,
  getStageByLessonSlug as getExpressStage,
} from "@/app/learn/express/data/express-curriculum";
import { EXPRESS_LEGACY_SLUG_MAP, getExpressLessonContent } from "@/app/learn/express/data/express-lesson-content";

import {
  getAllNestjsLessons,
  getNestjsStageByLessonSlug as getNestjsStage,
  NESTJS_LEGACY_SLUG_MAP,
} from "@/app/learn/nestjs/data/nestjs-curriculum";
import { getNestjsLessonContent } from "@/app/learn/nestjs/data/nestjs-lesson-content";

import {
  getAllLessons as getAllOOPLessons,
  getStageByLessonSlug as getOOPStage,
} from "@/app/learn/oop/data/oop-curriculum";
import { getOOPLessonContent } from "@/app/learn/oop/data/oop-lesson-content";

import {
  getAllLessons as getAllPostgresqlLessons,
  getStageByLessonSlug as getPostgresqlStage,
} from "@/app/learn/postgresql/data/postgresql-curriculum";
import { getPostgresqlLessonContent, POSTGRESQL_LEGACY_SLUG_MAP } from "@/app/learn/postgresql/data/postgresql-lesson-content";

import {
  getAllLessons as getAllMongoLessons,
  getStageByLessonSlug as getMongoStage,
} from "@/app/learn/mongodb/data/mongodb-curriculum";
import { getMongodbLessonContent, MONGODB_LEGACY_SLUG_MAP } from "@/app/learn/mongodb/data/mongodb-lesson-content";

import {
  getAllLessons as getAllPrismaLessons,
  getStageByLessonSlug as getPrismaStage,
} from "@/app/learn/prisma/data/prisma-curriculum";
import { getPrismaLessonContent, PRISMA_LEGACY_SLUG_MAP } from "@/app/learn/prisma/data/prisma-lesson-content";

import {
  getAllLessons as getAllReduxLessons,
  getStageByLessonSlug as getReduxStage,
} from "@/app/learn/redux/data/redux-curriculum";
import { getReduxLessonContent } from "@/app/learn/redux/data/redux-lesson-content";
import { REDUX_LEGACY_SLUG_MAP } from "@/app/learn/redux/content";

import {
  getAllLessons as getAllSysDesignLessons,
  getStageByLessonSlug as getSysDesignStage,
} from "@/app/learn/system-design/data/system-design-curriculum";
import { getSystemDesignLessonContent } from "@/app/learn/system-design/data/system-design-lesson-content";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function extractCodeBlocks(content: any) {
  const blocks: Array<{ id: string; title: string; code: string; hash: string }> = [];
  const addBlock = (id: string, title: string, rawCode?: string) => {
    const trimmed = rawCode?.trim();
    if (!trimmed) return;
    blocks.push({
      id,
      title,
      code: trimmed,
      hash: sha256Hex(id + ":" + trimmed),
    });
  };

  if (content.part1?.codeSnippet) {
    addBlock("part1-main", content.part1.title || "Core Concept Example", content.part1.codeSnippet);
  }
  content.part2?.cards?.forEach((card: any, idx: number) => {
    if (card.codeSnippet) addBlock("part2-card-" + (idx + 1), card.title || "Rule Card " + (idx + 1), card.codeSnippet);
  });
  content.part2?.concepts?.forEach((concept: any, idx: number) => {
    if (concept.codeSnippet) addBlock("part2-concept-" + (idx + 1), concept.name || "Concept " + (idx + 1), concept.codeSnippet);
  });
  content.part3?.points?.forEach((pt: any, idx: number) => {
    if (pt.codeSnippet) addBlock("part3-point-" + (idx + 1), pt.title || "Practice Example " + (idx + 1), pt.codeSnippet);
  });
  if (content.part4?.bad?.code) {
    addBlock("part4-bad", content.part4.bad.title || "Common Mistake / Anti-Pattern", content.part4.bad.code);
  } else if (content.part4?.badApproach?.code) {
    addBlock("part4-bad", content.part4.badApproach.title || "Common Mistake / Anti-Pattern", content.part4.badApproach.code);
  }
  if (content.part4?.good?.code) {
    addBlock("part4-good", content.part4.good.title || "Recommended Pattern", content.part4.good.code);
  } else if (content.part4?.betterApproach?.code) {
    addBlock("part4-good", content.part4.betterApproach.title || "Recommended Pattern", content.part4.betterApproach.code);
  }
  if (content.part5?.starterCode) {
    addBlock("part5-starter", content.part5.title || "Interactive Sandbox Starter Code", content.part5.starterCode);
  }
  return blocks;
}

function buildLessonSummaryText(meta: any, content: any) {
  const sections: string[] = [];
  const objectives: string[] = [];

  if (meta.desc || content.subtitle) {
    sections.push("Overview: " + (meta.desc || content.subtitle));
  }
  if (content.scenario?.question) {
    sections.push("Real-World Scenario: " + content.scenario.question + " -> " + content.scenario.answer);
  }
  if (content.part1) {
    const p1 = content.part1;
    if (p1.bigPicture) sections.push("Big Picture: " + p1.bigPicture);
    if (p1.explanation) sections.push("Explanation: " + p1.explanation);
    if (p1.analogy) sections.push("Analogy: " + p1.analogy);
    if (p1.breakdownItems && p1.breakdownItems.length > 0) {
      const items = p1.breakdownItems.map((item: any) => "- " + item.title + ": " + item.desc).join("\\n");
      sections.push("Key Breakdown:\\n" + items);
      p1.breakdownItems.slice(0, 4).forEach((b: any) => objectives.push(b.title));
    }
  }
  if (content.part2) {
    const p2 = content.part2;
    if (p2.rule) sections.push("Core Rule (" + p2.rule.title + "): " + p2.rule.content);
    if (p2.cards && p2.cards.length > 0) {
      sections.push("Why It Matters & Rules:\\n" + p2.cards.map((c: any) => "- " + c.title + ": " + c.description).join("\\n"));
    }
    if (p2.concepts && p2.concepts.length > 0) {
      sections.push("Concepts:\\n" + p2.concepts.map((c: any) => "- " + c.name + ": " + c.desc).join("\\n"));
    }
  }
  if (content.part3) {
    const p3 = content.part3;
    if (p3.points && p3.points.length > 0) {
      sections.push("In Practice:\\n" + p3.points.map((pt: any) => "- " + pt.title + ": " + pt.content).join("\\n"));
    }
    if (p3.deepDives && p3.deepDives.length > 0) {
      sections.push("Deep Dive:\\n" + p3.deepDives.map((d: any) => "- " + d.heading + ": " + d.content).join("\\n"));
    }
  }
  if (content.part4) {
    const p4 = content.part4;
    if (p4.problem) sections.push("Common Pitfall: " + p4.problem);
    if (p4.bad?.explanation) {
      sections.push("What to Avoid (" + p4.bad.title + "): " + p4.bad.explanation);
    } else if (p4.badApproach?.flaw) {
      sections.push("What to Avoid (" + p4.badApproach.title + "): " + p4.badApproach.flaw);
    }
    if (p4.good?.explanation) {
      sections.push("Recommended Fix (" + p4.good.title + "): " + p4.good.explanation);
    } else if (p4.betterApproach?.benefit) {
      sections.push("Recommended Fix (" + p4.betterApproach.title + "): " + p4.betterApproach.benefit);
    }
    if (p4.whyItMatters) sections.push("Why It Matters: " + p4.whyItMatters);
  }
  const takeaways = content.part6?.takeaways || content.part7?.takeaways || [];
  if (takeaways.length > 0) {
    sections.push("Key Takeaways:\\n" + takeaways.map((t: any) => "- " + t.title + ": " + t.desc).join("\\n"));
    takeaways.slice(0, 4).forEach((t: any) => {
      if (!objectives.includes(t.title)) objectives.push(t.title);
    });
  }
  return { summaryText: sections.join("\\n\\n"), objectives: objectives.slice(0, 6) };
}

const ADAPTERS = [
  { trackKey: "typescript", trackTitle: "TypeScript", getLessons: getAllTSLessons, getContent: getTypeScriptLessonContent, getStageName: (s: string) => getTSStage(s)?.name, legacyMap: TYPESCRIPT_LEGACY_SLUG_MAP },
  { trackKey: "javascript", trackTitle: "JavaScript", getLessons: getAllJSLessons, getContent: getJSLessonContent, getStageName: (s: string) => getJSStage(s)?.name, legacyMap: JAVASCRIPT_LEGACY_SLUG_MAP },
  { trackKey: "react", trackTitle: "React.js", getLessons: getAllReactLessons, getContent: getReactLessonContent, getStageName: (s: string) => getReactStage(s)?.name },
  { trackKey: "nextjs", trackTitle: "Next.js", getLessons: getAllNextjsLessons, getContent: getNextjsLessonContent, getStageName: (s: string) => getNextjsStage(s)?.name, legacyMap: NEXTJS_LEGACY_SLUG_MAP },
  { trackKey: "nodejs", trackTitle: "Node.js", getLessons: getAllNodeLessons, getContent: getNodejsLessonContent, getStageName: (s: string) => getNodeStage(s)?.name, legacyMap: NODEJS_LEGACY_SLUG_MAP },
  { trackKey: "express", trackTitle: "Express.js", getLessons: getAllExpressLessons, getContent: getExpressLessonContent, getStageName: (s: string) => getExpressStage(s)?.name, legacyMap: EXPRESS_LEGACY_SLUG_MAP },
  { trackKey: "nestjs", trackTitle: "NestJS", getLessons: getAllNestjsLessons, getContent: getNestjsLessonContent, getStageName: (s: string) => getNestjsStage(s)?.name, legacyMap: NESTJS_LEGACY_SLUG_MAP },
  { trackKey: "oop", trackTitle: "Object-Oriented Programming", getLessons: getAllOOPLessons, getContent: getOOPLessonContent, getStageName: (s: string) => getOOPStage(s)?.name },
  { trackKey: "postgresql", trackTitle: "PostgreSQL", getLessons: getAllPostgresqlLessons, getContent: getPostgresqlLessonContent, getStageName: (s: string) => getPostgresqlStage(s)?.name, legacyMap: POSTGRESQL_LEGACY_SLUG_MAP },
  { trackKey: "mongodb", trackTitle: "MongoDB", getLessons: getAllMongoLessons, getContent: getMongodbLessonContent, getStageName: (s: string) => getMongoStage(s)?.name, legacyMap: MONGODB_LEGACY_SLUG_MAP },
  { trackKey: "prisma", trackTitle: "Prisma ORM", getLessons: getAllPrismaLessons, getContent: getPrismaLessonContent, getStageName: (s: string) => getPrismaStage(s)?.name, legacyMap: PRISMA_LEGACY_SLUG_MAP },
  { trackKey: "redux", trackTitle: "Redux Toolkit", getLessons: getAllReduxLessons, getContent: getReduxLessonContent, getStageName: (s: string) => getReduxStage(s)?.name, legacyMap: REDUX_LEGACY_SLUG_MAP },
  { trackKey: "system-design", trackTitle: "System Design", getLessons: getAllSysDesignLessons, getContent: getSystemDesignLessonContent, getStageName: (s: string) => getSysDesignStage(s)?.name },
];

export function exportCatalogs() {
  const tracks = ADAPTERS.map((adapter) => {
    const rawLessons = adapter.getLessons();
    const lessons = rawLessons.map((meta: any) => {
      const content = adapter.getContent(meta.slug);
      const canonicalId = adapter.trackKey + ":" + meta.slug;
      const { summaryText, objectives } = buildLessonSummaryText(meta, content);
      const codeBlocks = extractCodeBlocks(content);
      const difficulty = String(content.difficulty || meta.difficulty || "Moderate");
      const title = content.title || meta.name;
      const subtitle = content.subtitle || meta.desc || "";
      const stageName = adapter.getStageName?.(meta.slug);
      const contentHash = sha256Hex(
        JSON.stringify({
          lessonId: canonicalId,
          title,
          subtitle,
          difficulty,
          summaryText,
          codeHashes: codeBlocks.map((b) => b.hash),
        }),
      );
      return {
        lessonId: canonicalId,
        trackKey: adapter.trackKey,
        trackTitle: adapter.trackTitle,
        slug: meta.slug,
        code: meta.code,
        title,
        subtitle,
        difficulty,
        stageName,
        objectives,
        summaryText,
        codeBlocks,
        contentHash,
      };
    });

    return {
      trackKey: adapter.trackKey,
      trackTitle: adapter.trackTitle,
      legacyMap: adapter.legacyMap || {},
      lessons,
    };
  });

  return {
    curriculum: {
      topicsMeta: TOPICS_META,
      knownLessons: KNOWN_LESSONS,
      tracks,
    },
    interview: {
      topicsMeta: TOPICS_META,
      knownLessons: KNOWN_LESSONS,
      questions: ALL_INTERVIEW_QUESTIONS,
    },
  };
}
`,
);

try {
  const bundleOut = path.join(tmpDir, "extract.cjs");
  await esbuild.build({
    entryPoints: [extractorEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundleOut,
    tsconfig: path.join(clientRoot, "tsconfig.json"),
    absWorkingDir: clientRoot,
    logLevel: "silent",
  });

  const mod = require(bundleOut);
  const { curriculum, interview } = mod.exportCatalogs();

  fs.writeFileSync(
    path.join(outDataDir, "curriculum-catalog.json"),
    JSON.stringify(curriculum, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDataDir, "interview-catalog.json"),
    JSON.stringify(interview, null, 2),
    "utf8",
  );

  const totalLessons = curriculum.tracks.reduce(
    (sum, t) => sum + t.lessons.length,
    0,
  );
  console.log(
    `Synced ${curriculum.tracks.length} tracks (${totalLessons} lessons) and ${interview.questions.length} interview questions to src/catalog/data/`,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
