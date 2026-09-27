import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import {
  checkReceipt, findReceipt, lockActor, lockProject, profileFor, readProject, recordEvent, requestHash, requireActive, requireMember, saveReceipt,
  withDatabase, withReadSnapshot, type ProjectRow, type Transaction,
} from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseCommandResult, parseGraphCommand, type CommandResult, type GraphCommand } from "../contracts/commands.ts";
import { LIMITS, parseDraftPair, type DraftView } from "../contracts/scope-document.ts";
import { MAX_VERSION } from "../contracts/strict.ts";
import { applyGraphCommand, GraphError, type Applied, type Draft } from "../domain/graph.ts";

// The one semantic dispatcher (Data03 "Shared mutation primitives"). Routes only adapt identity and transport.
const COMMAND_OPERATION = "DRAFT_COMMAND_V1";

export type LockedDraft = { id: string; documentRevision: number; layoutRevision: number; draft: Draft };

/** A stored draft that fails its own schema is a server fault, never something to repair or show. */
export function storedDraft(document: unknown, layout: unknown): Draft {
  try { return parseDraftPair(document, layout); } catch { throw new ProjectError("UNAVAILABLE"); }
}

/** Domain refusals keep their code and details; anything else stays a server fault. */
export function graphFailure(error: unknown): never {
  if (error instanceof GraphError) throw new ProjectError(error.code, error.details);
  throw error;
}

export function nextRevision(value: number): number {
  if (value >= MAX_VERSION) throw new ProjectError("VERSION_EXHAUSTED");
  return value + 1;
}

export const asJson = (value: unknown) => value as Prisma.InputJsonValue;

/** PostgreSQL checks JSONB's formatted text, which is larger than compact JSON.stringify output. */
async function requireStoredSize(tx: Transaction, document: unknown, layout: unknown) {
  const [size] = await tx.$queryRaw<Array<{ documentBytes: number; layoutBytes: number }>>`
    SELECT octet_length(${JSON.stringify(document)}::jsonb::text)::integer AS "documentBytes",
           octet_length(${JSON.stringify(layout)}::jsonb::text)::integer AS "layoutBytes"`;
  if (!size || size.documentBytes > LIMITS.documentBytes || size.layoutBytes > LIMITS.layoutBytes) {
    throw new ProjectError("LIMIT_EXCEEDED");
  }
}

async function requireReadableDraft(tx: Transaction, projectId: string, draftId: string) {
  const draft = await tx.scopeDraft.findFirst({ where: { id: draftId, projectId }, select: { id: true } });
  if (!draft) throw new ProjectError("NOT_FOUND");
}

/** Lock order 4 (after actor and project): the route's draft, which must be the project's current editable draft. */
async function lockDraft(tx: Transaction, project: ProjectRow, draftId: string): Promise<LockedDraft> {
  const [row] = await tx.$queryRaw<Array<{ id: string; status: string; document_revision: number; layout_revision: number; document_json: unknown; layout_json: unknown }>>`
    SELECT id, status::text AS status, document_revision, layout_revision, document_json, layout_json
    FROM app.scope_draft WHERE id = ${draftId}::uuid AND project_id = ${project.id}::uuid FOR UPDATE`;
  if (!row) throw new ProjectError("NOT_FOUND");
  if (row.status !== "EDITABLE" || row.id !== project.currentDraftId) throw new ProjectError("DRAFT_REPLACED");
  return { id: row.id, documentRevision: row.document_revision, layoutRevision: row.layout_revision, draft: storedDraft(row.document_json, row.layout_json) };
}

/**
 * Draft mutation skeleton, in the Data03 order: actor → project lock → current read access → matching receipt replay →
 * (new work only) owner/editor capability → ACTIVE project → current draft lock → work. `work` returns the safe result
 * that is saved as the receipt and replayed for the same key.
 */
export async function draftMutation<T extends object>(
  identity: ProjectIdentity, projectId: string, draftId: string, key: string, operation: string, hash: string,
  parseStored: (value: unknown) => T,
  work: (tx: Transaction, project: ProjectRow, draft: LockedDraft, actorId: string) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  if (!uuid.test(projectId) || !uuid.test(draftId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) {
        checkReceipt(receipt, operation, hash);
        const stored = parseStored(receipt.result);
        await requireReadableDraft(tx, project.id, draftId);
        return { ...stored, replayed: true };
      }
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      const draft = await lockDraft(tx, project, draftId);
      const value = parseStored(await work(tx, project, draft, profile.id));
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, operation, hash, asJson(value));
      return { ...value, replayed: false };
    });
  });
}

/** Audit names what the command touched, bounded well under the audit payload cap. */
function auditRefs(applied: Applied) {
  const ids = [...new Set([...applied.createdIds, ...Object.keys(applied.versions), ...applied.retiredIds])].slice(0, 25);
  return ids.map((id) => ({ kind: "DRAFT_ENTITY", id }));
}

export async function executeGraphCommand(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<CommandResult> {
  const { key, ...raw } = input;
  let command: GraphCommand;
  try {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("INVALID_INPUT");
    command = parseGraphCommand(raw);
  } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(COMMAND_OPERATION, { projectId, draftId, command });
  return draftMutation(identity, projectId, draftId, key, COMMAND_OPERATION, hash, parseCommandResult, async (tx, project, draft, actorId) => {
    let applied: Applied;
    try { applied = applyGraphCommand(draft.draft, draft.documentRevision, command, randomUUID); } catch (error) { graphFailure(error); }
    // An effective no-op keeps every counter; only its receipt is saved.
    if (!applied.documentChanged) {
      return { draftId: draft.id, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, eventSequence: Number(project.eventSequence), createdIds: [], versions: {}, retiredIds: [] };
    }
    const documentRevision = nextRevision(draft.documentRevision);
    const layoutRevision = applied.layoutChanged ? nextRevision(draft.layoutRevision) : draft.layoutRevision;
    await requireStoredSize(tx, applied.document, applied.layout);
    await tx.scopeDraft.update({ where: { id: draft.id }, data: { documentJson: asJson(applied.document), layoutJson: asJson(applied.layout), documentRevision, layoutRevision }, select: { id: true } });
    const sequence = await recordEvent(tx, project, actorId, "DRAFT_COMMAND_SAVED", auditRefs(applied), { command: command.command, documentRevision, layoutRevision });
    return { draftId: draft.id, documentRevision, layoutRevision, eventSequence: Number(sequence), createdIds: applied.createdIds, versions: applied.versions, retiredIds: applied.retiredIds };
  });
}

/** GET D: one coherent document/layout revision pair for any admitted reader. */
export async function getDraft(identity: ProjectIdentity, projectId: string, draftId: string): Promise<DraftView> {
  if (!uuid.test(projectId) || !uuid.test(draftId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireMember(project);
      const row = await tx.scopeDraft.findFirst({ where: { id: draftId, projectId: project.id }, select: { id: true, status: true, documentRevision: true, layoutRevision: true, documentJson: true, layoutJson: true } });
      if (!row) throw new ProjectError("NOT_FOUND");
      return { id: row.id, status: row.status, documentRevision: row.documentRevision, layoutRevision: row.layoutRevision, ...storedDraft(row.documentJson, row.layoutJson) };
    });
  });
}
