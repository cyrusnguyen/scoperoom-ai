import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { saveChanges } from "../../../src/features/drafts/server/changes.ts";
import { getDraft } from "../../../src/features/drafts/server/execute-command.ts";
import { getProjectBootstrap } from "../../../src/features/projects/server/projects.ts";
import type { Identity } from "./fixture.ts";

// Helpers for PROJECT_CHANGED hint tests: real saves through the service, and the committed hint rows Realtime stores.
export type Hint = { topic: string; payload: Record<string, unknown> };

export async function draftOf(owner: Identity, projectId: string) {
  const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
  return { draftId, base: await getDraft(owner, projectId, draftId) };
}

/** A two-command batch (create flow, add start step): one changed save advancing the sequence by two. Returns its parts. */
export function flowBatch(revision: number) {
  const [flowId, start] = [randomUUID(), randomUUID()];
  const commands = [
    { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: revision, payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: revision + 1, payload: { flowId, kind: "START", label: "Step", description: "", actorLabel: "" }, proposedIds: [start] },
  ];
  return { flowId, start, body: { commands, moves: [] } };
}

/** Saves one changed batch as `owner` and returns the service result. */
export async function saveFlow(owner: Identity, projectId: string) {
  const { draftId, base } = await draftOf(owner, projectId);
  return saveChanges(owner, projectId, draftId, { ...flowBatch(base.documentRevision).body, key: randomUUID() });
}

/** Committed hints for one project, oldest first. */
export async function hintsFor(database: Client, projectId: string): Promise<Hint[]> {
  const { rows } = await database.query<Hint>("select topic, payload from realtime.messages where event = 'PROJECT_CHANGED' and topic like $1 order by (payload->>'eventSequence')::bigint, inserted_at", [`project:${projectId}:%`]);
  return rows;
}
