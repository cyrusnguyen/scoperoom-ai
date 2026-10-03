import { uuid, keyPattern, type ProjectIdentity } from "../../projects/contracts/project.ts";
import {
  checkReceipt, findReceipt, lockActor, lockProject, profileFor, recordEvent, requestHash, requireActive, requireMember, saveReceipt, withDatabase, type Transaction,
} from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";

const CANCEL_OPERATION = "AI_RUN_CANCEL_V1";

/**
 * Settles this project's runs whose SQL deadline has passed, only for a current member or the owner (one statement, atomic). The
 * definer function takes the project and run locks itself, so it is safe to call with or without them held; it must run
 * before, never inside, a READ ONLY snapshot. Returns how many runs it settled.
 */
export async function settleOverdueRuns(db: Pick<Transaction, "$queryRaw">, profileId: string, projectId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ settled: number }>>`
    SELECT app.settle_overdue_ai_runs(project.id) AS settled FROM app.project project
    WHERE project.id = ${projectId}::uuid AND project.status IN ('ACTIVE'::app.project_status, 'ARCHIVED'::app.project_status)
      AND (project.owner_id = ${profileId}::uuid OR EXISTS (SELECT 1 FROM app.project_membership WHERE project_id = project.id AND profile_id = ${profileId}::uuid AND active))`;
  return rows[0]?.settled ?? 0;
}

export type CancelResult = { runId: string; cancelRequested: boolean; aiRevision: number; replayed: boolean };

function replayOf(result: unknown): Omit<CancelResult, "replayed"> {
  const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
  if (!record || typeof record.runId !== "string" || typeof record.cancelRequested !== "boolean" || typeof record.aiRevision !== "number") throw new ProjectError("UNAVAILABLE");
  return { runId: record.runId, cancelRequested: record.cancelRequested, aiRevision: record.aiRevision };
}

/**
 * Records cancellation intent for the current originating editor or the owner. Intent only: the run stays nonterminal and keeps its
 * slot (and any consumed reservation) until the worker reports a terminal outcome or the SQL deadline settles it. No provider call here.
 */
export async function cancelRun(identity: ProjectIdentity, projectId: string, runId: string, key: string): Promise<CancelResult> {
  if (!uuid.test(projectId) || !uuid.test(runId)) throw new ProjectError("NOT_FOUND");
  if (!keyPattern.test(key)) throw new ProjectError("INVALID_INPUT");
  projectId = projectId.toLowerCase(); runId = runId.toLowerCase();
  const hash = requestHash(CANCEL_OPERATION, { projectId, runId });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      let project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      const exists = async () => (await tx.$queryRaw<Array<{ actor_id: string; cancel_requested: boolean; terminal: boolean }>>`
        SELECT actor_id, cancel_requested_at IS NOT NULL AS cancel_requested, terminal_at IS NOT NULL AS terminal FROM app.ai_run
        WHERE id = ${runId}::uuid AND project_id = ${project.id}::uuid FOR UPDATE`)[0];
      if (receipt) {
        checkReceipt(receipt, CANCEL_OPERATION, hash);
        if (!(await exists())) throw new ProjectError("NOT_FOUND");
        return { ...replayOf(receipt.result), replayed: true };
      }
      requireActive(project);
      // A run past its deadline is settled before anything else, so cancelling it reports the truth instead of re-arming it.
      if (await settleOverdueRuns(tx, profile.id, project.id)) project = await lockProject(tx, profile.id, projectId);
      const run = await exists();
      if (!run) throw new ProjectError("NOT_FOUND");
      if (role !== "OWNER" && !(role === "EDITOR" && run.actor_id === profile.id)) throw new ProjectError("FORBIDDEN");
      let aiRevision = project.aiRevision;
      if (!run.terminal && !run.cancel_requested) {
        const sequence = await recordEvent(tx, project, profile.id, "AI_RUN_CANCEL_REQUESTED", [{ kind: "AI_RUN", id: runId }], {});
        await tx.$executeRaw`UPDATE app.project SET ai_revision = ${sequence}::bigint WHERE id = ${project.id}::uuid`;
        await tx.$executeRaw`UPDATE app.ai_run SET cancel_requested_at = clock_timestamp(), last_event_sequence = ${sequence}::bigint WHERE id = ${runId}::uuid`;
        aiRevision = Number(sequence);
      }
      const result = { runId, cancelRequested: run.cancel_requested || !run.terminal, aiRevision };
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, CANCEL_OPERATION, hash, result);
      return { ...result, replayed: false };
    });
  });
}
