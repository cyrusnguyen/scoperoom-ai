import { SOURCE_LIMITS, USER_DOCUMENT_LIMIT } from "../contracts/source-version";
import type { ApiResult } from "@/client/api";

const LIMIT_TEXT: Record<string, string> = {
  SOURCE_SUBMISSION: `A source can hold at most ${SOURCE_LIMITS.submissionCodePoints.toLocaleString("en-US")} characters.`,
  SOURCE_BODY_BYTES: "This source is too large to send.",
  SOURCE_DOCUMENTS: `The project already has ${USER_DOCUMENT_LIMIT} active documents. Archive one first.`,
  SOURCE_VERSIONS: `The project has reached ${SOURCE_LIMITS.retainedVersions} retained versions.`,
  SOURCE_CODE_POINTS: `The project has reached ${SOURCE_LIMITS.projectCodePoints.toLocaleString("en-US")} characters of source text.`,
};

/** A refusal's message, naming the bound when a limit was hit (the server's own text is generic). */
export const refusalText = (result: Extract<ApiResult<unknown>, { ok: false }>) =>
  result.code === "LIMIT_EXCEEDED" ? LIMIT_TEXT[String(result.details?.limit)] ?? result.message : result.message;
