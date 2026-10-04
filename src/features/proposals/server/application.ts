import { Prisma } from "../../../../prisma/generated/client.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { checkReceipt, findReceipt, lockActor, lockProject, profileFor, requireActive, requireMember, saveReceipt, withDatabase, type ProjectRow, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import type { CapturedInput, RunDisposition, RunState, TaskKind, ValidatedProposal } from "../contracts/tasks.ts";

export function cursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProjectError("UNAVAILABLE");
  return value;
}

export type ApplicationRun = {
  id: string; task_type: TaskKind; draft_id: string; state: RunState; disposition: RunDisposition | null; result_hash: string | null;
  expected_document_revision: number; parent_snapshot_id: string | null; prompt_source_version_id: string;
  capture: CapturedInput | null; capture_hash: string; result: ValidatedProposal | null; cancel_requested_at: Date | null; terminal_at: Date | null;
};
export async function clock(tx: Transaction): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row) throw new ProjectError("UNAVAILABLE");
  return row.now;
}
export async function available(tx: Transaction, run: ApplicationRun, hash: string) {
  const [application] = await tx.$queryRaw<Array<{ id: string; draft_id: string }>>`
    SELECT id, draft_id FROM app.ai_suggestion_application WHERE run_id = ${run.id}::uuid`;
  if (application) throw new ProjectError("AI_RUN_CONSUMED", { applicationId: application.id, runId: run.id, draftId: application.draft_id });
  if (run.result_hash !== hash) throw new ProjectError("AI_RESULT_MISMATCH");
  if (run.state !== "SUCCEEDED" || run.disposition !== "AVAILABLE" || run.cancel_requested_at || !run.terminal_at
    || run.terminal_at.getTime() + 7 * 24 * 60 * 60 * 1000 <= (await clock(tx)).getTime() || !run.capture || !run.result) throw new ProjectError("AI_RESULT_UNAVAILABLE");
}
/** One shared access/receipt gate; children are locked by each operation in draft/source/run order. */
export async function applicationMutation<T extends object>(identity: ProjectIdentity, projectId: string, runId: string, key: string, operation: string, hash: string,
  parseReceipt: (value: unknown) => T, work: (tx: Transaction, project: ProjectRow, actorId: string) => Promise<T>): Promise<T & { replayed: boolean }> {
  if (!uuid.test(projectId) || !uuid.test(runId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async database => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async tx => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      requireMember(project);
      const [exists] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.ai_run WHERE id = ${runId}::uuid AND project_id = ${project.id}::uuid`;
      if (!exists) throw new ProjectError("NOT_FOUND");
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) { checkReceipt(receipt, operation, hash); return { ...parseReceipt(receipt.result), replayed: true }; }
      if (project.role !== "OWNER" && project.role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      const result = await work(tx, project, profile.id);
      const [size] = await tx.$queryRaw<Array<{ bytes: number }>>`SELECT octet_length(${JSON.stringify(result)}::jsonb::text)::integer AS bytes`;
      if (!size || size.bytes > 65_536) throw new ProjectError("LIMIT_EXCEEDED");
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, operation, hash, result as Prisma.InputJsonValue);
      return { ...result, replayed: false };
    }, { timeout: 15_000 });
  });
}
export async function lockRun(tx: Transaction, projectId: string, runId: string): Promise<ApplicationRun> {
  const [run] = await tx.$queryRaw<ApplicationRun[]>`SELECT id, task_type::text AS task_type, draft_id, state::text AS state, disposition::text AS disposition, result_hash,
    expected_document_revision, parent_snapshot_id, prompt_source_version_id, capture, capture_hash, result, cancel_requested_at, terminal_at
    FROM app.ai_run WHERE id = ${runId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`;
  if (!run) throw new ProjectError("NOT_FOUND");
  return run;
}
