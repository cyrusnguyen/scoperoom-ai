import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { applyFlowImport, previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { prepareFlow } from "../../src/features/exports/server/prepare-flow.ts";
import { parseFlowFile, serializeFlowFile } from "../../src/features/exchange/domain/flow-file.ts";
import type { FlowFileV1 } from "../../src/features/exchange/contracts/flow-file.ts";
import { canRun, withFixture } from "./support/fixture.ts";

// This fixture has distinct labels, so identity-free comparison keeps every supported field and connection.
function semantic(file: FlowFileV1) {
  const labels = new Map(file.nodes.map(node => [node.id, node.label])); assert.equal(new Set(labels.values()).size, file.nodes.length);
  const edges = new Map(file.edges.map(edge => [edge.id, edge]));
  const sort = <T>(values: T[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { flow: file.flow, nodes: sort(file.nodes.map(({ id, ...node }) => { void id; return node; })),
    edges: sort(file.edges.map(edge => ({ from: labels.get(edge.fromId), to: labels.get(edge.toId), condition: edge.condition }))),
    positions: sort(file.positions!.map(position => ({ label: labels.get(position.nodeId), x: position.x, y: position.y }))),
    sides: sort(file.edgeSides!.map(side => ({ fromNode: labels.get(edges.get(side.edgeId)!.fromId), toNode: labels.get(edges.get(side.edgeId)!.toId), from: side.from, to: side.to }))) };
}

test("real saved export preview Apply export preserves source graph geometry and resets imported identities and trust", { skip: !canRun }, async () => {
  await withFixture(async fixture => {
    const owner = await fixture.user(), projectId = await fixture.project(owner), draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const bytes = await readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
    const original = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes);
    const sourceResult = await applyFlowImport(owner, projectId, original.id, { key: randomUUID(), draftId, previewHash: original.previewHash });
    const before = await getDraft(owner, projectId, draftId);
    const request = (view: typeof before) => ({ format: "native", includeLinkHints: false, expectedDocumentRevision: view.documentRevision, expectedLayoutRevision: view.layoutRevision });
    const first = await prepareFlow(owner, projectId, draftId, sourceResult.flowId, request(before));
    const parsed = parseFlowFile(serializeFlowFile(first.file));
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), serializeFlowFile(parsed));
    const copied = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    const after = await getDraft(owner, projectId, draftId); assert.notEqual(copied.flowId, sourceResult.flowId);
    for (const [key, value] of Object.entries(before.document.flows)) assert.deepEqual(after.document.flows[key], value);
    for (const [key, value] of Object.entries(before.document.nodes)) { assert.deepEqual(after.document.nodes[key], value); assert.deepEqual(after.layout.positions[key], before.layout.positions[key]); }
    for (const [key, value] of Object.entries(before.document.edges)) { assert.deepEqual(after.document.edges[key], value); assert.deepEqual(after.layout.edgeSides[key], before.layout.edgeSides[key]); }
    assert.equal(after.layout.directions[sourceResult.flowId], before.layout.directions[sourceResult.flowId]);
    const flow = after.document.flows[copied.flowId]!; assert.equal(flow.inclusion, "UNDECIDED"); assert.equal(flow.confirmation, null); assert.equal(flow.verificationMethod, null);
    for (const node of Object.values(after.document.nodes).filter(node => node.flowId === copied.flowId)) { assert.equal(before.document.nodes[node.id], undefined); assert.equal(node.origin, "IMPORTED"); assert.deepEqual(node.sourceRefs, []); }
    for (const edge of Object.values(after.document.edges).filter(edge => edge.flowId === copied.flowId)) { assert.equal(before.document.edges[edge.id], undefined); assert.equal(edge.origin, "IMPORTED"); assert.deepEqual(edge.sourceRefs, []); }
    const second = await prepareFlow(owner, projectId, draftId, copied.flowId, request(after));
    assert.deepEqual(semantic(parseFlowFile(serializeFlowFile(second.file))), semantic(parsed));
    assert.deepEqual(await getDraft(owner, projectId, draftId), after);
  });
});
