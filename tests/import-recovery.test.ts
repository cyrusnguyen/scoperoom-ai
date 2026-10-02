import assert from "node:assert/strict";
import test from "node:test";
import { defaultStudioUi } from "../src/features/studio/ui/studio-ui.ts";
import { importBlocker, parseImportRecord, storedImportRecord } from "../src/features/exchange/ui/import-recovery.ts";

const id = "00000000-0000-4000-8000-000000000001";
test("import recovery stores only opaque original scope and pinned request", () => {
  const record = { actorId: id, projectId: id, draftId: id, previewId: id, createKey: id, discardKey: id, previewHash: "a".repeat(64), fingerprint: "b".repeat(64), attempt: { key: id, draftId: id, previewHash: "a".repeat(64) }, labels: "secret", file: "secret" };
  const wire = storedImportRecord(record);
  assert.equal(wire.includes("secret"), false);
  assert.deepEqual(parseImportRecord(wire, id, id)?.attempt, record.attempt);
  assert.equal(parseImportRecord(wire, "00000000-0000-4000-8000-000000000002", id), null);
  assert.equal(parseImportRecord(JSON.stringify({ ...record, attempt: { ...record.attempt, draftId: "wrong" } }), id, id), null);
  assert.equal(parseImportRecord(wire, id.toUpperCase(), id.toUpperCase())?.previewId, id);
  assert.equal(parseImportRecord("{}", id, id), null);
});
test("import permits completed queued edits but requires explicit unresolved or redo resolution", () => {
  assert.equal(importBlocker(defaultStudioUi, false), null);
  assert.match(importBlocker(defaultStudioUi, true)!, /drag/);
  const buffer = { kind: "NODE" as const, id, original: { label: "before" }, values: { label: "after" }, baseVersion: 1, conflict: false };
  for (const lane of ["buffers", "positionBuffers", "endpointBuffers"] as const) assert.match(importBlocker({ ...defaultStudioUi, [lane]: { [id]: buffer } }, false)!, /Studio/);
  assert.match(importBlocker({ ...defaultStudioUi, outbox: { ...defaultStudioUi.outbox, redo: [{}] as never } }, false)!, /redo/);
  const entry = { kind: "command" as const, command: { commandSchemaVersion: 1 as const, command: "CREATE_FLOW" as const, expectedDocumentRevision: 1, payload: { title: "Completed", purpose: "", classification: "USER_JOURNEY" as const, inclusion: "UNDECIDED" as const } }, proposedIds: [id] };
  assert.equal(importBlocker({ ...defaultStudioUi, outbox: { ...defaultStudioUi.outbox, entries: [entry] } }, false), null);
  for (const state of ["refused", "uncertain"] as const) assert.match(importBlocker({ ...defaultStudioUi, outbox: { ...defaultStudioUi.outbox, sending: { draftId: id, key: id, batches: [], state } } }, false)!, /Resolve/);
});
