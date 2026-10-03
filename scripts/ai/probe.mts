// Guarded synthetic-only probe. No provider call is made merely by importing this module.
// node --env-file-if-exists=.env.local --experimental-strip-types scripts/ai/probe.mts --live [--only=generate,improve]
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultFixture } from "../../tests/support/ai-results.ts";
import { AI_LIMITS, type CapturedInput } from "../../src/features/proposals/contracts/tasks.ts";
import { buildModelRequest, estimateInputTokens } from "../../src/features/proposals/domain/model-request.ts";
import { validateResult } from "../../src/features/proposals/domain/validate-result.ts";
import { createModelGateway } from "../../src/features/proposals/server/adapters/model.ts";
import type { ModelReply } from "../../src/features/proposals/server/ports.ts";

const CASE_NAMES = ["generate", "improve", "unsupported-schema", "calibrate-ascii-40k", "calibrate-cjk-10k"] as const;
type CaseName = typeof CASE_NAMES[number];

/** Validate the complete selection before credentials or a provider are used. One invocation has at most five calls, no retries. */
export function selectProbeCases(args: string[]): CaseName[] {
  if (!args.includes("--live")) throw new Error("Refusing to call a provider: this probe spends real quota. Pass --live to run it with synthetic input.");
  if (args.filter((arg) => arg === "--live").length !== 1 || args.some((arg) => arg !== "--live" && !arg.startsWith("--only="))) throw new Error("Use --live and at most one --only=case,case selection.");
  const selections = args.filter((arg) => arg.startsWith("--only="));
  if (selections.length > 1) throw new Error("Use at most one --only=case,case selection.");
  if (!selections.length) return [...CASE_NAMES];
  const names = selections[0].slice("--only=".length).split(",");
  if (names.some((name) => !(CASE_NAMES as readonly string[]).includes(name)) || new Set(names).size !== names.length) throw new Error("--only must name unique supported probe cases.");
  return CASE_NAMES.filter((name) => names.includes(name));
}

/** A refusal is the adapter's expected unsupported-schema outcome, not evidence of a particular HTTP status or failure cause. */
export function probeCaseVerified(name: CaseName, reply: ModelReply, schemaAccepted: boolean | null): boolean {
  if (name === "unsupported-schema") return reply.kind === "refused";
  if (reply.kind !== "completed" || reply.usage.inputTokens === null || reply.usage.outputTokens === null) return false;
  return name.startsWith("calibrate-") || schemaAccepted === true;
}

/** Deterministic varied synthetic prose for the local estimate calibration. */
function prose(codePoints: number): string {
  const words = ["customer", "order", "checkout", "payment", "review", "approve", "inventory", "shipping", "invoice", "refund", "support", "account", "address", "email", "confirm", "cancel", "update", "report", "admin", "warehouse"];
  let seed = 12345, out = "", line = "";
  while (out.length < codePoints) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    line += `${line ? " " : ""}${words[seed % words.length]}`;
    if (line.length > 70) { out += `${line}.\n`; line = ""; }
  }
  return out.slice(0, codePoints);
}
const withSourceText = (capture: CapturedInput, text: string): CapturedInput => ({ ...capture, sources: capture.sources.map((source) => ({ ...source, text })) });

async function main() {
  let selected: CaseName[];
  try { selected = selectProbeCases(process.argv.slice(2)); } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const paceMs = Number(process.env.PROBE_PACE_MS ?? 13_000);
  if (!Number.isSafeInteger(paceMs) || paceMs < 0 || paceMs > 60_000) {
    console.error("PROBE_PACE_MS must be an integer from 0 to 60000.");
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !model) {
    console.error("GOOGLE_GENERATIVE_AI_API_KEY and AI_MODEL must both be set (never printed).");
    process.exitCode = 2;
    return;
  }
  const version = (name: string): string => JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
  const gateway = createModelGateway({ apiKey });
  const fixture = resultFixture();
  const cases = [
    { name: "generate", capture: fixture.generate(), schema: null },
    { name: "improve", capture: fixture.improve(), schema: null },
    { name: "unsupported-schema", capture: fixture.generate(), schema: { type: "object", properties: { x: { type: "definitely-not-a-type" } } } },
    { name: "calibrate-ascii-40k", capture: withSourceText(fixture.generate(), prose(40_000)), schema: null },
    { name: "calibrate-cjk-10k", capture: withSourceText(fixture.generate(), "顧客が注文を確認し支払いを完了する。\n".repeat(550).slice(0, 10_000)), schema: null },
  ].filter((item) => selected.includes(item.name as CaseName));
  const results = [];
  for (const [index, item] of cases.entries()) {
    if (index > 0) await new Promise((done) => setTimeout(done, paceMs));
    const request = { ...buildModelRequest({ id: randomUUID(), model, capture: item.capture }, 120_000), ...(item.schema ? { outputSchema: item.schema as never } : {}) };
    const estimate = estimateInputTokens(request);
    const calibrating = item.name.startsWith("calibrate-");
    // Only this trusted synthetic harness lifts the local estimate guard to observe provider usage. Runtime ceilings are unchanged.
    const sentInputCeiling = calibrating ? 1_000_000 : request.maxInputTokens;
    const startedAt = performance.now();
    let reply: ModelReply;
    try { reply = await gateway.generate({ ...request, maxInputTokens: sentInputCeiling }, AbortSignal.timeout(130_000)); } catch { reply = { kind: "unknown" }; }
    const latencyMs = Math.round(performance.now() - startedAt);
    let schemaAccepted: boolean | null = null;
    if (!calibrating && item.name !== "unsupported-schema" && reply.kind === "completed") {
      try { validateResult(item.capture, reply.output); schemaAccepted = true; } catch { schemaAccepted = false; }
    }
    const usage = reply.kind === "completed" ? reply.usage : null;
    const requestBytes = Buffer.byteLength(JSON.stringify([request.systemInstruction, request.prompt, request.context, request.outputSchema]), "utf8");
    results.push({
      name: item.name, outcome: reply.kind, schemaAccepted,
      unsupportedSchemaOutcomeMatched: item.name === "unsupported-schema" ? reply.kind === "refused" : null,
      verified: probeCaseVerified(item.name as CaseName, reply, schemaAccepted), latencyMs, usage,
      estimatedInputTokens: estimate, requestBytes, sentInputCeiling,
      bytesPerRealInputToken: usage?.inputTokens ? Number((requestBytes / usage.inputTokens).toFixed(2)) : null,
      estimateOverReal: usage?.inputTokens ? Number((estimate / usage.inputTokens).toFixed(2)) : null,
    });
  }
  const summary = {
    at: new Date().toISOString(), model, packages: { ai: version("ai"), "@ai-sdk/google": version("@ai-sdk/google") },
    ceilings: { maxInputTokens: AI_LIMITS.maxInputTokens, maxOutputTokens: AI_LIMITS.maxOutputTokens },
    calls: results.length, verified: results.every((result) => result.verified), results,
  };
  mkdirSync(new URL("../../.tmp/stage-06.1/probe/", import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../.tmp/stage-06.1/probe/probe-${summary.at.replace(/[:.]/g, "-")}.json`, import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.verified) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
