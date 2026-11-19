export interface QuestionCodeInput {
  codeSnippet?: string;
  example?: string;
  answer?: string;
  explanation?: string;
}

export interface ExtractedQuestionCodeBlock {
  id: string;
  source: "codeSnippet" | "example" | "answer" | "explanation";
  language: string;
  code: string;
}

const FENCED_CODE_REGEX = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function normalizeCodeForDedup(code: string): string {
  return code.replace(/\r\n/g, "\n").trim();
}

function extractFencesFromMarkdown(
  markdown: string | undefined,
  source: "example" | "answer" | "explanation",
  seenNormalized: Set<string>,
  blocks: ExtractedQuestionCodeBlock[],
): void {
  if (!markdown || markdown.trim().length === 0) {
    return;
  }

  FENCED_CODE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = FENCED_CODE_REGEX.exec(markdown)) !== null) {
    const language = (match[1] || "").trim().toLowerCase() || "text";
    const rawCode = match[2] || "";
    const normalized = normalizeCodeForDedup(rawCode);
    if (!normalized || seenNormalized.has(normalized)) {
      continue;
    }

    index += 1;
    seenNormalized.add(normalized);
    blocks.push({
      id: `${source}-code-${index}`,
      source,
      language,
      code: rawCode.replace(/\r\n/g, "\n").trimEnd(),
    });
  }
}

export function extractQuestionCodeBlocks(
  question: QuestionCodeInput,
): ExtractedQuestionCodeBlock[] {
  const blocks: ExtractedQuestionCodeBlock[] = [];
  const seenNormalized = new Set<string>();

  const snippet = question.codeSnippet?.trim();
  if (snippet) {
    const normalized = normalizeCodeForDedup(snippet);
    seenNormalized.add(normalized);
    blocks.push({
      id: "primary-code-snippet",
      source: "codeSnippet",
      language: "text",
      code: snippet.replace(/\r\n/g, "\n"),
    });
  }

  extractFencesFromMarkdown(
    question.example,
    "example",
    seenNormalized,
    blocks,
  );
  extractFencesFromMarkdown(question.answer, "answer", seenNormalized, blocks);
  extractFencesFromMarkdown(
    question.explanation,
    "explanation",
    seenNormalized,
    blocks,
  );

  return blocks;
}

export function questionHasRelevantCode(question: QuestionCodeInput): boolean {
  return extractQuestionCodeBlocks(question).length > 0;
}
