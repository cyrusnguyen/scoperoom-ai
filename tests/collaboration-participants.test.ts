import assert from "node:assert/strict";
import test from "node:test";
import type { PresenceState } from "../src/features/collaboration/contracts/messages.ts";
import {
  claimOf, createDirectory, paletteIndex, resolveParticipants, selectorsByItem, PALETTE_SIZE, UNKNOWN_PARTICIPANT, type DirectoryMember,
} from "../src/features/collaboration/ui/participants.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [me, ann, bob, gone, flow, other, nodeA, nodeB] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const entry = (profileId: string, sessionId: string, over: Partial<PresenceState> = {}): PresenceState =>
  ({ projectId: id(90), epoch: id(91), draftId: id(92), flowId: flow, sessionId, profileId, selection: null, ...over });
const directory: DirectoryMember[] = [{ profileId: ann, displayName: "Ann", role: "EDITOR" }, { profileId: bob, displayName: "Bob", role: "VIEWER" }, { profileId: me, displayName: "Me", role: "OWNER" }];

test("people are deduplicated by profile, with sessions as a count, and the viewer is left out", () => {
  const people = resolveParticipants([entry(ann, id(11)), entry(ann, id(12)), entry(bob, id(13)), entry(me, id(14))], directory, me);
  assert.deepEqual(people.map((person) => [person.name, person.role, person.sessions]), [["Ann", "EDITOR", 2], ["Bob", "VIEWER", 1]]);
});

test("an id the directory lacks is a neutral Unknown participant, also before the directory has loaded", () => {
  assert.deepEqual(resolveParticipants([entry(gone, id(11)), entry(ann, id(12))], directory, me).map((person) => person.name), ["Ann", UNKNOWN_PARTICIPANT]);
  const [person] = resolveParticipants([entry(ann, id(11))], null, me);
  assert.equal(person!.name, UNKNOWN_PARTICIPANT);
  assert.equal(person!.role, null);
});

test("a name comes from the directory only, never from the claim", () => {
  const claim = { ...entry(ann, id(11)), displayName: "Someone Else" } as PresenceState;
  assert.equal(resolveParticipants([claim], directory, me)[0]!.name, "Ann");
});

test("a profile keeps one stable palette slot", () => {
  assert.equal(paletteIndex(ann), paletteIndex(ann));
  for (const profile of [me, ann, bob, gone]) assert.ok(paletteIndex(profile) >= 1 && paletteIndex(profile) <= PALETTE_SIZE);
});

test("selections are shown per item for the same flow only, once per person, never for the viewer", () => {
  const roster = [
    entry(ann, id(11), { selection: { kind: "NODES", ids: [nodeA, nodeB] } }), entry(ann, id(12), { selection: { kind: "NODES", ids: [nodeA] } }),
    entry(bob, id(13), { flowId: other, selection: { kind: "NODES", ids: [nodeA] } }), entry(me, id(14), { selection: { kind: "NODES", ids: [nodeB] } }),
  ];
  const items = selectorsByItem(roster, resolveParticipants(roster, directory, me), flow, me);
  assert.deepEqual(items.get(nodeA)!.map((person) => person.name), ["Ann"]);
  assert.deepEqual(items.get(nodeB)!.map((person) => person.name), ["Ann"]);
});

test("the claim carries the flow and the selection, and drops what the wire would reject", () => {
  assert.deepEqual(claimOf(flow, { kind: "EDGE", id: nodeA }), { flowId: flow, selection: { kind: "EDGE", ids: [nodeA] } });
  assert.deepEqual(claimOf(flow, { kind: "NODES", ids: [nodeA] }), { flowId: flow, selection: { kind: "NODES", ids: [nodeA] } });
  assert.deepEqual(claimOf(flow, { kind: "NODES", ids: [] }), { flowId: flow, selection: null });
  assert.deepEqual(claimOf(flow, { kind: "NODES", ids: Array.from({ length: 21 }, (_, n) => id(100 + n)) }), { flowId: flow, selection: null });
  assert.deepEqual(claimOf(null, { kind: "FLOW", id: flow }), { flowId: null, selection: null });
});

function rig() {
  const reads: ((members: DirectoryMember[] | null) => void)[] = [];
  const shown: DirectoryMember[][] = [];
  let valid = true;
  const directoryLoader = createDirectory({ read: () => new Promise((resolve) => reads.push(resolve)), fence: () => { const mine = valid; return () => mine && valid; }, publish: (members) => shown.push(members) });
  return { directoryLoader, reads, shown, invalidate: () => { valid = false; } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the directory is read once and again only when the membership version moves", async () => {
  const { directoryLoader, reads, shown } = rig();
  void directoryLoader.update(1); void directoryLoader.update(1);
  assert.equal(reads.length, 1, "a second update for the same version joins the read in flight");
  reads[0]!(directory); await settle();
  void directoryLoader.update(1);
  assert.equal(reads.length, 1, "a loaded version is not read again");
  void directoryLoader.update(2);
  assert.equal(reads.length, 2);
  reads[1]!([directory[0]!]); await settle();
  assert.deepEqual(shown, [directory, [directory[0]]]);
});

test("a superseded, replaced or failed read changes nothing, and a failure is retried", async () => {
  const { directoryLoader, reads, shown, invalidate } = rig();
  void directoryLoader.update(1); void directoryLoader.update(2);
  reads[0]!(directory); await settle();
  assert.deepEqual(shown, [], "the older read lost to the newer request");
  reads[1]!(null); await settle();
  assert.deepEqual(shown, [], "a failure publishes nothing");
  void directoryLoader.update(2);
  assert.equal(reads.length, 3, "the failed version is read again");
  invalidate();
  reads[2]!(directory); await settle();
  assert.deepEqual(shown, [], "a response after a project switch is dropped");
});
