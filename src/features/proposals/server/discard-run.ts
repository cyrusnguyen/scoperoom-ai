import { id, keys, object } from "../../drafts/contracts/strict.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { recordEvent, requestHash } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseDiscardRunInput, type DiscardedRun, type DiscardRunInput } from "../contracts/tasks.ts";
import { applicationMutation, available, cursor, lockRun } from "./application.ts";

const OPERATION = "AI_DISCARD_V1";
export function parseDiscardedRun(value: unknown): Omit<DiscardedRun, "replayed"> {
  try { const r = object(value); keys(r, ["runId", "disposition", "aiRevision"]); if (r.disposition !== "DISCARDED") throw new Error(); return { runId: id(r.runId), disposition: "DISCARDED", aiRevision: cursor(r.aiRevision) }; }
  catch { throw new ProjectError("UNAVAILABLE"); }
}
export async function discardRun(identity: ProjectIdentity, projectId: string, runId: string, raw: DiscardRunInput): Promise<DiscardedRun> {
  if (!uuid.test(projectId) || !uuid.test(runId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase(); runId = runId.toLowerCase();
  let input: DiscardRunInput;
  try { const r = object(raw); const { key, ...body } = r; if (typeof key !== "string") throw new Error(); input = parseDiscardRunInput(body, key); }
  catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(OPERATION, { projectId, runId, expectedResultHash: input.expectedResultHash });
  return applicationMutation(identity, projectId, runId, input.key, OPERATION, hash, parseDiscardedRun, async (tx, project, actorId) => {
    const run = await lockRun(tx, project.id, runId);
    await available(tx, run, input.expectedResultHash);
    await tx.$executeRaw`UPDATE app.ai_run SET disposition = 'DISCARDED' WHERE id = ${runId}::uuid`;
    const sequence = await recordEvent(tx, project, actorId, "AI_PROPOSAL_DISCARDED", [{ kind: "AI_RUN", id: runId }], {});
    await tx.$executeRaw`UPDATE app.project SET ai_revision = ${sequence}::bigint WHERE id = ${project.id}::uuid`;
    await tx.$executeRaw`UPDATE app.ai_run SET last_event_sequence = ${sequence}::bigint WHERE id = ${runId}::uuid`;
    return { runId, disposition: "DISCARDED" as const, aiRevision: Number(sequence) };
  });
}
