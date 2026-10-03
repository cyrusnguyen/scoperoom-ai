import { Prisma } from "../../../../prisma/generated/client.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { readAsMember, type ProjectRow, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { AI_LIMITS, type CapturedInput, type RunApplicability, type RunPage, type RunState, type RunDisposition, type RunSummary, type RunUsage, type RunView, type TaskKind, type ValidatedProposal } from "../contracts/tasks.ts";
import { settleOverdueRuns } from "./settle-runs.ts";

const BODY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type RunRow = {
  id: string; task_type: TaskKind; state: RunState; disposition: RunDisposition | null; actor_id: string; flow_id: string | null; created_at: Date; created_cursor: string;
  deadline_at: Date; terminal_at: Date | null; cancel_requested_at: Date | null; failure_code: string | null; last_event_sequence: bigint;
  attempts: number; input_known: number; input_tokens: bigint | null; output_known: number; output_tokens: bigint | null;
};
type DetailRow = RunRow & {
  draft_id: string; expected_document_revision: number; parent_snapshot_id: string | null; model: string; capture: CapturedInput | null; result: ValidatedProposal | null;
  result_hash: string | null; current_revision: number | null;
};

/** Summary columns only (no capture, result or prompt), plus the attempt token totals. Tokens, leases and provider ids are never selected. */
const summaryColumns = Prisma.sql`
  run.id, run.task_type::text AS task_type, run.state::text AS state, run.disposition::text AS disposition, run.actor_id, run.capture #>> '{selection,flowId}' AS flow_id,
  run.created_at, to_char(run.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor, run.deadline_at, run.terminal_at, run.cancel_requested_at,
  run.failure_code, run.last_event_sequence, usage.attempts, usage.input_known, usage.input_tokens, usage.output_known, usage.output_tokens`;
const usageJoin = Prisma.sql`
  LEFT JOIN LATERAL (SELECT count(*)::integer AS attempts, count(input_tokens)::integer AS input_known, sum(input_tokens)::bigint AS input_tokens,
    count(output_tokens)::integer AS output_known, sum(output_tokens)::bigint AS output_tokens FROM app.ai_run_attempt WHERE run_id = run.id) usage ON true`;

/** Known only when every attempt reported it: an unreported or unknown attempt keeps the total null instead of a partial sum. */
function usageOf(row: RunRow): RunUsage {
  const total = (known: number, sum: bigint | null) => (row.attempts > 0 && known === row.attempts ? Number(sum) : null);
  return { inputTokens: total(row.input_known, row.input_tokens), outputTokens: total(row.output_known, row.output_tokens) };
}

function summaryOf(row: RunRow): RunSummary {
  return {
    id: row.id, taskType: row.task_type, state: row.state, disposition: row.disposition, actorId: row.actor_id, flowId: row.flow_id, createdAt: row.created_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(), terminalAt: row.terminal_at?.toISOString() ?? null, cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    failureCode: row.failure_code, usage: usageOf(row), lastEventSequence: Number(row.last_event_sequence),
  };
}

/** Derived, never a competing state: nothing to apply, or the captured draft, revision or baseline has moved on. */
function applicabilityOf(row: DetailRow, project: ProjectRow): RunApplicability {
  if (row.state !== "SUCCEEDED" || row.disposition !== "AVAILABLE" || row.cancel_requested_at || row.result?.kind !== "proposal" || project.status !== "ACTIVE") return "UNAVAILABLE";
  return project.currentDraftId !== row.draft_id || row.current_revision !== row.expected_document_revision || project.approvedSnapshotId !== row.parent_snapshot_id ? "STALE" : "APPLICABLE";
}

function decodeCursor(cursor: string): [string, string] {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new Error();
    const [time, id, ...rest] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof time !== "string" || typeof id !== "string" || rest.length || !CURSOR_TIME.test(time) || Number.isNaN(Date.parse(`${time.slice(0, 23)}Z`)) || !uuid.test(id)) throw new Error();
    return [time, id.toLowerCase()];
  } catch {
    throw new ProjectError("INVALID_INPUT");
  }
}

/** Authorized, nonmutating read of one run. Overdue work is settled first, in its own bounded write, never inside the snapshot. */
export async function readRun(identity: ProjectIdentity, projectId: string, runId: string): Promise<RunView> {
  if (!uuid.test(runId)) throw new ProjectError("NOT_FOUND");
  return readAsMember(identity, projectId, async (tx, project) => {
    const [row] = await tx.$queryRaw<DetailRow[]>`
      SELECT ${summaryColumns}, run.draft_id, run.expected_document_revision, run.parent_snapshot_id, run.model, run.capture, run.result, run.result_hash, draft.document_revision AS current_revision
      FROM app.ai_run run ${usageJoin} LEFT JOIN app.scope_draft draft ON draft.id = run.draft_id AND draft.project_id = run.project_id
      WHERE run.id = ${runId}::uuid AND run.project_id = ${project.id}::uuid`;
    if (!row) throw new ProjectError("NOT_FOUND");
    const attempts = await tx.aiRunAttempt.findMany({
      where: { runId: row.id }, orderBy: { attemptNumber: "asc" },
      select: { attemptNumber: true, outcome: true, callMayHaveStarted: true, startedAt: true, inputTokens: true, outputTokens: true },
    });
    const bodiesLive = (row.capture !== null || row.result !== null) && row.disposition !== "APPLIED";
    return {
      ...summaryOf(row), draftId: row.draft_id, documentRevision: row.expected_document_revision, parentSnapshotId: row.parent_snapshot_id, model: row.model,
      capture: row.capture, result: row.result, resultHash: row.result_hash,
      attempts: attempts.map((attempt) => ({
        number: attempt.attemptNumber, outcome: attempt.outcome, callMayHaveStarted: attempt.callMayHaveStarted, startedAt: attempt.startedAt.toISOString(),
        usage: { inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens },
      })),
      applicability: applicabilityOf(row, project), expiresAt: row.terminal_at && bodiesLive ? new Date(row.terminal_at.getTime() + BODY_RETENTION_MS).toISOString() : null,
    };
  }, settleOverdueRuns);
}

/** Up to 50 summaries, newest first, with an opaque cursor over the exact (createdAt, id) order. Summaries carry no prompt or capture body. */
export async function listRuns(identity: ProjectIdentity, projectId: string, options: { cursor?: string; flowId?: string }): Promise<RunPage> {
  if (options.flowId !== undefined && !uuid.test(options.flowId)) throw new ProjectError("INVALID_INPUT");
  const position = options.cursor === undefined ? null : decodeCursor(options.cursor);
  return readAsMember(identity, projectId, async (tx: Transaction, project) => {
    const rows = await tx.$queryRaw<RunRow[]>`
      SELECT ${summaryColumns} FROM app.ai_run run ${usageJoin}
      WHERE run.project_id = ${project.id}::uuid
        ${options.flowId ? Prisma.sql`AND run.capture #>> '{selection,flowId}' = ${options.flowId.toLowerCase()}` : Prisma.empty}
        ${position ? Prisma.sql`AND (run.created_at, run.id) < (${position[0]}::timestamptz, ${position[1]}::uuid)` : Prisma.empty}
      ORDER BY run.created_at DESC, run.id DESC LIMIT ${AI_LIMITS.runPageSize + 1}`;
    const page = rows.slice(0, AI_LIMITS.runPageSize);
    const last = page.at(-1);
    return {
      runs: page.map(summaryOf),
      nextCursor: rows.length > page.length && last ? Buffer.from(JSON.stringify([last.created_cursor, last.id])).toString("base64url") : null,
    };
  }, settleOverdueRuns);
}
