import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { emptyDraft } from "../../../src/features/drafts/contracts/scope-document.ts";
import { parseStartRunInput } from "../../../src/features/proposals/contracts/tasks.ts";
import { canonicalJson, captureInput, sha256, type SavedSource } from "../../../src/features/proposals/domain/capture.ts";
import { admissionSubject } from "../../../src/features/proposals/server/admit-run.ts";
import { withFixture, type Fixture, type Identity } from "./fixture.ts";

export type Person = { identity: Identity; profile: string };
export type AiEnv = Fixture & { person: (label?: string) => Promise<Person>; projectFor: (owner: Person) => Promise<string> };

/** The shared fixture plus profile tracking, so rate-limit rows written by real admissions are removed with their subjects. */
export async function withAi(run: (env: AiEnv) => Promise<void>) {
  await withFixture(async (fixture) => {
    const profiles: string[] = [];
    const person = async (label?: string): Promise<Person> => {
      const identity = await fixture.user(label);
      const profile = await fixture.profileId(identity);
      profiles.push(profile);
      return { identity, profile };
    };
    try {
      await run({ ...fixture, person, projectFor: (owner) => fixture.project(owner.identity) });
    } finally {
      await fixture.database.query("delete from app.rate_limit_bucket where subject_hash = any($1::text[])", [profiles.map((profile) => admissionSubject(profile))]);
    }
  });
}

export async function draftOf(db: Client, projectId: string) {
  const { rows: [row] } = await db.query<{ id: string; revision: number }>("select d.id, d.document_revision revision from app.project p join app.scope_draft d on d.id = p.current_draft_id where p.id = $1", [projectId]);
  return row!;
}

export type SeedOptions = {
  projectId: string; owner: string; actor?: string; createdAt?: Date; id?: string; prompt?: string; flowId?: string;
  sources?: SavedSource[]; result?: object;
  /** A real Improve capture built from the current saved graph, for reviewed application tests. */
  selection?: { flowId: string; nodeIds: string[] };
  /** Bulk history rows that must not move the owner/day counters (a day holds at most 30). */
  uncounted?: boolean;
  /** QUEUED (default, reserved), RUNNING with a claimed and unreported attempt (consumed), or a settled terminal FAILED run. */
  shape?: "QUEUED" | "RUNNING" | "FAILED" | "SUCCEEDED";
};

/** One run written by the owner/bootstrap connection with the budget counters it would have: reserved, or consumed once claimed. */
export async function seedRun(db: Client, options: SeedOptions) {
  const actor = options.actor ?? options.owner;
  const createdAt = options.createdAt ?? new Date();
  const shape = options.shape ?? "QUEUED";
  const draft = await draftOf(db, options.projectId);
  const prompt = options.prompt ?? "seeded instruction";
  const sources = options.sources ?? [];
  const { rows: [saved] } = await db.query("select d.document_json, p.approved_snapshot_id from app.scope_draft d join app.project p on p.id = d.project_id where d.id = $1", [draft.id]);
  const parentSnapshotId = saved.approved_snapshot_id;
  const input = parseStartRunInput({ taskType: options.selection ? "REFINE_FLOW_SELECTION" : "PROPOSE_FLOW", prompt, draftId: draft.id, expectedDocumentRevision: draft.revision, expectedParentSnapshotId: parentSnapshotId, context: { selection: options.selection ?? null, sources: sources.map((source) => ({ sourceVersionId: source.sourceVersionId, expectedCurrentVersionId: source.currentVersionId })) } }, randomUUID());
  // Schema-only fixtures intentionally store {}; feature fixtures have a complete saved document.
  const document = saved.document_json.schemaVersion === 3 ? saved.document_json : emptyDraft().document;
  const { capture, hash } = captureInput({ projectId: options.projectId, draftId: draft.id, documentRevision: draft.revision, parentSnapshotId, document, sources, model: "seed-model" }, input);
  const stored = options.flowId ? { ...capture, taskType: "REFINE_FLOW_SELECTION", selection: { flowId: options.flowId, nodeIds: [randomUUID()] } } : capture;
  const versionId = randomUUID(); const sourceId = randomUUID();
  await db.query("begin");
  await db.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'AI_PROMPT', $3, $4)", [sourceId, options.projectId, versionId, actor]);
  await db.query(
    `insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
     values ($1, $2, $3, 1, 'AI instruction', $4, char_length($4), octet_length($4), $5, $6)`, [versionId, options.projectId, sourceId, capture.prompt, capture.promptHash, actor]);
  await db.query("commit");
  await db.query("insert into app.ai_owner_allowance (owner_id) values ($1) on conflict do nothing", [options.owner]);
  const reserved = shape === "QUEUED" && !options.uncounted ? 1 : 0; const consumed = shape !== "QUEUED" && !options.uncounted ? 1 : 0;
  await db.query(
    `insert into app.ai_budget_day (owner_id, day, reserved_runs, consumed_runs) values ($1, ($2::timestamptz at time zone 'UTC')::date, $3, $4)
     on conflict (owner_id, day) do update set reserved_runs = ai_budget_day.reserved_runs + $3, consumed_runs = ai_budget_day.consumed_runs + $4`, [options.owner, createdAt, reserved, consumed]);
  const { rows: [run] } = await db.query<{ id: string }>(
    `insert into app.ai_run (id, project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, parent_snapshot_id, deadline_at, created_at)
     values ($12, $1, $2, $3, $4, ($5::timestamptz at time zone 'UTC')::date, $6, $9::text::app.ai_task_kind, 'seed-model', 'seed-binding', $7::jsonb, $8, $10, $11, $5::timestamptz + interval '300 seconds', $5) returning id`,
    [options.projectId, draft.id, actor, options.owner, createdAt, versionId, JSON.stringify(stored), hash, stored.taskType, draft.revision, parentSnapshotId, options.id ?? randomUUID()]);
  const runId = run!.id;
  if (shape === "RUNNING") {
    const { rows: [attempt] } = await db.query<{ id: string }>(
      "insert into app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started) values ($1, 1, $2::timestamptz + interval '5 seconds', $2::timestamptz + interval '125 seconds', true) returning id", [runId, createdAt]);
    await db.query("update app.ai_run set state = 'RUNNING', current_attempt_id = $2, budget_state = 'CONSUMED' where id = $1", [runId, attempt!.id]);
  }
  if (shape === "FAILED") await db.query("update app.ai_run set state = 'FAILED', failure_code = 'TEST_FAILURE', terminal_at = $2, budget_state = 'CONSUMED' where id = $1", [runId, createdAt]);
  if (shape === "SUCCEEDED") {
    const result = options.result ?? { schemaVersion: 1, kind: "clarification", message: "need more" };
    await db.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [runId]);
    await db.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', result = $2::jsonb, result_hash = $3, terminal_at = $4 where id = $1", [runId, JSON.stringify(result), sha256(canonicalJson(result)), createdAt]);
  }
  return runId;
}
