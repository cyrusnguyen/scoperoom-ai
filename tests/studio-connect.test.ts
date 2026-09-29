import assert from "node:assert/strict";
import test from "node:test";
import { orientConnect, orientReconnect } from "../src/features/studio/ui/studio-ui.ts";

const cart = "cart", done = "done";
// React Flow labels a finished connection's ends by handle type: a drag that starts on a target-typed handle (top or
// left by default) arrives with the DROPPED step as `source`.
const conn = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ source, sourceHandle, target, targetHandle });

test("a new connection runs from where the drag started to where it was dropped, whichever end React Flow calls source", () => {
  // Started on Cart's right (source-typed) and dropped on Done's left: React Flow reports it as is.
  assert.deepEqual(orientConnect(conn(cart, "right", done, "left"), { nodeId: cart, handleId: "right" }),
    { fromId: cart, toId: done, fromHandle: "right", toHandle: "left" });
  // Started on Cart's top (target-typed): React Flow reports Done as source, but the gesture began at Cart.
  assert.deepEqual(orientConnect(conn(done, "left", cart, "top"), { nodeId: cart, handleId: "top" }),
    { fromId: cart, toId: done, fromHandle: "top", toHandle: "left" });
  assert.deepEqual(orientConnect(conn(done, "top", cart, "left"), { nodeId: cart, handleId: "left" }),
    { fromId: cart, toId: done, fromHandle: "left", toHandle: "top" });
  assert.deepEqual(orientConnect(conn(cart, "bottom", done, "top"), { nodeId: cart, handleId: "bottom" }),
    { fromId: cart, toId: done, fromHandle: "bottom", toHandle: "top" });
  // Without a recorded start, the connection is taken as reported.
  assert.deepEqual(orientConnect(conn(done, "left", cart, "top"), null),
    { fromId: done, toId: cart, fromHandle: "left", toHandle: "top" });
});

test("a step joined to itself is oriented by the handle the drag started on", () => {
  assert.deepEqual(orientConnect(conn(cart, "bottom", cart, "top"), { nodeId: cart, handleId: "top" }),
    { fromId: cart, toId: cart, fromHandle: "top", toHandle: "bottom" });
  assert.deepEqual(orientConnect(conn(cart, "bottom", cart, "top"), { nodeId: cart, handleId: "bottom" }),
    { fromId: cart, toId: cart, fromHandle: "bottom", toHandle: "top" });
});

test("reconnecting an end moves only that end; the other keeps its step and side", () => {
  const edge = { fromId: cart, toId: done }; // Cart --right→left--> Done
  const other = "other";
  // Grab the to end (target) and drop it on Other's top: from stays Cart/right.
  assert.deepEqual(orientReconnect(conn(cart, "right", other, "top"), edge, "target", "right", "bottom"),
    { fromId: cart, toId: other, fromHandle: "right", toHandle: "top" });
  // Grab the from end (source) and drop it on Other's left (target-typed, so React Flow reports Other as source... or not).
  assert.deepEqual(orientReconnect(conn(other, "left", done, "left"), edge, "source", "left", "top"),
    { fromId: other, toId: done, fromHandle: "left", toHandle: "left" });
  assert.deepEqual(orientReconnect(conn(done, "left", other, "top"), edge, "source", "left", "top"),
    { fromId: other, toId: done, fromHandle: "top", toHandle: "left" });
  // Grab the to end and drop it on Other's top where React Flow reports Other as source.
  assert.deepEqual(orientReconnect(conn(other, "top", cart, "right"), edge, "target", "right", "bottom"),
    { fromId: cart, toId: other, fromHandle: "right", toHandle: "top" });
  // An edge with no saved sides keeps its default handle at the end that did not move.
  assert.deepEqual(orientReconnect(conn(cart, null as unknown as string, other, "top"), edge, "target", undefined, "bottom"),
    { fromId: cart, toId: other, fromHandle: "bottom", toHandle: "top" });
});

test("reconnecting an end onto another handle of the same step changes only that side", () => {
  const edge = { fromId: cart, toId: done };
  assert.deepEqual(orientReconnect(conn(cart, "right", done, "top"), edge, "target", "right", "bottom"),
    { fromId: cart, toId: done, fromHandle: "right", toHandle: "top" });
  // Grab the from end and drop it on Cart's top: React Flow reports Done as source.
  assert.deepEqual(orientReconnect(conn(done, "left", cart, "top"), edge, "source", "left", "top"),
    { fromId: cart, toId: done, fromHandle: "top", toHandle: "left" });
});
