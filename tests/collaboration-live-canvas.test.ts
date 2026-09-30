import assert from "node:assert/strict";
import test from "node:test";
import type { PresenceState } from "../src/features/collaboration/contracts/messages.ts";
import type { SavedView } from "../src/features/collaboration/ui/preview-store.ts";
import type { Person } from "../src/features/collaboration/ui/participants.ts";
import { expiryDelay, gestureBases, gestureItems, sessionLabels, visibleDrags } from "../src/features/collaboration/ui/live-canvas.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flow = id(1);
const saved = (nodes: Record<string, { flowId: string; positionVersion: number }>): SavedView => ({ draftId: id(2), node: (nodeId) => nodes[nodeId] });
const moved = (...ids: string[]) => ids.map((nodeId, index) => ({ id: nodeId, position: { x: index * 10, y: index * 20 } }));

test("a gesture captures saved versions only: a never-saved node and one of another flow are skipped", () => {
  const view = saved({ a: { flowId: flow, positionVersion: 3 }, b: { flowId: id(9), positionVersion: 1 } });
  assert.deepEqual([...gestureBases(moved("a", "b", "new"), view, flow)], [["a", 3]]);
});

test("more than 20 saved targets sends nothing; exactly 20 sends all, and the local move is not limited by this", () => {
  const nodes = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`n${index}`, { flowId: flow, positionVersion: 1 }]));
  const ids = Object.keys(nodes);
  assert.equal(gestureBases(moved(...ids), saved(nodes), flow).size, 0);
  assert.equal(gestureBases(moved(...ids.slice(0, 20)), saved(nodes), flow).size, 20);
  // Never-saved nodes do not count toward the cap.
  assert.equal(gestureBases(moved(...ids, ...Array.from({ length: 5 }, (_, index) => `extra${index}`)).slice(1), saved(nodes), flow).size, 20);
});

test("items carry the version captured at gesture start and the current position; a node outside the capture is left out", () => {
  const bases = new Map([["a", 3]]);
  assert.deepEqual(gestureItems(bases, moved("a", "b")), [{ nodeId: "a", x: 0, y: 0, basePositionVersion: 3 }]);
  assert.deepEqual(gestureItems(new Map(), moved("a")), []);
});

test("a remote ghost for a node the local user is dragging is suppressed; other items and drags stay", () => {
  const shot = { cursors: [], drags: [
    { sessionId: "s1", gestureId: "g1", items: [{ nodeId: "a", x: 1, y: 1 }, { nodeId: "b", x: 2, y: 2 }] },
    { sessionId: "s2", gestureId: "g2", items: [{ nodeId: "a", x: 3, y: 3 }] },
  ] };
  const shown = visibleDrags(shot, new Set(["a"]));
  assert.deepEqual(shown.map((drag) => [drag.sessionId, drag.items.map((item) => item.nodeId)]), [["s1", ["b"]]]);
  assert.equal(visibleDrags(shot, new Set()).length, 2);
});

test("the expiry timer waits until the earliest shown entry has expired (one ms past it) and is absent when nothing is shown", () => {
  assert.equal(expiryDelay(null, 1000), null);
  assert.equal(expiryDelay(3000, 1000), 2001);
  assert.equal(expiryDelay(3000, 2999), 2);
  assert.equal(expiryDelay(3000, 3000), 1, "due now");
  assert.equal(expiryDelay(3000, 9000), 1, "already past: read at once");
});

test("labels come from the directory-resolved people by session; the viewer's other tab and an unlisted session are named neutrally", () => {
  const ann: Person = { profileId: id(11), name: "Ann", role: "EDITOR", sessions: 1, color: 4 };
  const entry = (profileId: string, sessionId: string): PresenceState => ({ projectId: id(90), epoch: id(91), draftId: id(92), flowId: flow, sessionId, profileId, selection: null });
  const labels = sessionLabels([entry(ann.profileId, "s1"), entry(id(12), "s2"), entry(id(13), "s3")], [ann], id(13));
  assert.deepEqual(labels.get("s1"), { name: "Ann", color: 4 });
  assert.equal(labels.get("s2")!.name, "Unknown participant");
  assert.equal(labels.get("s3")!.name, "Your other tab");
});
