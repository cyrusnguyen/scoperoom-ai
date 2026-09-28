import assert from "node:assert/strict";
import test from "node:test";
import type { DraftLayout } from "../src/features/drafts/contracts/draft-layout.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import { defaultStudioUi, moveTargets, studioDirtyCount } from "../src/features/studio/ui/studio-ui.ts";

const layout: DraftLayout = { schemaVersion: 1, positions: { a: { x: 0, y: 0, version: 3 }, b: { x: 100, y: 0, version: 5 } }, directions: {} };

test("a drag keeps only steps that moved from where they showed, rounded to whole pixels", () => {
  assert.deepEqual(moveTargets([{ id: "a", position: { x: 0.4, y: -0.2 } }, { id: "b", position: { x: 140.6, y: 20 } }, { id: "gone", position: { x: 1, y: 1 } }], layout), [{ nodeId: "b", x: 141, y: 20 }]);
});

test("the leave guard counts typed text and every unsaved change, sent or not", () => {
  const command = { commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: 3, payload: { edgeId: "e" } } as const;
  const outbox: Outbox = {
    ...emptyOutbox,
    entries: [{ kind: "drop", flowId: "f", items: [{ nodeId: "a", x: 1, y: 1 }] }, { kind: "command", command, proposedIds: [] }],
    sending: { draftId: "d", key: "k", state: "uncertain", batches: [{ commands: [{ command, proposedIds: [] }], moves: [{ flowId: "f", items: [{ nodeId: "a", expectedPositionVersion: 3, x: 1, y: 1 }, { nodeId: "b", expectedPositionVersion: 5, x: 2, y: 2 }] }] }] },
  };
  assert.equal(studioDirtyCount({ ...defaultStudioUi, outbox }), 5);
  assert.equal(studioDirtyCount(defaultStudioUi), 0);
});
