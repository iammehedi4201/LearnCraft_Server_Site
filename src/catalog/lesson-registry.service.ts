import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { InvalidLessonError } from "../tutor/errors/tutor.errors";

export interface TutorCodeBlock {
  id: string;
  title: string;
  code: string;
  hash: string;
}

export interface ResolvedTutorLesson {
  lessonId: string;
  trackKey: string;
  trackTitle: string;
  slug: string;
  code: string;
  title: string;
  subtitle: string;
  difficulty: string;
  stageName?: string;
  objectives: string[];
  summaryText: string;
  codeBlocks: TutorCodeBlock[];
  selectedCodeBlock: TutorCodeBlock | null;
  contentHash: string;
  codeHash: string | null;
}

export interface TutorLessonRouteMetadata {
  lessonId: string;
  trackKey: string;
  trackTitle: string;
  slug: string;
  code: string;
  lessonTitle: string;
  lessonUrl: string;
}

export interface TopicMetaEntry {
  title: string;
  badgeColor: string;
  icon: string;
  description: string;
}

export interface KnownLessonEntry {
  code: string;
  name: string;
  topicId: string;
}

interface StoredCatalogLesson {
  lessonId: string;
  trackKey: string;
  trackTitle: string;
  slug: string;
  code: string;
  title: string;
  subtitle: string;
  difficulty: string;
  stageName?: string;
  objectives: string[];
  summaryText: string;
  codeBlocks: TutorCodeBlock[];
  contentHash: string;
}

interface StoredCatalogTrack {
  trackKey: string;
  trackTitle: string;
  legacyMap: Record<string, string>;
  lessons: StoredCatalogLesson[];
}

interface CurriculumCatalogFile {
  topicsMeta: Record<string, TopicMetaEntry>;
  knownLessons: Record<string, KnownLessonEntry>;
  tracks: StoredCatalogTrack[];
}

export function computeSha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function loadCurriculumCatalog(): CurriculumCatalogFile {
  const candidates = [
    path.join(__dirname, "data", "curriculum-catalog.json"),
    path.join(process.cwd(), "src", "catalog", "data", "curriculum-catalog.json"),
    path.join(process.cwd(), "dist", "catalog", "data", "curriculum-catalog.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as CurriculumCatalogFile;
    }
  }
  throw new Error(
    "Missing curriculum-catalog.json. Run `npm run sync:catalog` to generate backend catalog data.",
  );
}

const CATALOG = loadCurriculumCatalog();
export const TOPICS_META = CATALOG.topicsMeta;
export const KNOWN_LESSONS = CATALOG.knownLessons;

const testLessonOverrides = new Map<string, Partial<ResolvedTutorLesson>>();

export function setLessonOverrideForTests(
  lessonId: string,
  override: Partial<ResolvedTutorLesson>,
): void {
  testLessonOverrides.set(lessonId.toLowerCase().trim(), override);
}

export function clearLessonOverridesForTests(): void {
  testLessonOverrides.clear();
}

function applyTestOverrides(
  canonicalId: string,
  rawLessonId: string,
  lesson: ResolvedTutorLesson,
): ResolvedTutorLesson {
  const override =
    testLessonOverrides.get(canonicalId.toLowerCase()) ||
    testLessonOverrides.get(rawLessonId.toLowerCase().trim());
  if (!override) return lesson;

  const merged: ResolvedTutorLesson = {
    ...lesson,
    ...override,
  };
  if (!override.contentHash) {
    merged.contentHash = computeSha256Hex(
      JSON.stringify({
        lessonId: merged.lessonId,
        title: merged.title,
        subtitle: merged.subtitle,
        summaryText: merged.summaryText,
        codeHashes: merged.codeBlocks.map((b) => b.hash),
      }),
    );
  }
  return merged;
}

function findInCatalogTrack(
  track: StoredCatalogTrack,
  targetSlugOrCode: string,
): StoredCatalogLesson | null {
  const norm = targetSlugOrCode.toLowerCase().trim();
  const resolvedNorm = track.legacyMap?.[norm]?.toLowerCase() ?? norm;

  return (
    track.lessons.find(
      (l) =>
        l.slug.toLowerCase() === resolvedNorm ||
        l.code.toLowerCase() === resolvedNorm ||
        l.code.toLowerCase().replace(/[^a-z0-9]/g, "") === resolvedNorm,
    ) ?? null
  );
}

export function resolveAuthoritativeLesson(
  rawLessonId: string,
  codeBlockId?: string,
): ResolvedTutorLesson {
  const cleaned = rawLessonId.trim();
  if (!cleaned) {
    throw new InvalidLessonError(rawLessonId);
  }

  let explicitTrack: string | null = null;
  let targetToken = cleaned;

  if (cleaned.startsWith("/learn/")) {
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length >= 3) {
      explicitTrack = parts[1].toLowerCase();
      targetToken = parts[2];
    } else {
      throw new InvalidLessonError(rawLessonId);
    }
  } else if (cleaned.includes(":")) {
    const [t, s] = cleaned.split(":", 2);
    if (!t || !s) throw new InvalidLessonError(rawLessonId);
    explicitTrack = t.toLowerCase();
    targetToken = s;
  }

  let matchedTrack: StoredCatalogTrack | null = null;
  let found: StoredCatalogLesson | null = null;

  if (explicitTrack) {
    const track = CATALOG.tracks.find((a) => a.trackKey === explicitTrack);
    if (track) {
      found = findInCatalogTrack(track, targetToken);
      if (found) matchedTrack = track;
    }
  } else {
    for (const track of CATALOG.tracks) {
      const candidate = findInCatalogTrack(track, targetToken);
      if (candidate) {
        found = candidate;
        matchedTrack = track;
        break;
      }
    }
  }

  if (!found || !matchedTrack) {
    const knownKey = explicitTrack
      ? `/learn/${explicitTrack}/${targetToken.toLowerCase()}`
      : Object.keys(KNOWN_LESSONS).find((k) =>
          k.endsWith(`/${targetToken.toLowerCase()}`),
        );
    const knownEntry = knownKey ? KNOWN_LESSONS[knownKey] : undefined;

    if (knownEntry) {
      const track = CATALOG.tracks.find((a) => a.trackKey === knownEntry.topicId);
      if (track) {
        found = findInCatalogTrack(track, knownEntry.code);
        if (found) matchedTrack = track;
      }

      if (!found) {
        const trackTitle =
          TOPICS_META[knownEntry.topicId]?.title || knownEntry.topicId;
        const slug = knownKey!.split("/").pop()!;
        const canonicalId = `${knownEntry.topicId}:${slug}`;
        const summaryText = `${knownEntry.name} (${knownEntry.code}) in ${trackTitle}. ${
          TOPICS_META[knownEntry.topicId]?.description || ""
        }`;
        const contentHash = computeSha256Hex(
          `${canonicalId}|${knownEntry.name}|${summaryText}`,
        );
        const baseLesson: ResolvedTutorLesson = {
          lessonId: canonicalId,
          trackKey: knownEntry.topicId,
          trackTitle,
          slug,
          code: knownEntry.code,
          title: knownEntry.name,
          subtitle: TOPICS_META[knownEntry.topicId]?.description || "",
          difficulty: "Moderate",
          objectives: [knownEntry.name],
          summaryText,
          codeBlocks: [],
          selectedCodeBlock: null,
          contentHash,
          codeHash: null,
        };
        return applyTestOverrides(canonicalId, rawLessonId, baseLesson);
      }
    }
  }

  if (!found || !matchedTrack) {
    throw new InvalidLessonError(rawLessonId);
  }

  let selectedCodeBlock: TutorCodeBlock | null = null;
  if (codeBlockId) {
    selectedCodeBlock =
      found.codeBlocks.find(
        (b) => b.id.toLowerCase() === codeBlockId.toLowerCase(),
      ) || null;
    if (!selectedCodeBlock) {
      throw new InvalidLessonError(`${rawLessonId}#${codeBlockId}`);
    }
  } else if (found.codeBlocks.length > 0) {
    selectedCodeBlock = found.codeBlocks[0];
  }

  const resolved: ResolvedTutorLesson = {
    ...found,
    selectedCodeBlock,
    codeHash: selectedCodeBlock?.hash ?? null,
  };

  return applyTestOverrides(found.lessonId, rawLessonId, resolved);
}

export function resolveLessonRouteMetadata(
  rawLessonId: string,
): TutorLessonRouteMetadata | null {
  try {
    const resolved = resolveAuthoritativeLesson(rawLessonId);
    const matchingKnownEntry = Object.entries(KNOWN_LESSONS).find(
      ([pathKey, entry]) =>
        entry.topicId.toLowerCase() === resolved.trackKey.toLowerCase() &&
        (entry.code.toLowerCase() === resolved.code.toLowerCase() ||
          pathKey
            .toLowerCase()
            .endsWith(`/${resolved.slug.toLowerCase()}`)),
    );

    const lessonUrl =
      matchingKnownEntry?.[0] || `/learn/${resolved.trackKey}/${resolved.slug}`;

    return {
      lessonId: resolved.lessonId,
      trackKey: resolved.trackKey,
      trackTitle: resolved.trackTitle,
      slug: resolved.slug,
      code: resolved.code,
      lessonTitle: resolved.title,
      lessonUrl,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class LessonRegistryService {
  getTopicsMeta(): Record<string, TopicMetaEntry> {
    return TOPICS_META;
  }

  resolveLesson(
    rawLessonId: string,
    codeBlockId?: string,
  ): ResolvedTutorLesson {
    return resolveAuthoritativeLesson(rawLessonId, codeBlockId);
  }

  resolveRouteMetadata(
    rawLessonId: string,
  ): TutorLessonRouteMetadata | null {
    return resolveLessonRouteMetadata(rawLessonId);
  }
}
