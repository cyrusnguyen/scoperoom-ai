import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { AI_LIMITS } from "../src/features/proposals/contracts/tasks.ts";
import { buildModelRequest, estimateInputTokens, OUTPUT_SCHEMA } from "../src/features/proposals/domain/model-request.ts";
import { MAX_RESPONSE_BYTES, boundedFetch, createModelGateway } from "../src/features/proposals/server/adapters/model.ts";
import { RUN_AI_TASK_ID, createJobDispatcher, type TriggerApi } from "../src/features/proposals/server/adapters/trigger.ts";
import type { ModelRequest } from "../src/features/proposals/server/ports.ts";
import { jobDispatcher, modelGateway } from "../src/features/proposals/server/providers.ts";
import { PROVIDER_SECRET_NAMES, withoutProviderSecrets } from "../scripts/e2e/provider-env.mjs";
import { resultFixture } from "./support/ai-results.ts";

// Everything here is a fake or a fetch stub: no key, no network, no SDK client that reaches a provider.
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ ...buildModelRequest({ id: "run-1", model: "model-x", capture: resultFixture().generate() }, 5_000), ...over });
const gemini = (text: string, finishReason = "STOP", usage: unknown = { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 }) =>
  ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }], ...(usage ? { usageMetadata: usage } : {}), responseId: "resp-1" });
const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const gateway = (handler: (url: string, init?: RequestInit) => Promise<Response> | Response) => {
  const calls: Array<{ url: string; body: string }> = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return handler(String(input), init);
  }) as typeof fetch;
  return { calls, gateway: createModelGateway({ apiKey: "test-key-not-real", fetch: stub }) };
};
const never = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
const signal = () => new AbortController().signal;

test("a completed reply returns the parsed output and normalized usage from exactly one provider call", async () => {
  const { gateway: model, calls } = gateway(() => respond(gemini('{"schemaVersion":1,"kind":"clarification","message":"hi"}')));
  assert.deepEqual(await model.generate(request(), signal()), {
    kind: "completed", output: { schemaVersion: 1, kind: "clarification", message: "hi" }, requestId: "resp-1", usage: { inputTokens: 12, outputTokens: 34 },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.body);
  assert.match(calls[0]!.url, /models\/model-x:generateContent/);
  assert.equal(body.generationConfig.maxOutputTokens, AI_LIMITS.maxOutputTokens);
  assert.equal(body.generationConfig.responseMimeType, "application/json"); // provider-side structured output is requested
});

test("missing usage is null, never zero", async () => {
  const { gateway: model } = gateway(() => respond(gemini('{"a":1}', "STOP", null)));
  const reply = await model.generate(request(), signal());
  assert.equal(reply.kind, "completed");
  assert.deepEqual(reply.kind === "completed" && reply.usage, { inputTokens: null, outputTokens: null });
  const partial = await gateway(() => respond(gemini('{"a":1}', "STOP", { promptTokenCount: 5 }))).gateway.generate(request(), signal());
  assert.deepEqual(partial.kind === "completed" && partial.usage.inputTokens, 5);
  assert.equal(partial.kind === "completed" && partial.usage.outputTokens === 0, false);
});

test("refused, incomplete, truncated and malformed replies are normalized, never thrown", async () => {
  assert.equal((await gateway(() => respond(gemini("", "SAFETY"))).gateway.generate(request(), signal())).kind, "refused");
  assert.equal((await gateway(() => respond(gemini('{"schemaVersion":1,"ope', "MAX_TOKENS"))).gateway.generate(request(), signal())).kind, "incomplete"); // truncated
  assert.equal((await gateway(() => respond(gemini("{not json"))).gateway.generate(request(), signal())).kind, "incomplete"); // malformed
  assert.equal((await gateway(() => respond(gemini(""))).gateway.generate(request(), signal())).kind, "incomplete"); // empty
  assert.equal((await gateway(() => respond(gemini("[1,2"))).gateway.generate(request(), signal())).kind, "incomplete");
});

test("429 and 5xx are unavailable with the server's retry hint, and SDK inference retries are disabled", async () => {
  const throttled = gateway(() => respond({ error: { message: "slow down", status: "RESOURCE_EXHAUSTED" } }, 429, { "retry-after": "7" }));
  assert.deepEqual(await throttled.gateway.generate(request(), signal()), { kind: "unavailable", retryAfterMs: 7_000 });
  assert.equal(throttled.calls.length, 1, "no hidden retry");
  const broken = gateway(() => respond({ error: { message: "boom" } }, 503));
  assert.equal((await broken.gateway.generate(request(), signal())).kind, "unavailable");
  assert.equal(broken.calls.length, 1);
  // A definite client error repeats identically, so it is non-retryable (refused), never a reason to spend the second call.
  for (const status of [400, 401, 403, 404]) {
    const definite = gateway(() => respond({ error: { message: "nope" } }, status));
    assert.equal((await definite.gateway.generate(request(), signal())).kind, "refused", String(status));
    assert.equal(definite.calls.length, 1);
  }
  assert.equal((await gateway(() => respond({ error: { message: "odd" } }, 409)).gateway.generate(request(), signal())).kind, "unknown"); // anything else may have run
});

test("a timeout, an abort and a network failure are unknown, and the reply never carries the error text", async () => {
  const slow = gateway(never);
  assert.deepEqual(await slow.gateway.generate(request({ timeoutMs: 25 }), signal()), { kind: "unknown" });
  assert.equal(slow.calls.length, 1);
  const controller = new AbortController();
  const aborted = gateway(never).gateway.generate(request({ timeoutMs: 60_000 }), controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.deepEqual(await aborted, { kind: "unknown" });
  const failed = await gateway(() => { throw new TypeError("secret prompt text leaked in error"); }).gateway.generate(request(), signal());
  assert.deepEqual(failed, { kind: "unknown" });
});

test("the wire schema avoids keywords the provider rejects outright", () => {
  // Live probe finding (Stage 06.1): gemini-3.8-flash answers 400 INVALID_ARGUMENT to maxItems, which refuses every real run. validateResult owns the limits.
  assert.ok(!JSON.stringify(OUTPUT_SCHEMA).includes("maxItems"));
});

test("the input token ceiling is enforced before any provider call", async () => {
  const model = gateway(() => respond(gemini("{}")));
  const big = request();
  assert.ok(estimateInputTokens(big) > 100);
  assert.deepEqual(await model.gateway.generate({ ...big, maxInputTokens: 100 }, signal()), { kind: "refused" });
  assert.equal(model.calls.length, 0);
  assert.equal((await model.gateway.generate({ ...big, maxInputTokens: estimateInputTokens(big) }, signal())).kind, "completed"); // exactly at the bound passes
});

test("response bytes are bounded before JSON parsing, by body size and by generated text size", async () => {
  const huge = gateway(() => new Response(`{"candidates":[],"pad":"${"x".repeat(MAX_RESPONSE_BYTES)}"}`, { status: 200 }));
  assert.deepEqual(await huge.gateway.generate(request(), signal()), { kind: "incomplete" });
  const longText = gateway(() => respond(gemini(JSON.stringify({ message: "m".repeat(AI_LIMITS.resultBytes) }))));
  assert.equal((await longText.gateway.generate(request(), signal())).kind, "incomplete");
  // The wrapper stops reading at the bound: a body that never ends is cut off, never buffered whole and never parsed.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)); } });
  await assert.rejects(boundedFetch((async () => new Response(endless)) as typeof fetch, 256 * 1024)("https://example.test"));
  assert.ok(pulled <= 8, `read ${pulled} chunks`);
  await assert.rejects(boundedFetch((async () => new Response("x", { headers: { "content-length": "999999" } })) as typeof fetch, 1_000)("https://example.test"));
});

const job = { runId: "9f0a1111-1111-4111-8111-111111111111", dispatchId: "7d0b2222-2222-4222-8222-222222222222", executionBinding: "20261003.1", deadlineAt: new Date(Date.now() + 200_000).toISOString() };
function fakeTrigger(over: Partial<TriggerApi> = {}) {
  const calls = { trigger: [] as Array<{ id: string; payload: unknown; options: unknown }>, cancel: [] as string[] };
  const api: TriggerApi = {
    trigger: async (id, payload, options) => { calls.trigger.push({ id, payload, options }); return { id: "task-1" }; },
    status: async () => "EXECUTING", cancel: async (taskId) => { calls.cancel.push(taskId); }, ...over,
  };
  return { calls, dispatcher: createJobDispatcher(api) };
}

test("dispatch maps dispatchId to the idempotency key, pins the captured binding and sends only identities and the deadline", async () => {
  const { dispatcher, calls } = fakeTrigger();
  assert.deepEqual(await dispatcher.dispatch(job), { kind: "accepted", taskId: "task-1" });
  assert.deepEqual(await dispatcher.dispatch({ ...job }), { kind: "accepted", taskId: "task-1" }); // repair re-delivers the same identity
  assert.equal(calls.trigger.length, 2);
  for (const call of calls.trigger) {
    assert.equal(call.id, RUN_AI_TASK_ID);
    assert.deepEqual(call.payload, job); // exactly {runId, dispatchId, executionBinding, deadlineAt}
    const options = call.options as { idempotencyKey: string; externalDeploymentId: string; ttl: number };
    assert.equal(options.idempotencyKey, job.dispatchId);
    assert.equal(options.externalDeploymentId, job.executionBinding); // the external deployment id from `trigger.dev deploy --external-id`
    assert.ok(!("version" in options), "no numeric version is ever sent");
    assert.ok(options.ttl >= 1 && options.ttl <= 200);
  }
});

test("dispatch is unavailable for an unknown binding, a provider failure or an expired deadline, and never throws", async () => {
  assert.deepEqual(await fakeTrigger({ trigger: async () => { throw new Error("version not found"); } }).dispatcher.dispatch(job), { kind: "unavailable" });
  assert.deepEqual(await fakeTrigger({ trigger: async () => ({ id: "" }) }).dispatcher.dispatch(job), { kind: "unavailable" });
  const expired = fakeTrigger();
  assert.deepEqual(await expired.dispatcher.dispatch({ ...job, deadlineAt: new Date(Date.now() - 1_000).toISOString() }), { kind: "unavailable" });
  assert.equal(expired.calls.trigger.length, 0, "no call past the deadline");
  const long = fakeTrigger(); // Trigger ignores an id over 128 characters, which would run the task on whatever deployment is current
  assert.deepEqual(await long.dispatcher.dispatch({ ...job, executionBinding: "b".repeat(129) }), { kind: "unavailable" });
  assert.equal(long.calls.trigger.length, 0);
  assert.deepEqual(await long.dispatcher.dispatch({ ...job, executionBinding: "b".repeat(128) }), { kind: "accepted", taskId: "task-1" });
});

test("cancel distinguishes requested, terminal and unknown, and a request never claims the task stopped", async () => {
  const live = fakeTrigger();
  assert.equal(await live.dispatcher.cancel("task-1"), "requested");
  assert.deepEqual(live.calls.cancel, ["task-1"]);
  const done = fakeTrigger({ status: async () => "COMPLETED" });
  assert.equal(await done.dispatcher.cancel("task-1"), "terminal");
  assert.deepEqual(done.calls.cancel, []);
  assert.equal(await fakeTrigger({ status: async () => { throw new Error("404"); } }).dispatcher.cancel("task-1"), "unknown");
  assert.equal(await fakeTrigger({ cancel: async () => { throw new Error("network"); } }).dispatcher.cancel("task-1"), "unknown");
});

test("the composition module treats blank keys as absent and the test environment never reaches a real provider", () => {
  assert.equal(jobDispatcher({}), undefined);
  assert.equal(jobDispatcher({ TRIGGER_SECRET_KEY: "  " }), undefined);
  assert.throws(() => modelGateway({}), /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.throws(() => modelGateway({ GOOGLE_GENERATIVE_AI_API_KEY: "" }));
  const blanked = withoutProviderSecrets({ GOOGLE_GENERATIVE_AI_API_KEY: "x", TRIGGER_SECRET_KEY: "y", TRIGGER_ACCESS_TOKEN: "z", KEEP: "1" });
  assert.deepEqual(PROVIDER_SECRET_NAMES.map((name) => blanked[name]), ["", "", ""]);
  assert.equal(blanked.KEEP, "1");
  assert.equal(jobDispatcher(blanked), undefined);
  assert.equal(jobDispatcher({ TRIGGER_SECRET_KEY: "would-be-real", SCOPEROOM_E2E: "1" }), undefined); // the hand-started dev e2e server is safe too
  assert.ok(jobDispatcher({ TRIGGER_SECRET_KEY: "fake-key-for-construction-only" }), "a configured production process gets its dispatcher (constructed, never called)");
  // The servers and suites that must stay network-free blank the keys; Next would otherwise load them from .env.local itself.
  assert.match(readFileSync("scripts/e2e/production.mjs", "utf8"), /withoutProviderSecrets\(\{/);
  assert.match(readFileSync("playwright.config.ts", "utf8"), /env: withoutProviderSecrets\(/);
  // Only the composition module's own tests and the Trigger entrypoints compose real providers: no suite imports it with the process env.
  const suites = ["tests", "tests/integration", "tests/workers", "tests/integration/support"].flatMap((dir) => {
    try { return readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => `${dir}/${name}`); } catch { return []; }
  });
  for (const file of suites) {
    if (file === "tests/ai-adapters.test.ts") continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /^\s*(?:import|export)[^\n]*from\s+["'][^"']*(?:server\/providers|adapters\/(?:model|trigger))(?:\.ts)?["']/m, `${file} must use injected fakes`);
  }
});
