const MAX_TITLE_LENGTH = 60;

const CONVERSATION_PREFIX_PATTERNS: Array<{ pattern: RegExp; prefix: string }> = [
  {
    pattern:
      /^(?:can you|could you|would you|please)\s+(?:help me\s+)?(?:understand|explain)\s+(?:to me\s+)?/i,
    prefix: "Understanding ",
  },
  {
    pattern: /^(?:explain|clarify)\s+(?:to me\s+)?/i,
    prefix: "Understanding ",
  },
  {
    pattern: /^(?:what\s+(?:is|are)\s+(?:a|an|the)?\s*)/i,
    prefix: "Understanding ",
  },
  {
    pattern: /^(?:how\s+(?:does|do|to)\s+)/i,
    prefix: "How ",
  },
  {
    pattern: /^(?:why\s+(?:does|do|is|are|should|use)\s+)/i,
    prefix: "Why ",
  },
  {
    pattern: /^(?:tell me about|show me|give me)\s+(?:an example of\s+)?/i,
    prefix: "",
  },
];

const LOWERCASE_SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "with",
]);

function formatWordForTitle(word: string, isFirstWord: boolean): string {
  if (!word) return word;

  if (
    /[A-Z].*[A-Z]/.test(word) ||
    /^[a-z]+[A-Z]/.test(word) ||
    word.includes(".") ||
    word.includes("_") ||
    word.includes("()")
  ) {
    return word;
  }

  const upper = word.toUpperCase();
  if (
    [
      "API",
      "ORM",
      "SQL",
      "JSX",
      "TSX",
      "DOM",
      "SSR",
      "CSR",
      "ISR",
      "RSC",
      "CSS",
      "HTML",
      "HTTP",
      "HTTPS",
      "JSON",
      "JWT",
      "REST",
      "CRUD",
      "OOP",
      "AI",
      "UI",
      "UX",
      "DB",
    ].includes(upper)
  ) {
    return upper;
  }

  const lower = word.toLowerCase();
  if (!isFirstWord && LOWERCASE_SMALL_WORDS.has(lower)) {
    return lower;
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength - 1).trimEnd();
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxLength * 0.45)) {
    return `${sliced.slice(0, lastSpace).trimEnd()}…`;
  }
  return `${sliced}…`;
}

export type QuickActionKind =
  | "explain_simply"
  | "step_by_step"
  | "explain_code"
  | "another_example"
  | "free";

const QUICK_ACTION_LABELS: Record<Exclude<QuickActionKind, "free">, string> = {
  explain_simply: "Simple Explanation",
  step_by_step: "Step-by-Step Guide",
  explain_code: "Code Walkthrough",
  another_example: "Another Example",
};

export function generateQuickActionTitle(
  action: QuickActionKind,
  lessonTitle: string,
): string {
  const cleanLesson = (lessonTitle || "Lesson")
    .split(":")[0]
    .replace(/\s+/g, " ")
    .trim();

  if (action === "free") {
    return truncateAtWordBoundary(cleanLesson || "Lesson Discussion", MAX_TITLE_LENGTH);
  }

  const suffix = QUICK_ACTION_LABELS[action];
  const full = `${cleanLesson}: ${suffix}`;
  if (full.length <= MAX_TITLE_LENGTH) {
    return full;
  }

  const availableForLesson = MAX_TITLE_LENGTH - suffix.length - 2;
  if (availableForLesson >= 10) {
    return `${truncateAtWordBoundary(cleanLesson, availableForLesson)}: ${suffix}`;
  }
  return truncateAtWordBoundary(suffix, MAX_TITLE_LENGTH);
}

export type InterviewActionKind =
  | "explain_question"
  | "explain_concept"
  | "break_down_answer"
  | "practical_example"
  | "explain_code"
  | "free";

const INTERVIEW_ACTION_LABELS: Record<
  Exclude<InterviewActionKind, "free">,
  string
> = {
  explain_question: "Question Breakdown",
  explain_concept: "Concept Explanation",
  break_down_answer: "Answer Breakdown",
  practical_example: "Practical Example",
  explain_code: "Code Explanation",
};

export function generateInterviewQuickActionTitle(
  action: InterviewActionKind,
  questionTitle: string,
): string {
  const cleanQuestion = (questionTitle || "Interview Question")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (action === "free") {
    return truncateAtWordBoundary(
      cleanQuestion || "Interview Discussion",
      MAX_TITLE_LENGTH,
    );
  }

  const suffix = INTERVIEW_ACTION_LABELS[action] || "Explanation";
  const full = `${cleanQuestion}: ${suffix}`;
  if (full.length <= MAX_TITLE_LENGTH) {
    return full;
  }

  const availableForQuestion = MAX_TITLE_LENGTH - suffix.length - 2;
  if (availableForQuestion >= 10) {
    return `${truncateAtWordBoundary(cleanQuestion, availableForQuestion)}: ${suffix}`;
  }
  return truncateAtWordBoundary(suffix, MAX_TITLE_LENGTH);
}

export function normalizeGenericTitle(
  title: string,
  lessonTitle?: string,
): string {
  const cleanTitle = (title || "").trim();
  const cleanLesson = (lessonTitle || "")
    .split(":")[0]
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanLesson) return cleanTitle || "Lesson Discussion";

  const lower = cleanTitle.toLowerCase();
  if (
    lower.includes("this concept") ||
    lower.includes("this lesson") ||
    lower.includes("the concept")
  ) {
    if (lower.includes("simple")) {
      return generateQuickActionTitle("explain_simply", cleanLesson);
    }
    if (lower.includes("step by step") || lower.includes("step-by-step")) {
      return generateQuickActionTitle("step_by_step", cleanLesson);
    }
    if (lower.includes("code") || lower.includes("line by line")) {
      return generateQuickActionTitle("explain_code", cleanLesson);
    }
    if (lower.includes("example")) {
      return generateQuickActionTitle("another_example", cleanLesson);
    }
    return truncateAtWordBoundary(`Understanding ${cleanLesson}`, MAX_TITLE_LENGTH);
  }

  return cleanTitle || cleanLesson;
}

export function generateConversationTitle(
  firstMessage: string,
  fallbackLessonTitle?: string,
): string {
  const cleanLesson = (fallbackLessonTitle || "")
    .split(":")[0]
    .replace(/\s+/g, " ")
    .trim();

  const normalized = (firstMessage || "")
    .replace(/[`*_~#>\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    if (cleanLesson) {
      return truncateAtWordBoundary(cleanLesson, MAX_TITLE_LENGTH);
    }
    return "Lesson Discussion";
  }

  let cleaned = normalized.replace(/[?!.]+$/g, "").trim();

  if (cleanLesson) {
    const genericReplaced = normalizeGenericTitle(cleaned, cleanLesson);
    if (genericReplaced !== cleaned) {
      return genericReplaced;
    }
  }

  let chosenPrefix = "";
  for (const rule of CONVERSATION_PREFIX_PATTERNS) {
    if (rule.pattern.test(cleaned)) {
      const stripped = cleaned.replace(rule.pattern, "").trim();
      if (stripped.length >= 3) {
        cleaned = stripped;
        if (
          rule.prefix &&
          !cleaned.toLowerCase().startsWith(rule.prefix.trim().toLowerCase())
        ) {
          chosenPrefix = rule.prefix;
        }
      }
      break;
    }
  }

  const combined = `${chosenPrefix}${cleaned}`.replace(/\s+/g, " ").trim();
  const words = combined.split(" ");
  const titleCased = words
    .map((word, index) => formatWordForTitle(word, index === 0))
    .join(" ");

  return truncateAtWordBoundary(titleCased || "Lesson Discussion", MAX_TITLE_LENGTH);
}
