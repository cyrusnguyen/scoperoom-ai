import assert from "node:assert/strict";
import test from "node:test";
import type { PeerMessage } from "../src/features/collaboration/contracts/messages.ts";
import { createPreviewStore, PREVIEW_TTL_MS, MAX_SESSIONS, type SavedView } from "../src/features/collaboration/ui/preview-store.ts";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const context = { projectId: uuid(1), epoch: uuid(2), draftId: uuid(3), flowId: uuid(4), sessionId: uuid(5) };
const alice = uuid(10);
const bob = uuid(11);
const [nodeA, nodeB, nodeC] = [uuid(20), uuid(21), uuid(22)];

/** A saved draft the tests can advance: nodeA and nodeB in the visible flow at version 3, nodeC in another flow. */
function saved(overrides: Partial<Record<string, { flowId: string; positionVersion: number } | undefined>> = {}, draftId = context.draftId): SavedView {
  const nodes: Record<string, { flowId: string; positionVersion: number } | undefined> = {
    [nodeA]: { flowId: context.flowId, positionVersion: 3 }, [nodeB]: { flowId: context.flowId, positionVersion: 3 }, [nodeC]: { flowId: uuid(99), positionVersion: 3 }, ...overrides,
  };
  return { draftId, node: (id) => nodes[id] };
}
const peer = (sessionId: string, sequence: number) => ({ projectId: context.projectId, epoch: context.epoch, draftId: context.draftId, flowId: context.flowId, sessionId, sequence });
const cursor = (sessionId: string, sequence: number, x = 1, y = 2): PeerMessage => ({ ...peer(sessionId, sequence), type: "CURSOR", x, y });
const drag = (sessionId: string, sequence: number, nodeIds = [nodeA], gestureId = "g1", base = 3): PeerMessage => ({
  ...peer(sessionId, sequence), type: "DRAG_PREVIEW", gestureId, items: nodeIds.map((nodeId, index) => ({ nodeId, x: 10 + index, y: 20, basePositionVersion: base })),
});
const end = (sessionId: string, sequence: number, gestureId = "g1"): PeerMessage => ({ ...peer(sessionId, sequence), type: "DRAG_END", gestureId });

function ready() {
  const store = createPreviewStore();
  store.setContext(context);
  store.syncSessions([context.sessionId, alice, bob]);
  return store;
}

test("a cursor and a drag ghost appear per session and carry only geometry", () => {
  const store = ready();
  assert.equal(store.receive(cursor(alice, 1, 5, 6), saved(), 1000), true);
  assert.equal(store.receive(drag(alice, 2, [nodeA, nodeB]), saved(), 1000), true);
  assert.deepEqual(store.snapshot(1000), {
    cursors: [{ sessionId: alice, x: 5, y: 6 }],
    drags: [{ sessionId: alice, gestureId: "g1", items: [{ nodeId: nodeA, x: 10, y: 20 }, { nodeId: nodeB, x: 11, y: 20 }] }],
  });
});

test("own-session traffic and sessions absent from the roster are ignored", () => {
  const store = ready();
  assert.equal(store.receive(cursor(context.sessionId, 1), saved(), 0), false);
  assert.equal(store.receive(cursor(uuid(12), 1), saved(), 0), false, "early packet before the first Presence sync");
  assert.deepEqual(store.snapshot(0), { cursors: [], drags: [] });
  const fresh = createPreviewStore();
  assert.equal(fresh.receive(cursor(alice, 1), saved(), 0), false, "no context yet");
});

test("anything but the exact context and the saved draft is rejected", () => {
  const store = ready();
  for (const wrong of [{ projectId: uuid(90) }, { epoch: uuid(91) }, { draftId: uuid(92) }, { flowId: uuid(93) }]) {
    assert.equal(store.receive({ ...cursor(alice, 1), ...wrong }, saved(), 0), false, JSON.stringify(wrong));
    assert.equal(store.receive({ ...drag(alice, 1), ...wrong }, saved(), 0), false, JSON.stringify(wrong));
  }
  assert.equal(store.receive(cursor(alice, 1), saved({}, uuid(92)), 0), false, "the saved draft moved on");
  assert.deepEqual(store.snapshot(0), { cursors: [], drags: [] });
  assert.equal(store.receive(cursor(alice, 1), saved(), 0), true, "rejections did not consume the watermark");
});

test("a drag must match the saved nodes, their flow and their position versions", () => {
  const store = ready();
  assert.equal(store.receive(drag(alice, 1, [nodeA, uuid(77)]), saved(), 0), false, "unknown node");
  assert.equal(store.receive(drag(alice, 1, [nodeA, nodeC]), saved(), 0), false, "node of another flow");
  assert.equal(store.receive(drag(alice, 1, [nodeA], "g1", 2), saved(), 0), false, "stale base version");
  assert.equal(store.receive(drag(alice, 1, [nodeA], "g1", 4), saved(), 0), false, "base version ahead of the saved one");
  assert.deepEqual(store.snapshot(0).drags, []);
  assert.equal(store.receive(drag(alice, 1), saved(), 0), true, "rejections did not consume the watermark");
});

test("sequence must strictly increase per session; out-of-order and repeated packets are dropped", () => {
  const store = ready();
  assert.equal(store.receive(cursor(alice, 5, 50, 0), saved(), 0), true);
  assert.equal(store.receive(cursor(alice, 4, 40, 0), saved(), 0), false);
  assert.equal(store.receive(cursor(alice, 5, 55, 0), saved(), 0), false);
  assert.equal(store.receive(cursor(bob, 1, 1, 0), saved(), 0), true, "another session has its own watermark");
  assert.deepEqual(store.snapshot(0).cursors, [{ sessionId: alice, x: 50, y: 0 }, { sessionId: bob, x: 1, y: 0 }]);
  assert.equal(store.receive(cursor(alice, 6, 60, 0), saved(), 0), true);
});

test("a preview that arrives after its DRAG_END cannot resurrect the ghost", () => {
  const store = ready();
  store.receive(drag(alice, 1), saved(), 0);
  assert.equal(store.receive(end(alice, 3), saved(), 0), true);
  assert.deepEqual(store.snapshot(0).drags, []);
  assert.equal(store.receive(drag(alice, 2, [nodeA], "g1"), saved(), 0), false, "delayed preview of the ended gesture");
  assert.equal(store.receive(end(alice, 3), saved(), 0), false, "duplicate end");
  assert.deepEqual(store.snapshot(0).drags, []);
  assert.equal(store.receive(drag(alice, 4, [nodeA], "g2"), saved(), 0), true, "a later gesture is fine");
});

test("DRAG_END only clears the gesture it names; one drag and one cursor per session", () => {
  const store = ready();
  store.receive(drag(alice, 1, [nodeA], "g1"), saved(), 0);
  store.receive(drag(alice, 2, [nodeB], "g2"), saved(), 0);
  assert.deepEqual(store.snapshot(0).drags.map((entry) => [entry.gestureId, entry.items.length]), [["g2", 1]]);
  store.receive(end(alice, 3, "g1"), saved(), 0);
  assert.equal(store.snapshot(0).drags.length, 1, "an end for another gesture leaves the active one");
  store.receive(end(alice, 4, "g2"), saved(), 0);
  assert.equal(store.snapshot(0).drags.length, 0);
  store.receive(cursor(alice, 5, 1, 1), saved(), 0);
  store.receive(cursor(alice, 6, 2, 2), saved(), 0);
  assert.deepEqual(store.snapshot(0).cursors, [{ sessionId: alice, x: 2, y: 2 }]);
});

test("nextExpiry is the earliest last-update plus the TTL of what is shown, and null when nothing is", () => {
  const store = ready();
  assert.equal(store.nextExpiry(0), null);
  store.receive(cursor(alice, 1), saved(), 1000);
  store.receive(drag(bob, 1), saved(), 1500);
  assert.equal(store.nextExpiry(1600), 1000 + PREVIEW_TTL_MS, "the cursor goes first");
  store.receive(cursor(alice, 2), saved(), 1800);
  assert.equal(store.nextExpiry(1900), 1500 + PREVIEW_TTL_MS, "a refresh moves that entry's expiry");
  assert.equal(store.snapshot(1500 + PREVIEW_TTL_MS).drags.length, 0, "and the snapshot agrees at exactly that time");
  assert.equal(store.nextExpiry(1500 + PREVIEW_TTL_MS), 1800 + PREVIEW_TTL_MS, "an already expired entry is not the next expiry");
  assert.equal(store.nextExpiry(1800 + PREVIEW_TTL_MS), null);
});

test("visuals expire about two seconds after their last update, but the watermark stays", () => {
  const store = ready();
  store.receive(cursor(alice, 7), saved(), 1000);
  store.receive(drag(alice, 8), saved(), 1500);
  assert.equal(store.snapshot(1000 + PREVIEW_TTL_MS - 1).cursors.length, 1);
  assert.equal(store.snapshot(1000 + PREVIEW_TTL_MS).cursors.length, 0, "the cursor expired");
  assert.equal(store.snapshot(1000 + PREVIEW_TTL_MS).drags.length, 1, "the drag was updated later");
  assert.deepEqual(store.snapshot(1500 + PREVIEW_TTL_MS), { cursors: [], drags: [] });
  assert.equal(store.receive(drag(alice, 8), saved(), 4000), false, "an older packet after expiry stays dropped");
  assert.equal(store.receive(drag(alice, 3), saved(), 4000), false);
  assert.equal(store.receive(drag(alice, 9), saved(), 4000), true);
  assert.equal(store.snapshot(4000).drags.length, 1);
});

test("a save that advances a target drops the ghost and a delayed preview of the old version stays out", () => {
  const store = ready();
  store.receive(cursor(alice, 1), saved(), 0);
  store.receive(drag(alice, 2, [nodeA, nodeB]), saved(), 0);
  store.reconcile(saved({ [nodeB]: { flowId: context.flowId, positionVersion: 4 } }));
  assert.deepEqual(store.snapshot(0).drags, [], "one moved target drops the whole drag");
  assert.equal(store.snapshot(0).cursors.length, 1, "the cursor is not a saved-node claim");
  assert.equal(store.receive(drag(alice, 3, [nodeA, nodeB]), saved({ [nodeB]: { flowId: context.flowId, positionVersion: 4 } }), 0), false, "a delayed preview with the old base version");
  assert.equal(store.receive(drag(alice, 4, [nodeA, nodeB], "g2", 4), saved({ [nodeB]: { flowId: context.flowId, positionVersion: 4 } }), 0), false, "nodeA is still at version 3");
  store.reconcile(saved());
  assert.equal(store.receive(drag(alice, 5), saved(), 0), true);
});

test("reconcile keeps drags that still match and drops deleted targets, moved flows and a replaced draft", () => {
  const store = ready();
  store.receive(drag(alice, 1, [nodeA]), saved(), 0);
  store.receive(drag(bob, 1, [nodeB]), saved(), 0);
  store.reconcile(saved());
  assert.equal(store.snapshot(0).drags.length, 2);
  store.reconcile(saved({ [nodeB]: undefined }));
  assert.deepEqual(store.snapshot(0).drags.map((entry) => entry.sessionId), [alice], "deleted target");
  store.reconcile(saved({ [nodeA]: { flowId: uuid(99), positionVersion: 3 } }));
  assert.deepEqual(store.snapshot(0).drags, [], "target left the visible flow");
  store.receive(cursor(alice, 2), saved(), 0);
  store.receive(drag(alice, 3), saved(), 0);
  store.reconcile(saved({}, uuid(92)));
  assert.deepEqual(store.snapshot(0), { cursors: [], drags: [] }, "another draft is current");
});

test("the same target dragged by two sessions shows two ghosts and each ends on its own", () => {
  const store = ready();
  store.receive(drag(alice, 1, [nodeA]), saved(), 0);
  store.receive(drag(bob, 1, [nodeA]), saved(), 0);
  assert.equal(store.snapshot(0).drags.length, 2);
  store.receive(end(alice, 2), saved(), 0);
  assert.deepEqual(store.snapshot(0).drags.map((entry) => entry.sessionId), [bob]);
  store.reconcile(saved({ [nodeA]: { flowId: context.flowId, positionVersion: 4 } }));
  assert.deepEqual(store.snapshot(0).drags, []);
});

test("a session that leaves Presence loses its visuals and watermark", () => {
  const store = ready();
  store.receive(cursor(alice, 9), saved(), 0);
  store.receive(drag(bob, 9), saved(), 0);
  store.syncSessions([context.sessionId, bob]);
  assert.deepEqual(store.snapshot(0).cursors, []);
  assert.equal(store.snapshot(0).drags.length, 1);
  assert.equal(store.receive(cursor(alice, 10), saved(), 0), false, "not on the roster any more");
  store.syncSessions([context.sessionId, alice, bob]);
  assert.equal(store.receive(cursor(alice, 1), saved(), 0), true, "a rejoining session starts a fresh watermark");
  assert.equal(store.receive(drag(bob, 9), saved(), 0), false, "the remaining session kept its watermark");
});

test("at most 64 sessions are tracked and the own session does not count", () => {
  const store = createPreviewStore();
  store.setContext(context);
  const others = Array.from({ length: 70 }, (_, index) => uuid(200 + index));
  store.syncSessions([context.sessionId, ...others]);
  let accepted = 0;
  for (const [index, sessionId] of others.entries()) if (store.receive(cursor(sessionId, 1, index, 0), saved(), 0)) accepted += 1;
  assert.equal(accepted, MAX_SESSIONS);
  assert.equal(store.snapshot(0).cursors.length, MAX_SESSIONS);
});

test("a context change clears everything and keeps the roster only for the same channel", () => {
  const store = ready();
  store.receive(cursor(alice, 5), saved(), 0);
  store.receive(drag(alice, 6), saved(), 0);
  store.setContext({ ...context });
  assert.equal(store.snapshot(0).cursors.length, 1, "an identical context changes nothing");
  const otherFlow = { ...context, flowId: uuid(50) };
  store.setContext(otherFlow);
  assert.deepEqual(store.snapshot(0), { cursors: [], drags: [] });
  assert.equal(store.receive({ ...cursor(alice, 5), flowId: otherFlow.flowId }, saved(), 0), true, "watermarks were torn down and the roster of the same channel stayed");
  store.setContext({ ...otherFlow, epoch: uuid(51) });
  assert.equal(store.receive({ ...cursor(alice, 9), epoch: uuid(51), flowId: otherFlow.flowId }, saved(), 0), false, "a new epoch is a new channel with a new roster");
  store.setContext(null);
  assert.equal(store.receive(cursor(alice, 10), saved(), 0), false);
});

test("clear() drops the visuals for a disconnect but keeps the roster and watermarks", () => {
  const store = ready();
  store.receive(cursor(alice, 5), saved(), 0);
  store.receive(drag(alice, 6), saved(), 0);
  store.clear();
  assert.deepEqual(store.snapshot(0), { cursors: [], drags: [] });
  assert.equal(store.receive(drag(alice, 6), saved(), 0), false, "a packet from before the disconnect cannot come back");
  assert.equal(store.receive(drag(alice, 7), saved(), 0), true);
});
