import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { APICallError, generateText, type OutputInterface } from "ai";
import { AI_LIMITS } from "../../contracts/tasks.ts";
import { estimateInputTokens } from "../../domain/model-request.ts";
import { modelRoute } from "../../domain/model-route.ts";
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
    if (status === 400 || status === 401 || status === 403 || status === 404) return { kind: "refused" }; // a definite, repeatable client error is never worth the second call
  }
  return { kind: "unknown" }; // timeout, abort, network failure, other 4xx or anything unrecognized: the call may have run
}

/** `apiKey` is Google's (the original single provider); `anthropicApiKey` adds Anthropic. A provider without a key is not supported. */
export type ModelAdapterOptions = { apiKey?: string; anthropicApiKey?: string; fetch?: typeof fetch };

/**
 * Anthropic's strict structured output compiles the schema into a grammar and refuses OUTPUT_SCHEMA as "Schema is too complex" (live,
 * 2026-10-14), so Claude gets the schema in its system text instead. The provider schema only ever guided the model: validateResult is
 * the authority either way. Without the grammar Claude may fence its JSON, so one surrounding fence is removed before parsing.
 */
const withSchema = (system: string, schema: Json) => `${system}\n\nThe reply is one JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(schema)}`;
const unfenced = (text: string) => /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1] ?? text;

/** Claude models that accept `effort`: the Claude 5 generation (Opus, Sonnet, Haiku and Fable 5.x). */
const CLAUDE_EFFORT = /^claude-(?:opus|sonnet|haiku|fable)-5(?:-|$)/;

/** Provider-reported token counts only: the SDK turns an absent count into 0, so a field the provider did not send stays null. */
function reportedUsage(provider: "google" | "anthropic", metadata: Record<string, Record<string, unknown>> | undefined, usage: { inputTokens?: number; outputTokens?: number }) {
  const raw = (provider === "google" ? metadata?.google?.usageMetadata : metadata?.anthropic?.usage) as Record<string, unknown> | undefined ?? {};
  const [input, output] = provider === "google" ? ["promptTokenCount", "candidatesTokenCount"] : ["input_tokens", "output_tokens"];
  return { inputTokens: typeof raw[input] === "number" ? usage.inputTokens ?? null : null, outputTokens: typeof raw[output] === "number" ? usage.outputTokens ?? null : null };
}

export function createModelGateway({ apiKey, anthropicApiKey, fetch: transport = fetch }: ModelAdapterOptions): ModelGateway {
  const bounded = boundedFetch(transport);
  const providers = {
    google: apiKey ? createGoogleGenerativeAI({ apiKey, fetch: bounded }) : null,
    anthropic: anthropicApiKey ? createAnthropic({ apiKey: anthropicApiKey, fetch: bounded }) : null,
  };
  const resolve = (model: string) => {
    const route = modelRoute(model), provider = route && providers[route.provider];
    return route && provider ? { name: route.provider, id: route.id, model: provider(route.id) } : null;
  };
  return {
    supports: (model) => resolve(model) !== null,
    async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
      // The ceiling is enforced here too, so no caller can send more than the configured input.
      if (estimateInputTokens(request) > request.maxInputTokens) return { kind: "refused" };
      // Backstop for a caller that skipped `supports`: never route a model to another provider.
      const target = resolve(request.model);
      if (!target) return { kind: "refused" };
      try {
        const result = await generateText({
          model: target.model,
          system: target.name === "anthropic" ? withSchema(request.systemInstruction, request.outputSchema) : request.systemInstruction,
          prompt: `${request.prompt}\n\n<context>\n${JSON.stringify(request.context)}\n</context>`,
          ...(target.name === "anthropic" ? {} : { output: rawJson(request.outputSchema) }),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0, // hidden SDK inference retries are never allowed: the SQL claim is the only authority for a call
          // ponytail: one fixed effort for the Claude 5 generation. Sonnet 5.5 always thinks and its thinking counts toward the same
          // maxOutputTokens as the JSON reply, so low effort leaves the budget to the answer; older Claude models reject the parameter
          // (after the claim), so they get none. Revisit with measured smoke usage.
          ...(target.name === "anthropic" && CLAUDE_EFFORT.test(target.id) ? { providerOptions: { anthropic: { effort: "low" } } } : {}),
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
        });
        const requestId = result.response.id;
        if (result.finishReason === "content-filter") return { kind: "refused", requestId };
        if (result.finishReason !== "stop") return { kind: "incomplete", requestId }; // length (truncated), error, other
        if (Buffer.byteLength(result.text, "utf8") > AI_LIMITS.resultBytes) return { kind: "incomplete", requestId };
        let output: unknown;
        try { output = JSON.parse(target.name === "anthropic" ? unfenced(result.text) : result.text); } catch { return { kind: "incomplete", requestId }; }
        const usage = reportedUsage(target.name, result.providerMetadata as Record<string, Record<string, unknown>> | undefined, result.usage);
        return { kind: "completed", output, requestId, usage };
      } catch (error) {
        return normalize(error);
      }
    },
  };
}
