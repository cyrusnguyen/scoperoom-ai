import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { asJson } from "../../drafts/server/execute-command.ts";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import {
  checkReceipt, entitlementActive, findReceipt, lockActor, lockProject, profileFor, recordEvent, requestHash, requireActive, requireMember, saveReceipt,
  withDatabase, type ProjectRow, type Transaction,
} from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { assertSourceCapacity, insertPromptEvidence } from "../../sources/server/source-versions.ts";
import { AI_LIMITS, parseStartRunInput, startBody, startBodyBytes, type StartRunInput, type TaskKind } from "../contracts/tasks.ts";
import { evidenceStats } from "../domain/capture.ts";
import { captureSaved } from "./capture.ts";
import { settleOverdueRuns } from "./settle-runs.ts";

const START_OPERATION = "AI_RUN_START_V1";
const RATE_ACTION = "AI_ADMISSION";

/** What the run captured, without any prompt or source text: enough to recover the durable identity of the exact input. */
export type RunManifest = { taskType: TaskKind; draftId: string; documentRevision: number; parentSnapshotId: string | null; sourceVersionIds: string[]; captureHash: string };
export type AdmitResult = { runId: string; state: "QUEUED"; aiRevision: number; replayed: boolean; manifest: RunManifest };
/** Content-independent execution configuration, resolved before any lock. The binding is opaque and carries no credential. */
export type AiConfiguration = { model: string; executionBinding: string };

export function aiConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env): AiConfiguration {
  const { AI_MODEL: model, AI_EXECUTION_BINDING: executionBinding } = env;
  const valid = (value: string | undefined): value is string => Boolean(value) && value!.length <= 200 && /^[\x21-\x7e]+$/.test(value!);
  if (!valid(model) || !valid(executionBinding)) throw new ProjectError("UNAVAILABLE");
  return { model, executionBinding };
}

/** Keyed server-side by the database environment id, so a bucket row names neither the profile id, an email, nor a bare hash of either. */
export function admissionSubject(profileId: string, key = process.env.SCOPEROOM_ENVIRONMENT_ID): string {
  if (!key) throw new ProjectError("UNAVAILABLE");
  return createHmac("sha256", key).update(`${RATE_ACTION}:${profileId}`).digest("hex");
}

/** One fixed-minute counter per actor. Called after receipt recovery; a full bucket refuses without incrementing. */
async function countAttempt(tx: Transaction, profileId: string) {
  const rows = await tx.$queryRaw<Array<{ count: number }>>`
    INSERT INTO app.rate_limit_bucket (subject_hash, action, window_start, count, expires_at)
    SELECT ${admissionSubject(profileId)}, ${RATE_ACTION}, minute.start, 1, minute.start + INTERVAL '10 minutes' FROM (SELECT date_trunc('minute', clock_timestamp()) AS start) minute
    ON CONFLICT (subject_hash, action, window_start) DO UPDATE SET count = rate_limit_bucket.count + 1 WHERE rate_limit_bucket.count < ${AI_LIMITS.admissionAttemptsPerMinute}
    RETURNING count`;
  if (!rows.length) throw new ProjectError("RATE_LIMITED");
  // Bounded self-pruning keeps the table small without a scheduler.
  await tx.$executeRaw`
    DELETE FROM app.rate_limit_bucket WHERE (subject_hash, action, window_start) IN (
      SELECT subject_hash, action, window_start FROM app.rate_limit_bucket WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 20 FOR UPDATE SKIP LOCKED)`;
}

/** Built from the stored run for both the first response and a replay, so the two always agree. */
async function manifestOf(tx: Transaction, projectId: string, runId: string): Promise<RunManifest> {
  const [row] = await tx.$queryRaw<Array<{ task_type: TaskKind; draft_id: string; expected_document_revision: number; parent_snapshot_id: string | null; capture_hash: string; source_ids: string[] | null }>>`
    SELECT task_type::text AS task_type, draft_id, expected_document_revision, parent_snapshot_id, capture_hash, jsonb_path_query_array(capture, '$.sources[*].sourceVersionId') AS source_ids
    FROM app.ai_run WHERE id = ${runId}::uuid AND project_id = ${projectId}::uuid`;
  if (!row) throw new ProjectError("UNAVAILABLE");
  return { taskType: row.task_type, draftId: row.draft_id, documentRevision: row.expected_document_revision, parentSnapshotId: row.parent_snapshot_id, sourceVersionIds: row.source_ids ?? [], captureHash: row.capture_hash };
}

function replayOf(result: Prisma.JsonValue): Pick<AdmitResult, "runId" | "state" | "aiRevision"> {
  const record = result && typeof result === "object" && !Array.isArray(result) ? result : null;
  if (!record || typeof record.runId !== "string" || record.state !== "QUEUED" || typeof record.aiRevision !== "number") throw new ProjectError("UNAVAILABLE");
  return { runId: record.runId, state: "QUEUED", aiRevision: record.aiRevision };
}

/**
 * Everything after the limiter, still under the actor and project locks. Lock order continues: draft, source children, then the
 * owner allowance and the owner/day budget last. A refusal here is rolled back to a savepoint by the caller, so no write survives it.
 */
async function admitLocked(tx: Transaction, project: ProjectRow, actorId: string, input: StartRunInput, hash: string, configuration: AiConfiguration) {
  const { capture, hash: captureHash } = await captureSaved(tx, project, input, configuration.model);
  const prompt = evidenceStats(capture.prompt);
  await assertSourceCapacity(tx, project.id, prompt.codePointCount);
  const [slots] = await tx.$queryRaw<Array<{ active: number; applicable: number }>>`
    SELECT count(*) FILTER (WHERE state IN ('QUEUED', 'RUNNING', 'VALIDATING'))::integer AS active, count(*) FILTER (WHERE state = 'SUCCEEDED' AND disposition = 'AVAILABLE')::integer AS applicable
    FROM app.ai_run WHERE project_id = ${project.id}::uuid`;
  if (!slots || slots.active > 0) throw new ProjectError("AI_BUSY", { scope: "PROJECT" });
  if (slots.applicable >= AI_LIMITS.applicableResults) throw new ProjectError("LIMIT_EXCEEDED", { limit: "APPLICABLE_PROPOSALS" });

  // The owner allowance serializes admission across the owner's projects; its count is read afterwards, in a fresh statement.
  await tx.$executeRaw`INSERT INTO app.ai_owner_allowance (owner_id) VALUES (${project.ownerId}::uuid) ON CONFLICT DO NOTHING`;
  await tx.$queryRaw`SELECT owner_id FROM app.ai_owner_allowance WHERE owner_id = ${project.ownerId}::uuid FOR UPDATE`;
  const [owner] = await tx.$queryRaw<Array<{ active: number }>>`SELECT count(*)::integer AS active FROM app.ai_run WHERE owner_id = ${project.ownerId}::uuid AND state IN ('QUEUED', 'RUNNING', 'VALIDATING') AND deadline_at > transaction_timestamp()`;
  if (!owner || owner.active >= AI_LIMITS.ownerConcurrentRuns) throw new ProjectError("AI_BUSY", { scope: "OWNER" });
  const [clock] = await tx.$queryRaw<Array<{ now: Date; day: string }>>`SELECT transaction_timestamp() AS now, ((transaction_timestamp() AT TIME ZONE 'UTC')::date)::text AS day`;
  if (!clock) throw new ProjectError("UNAVAILABLE");
  const reserved = await tx.$queryRaw<Array<{ reserved_runs: number }>>`
    INSERT INTO app.ai_budget_day (owner_id, day, reserved_runs) VALUES (${project.ownerId}::uuid, ${clock.day}::date, 1)
    ON CONFLICT (owner_id, day) DO UPDATE SET reserved_runs = ai_budget_day.reserved_runs + 1
    WHERE ai_budget_day.reserved_runs + ai_budget_day.consumed_runs < ${AI_LIMITS.ownerDailyRuns}
    RETURNING reserved_runs`;
  if (!reserved.length) throw new ProjectError("AI_BUDGET_EXCEEDED");
  // Read last, after every wait: a revocation committed while this admission queued is seen. The provider claim rechecks authority again.
  const entitlement = await tx.pilotEntitlement.findUnique({ where: { profileId: project.ownerId } });
  if (!entitlementActive(entitlement)) throw new ProjectError("ENTITLEMENT_REQUIRED");

  const promptVersionId = await insertPromptEvidence(tx, project.id, actorId, prompt);
  const runId = randomUUID();
  // The insert trigger pins created_at, the UTC admission day and the 300 second deadline to this transaction's clock.
  await tx.aiRun.create({
    data: {
      id: runId, projectId: project.id, draftId: capture.draftId, actorId, ownerId: project.ownerId, admissionDay: new Date(`${clock.day}T00:00:00Z`), promptSourceVersionId: promptVersionId,
      taskType: capture.taskType, model: configuration.model, executionBinding: configuration.executionBinding, capture: asJson(capture), captureHash,
      expectedDocumentRevision: capture.documentRevision, parentSnapshotId: capture.parentSnapshotId, deadlineAt: new Date(clock.now.getTime() + 300_000), createdAt: clock.now,
    },
    select: { id: true },
  });
  const sequence = await recordEvent(tx, project, actorId, "AI_RUN_ADMITTED", [{ kind: "AI_RUN", id: runId }, { kind: "DRAFT", id: capture.draftId }],
    { taskType: capture.taskType, draftId: capture.draftId, documentRevision: capture.documentRevision, sourceCount: capture.sources.length, model: configuration.model });
  await tx.$executeRaw`UPDATE app.project SET ai_revision = ${sequence}::bigint WHERE id = ${project.id}::uuid`;
  await tx.$executeRaw`UPDATE app.ai_run SET last_event_sequence = ${sequence}::bigint WHERE id = ${runId}::uuid`;
  const result = { runId, state: "QUEUED" as const, aiRevision: Number(sequence) };
  await saveReceipt(tx, actorId, "PROJECT", project.id, input.key, START_OPERATION, hash, result);
  return { ...result, replayed: false, manifest: await manifestOf(tx, project.id, runId) };
}

/**
 * One short admission transaction (Data 04): actor, project, current access, receipt replay, capability, the actor's attempt counter,
 * then the locked capture, capacity, owner allowance and owner/day reservation. No model, tokenizer or network call runs inside it.
 */
export async function admitRun(identity: ProjectIdentity, projectId: string, input: StartRunInput, configuration: AiConfiguration = aiConfiguration()): Promise<AdmitResult> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase();
  if (!keyPattern.test(input.key)) throw new ProjectError("INVALID_INPUT");
  if (startBodyBytes(input) > AI_LIMITS.startBodyBytes) throw new ProjectError("LIMIT_EXCEEDED", { limit: "START_BODY_BYTES" });
  const hash = requestHash(START_OPERATION, { projectId, body: startBody(input) });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    const outcome = await database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId, true);
      let project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, input.key);
      if (receipt) {
        checkReceipt(receipt, START_OPERATION, hash);
        const replayed = replayOf(receipt.result);
        return { result: { ...replayed, replayed: true, manifest: await manifestOf(tx, project.id, replayed.runId) } };
      }
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      await countAttempt(tx, profile.id);
      // An overdue run on this project is settled under the locks already held; settlement advances the event sequence, so reread it.
      if (await settleOverdueRuns(tx, profile.id, project.id)) project = await lockProject(tx, profile.id, projectId);
      // A refusal after this point still commits the attempt count but nothing else.
      await tx.$executeRaw`SAVEPOINT ai_admission`;
      try {
        return { result: await admitLocked(tx, project, profile.id, input, hash, configuration) };
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT ai_admission`;
        return { refusal: error };
      }
    });
    if ("refusal" in outcome) throw outcome.refusal;
    return outcome.result;
  });
}

/** The HTTP entry: parses the strict body (the parser's size refusal is LIMIT_EXCEEDED on START_BODY_BYTES, every other failure INVALID_INPUT), then admits. */
export async function startRun(identity: ProjectIdentity, projectId: string, input: Record<string, unknown>): Promise<AdmitResult> {
  const { key, ...body } = input;
  let parsed: StartRunInput;
  try {
    parsed = parseStartRunInput(body, typeof key === "string" ? key : "");
  } catch (error) {
    throw error instanceof Error && error.message === "LIMIT_EXCEEDED" && error.cause === "START_BODY_BYTES"
      ? new ProjectError("LIMIT_EXCEEDED", { limit: "START_BODY_BYTES" }) : new ProjectError("INVALID_INPUT");
  }
  return admitRun(identity, projectId, parsed);
}
