import assert from "node:assert/strict";
import test from "node:test";
import { CHANGES_BODY_LIMIT, MAX_CHANGE_COMMANDS, MAX_CHANGE_MOVES, parseChanges } from "../src/features/drafts/contracts/changes.ts";
import type { GraphCommand } from "../src/features/drafts/contracts/commands.ts";
import { emptyDraft, type DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { applyChanges } from "../src/features/drafts/domain/changes.ts";
import { applyGraphCommand, GraphError } from "../src/features/drafts/domain/graph.ts";
import {
  acknowledged, addDrop, build, emptyOutbox, enqueue, optimistic, pendingCount, rebase, redo, split, startSave, undo, wireBody, withEntries, type Outbox,
} from "../src/features/studio/ui/outbox.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Deterministic "crypto.randomUUID" for enqueue. */
const ids = (from: number) => { let next = from; return () => id(next++); };
const flowId = id(1), start = id(2), end = id(3);

/** A saved draft (revision 4): one flow with Start and End at their placed positions, no connection. */
function saved(): DraftView {
  let draft = { ...emptyDraft() };
  let revision = 1;
  const apply = (command: GraphCommand, created: string[]) => {
    const queue = [...created];
    const applied = applyGraphCommand(draft, revision, command, () => queue.shift()!);
    draft = { document: applied.document, layout: applied.layout };
    revision += 1;
  };
  apply({ commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, [flowId]);
  apply({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" } }, [start]);
  apply({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 3, payload: { flowId, kind: "OUTCOME", label: "End", description: "", actorLabel: "" } }, [end]);
  return { id: id(99), status: "EDITABLE", documentRevision: revision, layoutRevision: 3, ...draft };
}

const addNode = (rev: number, label: string): GraphCommand => ({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: rev, payload: { flowId, kind: "ACTION", label, description: "", actorLabel: "" } });
const addEdge = (rev: number, fromId: string, toId: string): GraphCommand => ({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: rev, payload: { flowId, fromId, toId, condition: "" } });
const rename = (version: number, nodeId: string, label: string): GraphCommand => ({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: version, payload: { nodeId, label } });
const describeNode = (version: number, nodeId: string, description: string): GraphCommand => ({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: version, payload: { nodeId, description } });

/** Enqueues through the pure path the provider uses: validate against the optimistic draft, then store the entries. */
function queue(outbox: Outbox, base: DraftView, command: GraphCommand, newId = ids(500)) {
  const result = enqueue(outbox, base, command, newId);
  return { outbox: withEntries(outbox, base, result.entries), result };
}

test("the optimistic draft equals the server's apply of the same batch, with the same proposed ids", () => {
  const base = saved();
  let outbox = emptyOutbox;
  const newId = ids(10);
  const step = queue(outbox, base, addNode(4, "Pay"), newId);
  outbox = step.outbox;
  const payId = step.result.createdIds[0]!;
  assert.equal(payId, id(10));
  outbox = queue(outbox, base, addEdge(5, start, payId), newId).outbox;
  outbox = queue(outbox, base, rename(1, start, "Begin"), newId).outbox;
  outbox = addDrop(outbox, base, flowId, [{ nodeId: payId, x: 400, y: 300 }, { nodeId: end, x: -20, y: 500 }]);
  outbox = queue(outbox, base, { commandSchemaVersion: 1, command: "DUPLICATE_FLOW", expectedDocumentRevision: 7, payload: { flowId } }, newId).outbox;

  const shown = optimistic(outbox, base);
  const { changes } = build(base, outbox.entries);
  // What the browser would send, parsed exactly as the route parses it, applied by the server's own function.
  const server = applyChanges(base, base.documentRevision, parseChanges(wireBody(changes)));
  assert.deepEqual(shown.document, server.document);
  assert.deepEqual(shown.layout, server.layout);
  assert.equal(shown.documentRevision, server.documentRevision);
  assert.equal(shown.layoutRevision, base.layoutRevision + 1);
  // Commands go first, then moves: the created step and End are moved at the versions the commands left them at.
  assert.deepEqual(changes.moves, [{ flowId, items: [{ nodeId: payId, expectedPositionVersion: 1, x: 400, y: 300 }, { nodeId: end, expectedPositionVersion: 1, x: -20, y: 500 }] }]);
  assert.equal(shown.layout.positions[payId]!.x, 400);
  assert.equal(Object.keys(shown.document.flows).length, 2, "the duplicate is shown before any request");
});

test("guards come from the optimistic draft: a stale one is refused locally with its usual code", () => {
  const base = saved();
  const first = queue(emptyOutbox, base, addNode(4, "Pay"));
  assert.equal(first.result.documentRevision, 5);
  assert.throws(() => enqueue(first.outbox, base, addNode(4, "Ship")), (error: unknown) => error instanceof GraphError && error.code === "STALE_DOCUMENT_REVISION");
  assert.throws(() => enqueue(emptyOutbox, base, rename(7, start, "X")), (error: unknown) => error instanceof GraphError && error.code === "STALE_ENTITY_VERSION");
  // A command that changes nothing is acknowledged without being queued.
  const same = enqueue(emptyOutbox, base, rename(1, start, "Start"));
  assert.deepEqual(same.entries, []);
});

test("consecutive edits of the same fields of one record coalesce into one queued command", () => {
  const base = saved();
  let { outbox, result } = queue(emptyOutbox, base, rename(1, start, "Begin"));
  assert.deepEqual(result.versions[start], 2);
  ({ outbox, result } = queue(outbox, base, rename(2, start, "Begin here")));
  assert.equal(outbox.entries.length, 1);
  assert.deepEqual(outbox.entries[0], { kind: "command", command: rename(1, start, "Begin here"), proposedIds: [] });
  assert.equal(result.versions[start], 2, "the reported version is the coalesced one");
  assert.equal(optimistic(outbox, base).document.nodes[start]!.version, 2);
  // Another field of the same step is its own change (its own undo step).
  ({ outbox } = queue(outbox, base, describeNode(2, start, "Where it begins")));
  assert.equal(outbox.entries.length, 2);
  // Typing the saved value back leaves nothing to save for that edit.
  ({ outbox } = queue(emptyOutbox, base, rename(1, end, "Finish")));
  ({ outbox } = queue(outbox, base, rename(2, end, "End")));
  assert.deepEqual(outbox.entries, []);
});

test("undo removes the last unsaved change of any kind (a joined placement with its step); redo re-appends it", () => {
  const base = saved();
  const added = queue(emptyOutbox, base, addNode(4, "Pay"));
  const payId = added.result.createdIds[0]!;
  let outbox = addDrop(added.outbox, base, flowId, [{ nodeId: payId, x: 10, y: 10 }], true);
  outbox = addDrop(outbox, base, flowId, [{ nodeId: start, x: 50, y: 50 }]);
  outbox = undo(outbox);
  assert.equal(optimistic(outbox, base).layout.positions[start]!.x, 0);
  assert.ok(optimistic(outbox, base).document.nodes[payId]);
  outbox = undo(outbox);
  assert.equal(outbox.entries.length, 0, "the shape and its drop point go together");
  assert.equal(optimistic(outbox, base).document.nodes[payId], undefined);
  outbox = redo(outbox);
  assert.equal(optimistic(outbox, base).layout.positions[payId]!.x, 10);
  outbox = redo(outbox);
  assert.equal(optimistic(outbox, base).layout.positions[start]!.x, 50);
  assert.deepEqual(outbox.redo, []);
  // A new change after an undo drops what could be redone.
  outbox = undo(outbox);
  outbox = queue(outbox, base, rename(1, end, "Done")).outbox;
  assert.deepEqual(outbox.redo, []);
});

test("a save takes the queued changes; later edits form a new segment on top, and an acknowledgement keeps what is shown", () => {
  const base = saved();
  let { outbox } = queue(emptyOutbox, base, addNode(4, "Pay"));
  outbox = startSave(outbox, base, "key-1");
  assert.equal(outbox.sending?.state, "waiting");
  assert.equal(outbox.sending?.key, "key-1");
  assert.equal(outbox.entries.length, 0);
  assert.equal(pendingCount(outbox), 1);
  // Editing continues while the batch is in flight: guards build on the batch's result.
  const behind = queue(outbox, base, rename(1, end, "Done"));
  outbox = behind.outbox;
  const before = optimistic(outbox, base);
  assert.equal(before.documentRevision, 6);
  outbox = acknowledged(outbox, "key-2");
  assert.equal(outbox.sending, null);
  assert.equal(outbox.base!.documentRevision, 5);
  assert.deepEqual(optimistic(outbox, base).document, before.document);
  // Once saved and re-read, the saved draft is shown again.
  const reread = { ...outbox.base!, layoutRevision: 4 };
  assert.equal(optimistic(startSave(outbox, base, "k"), reread).documentRevision, 6);
  assert.equal(optimistic(undo(outbox), reread), reread);
});

test("the outbox splits at the batch limits into sequential batches that apply like one", () => {
  const base = saved();
  let outbox = emptyOutbox;
  // Alternating fields never coalesce.
  for (let n = 0; n < 230; n++) outbox = queue(outbox, base, n % 2 ? describeNode(n + 1, start, `D${n}`) : rename(n + 1, start, `L${n}`)).outbox;
  assert.equal(outbox.entries.length, 230);
  const { changes } = build(base, outbox.entries);
  const batches = split({ ...changes, moves: [{ flowId, items: Array.from({ length: 1 }, () => ({ nodeId: end, expectedPositionVersion: 1, x: 1, y: 1 })) }] });
  assert.deepEqual(batches.map((batch) => batch.commands.length), [MAX_CHANGE_COMMANDS, MAX_CHANGE_COMMANDS, 30]);
  assert.equal(batches.at(-1)!.moves.length, 1, "moves ride with the last commands");
  const sequential = batches.reduce((draft, batch) => {
    const applied = applyChanges(draft, draft.documentRevision, parseChanges(wireBody(batch)));
    return { ...draft, document: applied.document, layout: applied.layout, documentRevision: applied.documentRevision };
  }, base);
  const once = applyChanges(base, base.documentRevision, { commands: changes.commands, moves: batches.at(-1)!.moves });
  assert.deepEqual(sequential.document, once.document);

  const many = Array.from({ length: 450 }, (_, n) => ({ nodeId: id(1000 + n), expectedPositionVersion: 1, x: n, y: n }));
  const moves = split({ commands: [], moves: [{ flowId, items: many }] });
  assert.deepEqual(moves.map((batch) => batch.moves.reduce((count, group) => count + group.items.length, 0)), [MAX_CHANGE_MOVES, MAX_CHANGE_MOVES, 50]);

  const big = "\u{1f642}".repeat(4000); // 16 KB of UTF-8 per command
  const heavy = Array.from({ length: 40 }, (_, n) => ({ command: describeNode(n + 1, start, big), proposedIds: [] }));
  const byBytes = split({ commands: heavy, moves: [] });
  assert.ok(byBytes.length > 1);
  for (const batch of byBytes) assert.ok(new TextEncoder().encode(JSON.stringify(wireBody(batch))).length <= CHANGES_BODY_LIMIT);
});

test("Apply my changes again replays on the newer saved draft with fresh guards and drops only what no longer applies", () => {
  const base = saved();
  let outbox = emptyOutbox;
  const newId = ids(10);
  let step = queue(outbox, base, addNode(4, "Pay"), newId);
  const payId = step.result.createdIds[0]!;
  outbox = queue(step.outbox, base, addEdge(5, start, end), newId).outbox;
  step = queue(outbox, base, rename(1, start, "Mine"), newId);
  outbox = addDrop(step.outbox, base, flowId, [{ nodeId: end, x: 70, y: 700 }, { nodeId: payId, x: 5, y: 5 }]);
  outbox = queue(outbox, base, { commandSchemaVersion: 1, command: "UPDATE_EDGE", expectedEntityVersion: 1, payload: { edgeId: id(11), condition: "Yes" } }, newId).outbox;
  outbox = startSave(outbox, base, "key-1");
  const names = optimistic(outbox, base).document;

  // Someone else renamed Start and deleted End (so the connection to it and End's move no longer apply).
  let theirs = { ...base };
  for (const command of [rename(1, start, "Theirs"), { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 5, payload: { flowId, nodeIds: [end], removeEdgeIds: [] } } as GraphCommand]) {
    const applied = applyGraphCommand(theirs, theirs.documentRevision, command, () => "unused");
    theirs = { ...theirs, document: applied.document, layout: applied.layout, documentRevision: theirs.documentRevision + 1 };
  }
  const rebased = rebase(outbox, theirs, names);
  assert.equal(rebased.base, theirs);
  assert.equal(rebased.sending, null);
  assert.deepEqual(rebased.dropped, ["Connection Mine → End", "Connection label “Yes”", "Move End"]);
  const shown = optimistic(rebased, theirs);
  assert.equal(shown.document.nodes[start]!.label, "Mine", "my rename is applied again over theirs");
  assert.equal(shown.document.nodes[payId]!.label, "Pay");
  assert.deepEqual([shown.layout.positions[payId]!.x, shown.layout.positions[payId]!.y], [5, 5]);
  const { changes } = build(theirs, rebased.entries);
  assert.deepEqual(changes.commands.map(({ command }) => "expectedDocumentRevision" in command ? command.expectedDocumentRevision : command.expectedEntityVersion), [6, 2]);
  assert.deepEqual(changes.commands[0]!.proposedIds, [payId], "created ids are kept");
  const server = applyChanges(theirs, theirs.documentRevision, parseChanges(wireBody(changes)));
  assert.deepEqual(server.document, shown.document);
});
