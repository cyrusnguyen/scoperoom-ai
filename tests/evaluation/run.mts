// Trusted synthetic evaluator. Import and default execution never compose a live provider.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import { id, keys, object, text, version } from "../../src/features/drafts/contracts/strict.ts";
import { AI_LIMITS, PROMPT_VERSION, RESULT_SCHEMA_VERSION, parseStartRunInput, type CapturedInput, type StartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { canonicalJson, captureInput, sha256, type SavedContext } from "../../src/features/proposals/domain/capture.ts";
import { buildModelRequest, estimateInputTokens } from "../../src/features/proposals/domain/model-request.ts";
import { applyProposal } from "../../src/features/proposals/domain/proposal-diff.ts";
import { ResultError, validateResult } from "../../src/features/proposals/domain/validate-result.ts";
import { validatedCapture, type CaptureRow } from "../../src/features/proposals/server/applicability.ts";
import { createModelGateway } from "../../src/features/proposals/server/adapters/model.ts";
import type { ModelGateway, ModelReply } from "../../src/features/proposals/server/ports.ts";

export const MODEL = "gemini-3.8-flash";
const root = fileURLToPath(new URL("../../", import.meta.url));
const corpusPath = resolve(root, "tests/evaluation/cases.json");
const journalPath = resolve(root, ".tmp/stage-06.3-runtime/provider-budget.json");
const evidenceDir = resolve(root, ".tmp/stage-06.3-runtime/evaluation");
const ids = ["G", "I"].flatMap(prefix => Array.from({ length: 12 }, (_, n) => `${prefix}${String(n + 1).padStart(2, "0")}`));
export type EvaluationCase = {
  id: string; partition: "development" | "held-out"; intent: string; saved: SavedContext;
  layout: ReturnType<typeof parseDraftPair>["layout"]; input: StartRunInput; capture: CapturedInput; captureHash: string;
  validationProbe: unknown; expected: Record<string, string>; rubric: Record<string, string>;
};

export function loadCorpus(path = corpusPath): EvaluationCase[] {
  const raw = object(JSON.parse(readFileSync(path, "utf8")));
  keys(raw, ["schemaVersion", "syntheticOnly", "frozenAt", "tuningPlanned", "cases"]);
  if (raw.schemaVersion !== 1 || raw.syntheticOnly !== true || raw.tuningPlanned !== false || !Array.isArray(raw.cases) || raw.cases.length !== 24) throw new Error("CORPUS_INVALID");
  return raw.cases.map((value, index) => {
    const item = object(value);
    keys(item, ["id", "partition", "intent", "saved", "layout", "input", "capture", "captureHash", "validationProbe", "expected", "rubric"]);
    if (item.id !== ids[index] || item.partition !== (index % 12 < 8 ? "development" : "held-out")) throw new Error("CORPUS_PARTITION_INVALID");
    text(item.intent, 240, true);
    const saved = object(item.saved);
    keys(saved, ["projectId", "draftId", "documentRevision", "parentSnapshotId", "document", "sources", "model"]);
    id(saved.projectId); id(saved.draftId); version(saved.documentRevision);
    if (saved.parentSnapshotId !== null) id(saved.parentSnapshotId);
    if (saved.model !== MODEL || !Array.isArray(saved.sources)) throw new Error("CORPUS_MODEL_INVALID");
    const pair = parseDraftPair(saved.document, item.layout);
    if (!pair.document.projectGoal.startsWith("Synthetic Stage 06.3")) throw new Error("CORPUS_NOT_SYNTHETIC");
    for (const value of saved.sources) {
      const source = object(value); keys(source, ["projectId", "sourceId", "sourceVersionId", "currentVersionId", "title", "text", "contentHash"]);
      id(source.projectId); id(source.sourceId); id(source.sourceVersionId); id(source.currentVersionId);
      text(source.title, 120, true); text(source.text, 100_000, true);
    }
    const inputRaw = object(item.input); const { key, ...body } = inputRaw;
    const input = parseStartRunInput(body, String(key));
    const context = { ...saved, document: pair.document } as SavedContext;
    const rebuilt = captureInput(context, input);
    if (canonicalJson(rebuilt.capture) !== canonicalJson(item.capture) || rebuilt.hash !== item.captureHash
      || rebuilt.capture.versions.prompt !== PROMPT_VERSION || rebuilt.capture.versions.resultSchema !== RESULT_SCHEMA_VERSION) throw new Error("CORPUS_CAPTURE_INVALID");
    for (const name of ["expected", "rubric"] as const) {
      const fields = object(item[name]);
      keys(fields, name === "expected" ? ["schema", "scope", "sources", "dependencies", "authority", "capacity"] : ["omissions", "unsupportedClaims", "correctionEffort"]);
      for (const field of Object.values(fields)) text(field, 2_000, true);
    }
    const request = buildModelRequest({ id: item.id as string, model: MODEL, capture: rebuilt.capture }, 120_000);
    if (estimateInputTokens(request) > AI_LIMITS.maxInputTokens) throw new Error("CORPUS_INPUT_TOO_LARGE");
    return { ...item, saved: context, layout: pair.layout, input, capture: rebuilt.capture } as EvaluationCase;
  });
}

/** Live selection must be explicit and bounded before reading credentials. */
export function selectCases(args: string[], known = ids): string[] {
  const live = args.includes("--live");
  const allowed = ["--live", "--synthetic", `--model=${MODEL}`, "--target=synthetic"];
  if (new Set(args).size !== args.length || args.some(arg => !allowed.includes(arg) && !arg.startsWith("--only=") && !arg.startsWith("--limit="))) throw new Error("ARGUMENTS_INVALID");
  if (live && !allowed.every(arg => args.includes(arg))) throw new Error("LIVE_CONFIRMATION_REQUIRED");
  if (!live && args.some(arg => allowed.slice(1).includes(arg))) throw new Error("ARGUMENTS_INVALID");
  const only = args.filter(arg => arg.startsWith("--only="));
  const limits = args.filter(arg => arg.startsWith("--limit="));
  if (only.length > 1 || limits.length > 1 || (live && (!only.length || !limits.length))) throw new Error("BOUNDED_SELECTION_REQUIRED");
  const chosen = only.length ? only[0].slice(7).split(",") : [...known];
  if (!chosen.length || chosen.length > 24 || chosen.some(name => !known.includes(name)) || new Set(chosen).size !== chosen.length) throw new Error("CASE_SELECTION_INVALID");
  if (limits.length && (!/^--limit=[1-9]\d*$/.test(limits[0]) || Number(limits[0].slice(8)) !== chosen.length)) throw new Error("CASE_LIMIT_INVALID");
  return known.filter(name => chosen.includes(name));
}

type Reservation = { slot: number; id: string; kind: "corpus" | "journey"; runId: string; model: string; reservedAt: string };
type Budget = { model: string; authorizedCalls: number; reservedCalls: number; records: Reservation[] } & Record<string, unknown>;
function readBudget(path: string): Budget {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("BUDGET_INVALID");
  const raw = object(JSON.parse(readFileSync(path, "utf8")));
  keys(raw, ["model", "authorizedCalls", "reservedCalls", "records", "purpose", "authorizationDate", "scope"]);
  if (raw.purpose !== "24 synthetic evaluation cases plus two product journeys" || raw.authorizationDate !== "2026-10-05"
    || raw.scope !== "No retries or calibration beyond cumulative budget" || raw.model !== MODEL || raw.authorizedCalls !== 26 || !Number.isSafeInteger(raw.reservedCalls) || !Array.isArray(raw.records)
    || raw.reservedCalls !== raw.records.length || raw.records.length > 26) throw new Error("BUDGET_INVALID");
  const seen = new Set<string>(); const runIds = new Set<string>();
  let journeys = 0;
  raw.records.forEach((entry, i) => {
    const record = object(entry); keys(record, ["slot", "id", "kind", "runId", "model", "reservedAt"]);
    if (record.slot !== i + 1 || record.model !== MODEL || (record.kind !== "corpus" && record.kind !== "journey")
      || typeof record.id !== "string" || seen.has(record.id) || typeof record.reservedAt !== "string" || !Number.isFinite(Date.parse(record.reservedAt))) throw new Error("BUDGET_INVALID");
    id(record.runId); if (runIds.has(record.runId as string)) throw new Error("BUDGET_INVALID"); runIds.add(record.runId as string);
    if (record.kind === "corpus" ? !ids.includes(record.id) : !["journey:PROPOSE_FLOW", "journey:REFINE_FLOW_SELECTION"].includes(record.id)) throw new Error("BUDGET_INVALID");
    if (record.kind === "journey") journeys++;
    seen.add(record.id);
  });
  if (journeys > 2) throw new Error("BUDGET_INVALID");
  return raw as Budget;
}

/** One conservative physical-call reservation. In-place fsync avoids an atomic-rename durability gap; torn writes fail closed. */
function reserve(path: string, record: Omit<Reservation, "slot" | "reservedAt">, syncFile = fsyncSync) {
  const lock = `${path}.lock`;
  const lockFd = openSync(lock, "wx", 0o600); // concurrent/stale lock fails closed; never auto-reclaim a crash
  try {
    const budget = readBudget(path);
    if (budget.reservedCalls >= 26 || budget.records.some(entry => entry.id === record.id || entry.runId === record.runId)) throw new Error("BUDGET_DENIED");
    const next = { ...budget, reservedCalls: budget.reservedCalls + 1, records: [...budget.records, { ...record, slot: budget.reservedCalls + 1, reservedAt: new Date().toISOString() }] };
    // Validate the caller's reservation before persistence. No reservation is ever refunded.
    if (record.model !== MODEL || (record.kind === "corpus" ? !ids.includes(record.id) : !["journey:PROPOSE_FLOW", "journey:REFINE_FLOW_SELECTION"].includes(record.id))) throw new Error("BUDGET_INVALID");
    const fd = openSync(path, "w", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); syncFile(fd); } finally { closeSync(fd); }
  } finally { closeSync(lockFd); unlinkSync(lock); }
}

export function budgetGateway(options: { journal: string; id: string; kind: "corpus" | "journey"; apiKey: string; transport: typeof fetch; syncFile?: typeof fsyncSync; onDenied?: () => void }): ModelGateway {
  return {
    async generate(request, signal) {
      let denied = false;
      const deny = () => { if (!denied) options.onDenied?.(); denied = true; };
      try {
        id(request.runId);
        if (request.model !== MODEL) throw new Error("MODEL_MISMATCH");
        // Reservation sits at the physical fetch boundary, after the adapter's no-call input guard.
        const gateway = createModelGateway({ apiKey: options.apiKey, fetch: async (input, init) => {
          try {
            const target = new URL(input instanceof Request ? input.url : String(input));
            if (target.origin !== "https://generativelanguage.googleapis.com" || target.pathname !== `/v1beta/models/${MODEL}:generateContent`
              || (init?.method ?? (input instanceof Request ? input.method : "GET")) !== "POST") throw new Error("TRANSPORT_TARGET_INVALID");
            reserve(options.journal, { id: options.id, kind: options.kind, runId: request.runId, model: MODEL }, options.syncFile);
          } catch { deny(); throw new Error("EVALUATOR_BUDGET_DENIED"); }
          return options.transport(input, { ...init, redirect: "error" });
        } });
        const reply = await gateway.generate(request, signal);
        return denied ? { kind: "refused" } : reply;
      } catch { deny(); return { kind: "refused" }; }
    },
  };
}

export function assess(item: Pick<EvaluationCase, "capture" | "saved" | "layout">, output: unknown) {
  let schemaFailure: string | null = null, applicationFailure: string | null = null, scopePreserved: boolean | null = null;
  let result: ReturnType<typeof validateResult> | null = null;
  try { result = validateResult(item.capture, output); } catch (error) { schemaFailure = error instanceof ResultError ? error.reason : "INVALID_RESULT"; }
  if (result?.kind === "clarification") scopePreserved = true;
  if (result?.kind === "proposal") {
    try {
      const after = applyProposal({ document: item.saved.document, layout: item.layout }, item.capture, result, result.operations.map(op => op.id), randomUUID);
      const selected = new Set(item.capture.selection?.nodeIds ?? []);
      scopePreserved = Object.values(item.saved.document.nodes).filter(node => !selected.has(node.id)).every(node =>
        canonicalJson(after.document.nodes[node.id]) === canonicalJson(node) && canonicalJson(after.layout.positions[node.id]) === canonicalJson(item.layout.positions[node.id]));
      scopePreserved &&= Object.entries(item.saved.document.flows).every(([id, flow]) => { const next = after.document.flows[id]; return next && Object.entries(flow).filter(([key]) => !["version", "behaviourVersion"].includes(key)).every(([key, value]) => canonicalJson(next[key as keyof typeof next]) === canonicalJson(value)); });
      const incident = new Set(item.capture.taskType === "PROPOSE_FLOW" ? [] : item.capture.graph.edges.map(edge => edge.id));
      scopePreserved &&= Object.entries(item.saved.document.edges).filter(([id]) => !incident.has(id)).every(([id, edge]) => canonicalJson(after.document.edges[id]) === canonicalJson(edge));
    } catch { applicationFailure = "APPLICATION_INVALID"; scopePreserved = false; }
  }
  return { schemaFailure, applicationFailure, scopePreserved, resultKind: result?.kind ?? null,
    humanReview: { status: "not_reviewed", omissions: null, unsupportedClaims: null, correctionEffort: null, useful: null } };
}

function identities() {
  const paths = ["tests/evaluation/cases.json", "tests/evaluation/run.mts", "package.json", "pnpm-lock.yaml", "src/features/proposals/contracts/tasks.ts", "src/features/proposals/domain/capture.ts", "src/features/proposals/domain/model-request.ts", "src/features/proposals/domain/validate-result.ts", "src/features/proposals/domain/proposal-diff.ts", "src/features/proposals/server/applicability.ts", "src/features/proposals/server/adapters/model.ts", "src/features/proposals/server/run-ai.ts"];
  return { model: MODEL, thinking: "provider default; no explicit thinking setting", prompt: PROMPT_VERSION, resultSchema: RESULT_SCHEMA_VERSION,
    packages: Object.fromEntries(["ai", "@ai-sdk/google"].map(name => [name, JSON.parse(readFileSync(resolve(root, `node_modules/${name}/package.json`), "utf8")).version])),
    sourceHashes: Object.fromEntries(paths.map(path => [path, sha256(readFileSync(resolve(root, path), "utf8"))])) };
}
function retain(summary: unknown) {
  mkdirSync(evidenceDir, { recursive: true });
  const path = resolve(evidenceDir, `evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ evidence: path, ...(summary as Record<string, unknown>), results: undefined }, null, 2));
}
function liveEnvironment() {
  if (process.env.AI_MODEL !== MODEL || !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
    || process.env.TRIGGER_SECRET_KEY?.trim() || process.env.TRIGGER_ACCESS_TOKEN?.trim()) throw new Error("LIVE_ENVIRONMENT_INVALID");
  // Confirm the existing authority without changing it. Deterministic runs never read this journal.
  readBudget(journalPath);
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

async function journey(args: string[]) {
  const confirmations = ["--live", "--synthetic", `--model=${MODEL}`, "--target=guarded-loopback"];
  const fields = ["journey", "project", "environment"];
  if (!confirmations.every(arg => args.includes(arg)) || args.length !== 7 || new Set(args).size !== 7
    || args.some(arg => !confirmations.includes(arg) && !fields.some(field => arg.startsWith(`--${field}=`)))) throw new Error("JOURNEY_ARGUMENTS_INVALID");
  const value = (field: string) => id(args.find(arg => arg.startsWith(`--${field}=`))?.slice(field.length + 3));
  const runId = value("journey"), projectId = value("project"), environmentId = value("environment");
  const apiKey = liveEnvironment();
  if (process.env.SCOPEROOM_ENVIRONMENT_ID !== environmentId || !process.env.AI_EXECUTION_BINDING || process.env.AI_EXECUTION_BINDING !== "stage-06.3-local-evaluation") throw new Error("JOURNEY_IDENTITY_INVALID");
  const { localConfig, inspectLocalContainer } = await import("../../scripts/db/guard.mjs");
  const { dbPort, projectId: stackId } = localConfig();
  const target = new URL(process.env.WORKER_DATABASE_URL ?? "");
  if (!/^postgres(ql)?:$/.test(target.protocol) || target.hostname !== "127.0.0.1" || target.port !== dbPort || target.pathname !== "/postgres" || target.username !== "app_worker_runtime") throw new Error("WORKER_TARGET_INVALID");
  inspectLocalContainer(stackId, dbPort);
  const { createDatabase } = await import("../../src/server/db.ts");
  const db = await createDatabase(target.href, environmentId);
  try {
    const [role] = await db.$queryRaw<Array<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`SELECT current_user, session_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role?.current_user !== "app_worker" || role.session_user !== "app_worker_runtime" || role.rolsuper || role.rolbypassrls) throw new Error("WORKER_ROLE_INVALID");
    const [run] = await db.$queryRaw<Array<CaptureRow & { model: string; execution_binding: string; project_id: string; state: string; goal: string; document: unknown; layout: unknown; document_revision: number }>>`
      SELECT run.task_type, run.draft_id, run.expected_document_revision, run.parent_snapshot_id, run.capture, run.capture_hash, run.model, run.execution_binding, run.project_id, run.state, draft.document_json->>'projectGoal' AS goal, draft.document_json AS document, draft.layout_json AS layout, draft.document_revision
      FROM app.ai_run run JOIN app.scope_draft draft ON draft.id = run.draft_id AND draft.project_id = run.project_id WHERE run.id = ${runId}::uuid`;
    const capture = run && validatedCapture(run);
    if (!run || !capture || run.project_id !== projectId || !run.goal.startsWith("Synthetic Stage 06.3") || run.model !== MODEL || capture.versions.model !== MODEL
      || run.execution_binding !== process.env.AI_EXECUTION_BINDING || run.state !== "QUEUED") throw new Error("JOURNEY_CAPTURE_INVALID");
    if (run.document_revision !== capture.documentRevision) throw new Error("JOURNEY_DRAFT_CHANGED");
    const savedPair = parseDraftPair(run.document, run.layout);
    const assessmentInput = { capture, saved: { document: savedPair.document } as SavedContext, layout: savedPair.layout };
    const results: unknown[] = []; let budgetDenied = false;
    const gateway = budgetGateway({ journal: journalPath, id: `journey:${capture.taskType}`, kind: "journey", apiKey, transport: fetch, onDenied: () => { budgetDenied = true; } });
    const observed: ModelGateway = { generate: async (request, signal) => {
      if (request.runId !== runId || request.model !== run.model || canonicalJson(request.context) !== canonicalJson(buildModelRequest({id: runId, model: MODEL, capture}, request.timeoutMs).context)) throw new Error("JOURNEY_REQUEST_INVALID");
      const started = performance.now(); const reply = await gateway.generate(request, signal);
      results.push({ outcome: budgetDenied ? "budget_denied" : reply.kind, latencyMs: Math.round(performance.now() - started), usage: reply.kind === "completed" ? reply.usage : {inputTokens:null,outputTokens:null}, output: reply.kind === "completed" ? reply.output : null, assessment: reply.kind === "completed" ? assess(assessmentInput, reply.output) : null });
      return reply;
    } };
    const { runAi } = await import("../../src/features/proposals/server/run-ai.ts");
    const retryAt = await runAi(runId, observed, db);
    const settled = await db.$queryRaw`SELECT state, failure_code, result, result_hash FROM app.ai_run WHERE id = ${runId}::uuid`;
    const attempts = await db.$queryRaw`SELECT attempt_number, outcome, call_may_have_started, input_tokens, output_tokens FROM app.ai_run_attempt WHERE run_id = ${runId}::uuid ORDER BY attempt_number`;
    retain({ ...identities(), mode: "live-local-journey-worker", runId, projectId, environmentId, executionBinding: run.execution_binding, capture, captureHash: run.capture_hash,
      budgetDenied, retryAt: retryAt ?? null, settled, attempts, results, callsReserved: readBudget(journalPath).reservedCalls, journeyUiApply: "not_verified_by_this_cli", hostedTrigger: "not_qualified", humanReview: "not_reviewed" });
    const terminal = settled as Array<{ state: string; result: {kind: string; operations?: unknown[]} | null }>;
    if (budgetDenied || retryAt || terminal[0]?.state !== "SUCCEEDED" || terminal[0]?.result?.kind !== "proposal" || !terminal[0]?.result?.operations?.length) process.exitCode = 1;
  } finally { await db.$disconnect(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log("Default: deterministic no-network corpus validation. Live corpus requires --live --synthetic --model=gemini-3.8-flash --target=synthetic --only=G01,... --limit=N. Trusted local journey: --live --synthetic --model=gemini-3.8-flash --target=guarded-loopback --journey=UUID --project=UUID --environment=UUID. Shared cumulative physical-call budget is 26; no resets/refunds/retries. Outputs: ignored .tmp/stage-06.3-runtime/evaluation. Human review remains required."); return; }
  if (args.some(arg => arg.startsWith("--journey="))) { await journey(args); return; }
  const selected = selectCases(args);
  const corpus = loadCorpus().filter(item => selected.includes(item.id));
  const live = args.includes("--live"); const apiKey = live ? liveEnvironment() : null;
  const reservedBefore = live ? readBudget(journalPath).reservedCalls : 0;
  const results = [];
  for (const [index, item] of corpus.entries()) {
    if (live && index) await sleep(13_000);
    let budgetDenied = false;
    const request = buildModelRequest({id: randomUUID(), model: MODEL, capture: item.capture}, 120_000);
    const started = performance.now();
    const reply: ModelReply = apiKey ? await budgetGateway({journal: journalPath, id: item.id, kind: "corpus", apiKey, transport: fetch, onDenied: () => {budgetDenied = true;}}).generate(request, AbortSignal.timeout(130_000)) : {kind:"completed", output:item.validationProbe, usage:{inputTokens:null,outputTokens:null}};
    const assessment = reply.kind === "completed" ? assess(item, reply.output) : null;
    results.push({id:item.id, partition:item.partition, captureHash:item.captureHash, capture:item.capture, expected:item.expected, rubric:item.rubric,
      outcome:budgetDenied ? "budget_denied" : live ? reply.kind : "synthetic_validator_probe", latencyMs:live ? Math.round(performance.now()-started) : null,
      estimatedInputTokens:estimateInputTokens(request), usage:reply.kind === "completed" ? reply.usage : {inputTokens:null,outputTokens:null}, assessment,
      output:reply.kind === "completed" ? reply.output : null});
    if (budgetDenied) break;
  }
  const counts = outcomeCounts(results);
  const invalid = results.filter(row => row.assessment?.schemaFailure || row.assessment?.applicationFailure || row.assessment?.scopePreserved === false).length;
  const denied = results.filter(row => row.outcome === "budget_denied").length;
  retain({ ...identities(), mode:live ? "live-synthetic" : "deterministic-no-network", selected, denominator:corpus.length, evaluated:results.length,
    ...counts, deterministicInvalid:invalid, budgetDenied:denied, reservationsThisInvocation:live ? readBudget(journalPath).reservedCalls - reservedBefore : 0, cumulativeReservedCalls:live ? readBudget(journalPath).reservedCalls : 0,
    humanReviewed:0, usefulness:"unscored; human rubric review required", results });
  if (invalid || denied || (live && counts.providerNoncompletion) || results.length !== corpus.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error("Evaluation refused or failed. Check arguments, frozen corpus, trusted environment and durable budget; no authority is reset."); process.exitCode = 2; }
}



export function outcomeCounts(rows: Array<{ outcome: string; assessment: ReturnType<typeof assess> | null }>) {
  const valid = rows.filter(row => row.assessment && !row.assessment.schemaFailure && !row.assessment.applicationFailure && row.assessment.scopePreserved === true);
  return {
    providerNoncompletion: rows.filter(row => !["completed", "synthetic_validator_probe", "budget_denied"].includes(row.outcome)).length,
    schemaFailures: rows.filter(row => row.assessment?.schemaFailure).length,
    applicationFailures: rows.filter(row => row.assessment?.applicationFailure).length,
    scopePreservationFailures: rows.filter(row => row.assessment?.scopePreserved === false).length,
    validatedProposals: valid.filter(row => row.assessment?.resultKind === "proposal").length,
    validatedClarifications: valid.filter(row => row.assessment?.resultKind === "clarification").length,
  };
}
