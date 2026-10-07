import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { keyPattern, uuid, type ProjectAccessRole, type ProjectIdentity } from "../../projects/contracts/project.ts";
import {
  checkReceipt, findReceipt, lockActor, lockProject, profileFor, projectRole, readProject, recordEvent, requestHash, requireActive, requireMember, saveReceipt,
  withDatabase, withReadSnapshot, type ProjectRow, type Transaction,
} from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseCommandResult, type CommandResult } from "../contracts/commands.ts";
import { LIMITS, parseDraftPair, type DraftView } from "../contracts/scope-document.ts";
import { MAX_VERSION } from "../contracts/strict.ts";
import { applyGraphCommand, GraphError, type Applied, type Draft } from "../domain/graph.ts";
import { isScopeCommand, parseDraftCommand, type DraftCommand } from "../../scope/contracts/scope-commands.ts";
import { applyScopeCommand, commandMembers, commandSourceRefs, formatDisplayId } from "../../scope/domain/scope.ts";
import { checkSourceRefs } from "../../sources/server/source-versions.ts";

// The one semantic dispatcher (Data03 "Shared mutation primitives"). Routes only adapt identity and transport.
const COMMAND_OPERATION = "DRAFT_COMMAND_V1";
const MAX_REQUIREMENT_DISPLAY_SEQUENCE = 999_999_999;
export const ASSIGNABLE_ROLES: readonly ProjectAccessRole[] = ["OWNER", "EDITOR", "REVIEWER"];

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
export async function requireStoredSize(tx: Transaction, document: unknown, layout: unknown) {
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
export async function lockDraft(tx: Transaction, project: ProjectRow, draftId: string): Promise<LockedDraft> {
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
 * that is saved as the receipt and replayed for the same key. `timeout` overrides Prisma's 5 s interactive-transaction limit.
 */
export async function draftMutation<T extends object>(
  identity: ProjectIdentity, projectId: string, draftId: string, key: string, operation: string, hash: string,
  parseStored: (value: unknown) => T,
  work: (tx: Transaction, project: ProjectRow, draft: LockedDraft, actorId: string) => Promise<T>,
  timeout?: number,
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
    }, timeout ? { timeout } : undefined);
  });
}

/**
 * Audit names what the command touched, bounded well under the audit payload cap. `extra` names records an
 * effective command touched without creating, versioning or retiring them (a layout-only side-only RECONNECT_EDGE
 * touches only its edge) — audit-row naming only, never fed back into the receipt or `CommandResult`/`ChangesResult`.
 */
export function auditRefs(applied: Applied, extra: string[] = []) {
  const ids = [...new Set([...applied.createdIds, ...Object.keys(applied.versions), ...applied.retiredIds, ...extra])].slice(0, 25);
  return ids.map((id) => ({ kind: "DRAFT_ENTITY", id }));
}

export async function executeGraphCommand(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<CommandResult> {
  const { key, ...raw } = input;
  let command: DraftCommand;
  try {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("INVALID_INPUT");
    command = parseDraftCommand(raw);
  } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(COMMAND_OPERATION, { projectId, draftId, command });
  return draftMutation(identity, projectId, draftId, key, COMMAND_OPERATION, hash, parseCommandResult, async (tx, project, draft, actorId) => {
    // The project row is already locked FOR UPDATE, so the next label is serialized with every other creation.
    let label: number | null = null;
    if (command.command === "CREATE_REQUIREMENT") {
      const [row] = await tx.$queryRaw<Array<{ sequence: number }>>`
        SELECT requirement_display_sequence AS sequence FROM app.project WHERE id = ${project.id}::uuid`;
      if (!row) throw new ProjectError("UNAVAILABLE");
      if (row.sequence >= MAX_REQUIREMENT_DISPLAY_SEQUENCE) throw new ProjectError("VERSION_EXHAUSTED");
      label = row.sequence + 1;
    }
    let applied: Applied;
    try {
      applied = isScopeCommand(command)
        ? applyScopeCommand(draft.draft, draft.documentRevision, command, randomUUID, { actorId, now: new Date().toISOString(), ...(label === null ? {} : { displayId: formatDisplayId(label) }) })
        : applyGraphCommand(draft.draft, draft.documentRevision, command, randomUUID);
    } catch (error) { graphFailure(error); }
    if (isScopeCommand(command) && applied.documentChanged) {
      await checkSourceRefs(tx, project.id, commandSourceRefs(command));
      for (const member of commandMembers(command)) {
        const role = await projectRole(tx, project, member);
        if (!role || !ASSIGNABLE_ROLES.includes(role)) throw new ProjectError("INVALID_INPUT");
      }
      if (label !== null) await tx.$executeRaw`UPDATE app.project SET requirement_display_sequence = ${label} WHERE id = ${project.id}::uuid`;
    }
    // An effective no-op keeps every counter; only its receipt is saved. A layout-only effect (Task 13's side-only
    // RECONNECT_EDGE) still writes and advances layoutRevision, just never documentRevision or a record version.
    if (!applied.documentChanged && !applied.layoutChanged) {
      return { draftId: draft.id, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, eventSequence: Number(project.eventSequence), createdIds: [], versions: {}, retiredIds: [] };
    }
    const documentRevision = applied.documentChanged ? nextRevision(draft.documentRevision) : draft.documentRevision;
    const layoutRevision = applied.layoutChanged ? nextRevision(draft.layoutRevision) : draft.layoutRevision;
    await requireStoredSize(tx, applied.document, applied.layout);
    await tx.scopeDraft.update({ where: { id: draft.id }, data: { documentJson: asJson(applied.document), layoutJson: asJson(applied.layout), documentRevision, layoutRevision }, select: { id: true } });
    const extraRef = command.command === "RECONNECT_EDGE" ? [command.payload.edgeId] : [];
    const sequence = await recordEvent(tx, project, actorId, "DRAFT_COMMAND_SAVED", auditRefs(applied, extraRef), { command: command.command, documentRevision, layoutRevision });
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
