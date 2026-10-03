import assert from "node:assert/strict";
import test from "node:test";
import { exportSaveBlocker } from "../src/features/exports/ui/export-state.ts";
import { defaultStudioUi } from "../src/features/studio/ui/studio-ui.ts";
import { edit } from "../src/features/studio/ui/buffers.ts";

test("export Save qualification blocks unsubmitted text endpoint and coordinate buffers", () => {
  const dirty = edit({}, { kind: "NODE", id: "n", version: 1, fields: { label: "Saved" } }, "label", "Typed");
  for (const name of ["buffers", "endpointBuffers", "positionBuffers"] as const) assert.match(exportSaveBlocker({ ...defaultStudioUi, [name]: dirty }, false) ?? "", /Submit or discard/);
  assert.equal(exportSaveBlocker(defaultStudioUi, false), null);
});
test("export Save qualification refuses active drag uncertain and refused saves", () => {
  assert.match(exportSaveBlocker(defaultStudioUi, true) ?? "", /Finish/);
  for (const state of ["uncertain", "refused"] as const) assert.match(exportSaveBlocker({ ...defaultStudioUi, outbox: { ...defaultStudioUi.outbox, sending: { draftId: "55555555-5555-4555-8555-555555555555", key: "11111111-1111-4111-8111-111111111111", batches: [{ commands: [], moves: [] }], state } } }, false) ?? "", /Resolve/);
});
