import assert from "node:assert/strict";
import test from "node:test";
import { parseHint, parsePeerMessage, parsePresence } from "../src/features/collaboration/contracts/messages.ts";

const uuid = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const upper = "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF";
const context = { projectId: uuid(1), epoch: uuid(2), draftId: uuid(3), flowId: uuid(4) };
const peer = { ...context, sessionId: uuid(5), sequence: 1 };
const cursor = { ...peer, type: "CURSOR", x: 10.5, y: -20 };
const drag = { ...peer, type: "DRAG_PREVIEW", gestureId: "g-1", items: [{ nodeId: uuid(6), x: 1, y: 2, basePositionVersion: 3 }] };
const end = { ...peer, type: "DRAG_END", gestureId: "g-1" };
const presence = { projectId: uuid(1), epoch: uuid(2), draftId: uuid(3), flowId: uuid(4), sessionId: uuid(5), profileId: uuid(7), selection: { kind: "NODES", ids: [uuid(6)] } };
const hint = { type: "PROJECT_CHANGED", projectId: uuid(1), epoch: uuid(2), eventSequence: 9 };
const items = (count: number) => Array.from({ length: count }, (_, index) => ({ nodeId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`, x: 0, y: 0, basePositionVersion: 1 }));
const ids = (count: number) => items(count).map((item) => item.nodeId);

test("valid messages, presence and hints parse to themselves", () => {
  for (const message of [cursor, drag, end]) assert.deepEqual(parsePeerMessage(message), message);
  assert.deepEqual(parsePeerMessage({ ...cursor, sequence: 0 }), { ...cursor, sequence: 0 });
  assert.equal(parsePeerMessage({ ...drag, items: items(20) })?.type, "DRAG_PREVIEW");
  for (const selection of [null, { kind: "NODES", ids: ids(20) }, { kind: "EDGE", ids: [uuid(6)] }, { kind: "FLOW", ids: [uuid(4)] }]) {
    assert.deepEqual(parsePresence({ ...presence, selection }), { ...presence, selection });
  }
  assert.equal(parsePresence({ ...presence, flowId: null })?.flowId, null);
  assert.deepEqual(parseHint(hint), hint);
  assert.deepEqual(parseHint({ ...hint, id: "provider-1" }), hint, "the provider id is dropped");
  assert.equal(parseHint({ ...hint, eventSequence: 0 })?.eventSequence, 0);
});

const cyclic: Record<string, unknown> = { ...cursor };
cyclic.self = cyclic;
type Shape<Base = Record<string, unknown>> = (base: Base) => unknown;
const badInputs: Record<string, Shape> = {
  "null": () => null, "undefined": () => undefined, "array": (base) => [base], "string": () => "CURSOR", "number": () => 7,
  "class instance": (base) => Object.assign(new (class Peer {})(), base),
  "cyclic": () => cyclic, "bigint field": (base) => ({ ...base, extra: BigInt(1) }),
  "unknown key": (base) => ({ ...base, extra: 1 }),
  "missing key": (base) => Object.fromEntries(Object.entries(base).filter(([key]) => key !== "sessionId")),
  "non-canonical uuid": (base) => ({ ...base, sessionId: upper }),
  "uuid without dashes": (base) => ({ ...base, projectId: uuid(1).replaceAll("-", "") }),
  "sequence fractional": (base) => ({ ...base, sequence: 1.5 }),
  "sequence negative": (base) => ({ ...base, sequence: -1 }),
  "sequence unsafe": (base) => ({ ...base, sequence: Number.MAX_SAFE_INTEGER + 1 }),
  "sequence NaN": (base) => ({ ...base, sequence: Number.NaN }),
  "sequence string": (base) => ({ ...base, sequence: "1" }),
  "unknown type": (base) => ({ ...base, type: "PING" }),
  "oversize (over 8192 bytes)": (base) => ({ ...base, extra: "x".repeat(9000) }),
};
const cursorOnly: Record<string, Shape> = {
  "x NaN": (base) => ({ ...base, x: Number.NaN }), "y Infinity": (base) => ({ ...base, y: Number.POSITIVE_INFINITY }),
  "x beyond limit": (base) => ({ ...base, x: 100_001 }), "y beyond limit": (base) => ({ ...base, y: -100_001 }), "x string": (base) => ({ ...base, x: "1" }),
};
const dragOnly: Record<string, Shape<typeof drag>> = {
  "no items": (base) => ({ ...base, items: [] }), "items not array": (base) => ({ ...base, items: {} }),
  "21 items": (base) => ({ ...base, items: items(21) }),
  "duplicate node": (base) => ({ ...base, items: [base.items[0], base.items[0]] }),
  "item extra key": (base) => ({ ...base, items: [{ ...base.items[0], label: "Pay" }] }),
  "item node not uuid": (base) => ({ ...base, items: [{ ...base.items[0], nodeId: "n1" }] }),
  "item x Infinity": (base) => ({ ...base, items: [{ ...base.items[0], x: Number.POSITIVE_INFINITY }] }),
  "item y beyond limit": (base) => ({ ...base, items: [{ ...base.items[0], y: 100_001 }] }),
  "version 0": (base) => ({ ...base, items: [{ ...base.items[0], basePositionVersion: 0 }] }),
  "version negative": (base) => ({ ...base, items: [{ ...base.items[0], basePositionVersion: -1 }] }),
  "version fractional": (base) => ({ ...base, items: [{ ...base.items[0], basePositionVersion: 1.5 }] }),
  "version unsafe": (base) => ({ ...base, items: [{ ...base.items[0], basePositionVersion: 2 ** 53 }] }),
  "gesture empty": (base) => ({ ...base, gestureId: "" }), "gesture not string": (base) => ({ ...base, gestureId: 4 }),
  "gesture over 64 bytes": (base) => ({ ...base, gestureId: "g".repeat(65) }),
  "gesture 33 two-byte characters (66 bytes)": (base) => ({ ...base, gestureId: "é".repeat(33) }),
  "gesture lone surrogate": (base) => ({ ...base, gestureId: "\ud800" }),
};

test("peer messages reject malformed, oversized and out-of-range input", () => {
  for (const [name, shape] of Object.entries(badInputs)) for (const base of [cursor, drag, end]) assert.equal(parsePeerMessage(shape(base)), null, `${name} ${base.type}`);
  for (const [name, shape] of Object.entries(cursorOnly)) assert.equal(parsePeerMessage(shape(cursor)), null, name);
  for (const [name, shape] of Object.entries(dragOnly)) assert.equal(parsePeerMessage(shape(drag)), null, name);
  assert.equal(parsePeerMessage({ ...end, gestureId: "" }), null);
  assert.equal(parsePeerMessage({ ...end, gestureId: "g".repeat(65) }), null);
  assert.equal(parsePeerMessage({ ...cursor, items: [] }), null, "cursor with drag key");
  assert.equal(parsePeerMessage({ ...end, x: 1 }), null, "end with cursor key");
});

test("size limits are exact and counted in bytes", () => {
  assert.notEqual(parsePeerMessage({ ...drag, gestureId: "g".repeat(64) }), null);
  assert.notEqual(parsePeerMessage({ ...drag, gestureId: "é".repeat(32) }), null);
  assert.notEqual(parsePeerMessage({ ...cursor, x: 100_000, y: -100_000 }), null);
  assert.notEqual(parsePeerMessage({ ...drag, items: [{ ...drag.items[0], basePositionVersion: 2_147_483_647 }] }), null);
  assert.equal(parsePeerMessage({ ...drag, items: [{ ...drag.items[0], basePositionVersion: 2_147_483_648 }] }), null);
});

test("presence rejects malformed, oversized and mis-shaped selections", () => {
  const bad: Record<string, unknown> = {
    "null": null, "array": [presence], "unknown key": { ...presence, email: "a@b.c" }, "missing key": { ...presence, profileId: undefined },
    "flow not uuid": { ...presence, flowId: "f1" }, "session uppercase": { ...presence, sessionId: upper },
    "selection not object": { ...presence, selection: "NODES" }, "selection array": { ...presence, selection: [] },
    "selection extra key": { ...presence, selection: { kind: "NODES", ids: [], label: "x" } },
    "unknown kind": { ...presence, selection: { kind: "GROUP", ids: [uuid(6)] } },
    "21 node ids": { ...presence, selection: { kind: "NODES", ids: ids(21) } },
    "duplicate node ids": { ...presence, selection: { kind: "NODES", ids: [uuid(6), uuid(6)] } },
    "non-uuid node id": { ...presence, selection: { kind: "NODES", ids: ["n1"] } },
    "edge with no id": { ...presence, selection: { kind: "EDGE", ids: [] } },
    "edge with two ids": { ...presence, selection: { kind: "EDGE", ids: [uuid(6), uuid(8)] } },
    "flow with no id": { ...presence, selection: { kind: "FLOW", ids: [] } },
    "flow with two ids": { ...presence, selection: { kind: "FLOW", ids: [uuid(4), uuid(8)] } },
    "oversize": { ...presence, extra: "x".repeat(9000) },
  };
  for (const [name, input] of Object.entries(bad)) assert.equal(parsePresence(input), null, name);
});

test("hints carry exactly the four contract keys plus the provider id", () => {
  const bad: Record<string, unknown> = {
    "null": null, "array": [hint], "extra key": { ...hint, extra: 1 }, "id and extra key": { ...hint, id: "p", extra: 1 },
    "missing sequence": { ...hint, eventSequence: undefined }, "wrong type": { ...hint, type: "DRAFT_CHANGED" },
    "project uppercase": { ...hint, projectId: upper }, "epoch not uuid": { ...hint, epoch: "e" },
    "negative sequence": { ...hint, eventSequence: -1 }, "fractional sequence": { ...hint, eventSequence: 0.5 },
    "unsafe sequence": { ...hint, eventSequence: 2 ** 53 }, "NaN sequence": { ...hint, eventSequence: Number.NaN },
    "id not string": { ...hint, id: 4 }, "id over 64 bytes": { ...hint, id: "i".repeat(65) },
  };
  for (const [name, input] of Object.entries(bad)) assert.equal(parseHint(input), null, name);
});

test("rejection never throws and never logs the rejected body", (t) => {
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) => t.mock.method(console, level, () => undefined));
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
  for (const input of [hostile, cyclic, { ...cursor, sessionId: "secret-body" }, BigInt(1)]) {
    assert.equal(parsePeerMessage(input), null);
    assert.equal(parsePresence(input), null);
    assert.equal(parseHint(input), null);
  }
  assert.equal(spies.reduce((total, spy) => total + spy.mock.callCount(), 0), 0);
});
