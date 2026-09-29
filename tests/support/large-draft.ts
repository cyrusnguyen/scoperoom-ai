import { MAX_CHANGE_COMMANDS } from "../../src/features/drafts/contracts/changes.ts";
import { emptyDraft, LIMITS, parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import type { Draft } from "../../src/features/drafts/domain/graph.ts";

/** A draft at the size limits: 5 flows, 200 steps with long multibyte descriptions and 400 connections, about 1.93 MB of JSON. */
export function largeDraft(): Draft {
  const { document, layout } = emptyDraft();
  const at = (kind: number, n: number) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  for (let f = 0; f < LIMITS.flows; f += 1) {
    const flow = at(1, f);
    document.flows[flow] = { id: flow, version: 1, behaviourVersion: 1, title: "Flow", purpose: "ệ".repeat(4_000), classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null };
    layout.directions[flow] = "TB";
    for (let n = 0; n < 40; n += 1) {
      const node = at(2, f * 40 + n);
      document.nodes[node] = { id: node, flowId: flow, version: 1, behaviourVersion: 1, kind: n ? "ACTION" : "START", label: "Step", description: "ệ".repeat(2_700), actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
      layout.positions[node] = { x: n * 10, y: n * 10, version: 1 };
    }
    for (let e = 0; e < 80; e += 1) {
      const edge = at(3, f * 80 + e);
      document.edges[edge] = { id: edge, flowId: flow, version: 1, fromId: at(2, f * 40 + (e % 39)), toId: at(2, f * 40 + (e % 39) + 1), condition: "c".repeat(200), origin: "HUMAN", sourceRefs: [] };
    }
  }
  return parseDraftPair(document, layout);
}

/** The largest batch: 100 label edits and 200 moves, one per step. */
export function largestBatch(draft: Draft) {
  const nodes = Object.values(draft.document.nodes);
  const moves = Object.keys(draft.document.flows).map((flowId) => ({
    flowId, items: nodes.filter((node) => node.flowId === flowId).map((node) => ({ nodeId: node.id, expectedPositionVersion: 1, x: 1_000, y: 1_000 })),
  }));
  return { commands: nodes.slice(0, MAX_CHANGE_COMMANDS).map((node) => ({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: node.version, payload: { nodeId: node.id, label: "Renamed" } })), moves };
}
