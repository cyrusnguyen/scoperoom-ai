import { setTimeout as sleep } from "node:timers/promises";
import { getWorkerDatabase } from "../../../server/db.ts";
import { PROMPT_VERSION, type CapturedInput, type ValidatedProposal } from "../contracts/tasks.ts";
import { canonicalJson, sha256 } from "../domain/capture.ts";
import { buildModelRequest, estimateInputTokens } from "../domain/model-request.ts";
import { proposalDiff } from "../domain/proposal-diff.ts";
import { validateResult } from "../domain/validate-result.ts";
import type { Sql } from "./dispatch-ai.ts";
import type { ModelGateway, ModelReply } from "./ports.ts";

const ATTEMPT_MS = 120_000;
type Terminal = "FAILED" | "CANCELLED" | "TIMED_OUT";
type Outcome = "COMPLETED" | "REFUSED" | "INCOMPLETE" | "UNAVAILABLE" | "UNKNOWN" | "TIMED_OUT" | "CANCELLED";
type Claim = { out_status: string; out_attempt_id: string | null; out_attempt_token: string | null; out_attempt_deadline_at: Date | null };

export async function finishRun(db: Sql, runId: string, state: Terminal, code: string | null): Promise<string | undefined> {
  const [row] = await db.$queryRaw<Array<{ status: string }>>`SELECT app.finish_ai_run(${runId}::uuid, ${state}::text::app.ai_run_state, ${code}::text) AS status`;
  return row?.status;
}

/** After an attempt is reported, ends the run by what is true now: cancel intent wins, then the passed deadline, else the given safe code. */
async function closeOut(db: Sql, runId: string, code: string) {
  const [row] = await db.$queryRaw<Array<{ cancelled: boolean; overdue: boolean; terminal: boolean }>>`
    SELECT cancel_requested_at IS NOT NULL AS cancelled, clock_timestamp() >= deadline_at AS overdue, terminal_at IS NOT NULL AS terminal FROM app.ai_run WHERE id = ${runId}::uuid`;
  if (!row || row.terminal) return;
  if (row.cancelled) await finishRun(db, runId, "CANCELLED", null);
  else if (row.overdue) await finishRun(db, runId, "TIMED_OUT", null);
  else await finishRun(db, runId, "FAILED", code);
}

/** A reply refused by the fence is recorded by its actual cause: cancellation, a closed attempt window, or lost authority (UNKNOWN: the call ran, its output is discarded). */
async function fencedOutcome(db: Sql, runId: string, windowEnd: Date): Promise<Outcome> {
  const [row] = await db.$queryRaw<Array<{ cancelled: boolean; closed: boolean }>>`
    SELECT cancel_requested_at IS NOT NULL AS cancelled, clock_timestamp() >= ${windowEnd}::timestamptz AS closed FROM app.ai_run WHERE id = ${runId}::uuid`;
  return row?.cancelled ? "CANCELLED" : row?.closed ? "TIMED_OUT" : "UNKNOWN";
}

type Attempt = { runId: string; id: string; token: string };
async function settle(db: Sql, attempt: Attempt, outcome: Outcome, result: ValidatedProposal | null, reply: ModelReply | null): Promise<string | undefined> {
  const usage = reply?.kind === "completed" ? reply.usage : { inputTokens: null, outputTokens: null };
  const [row] = await db.$queryRaw<Array<{ status: string }>>`
    SELECT app.settle_ai_attempt(${attempt.runId}::uuid, ${attempt.id}::uuid, ${attempt.token}::uuid, ${outcome}::text::app.ai_attempt_outcome,
      ${result ? JSON.stringify(result) : null}::text::jsonb, ${result ? sha256(canonicalJson(result)) : null}::text,
      ${usage.inputTokens}::integer, ${usage.outputTokens}::integer, ${reply?.requestId ?? null}::text) AS status`;
  return row?.status;
}

const OUTCOME = { refused: "REFUSED", incomplete: "INCOMPLETE", unavailable: "UNAVAILABLE", unknown: "UNKNOWN" } as const;
const GIVE_UP = { refused: "MODEL_REFUSED", incomplete: "MODEL_INCOMPLETE", unavailable: "MODEL_UNAVAILABLE", unknown: "MODEL_UNKNOWN" } as const;

/**
 * Executes one run from a task delivery (Data 04): at most two provider calls, each only after its own fresh SQL claim. A delivery,
 * retry or duplicate worker can never grant a call: BUSY, terminal and ceiling answers come from the database, and a claimed attempt is
 * never repeated (a lost process leaves it consumed; a retry waits for its window and then needs a new claim). The provider runs
 * outside every lock; the reply is validated before the only writer of a result, which itself requires the current attempt token.
 */
export async function runAi(runId: string, gateway: ModelGateway, db?: Sql): Promise<Date | void> {
  const sql = db ?? await getWorkerDatabase();
  for (let call = 1; call <= 2; call += 1) {
    const [run] = await sql.$queryRaw<Array<{ model: string; capture: CapturedInput | null; terminal: boolean }>>`
      SELECT model, capture, terminal_at IS NOT NULL AS terminal FROM app.ai_run WHERE id = ${runId}::uuid`;
    if (!run || run.terminal || !run.capture) return;
    // Only this build's prompt is available: another captured version would be sent with rules its record does not name, and a retry could mix prompts. Fail before any claim, so the reservation is released.
    if (run.capture.versions.prompt !== PROMPT_VERSION) { await finishRun(sql, runId, "FAILED", "PROMPT_VERSION_UNSUPPORTED"); return; }
    const request = buildModelRequest({ id: runId, model: run.model, capture: run.capture }, ATTEMPT_MS);
    // Too large for the configured ceiling: fail before any claim, so the reservation is released, not consumed.
    if (estimateInputTokens(request) > request.maxInputTokens) { await finishRun(sql, runId, "FAILED", "INPUT_TOO_LARGE"); return; }

    const [claim] = await sql.$queryRaw<Claim[]>`
      SELECT out_status, out_attempt_id, out_attempt_token, out_attempt_deadline_at FROM app.claim_ai_attempt(${runId}::uuid)`;
    if (claim?.out_status === "CANCELLED") { await finishRun(sql, runId, "CANCELLED", null); return; }
    if (claim?.out_status === "DEADLINE") { await finishRun(sql, runId, "TIMED_OUT", null); return; }
    if (claim?.out_status === "DENIED") { await finishRun(sql, runId, "FAILED", "ACCESS_REVOKED"); return; }
    if (claim?.out_status === "CEILING") { await finishRun(sql, runId, "FAILED", "ATTEMPTS_EXHAUSTED"); return; }
    if (claim?.out_status === "BUSY") {
      // A retry can arrive before its crashed predecessor's call window closes. Keep the delivery alive: the Trigger handler waits
      // durably until this SQL-owned window ends, then re-enters for a fresh claim. Returning success here would abandon the run.
      const [window] = await sql.$queryRaw<Array<{ retry_at: Date }>>`
        SELECT LEAST(COALESCE(attempt.deadline_at, run.deadline_at), run.deadline_at) AS retry_at
        FROM app.ai_run run LEFT JOIN app.ai_run_attempt attempt ON attempt.id = run.current_attempt_id
        WHERE run.id = ${runId}::uuid AND run.terminal_at IS NULL`;
      return window ? new Date(window.retry_at.getTime() + 1) : undefined;
    }
    if (claim?.out_status !== "CLAIMED" || !claim.out_attempt_id || !claim.out_attempt_token || !claim.out_attempt_deadline_at) return; // TERMINAL, MISSING
    const attempt: Attempt = { runId, id: claim.out_attempt_id, token: claim.out_attempt_token };

    // min(120 s, time left in the attempt window, which the claim already capped at the 300 s run deadline); never call without time.
    const timeoutMs = Math.min(ATTEMPT_MS, claim.out_attempt_deadline_at.getTime() - Date.now());
    let reply: ModelReply = { kind: "unknown" };
    let timedOut = timeoutMs <= 0;
    if (!timedOut) {
      const signal = AbortSignal.timeout(timeoutMs);
      try { reply = await gateway.generate({ ...request, timeoutMs }, signal); } catch { reply = { kind: "unknown" }; } // never refunds, never logs
      timedOut = signal.aborted && reply.kind !== "completed";
    }

    if (reply.kind === "completed") {
      const begun = (await sql.$queryRaw<Array<{ status: string }>>`
        SELECT app.begin_ai_validation(${attempt.runId}::uuid, ${attempt.id}::uuid, ${attempt.token}::uuid) AS status`)[0]?.status;
      if (begun === "STALE") return;
      let result: ValidatedProposal | null = null;
      if (begun === "VALIDATING") {
        try {
          result = validateResult(run.capture, reply.output);
          if (result.kind === "proposal") proposalDiff(run.capture, result, result.operations.map(operation => operation.id));
        } catch { result = null; }
      }
      const status = await settle(sql, attempt, result ? "COMPLETED" : begun === "FENCED" ? await fencedOutcome(sql, runId, claim.out_attempt_deadline_at) : "INCOMPLETE", result, reply);
      if (status === "SUCCEEDED" || status === "STALE") return;
      await closeOut(sql, runId, begun === "FENCED" || status === "FENCED" ? "RESULT_FENCED" : "RESULT_INVALID");
      return;
    }

    const status = await settle(sql, attempt, timedOut ? "TIMED_OUT" : OUTCOME[reply.kind], null, reply);
    if (status === "STALE") return;
    if (reply.kind === "refused" || reply.kind === "incomplete" || call === 2) { await closeOut(sql, runId, GIVE_UP[reply.kind]); return; }
    await sleep(Math.min(reply.retryAfterMs ?? 0, 10_000)); // the next call, if any, needs its own SQL claim and still honours the deadline
  }
}
