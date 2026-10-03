import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { APICallError, generateText, type OutputInterface } from "ai";
import { AI_LIMITS } from "../../contracts/tasks.ts";
import { estimateInputTokens } from "../../domain/model-request.ts";
import type { Json, ModelGateway, ModelReply, ModelRequest } from "../ports.ts";

/** Whole HTTP body ceiling, enforced while reading and before the SDK parses a byte of it: four times the stored result cap. */
export const MAX_RESPONSE_BYTES = 4 * AI_LIMITS.resultBytes;

class ResponseTooLarge extends Error {}

/** Wraps fetch so a body larger than `limit` is cut off while streaming and never reaches a JSON parser. */
export function boundedFetch(inner: typeof fetch, limit = MAX_RESPONSE_BYTES): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const declared = Number(response.headers.get("content-length"));
    if (declared > limit) { await response.body?.cancel().catch(() => undefined); throw new ResponseTooLarge(); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
      size += part.value.byteLength;
      if (size > limit) { await reader!.cancel().catch(() => undefined); throw new ResponseTooLarge(); }
      chunks.push(part.value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Raw JSON text out: the SDK asks the provider for schema-shaped JSON but never parses it, so the byte bound applies before JSON.parse. */
const rawJson = (schema: Json): OutputInterface<string, string, never> => ({
  name: "raw-json",
  responseFormat: Promise.resolve({ type: "json" as const, schema: schema as never }),
  parseCompleteOutput: async ({ text }) => text,
  parsePartialOutput: async ({ text }) => ({ partial: text }),
  createElementStreamTransform: () => undefined,
});

const retryAfter = (error: APICallError): number | undefined => {
  const seconds = Number(error.responseHeaders?.["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3_600) * 1000 : undefined;
};

/** Never throws and never carries prompt or result text: every outcome is normalized to a ModelReply. */
function normalize(error: unknown): ModelReply {
  if (error instanceof ResponseTooLarge) return { kind: "incomplete" };
  const cause = error instanceof Error && error.cause ? error.cause : null;
  if (cause instanceof ResponseTooLarge) return { kind: "incomplete" };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429 || status === 408 || (status !== undefined && status >= 500)) return { kind: "unavailable", retryAfterMs: retryAfter(error) };
  }
  return { kind: "unknown" }; // timeout, abort, network failure, other 4xx or anything unrecognized: the call may have run
}

export type ModelAdapterOptions = { apiKey: string; fetch?: typeof fetch };

export function createModelGateway({ apiKey, fetch: transport = fetch }: ModelAdapterOptions): ModelGateway {
  const provider = createGoogleGenerativeAI({ apiKey, fetch: boundedFetch(transport) });
  return {
    async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
      // The ceiling is enforced here too, so no caller can send more than the configured input.
      if (estimateInputTokens(request) > request.maxInputTokens) return { kind: "refused" };
      try {
        const result = await generateText({
          model: provider(request.model),
          system: request.systemInstruction,
          prompt: `${request.prompt}\n\n<context>\n${JSON.stringify(request.context)}\n</context>`,
          output: rawJson(request.outputSchema),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0, // hidden SDK inference retries are never allowed: the SQL claim is the only authority for a call
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
        });
        const requestId = result.response.id;
        if (result.finishReason === "content-filter") return { kind: "refused", requestId };
        if (result.finishReason !== "stop") return { kind: "incomplete", requestId }; // length (truncated), error, other
        if (Buffer.byteLength(result.text, "utf8") > AI_LIMITS.resultBytes) return { kind: "incomplete", requestId };
        let output: unknown;
        try { output = JSON.parse(result.text); } catch { return { kind: "incomplete", requestId }; }
        // Missing usage is null, never zero: the SDK turns an absent provider count into 0, so trust it only when the provider reported the field.
        const raw = (result.providerMetadata?.google?.usageMetadata ?? {}) as Record<string, unknown>;
        const usage = {
          inputTokens: typeof raw.promptTokenCount === "number" ? result.usage.inputTokens ?? null : null,
          outputTokens: typeof raw.candidatesTokenCount === "number" ? result.usage.outputTokens ?? null : null,
        };
        return { kind: "completed", output, requestId, usage };
      } catch (error) {
        return normalize(error);
      }
    },
  };
}
