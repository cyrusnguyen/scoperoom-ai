import type { SourceKind } from "../contracts/source-version";

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = { USER_TEXT: "Pasted", USER_UPLOAD: "Uploaded", PROMOTED_GRAPH: "Saved flow", QUESTION_ANSWER: "Answer", AI_PROMPT: "AI instruction" };
