import assert from "node:assert/strict";
import test from "node:test";
import type { Changes } from "../src/features/drafts/contracts/changes.ts";
import type { GraphCommand } from "../src/features/drafts/contracts/commands.ts";
import { emptyDraft, LIMITS, type DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { applyGraphCommand, dependencyPlan, GraphError } from "../src/features/drafts/domain/graph.ts";
import { utf8Bytes } from "../src/features/drafts/contracts/strict.ts";
import {
  advance, applyBatch, build, emptyOutbox, enqueue, undo, wireBody, withEntries, addDrop, optimistic, type Outbox,
} from "../src/features/studio/ui/outbox.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (from: number) => { let next = from; return () => id(next++); };
const flowId = id(1), start = id(2), mid = id(3), end = id(4), edgeId = id(5);

/** Revision 6: one flow, Start (0,0), Mid (0,160), End (0,320), and a connection Start -> Mid. */
function saved(): DraftView {
  let draft = { ...emptyDraft() };
  let revision = 1;
  const apply = (command: GraphCommand, created: string[]) => {
    const queued = [...created];
    const applied = applyGraphCommand(draft, revision, command, () => queued.shift()!);
    draft = { document: applied.document, layout: applied.layout };
    revision += 1;
  };
  apply({ commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } }, [flowId]);
  for (const [n, [kind, label]] of [["START", "Start"], ["ACTION", "Mid"], ["OUTCOME", "End"]].entries()) {
    apply({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 2 + n, payload: { flowId, kind: kind as "START", label: label!, description: "", actorLabel: "" } }, [[start, mid, end][n]!]);
  }
  apply({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: 5, payload: { flowId, fromId: start, toId: mid, condition: "" } }, [edgeId]);
  return { id: id(99), status: "EDITABLE", documentRevision: revision, layoutRevision: 4, ...draft };
}

const G = 1 as const;
const rename = (version: number, nodeId: string, label: string): GraphCommand => ({ commandSchemaVersion: G, command: "UPDATE_NODE", expectedEntityVersion: version, payload: { nodeId, label } });
const addNode = (rev: number, label: string): GraphCommand => ({ commandSchemaVersion: G, command: "ADD_NODE", expectedDocumentRevision: rev, payload: { flowId, kind: "ACTION", label, description: "", actorLabel: "" } });
const deleteNode = (rev: number, nodeId: string): GraphCommand => ({ commandSchemaVersion: G, command: "DELETE_NODES", expectedDocumentRevision: rev, payload: { flowId, nodeIds: [nodeId], removeEdgeIds: [] } });

/** Another tab's saved change, applied exactly as the server applies a batch. */
function remote(view: DraftView, commands: GraphCommand[], moves: { nodeId: string; x: number; y: number }[] = [], newId = ids(900)): DraftView {
  const changes: Changes = {
    commands: commands.map((command) => ({ command, proposedIds: command.command === "ADD_NODE" || command.command === "ADD_EDGE" || command.command === "DUPLICATE_FLOW" || command.command === "CREATE_FLOW" ? [newId()] : [] })),
    moves: moves.length ? [{ flowId, items: moves.map(({ nodeId, x, y }) => ({ nodeId, expectedPositionVersion: view.layout.positions[nodeId]!.version, x, y })) }] : [],
  };
  return applyBatch(view, changes);
}

/** The local outbox path the provider uses: validate against the shown draft, then store the entries. */
function queue(outbox: Outbox, base: DraftView, command: GraphCommand, newId = ids(500)) {
  const queued = enqueue(outbox, base, command, newId);
  return { outbox: withEntries(outbox, base, queued.entries), created: queued.createdIds };
}

const same = (a: Outbox, b: Outbox) => assert.equal(a, b, "declined: the very same outbox comes back");

test("the reproduced case: pending A, remote B, then editing B at its shown version is admitted", () => {
  const base = saved();
  const outbox = queue(emptyOutbox, base, rename(1, start, "A")).outbox;
  const fresh = remote(base, [rename(1, end, "B")]);
  assert.throws(() => enqueue(outbox, fresh, rename(2, end, "B2")), (error: unknown) => error instanceof GraphError && error.code === "STALE_ENTITY_VERSION", "frozen it is refused locally");
  const next = advance(outbox, fresh);
  assert.equal(next.base, fresh);
  assert.deepEqual(next.entries, outbox.entries);
  assert.equal(optimistic(next, fresh).document.nodes[end]!.label, "B");
  const edited = enqueue(next, fresh, rename(2, end, "B2"));
  assert.equal(edited.entries.length, 2);
  // Every request the outbox can now send is what it captured: its guard is untouched.
  assert.deepEqual(build(fresh, edited.entries).changes.commands.map(({ command }) => command), [rename(1, start, "A"), rename(2, end, "B2")]);
});

test("a remote edit of the same record keeps the view frozen", () => {
  const base = saved();
  const outbox = queue(emptyOutbox, base, rename(1, start, "Mine")).outbox;
  same(advance(outbox, remote(base, [rename(1, start, "Theirs")])), outbox);
});

test("a pending document-guarded create is frozen by any remote document change, not by a remote move", () => {
  const base = saved();
  const outbox = queue(emptyOutbox, base, addNode(6, "Pay")).outbox;
  same(advance(outbox, remote(base, [rename(1, end, "Theirs")])), outbox);
  const moved = remote(base, [], [{ nodeId: end, x: 500, y: 500 }]);
  assert.equal(advance(outbox, moved).base, moved, "a layout-only change leaves the create's guard alone");
});

test("a pending drop is frozen when someone else moved that step, and advances when they moved another", () => {
  const base = saved();
  const outbox = addDrop(emptyOutbox, base, flowId, [{ nodeId: mid, x: 300, y: 300 }]);
  same(advance(outbox, remote(base, [], [{ nodeId: mid, x: 900, y: 900 }])), outbox);
  const unrelated = remote(base, [], [{ nodeId: end, x: 900, y: 900 }]);
  assert.equal(advance(outbox, unrelated).base, unrelated);
});

test("a move cancelled by a later delete: frozen through undo, redo cleared before the base advances", () => {
  const base = saved();
  const dropped = addDrop(emptyOutbox, base, flowId, [{ nodeId: end, x: 300, y: 300 }]);
  const both = queue(dropped, base, deleteNode(6, end)).outbox;
  const fresh = remote(base, [], [{ nodeId: end, x: 900, y: 900 }]);
  // The whole chain sends the same request on both bases (only the delete); the drop prefix does not.
  assert.deepEqual(wireBody(build(base, both.entries).changes), wireBody(build(fresh, both.entries).changes));
  same(advance(both, fresh), both);
  const undone = undo(both);
  same(advance(undone, fresh), undone);
  const nothing = undo(undone);
  const next = advance(nothing, fresh);
  assert.equal(next.base, fresh);
  assert.deepEqual(next.redo, [], "redo would switch back to the old guards, so it is discarded");
});

test("create, a joined drop back to the default spot, then delete: the create/drop prefix changes from zero moves to one", () => {
  const base = saved();
  const created = queue(emptyOutbox, base, addNode(6, "Pay"));
  const payId = created.created[0]!;
  const defaultAt = optimistic(created.outbox, base).layout.positions[payId]!;
  const dropped = addDrop(created.outbox, base, flowId, [{ nodeId: payId, x: defaultAt.x, y: defaultAt.y }], true);
  assert.equal(build(base, dropped.entries).changes.moves.length, 0, "a drop where it already is sends nothing");
  const all = queue(dropped, base, deleteNode(7, payId)).outbox;
  // Someone moved a neighbour lower, which moves the default spot: the same drop is now a real move.
  const fresh = remote(base, [], [{ nodeId: end, x: 0, y: 900 }]);
  assert.equal(build(fresh, dropped.entries).changes.moves.length, 1);
  assert.deepEqual(wireBody(build(base, all.entries).changes), wireBody(build(fresh, all.entries).changes), "the complete body still matches");
  same(advance(all, fresh), all);
  const undone = undo(all);
  same(advance(undone, fresh), undone);
  const next = advance(undo(undo(all)), fresh);
  assert.equal(next.base, fresh);
  assert.deepEqual(next.redo, []);
});

test("everything undone: a conflicting redo is cleared, an unrelated one survives", () => {
  const base = saved();
  const outbox = undo(queue(emptyOutbox, base, rename(1, start, "Mine")).outbox);
  assert.equal(outbox.entries.length, 0);
  const conflicting = remote(base, [rename(1, start, "Theirs")]);
  const cleared = advance(outbox, conflicting);
  assert.equal(cleared.base, conflicting);
  assert.deepEqual(cleared.redo, []);
  const unrelated = remote(base, [rename(1, end, "Theirs")]);
  const kept = advance(outbox, unrelated);
  assert.equal(kept.base, unrelated);
  assert.equal(kept.redo, outbox.redo);
});

test("advance declines with no base, while a save is pending, or for a read that is not newer", () => {
  const base = saved();
  const fresh = remote(base, [rename(1, end, "B")]);
  same(advance(emptyOutbox, fresh), emptyOutbox);
  const queued = queue(emptyOutbox, base, rename(1, start, "A")).outbox;
  const sending: Outbox = { ...queued, entries: [], sending: { draftId: base.id, key: "k", batches: [build(base, queued.entries).changes], state: "uncertain" } };
  same(advance(sending, fresh), sending);
  const older = { ...fresh, documentRevision: base.documentRevision - 1 };
  same(advance(queued, older), queued);
  assert.equal(advance(queued, { ...fresh, id: id(98) }), queued, "another draft is never adopted");
});

// ---------------------------------------------------------------------------------------------------------------
// The exhaustive correctness oracle. Every short local sequence, in every undo/redo-reachable state, against every
// remote change: after an accepted advance, EVERY joined-group boundary prefix that stays reachable (the active
// entries, and the redo chain when it is kept) must build a byte-identical request body and the same size verdict on
// both bases. The oracle has no caps; it defines what is safe, and the production algorithm may only be more careful.
// ---------------------------------------------------------------------------------------------------------------

type Op = { name: string; apply: (outbox: Outbox, base: DraftView, newId: () => string) => Outbox | null };

/** One validated command, queued as the provider does; null when it is refused or changes nothing. */
function command(outbox: Outbox, base: DraftView, make: (shown: DraftView) => GraphCommand, newId: () => string): { outbox: Outbox; created: string[] } | null {
  try {
    const queued = enqueue(outbox, base, make(optimistic(outbox, base)), newId);
    return queued.entries === outbox.entries ? null : { outbox: withEntries(outbox, base, queued.entries), created: queued.createdIds };
  } catch (error) {
    if (error instanceof GraphError) return null;
    throw error;
  }
}
const createdNodes = (outbox: Outbox, base: DraftView) => Object.keys(optimistic(outbox, base).document.nodes).filter((nodeId) => !(nodeId in base.document.nodes));
const versionOf = (shown: DraftView, nodeId: string) => shown.document.nodes[nodeId]?.version ?? 0;

const OPS: Op[] = [
  { name: "rename Start", apply: (o, b, n) => command(o, b, (s) => rename(versionOf(s, start), start, `S${n().slice(-3)}`), n)?.outbox ?? null },
  { name: "rename Mid", apply: (o, b, n) => command(o, b, (s) => rename(versionOf(s, mid), mid, `M${n().slice(-3)}`), n)?.outbox ?? null },
  { name: "move Mid", apply: (o, b) => addDrop(o, b, flowId, [{ nodeId: mid, x: 250, y: 250 }]) },
  { name: "move Start", apply: (o, b) => addDrop(o, b, flowId, [{ nodeId: start, x: 40, y: 40 }]) },
  { name: "add step", apply: (o, b, n) => command(o, b, (s) => addNode(s.documentRevision, "Pay"), n)?.outbox ?? null },
  {
    name: "add step, joined drop at its default spot",
    apply: (o, b, n) => {
      const added = command(o, b, (s) => addNode(s.documentRevision, "Pay"), n);
      const at = added && optimistic(added.outbox, b).layout.positions[added.created[0]!]!;
      return added && addDrop(added.outbox, b, flowId, [{ nodeId: added.created[0]!, x: at!.x, y: at!.y }], true);
    },
  },
  {
    name: "add step, joined drop elsewhere",
    apply: (o, b, n) => { const added = command(o, b, (s) => addNode(s.documentRevision, "Pay"), n); return added && addDrop(added.outbox, b, flowId, [{ nodeId: added.created[0]!, x: 700, y: 700 }], true); },
  },
  { name: "rename last created", apply: (o, b, n) => { const last = createdNodes(o, b).at(-1); return last ? command(o, b, (s) => rename(versionOf(s, last), last, "Renamed"), n)?.outbox ?? null : null; } },
  { name: "move last created", apply: (o, b) => { const last = createdNodes(o, b).at(-1); return last ? addDrop(o, b, flowId, [{ nodeId: last, x: 90, y: 90 }]) : null; } },
  { name: "delete last created", apply: (o, b, n) => { const last = createdNodes(o, b).at(-1); return last ? command(o, b, (s) => deleteNode(s.documentRevision, last), n)?.outbox ?? null : null; } },
  { name: "delete End", apply: (o, b, n) => command(o, b, (s) => deleteNode(s.documentRevision, end), n)?.outbox ?? null },
  { name: "add connection Start -> End", apply: (o, b, n) => command(o, b, (s) => ({ commandSchemaVersion: G, command: "ADD_EDGE", expectedDocumentRevision: s.documentRevision, payload: { flowId, fromId: start, toId: end, condition: "" } }), n)?.outbox ?? null },
  { name: "reconnect connection to End", apply: (o, b, n) => command(o, b, (s) => ({ commandSchemaVersion: G, command: "RECONNECT_EDGE", expectedDocumentRevision: s.documentRevision, payload: { edgeId, fromId: start, toId: end } }), n)?.outbox ?? null },
  { name: "delete connection", apply: (o, b, n) => command(o, b, (s) => ({ commandSchemaVersion: G, command: "DELETE_EDGE", expectedDocumentRevision: s.documentRevision, payload: { edgeId } }), n)?.outbox ?? null },
  { name: "duplicate flow", apply: (o, b, n) => command(o, b, (s) => ({ commandSchemaVersion: G, command: "DUPLICATE_FLOW", expectedDocumentRevision: s.documentRevision, payload: { flowId } }), n)?.outbox ?? null },
];

// Runtime bound: the third step is drawn from the operations that interact through created steps, drops and deletes.
const CORE = OPS.filter(({ name }) => ["move Mid", "add step, joined drop at its default spot", "add step, joined drop elsewhere", "move last created", "delete last created"].includes(name));

function remotes(base: DraftView): { name: string; fresh: DraftView }[] {
  const on = (name: string, commands: GraphCommand[], moves: { nodeId: string; x: number; y: number }[] = []) => ({ name, fresh: remote(base, commands, moves) });
  const rev = base.documentRevision;
  return [
    { name: "nothing changed", fresh: { ...base } },
    on("rename Start", [rename(1, start, "Theirs")]),
    on("rename Mid", [rename(1, mid, "Theirs")]),
    on("move Start", [], [{ nodeId: start, x: 400, y: 400 }]),
    on("move Mid", [], [{ nodeId: mid, x: 400, y: 400 }]),
    on("move End lower", [], [{ nodeId: end, x: 0, y: 900 }]),
    on("delete End", [deleteNode(rev, end)]),
    on("add step", [addNode(rev, "Theirs")]),
    on("reconnect connection", [{ commandSchemaVersion: G, command: "RECONNECT_EDGE", expectedDocumentRevision: rev, payload: { edgeId, fromId: start, toId: end } }]),
    on("delete connection", [{ commandSchemaVersion: G, command: "DELETE_EDGE", expectedDocumentRevision: rev, payload: { edgeId } }]),
    on("rename Mid and move End", [rename(1, mid, "Theirs")], [{ nodeId: end, x: 0, y: 900 }]),
  ];
}

const requests = (view: DraftView, entries: Outbox["entries"]) => {
  const built = build(view, entries);
  return { body: JSON.stringify(wireBody(built.changes)), over: built.overLimit, skipped: built.skipped.length };
};

/** All undo/redo-reachable states of one sequence: none undone, then one unit undone at a time. */
function reachable(full: Outbox): Outbox[] {
  const states = [full];
  while (states.at(-1)!.entries.length) states.push(undo(states.at(-1)!));
  return states;
}

/** The oracle: which joined-group boundary ends of the chain send the same request on both bases. */
function matchingEnds(chain: Outbox["entries"], base: DraftView, fresh: DraftView) {
  const matches = new Map<number, boolean>();
  let skippedPrefixes = 0;
  for (let end = 1; end <= chain.length; end++) {
    if (end !== chain.length && chain[end]!.joined) continue;
    const before = requests(base, chain.slice(0, end)), after = requests(fresh, chain.slice(0, end));
    matches.set(end, before.over === after.over && before.body === after.body);
    if (before.skipped || after.skipped) skippedPrefixes++;
  }
  return { matches, skippedPrefixes };
}

test("exhaustive oracle: every reachable prefix kept after an advance sends the same request on both bases", () => {
  const base = saved();
  const counts = { sequences: 0, cases: 0, advanced: 0, keptRedo: 0, clearedRedo: 0, declined: 0, conservativeRefusals: 0, unsafe: 0, prefixesChecked: 0, skippedCommandPrefixes: 0 };
  const alternatives = remotes(base);
  // Refused commands are expected millions of times here; capturing a stack for each GraphError dominates the run.
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  const visit = (outbox: Outbox, depth: number) => {
    if (outbox.entries.length) {
      counts.sequences++;
      for (const { fresh } of alternatives) {
        const { matches, skippedPrefixes } = matchingEnds(outbox.entries, base, fresh);
        counts.prefixesChecked += matches.size;
        counts.skippedCommandPrefixes += skippedPrefixes;
        for (const state of reachable(outbox)) {
          const activeEnd = state.entries.length;
          const activeOk = [...matches].filter(([end]) => end <= activeEnd).every(([, ok]) => ok);
          const redoOk = [...matches].filter(([end]) => end > activeEnd).every(([, ok]) => ok);
          const next = advance(state, fresh);
          counts.cases++;
          if (next === state) {
            counts.declined++;
            if (activeOk) counts.conservativeRefusals++;
            continue;
          }
          counts.advanced++;
          if (!activeOk || (next.redo.length > 0 && !redoOk) || next.base !== fresh || next.entries !== state.entries) counts.unsafe++;
          if (next.redo.length > 0) counts.keptRedo++;
          if (state.redo.length && !next.redo.length) { counts.clearedRedo++; if (redoOk) counts.conservativeRefusals++; }
        }
      }
    }
    if (depth === 3) return;
    const newId = ids(500 + depth * 60);
    for (const op of depth < 2 ? OPS : CORE) {
      const next = op.apply(outbox, base, newId);
      if (next && next.entries !== outbox.entries) visit(next, depth + 1);
    }
  };
  try { visit({ ...emptyOutbox, base }, 0); } finally { Error.stackTraceLimit = stackLimit; }
  console.log(`advance oracle: ${JSON.stringify(counts)}`);
  assert.equal(counts.unsafe, 0);
  assert.equal(counts.conservativeRefusals, 0, "with no caps, nothing provable is refused");
  // The space actually exercised every outcome, including prefixes that skip a command that no longer applies.
  for (const key of ["advanced", "keptRedo", "clearedRedo", "declined", "skippedCommandPrefixes"] as const) assert.ok(counts[key] > 0, key);
});

// ---------------------------------------------------------------------------------------------------------------
// Near the 2 MiB draft limit. Applying a whole chain in place checks the size once, at the end, so a later delete can
// make the complete chain fit while an intermediate create or duplicate prefix does not (and that prefix is what a
// person reaches by undoing the delete). Such a prefix can fit on only one of the two bases.
// ---------------------------------------------------------------------------------------------------------------

const LIMIT = LIMITS.documentBytes;
const sizeOf = (view: DraftView) => utf8Bytes(view.document);
const nodeAt = (n: number) => id(1000 + n);
const flow2 = id(50);

/**
 * A valid draft whose document is exactly `LIMIT - spare` bytes: a source flow of ten fat steps (the one duplicated),
 * and a second flow of padding steps, the last one tuned byte by byte.
 */
function nearLimit(spare: number): DraftView {
  const { document, layout } = emptyDraft();
  const flow = (flowKey: string) => {
    document.flows[flowKey] = { id: flowKey, version: 1, behaviourVersion: 1, title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null };
    layout.directions[flowKey] = "TB";
  };
  const step = (n: number, flowKey: string, description: string, notes: string[] = []) => {
    document.nodes[nodeAt(n)] = { id: nodeAt(n), flowId: flowKey, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Step", description, actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: notes };
    layout.positions[nodeAt(n)] = { x: n * 10, y: n * 10, version: 1 };
  };
  flow(flowId);
  flow(flow2);
  for (let n = 0; n < 10; n++) step(n, flowId, "ệ".repeat(4_000), Array.from({ length: 20 }, () => "ệ".repeat(500)));
  step(500, flow2, "ệ".repeat(500)); // the slack step other tabs' saves resize (see `resized`)
  let n = 10;
  const target = LIMIT - spare;
  while (utf8Bytes(document) + 12_400 < target) step(n++, flow2, "ệ".repeat(4_000));
  const tuned = n;
  step(tuned, flow2, "");
  const rest = target - utf8Bytes(document);
  document.nodes[nodeAt(tuned)]!.description = "ệ".repeat(Math.floor(rest / 3)) + "a".repeat(rest % 3);
  const view: DraftView = { id: id(97), status: "EDITABLE", documentRevision: 10, layoutRevision: 1, document, layout };
  assert.equal(sizeOf(view), target);
  return view;
}
/** What one command adds to the document, measured on a roomy twin. */
const growth = (command: GraphCommand) => {
  const roomy = nearLimit(700_000);
  const applied = applyGraphCommand(roomy, roomy.documentRevision, command, ids(700));
  return utf8Bytes(applied.document) - sizeOf(roomy);
};
/**
 * The same revisions with a document exactly `bytes` larger (or smaller, when negative). Real saves also move the
 * revision, which alone freezes a document-guarded create; holding it still isolates the size verdict, and the oracle
 * property is about what the pure function sends for the two drafts it is given.
 */
const resized = (view: DraftView, bytes: number): DraftView => {
  const node = view.document.nodes[nodeAt(500)]!;
  const description = bytes >= 0 ? node.description + "a".repeat(bytes) : node.description.slice(0, node.description.length + bytes / 3);
  return { ...view, document: { ...view.document, nodes: { ...view.document.nodes, [node.id]: { ...node, description } } } };
};
const chainOf = (base: DraftView, first: GraphCommand, second: (created: string[], shown: DraftView) => GraphCommand) => {
  const created = command(emptyOutbox, base, () => first, ids(800))!;
  const deleted = command(created.outbox, base, (shown) => second(created.created, shown), ids(800))!;
  return deleted.outbox;
};
const dupFlow: GraphCommand = { commandSchemaVersion: G, command: "DUPLICATE_FLOW", expectedDocumentRevision: 10, payload: { flowId } };
const deleteCopy = (created: string[], shown: DraftView): GraphCommand => {
  const plan = dependencyPlan(shown.document, created[0]!);
  return { commandSchemaVersion: G, command: "DELETE_FLOW", expectedDocumentRevision: shown.documentRevision, payload: { flowId: created[0]!, removeNodeIds: plan.nodeIds, removeEdgeIds: plan.edgeIds } };
};

for (const [name, first, second] of [
  ["a created step", addNode(10, "Pay"), (created: string[], shown: DraftView) => deleteNode(shown.documentRevision, created[0]!)],
  ["a duplicated flow", dupFlow, deleteCopy],
] as const) {
  test(`near the size limit, ${name} that fits on one base only: the delete makes the whole chain fit, the prefix does not`, () => {
    const need = growth(first);
    assert.ok(need > 100, "the step or copy is bigger than the adjustment below");
    const roomy = nearLimit(need + 50);
    const chain = chainOf(roomy, first, second);
    assert.equal(chain.entries.length, 2);
    const undone = undo(chain), nothing = undo(undone);

    // Expansion: someone else's save leaves too little room for the create, but the create-then-delete chain still fits.
    const tight = resized(roomy, 100);
    assert.equal(build(tight, chain.entries.slice(0, 1)).skipped.length, 1, "the create prefix no longer applies on the fuller draft");
    assert.equal(build(roomy, chain.entries.slice(0, 1)).skipped.length, 0);
    assert.equal(JSON.stringify(wireBody(build(roomy, chain.entries).changes)), JSON.stringify(wireBody(build(tight, chain.entries).changes)), "the complete body is identical on both");
    assert.equal(advance(chain, tight), chain);
    assert.equal(advance(undone, tight), undone, "undoing the delete reaches the prefix");
    const cleared = advance(nothing, tight);
    assert.equal(cleared.base, tight);
    assert.deepEqual(cleared.redo, [], "the redo chain would cross the limit only on the new base");

    // Shrink: the chain sits on a base too full for the create, and the newer draft has room again.
    const fuller = nearLimit(need - 60);
    const onFuller: Outbox = { ...chain, base: fuller }, nothingOnFuller = undo(undo(onFuller));
    const emptied = resized(fuller, -300);
    assert.equal(build(fuller, chain.entries.slice(0, 1)).skipped.length, 1);
    assert.equal(build(emptied, chain.entries.slice(0, 1)).skipped.length, 0, "the shrink lets the create fit");
    assert.equal(JSON.stringify(wireBody(build(fuller, chain.entries).changes)), JSON.stringify(wireBody(build(emptied, chain.entries).changes)), "the complete body is identical on both");
    assert.equal(advance(onFuller, emptied), onFuller);
    const undoneOnFuller = undo(onFuller);
    assert.equal(advance(undoneOnFuller, emptied), undoneOnFuller, "undoing the delete reaches the prefix");
    const cleared2 = advance(nothingOnFuller, emptied);
    assert.equal(cleared2.base, emptied);
    assert.deepEqual(cleared2.redo, []);
  });
}

test("the size verdict itself must match: a drop that is refused on one base and sendable on the other freezes the view", () => {
  const good = saved();
  const bad: DraftView = { ...good, documentRevision: good.documentRevision + 1, document: { ...good.document, nodes: { ...good.document.nodes, [end]: { ...good.document.nodes[end]!, description: "ệ".repeat(60_000) } } } };
  const outbox = addDrop(emptyOutbox, good, flowId, [{ nodeId: mid, x: 300, y: 300 }]);
  assert.equal(build(bad, outbox.entries).overLimit, true);
  assert.equal(advance(outbox, bad), outbox, "expansion: the newer draft would refuse the drop");
  const stuck = addDrop(emptyOutbox, bad, flowId, [{ nodeId: mid, x: 300, y: 300 }]);
  const recovered = { ...good, documentRevision: good.documentRevision + 2 };
  assert.equal(build(recovered, stuck.entries).overLimit, false);
  assert.equal(advance(stuck, recovered), stuck, "shrink: the drop is sendable on the newer draft, which is not the request the person was shown");
});

test("a shown chain that is over the size limit on the newer draft as well stays frozen", () => {
  const good = saved();
  const bad = (revision: number): DraftView => ({ ...good, documentRevision: revision, document: { ...good.document, nodes: { ...good.document.nodes, [end]: { ...good.document.nodes[end]!, description: "ệ".repeat(60_000) } } } });
  const outbox = addDrop(emptyOutbox, bad(good.documentRevision), flowId, [{ nodeId: mid, x: 300, y: 300 }]);
  assert.equal(build(bad(good.documentRevision + 1), outbox.entries).overLimit, true);
  assert.equal(advance(outbox, bad(good.documentRevision + 1)), outbox);
});

// ---------------------------------------------------------------------------------------------------------------
// Production admission cost. The oracle above is unbounded and is NOT the production path; this measures the bounded
// one: at most 16 prefix pairs, and at most 8 MiB of combined serialized (base + fresh) input charged per pair.
// ---------------------------------------------------------------------------------------------------------------

/** A view whose top-level copies are counted: JSON sizing copies it once and every build copies it once. */
function counted(view: DraftView) {
  let copies = 0;
  return { view: new Proxy(view, { ownKeys(target) { copies++; return Reflect.ownKeys(target); } }), builds: () => copies - 1 };
}
const asRename = (nodeId: string, version: number, label = `L${version}`): Outbox["entries"][number] => ({ kind: "command", command: rename(version, nodeId, label), proposedIds: [] });
/** `units` non-joined changes, each a rename of a different step (the first `moves` of them followed by a joined drop). */
const renames = (nodeIds: string[], units: number, moves = 0): Outbox["entries"] => Array.from({ length: units }, (_, i) => {
  const nodeId = nodeIds[i % nodeIds.length]!, version = 1 + Math.floor(i / nodeIds.length);
  return [asRename(nodeId, version), ...(i < moves ? [{ kind: "drop" as const, flowId: flow2, items: [{ nodeId, x: 5 + i, y: 5 }], joined: true as const }] : [])];
}).flat();
/** The saved draft plus fat steps (12 KB each), for a draft of a chosen size that is still valid. */
const fattened = (steps: number): DraftView => {
  const view = saved();
  const nodes = { ...view.document.nodes }, positions = { ...view.layout.positions };
  for (let n = 0; n < steps; n++) {
    nodes[nodeAt(n)] = { id: nodeAt(n), flowId, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Step", description: "ệ".repeat(4_000), actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
    positions[nodeAt(n)] = { x: n, y: n, version: 1 };
  }
  return { ...view, document: { ...view.document, nodes }, layout: { ...view.layout, positions } };
};
const MAX_PAIRS = 16, BUDGET = 8 * 1024 * 1024;

/** Runs advance three times and reports the slowest (main-thread) run, with the copies each base saw. */
function measure(outbox: Outbox, fresh: DraftView) {
  let worst = 0, declined = false, advanced: Outbox = outbox;
  const pair = utf8Bytes(outbox.base) + utf8Bytes(fresh);
  let builds = { base: 0, fresh: 0 };
  for (let run = 0; run < 3; run++) {
    const [base, next] = [counted(outbox.base!), counted(fresh)];
    const started = performance.now();
    const given = { ...outbox, base: base.view };
    advanced = advance(given, next.view);
    worst = Math.max(worst, performance.now() - started);
    declined = advanced === given;
    builds = { base: base.builds(), fresh: next.builds() };
  }
  return { result: advanced, declined, ms: worst, builds, pair, allowed: Math.min(MAX_PAIRS, Math.floor(BUDGET / pair)) };
}
const measured: string[] = [];
const report = (name: string, m: ReturnType<typeof measure>) => { measured.push(`${name}: ${m.ms.toFixed(0)} ms, ${m.builds.base} prefix pairs (allowed ${m.allowed}), pair ${(m.pair / 1024).toFixed(0)} KiB`); };

test("cost is bounded: each prefix pair is built once, within 16 pairs and 8 MiB of serialized input", () => {
  const slack = rename(1, nodeAt(500), "Theirs");

  // A draft at the 2 MiB limit: base + fresh serialize to a little over 4 MiB, so the 8 MiB budget pays for one pair. The
  // first prefix is proved, the second is not: two active units stay frozen.
  const big = nearLimit(1_000);
  const bigNext = remote(big, [slack]);
  const stepIds = Array.from({ length: 40 }, (_, i) => nodeAt(10 + i));
  const heavy: Outbox = { ...emptyOutbox, base: big, entries: renames(stepIds, 40) };
  let m = measure(heavy, bigNext);
  report("2 MiB draft, 40 active units (frozen by the byte budget)", m);
  assert.equal(m.allowed, 1);
  assert.equal(m.builds.base, 1, "no second pair is started");
  assert.equal(m.builds.fresh, 1);
  assert.ok(m.declined);

  // One active unit with a drop (its prefix builds moves and runs the final size check on both bases): advances.
  const one: Outbox = { ...emptyOutbox, base: big, entries: renames(stepIds, 1, 1) };
  m = measure(one, bigNext);
  report("2 MiB draft, 1 active unit with a drop (advances)", m);
  assert.equal(m.builds.base, 1);
  assert.equal(m.result.base?.documentRevision, bigNext.documentRevision);

  // One active unit and a long redo: the budget proves the active prefix only. Unproved redo would switch back to an
  // obsolete base, so it is cleared rather than kept.
  const units = renames(stepIds, 40).map((entry) => [entry]);
  const redoHeavy: Outbox = { ...emptyOutbox, base: big, entries: units[0]!, redo: units.slice(1).reverse() };
  m = measure(redoHeavy, bigNext);
  report("2 MiB draft, 1 active unit + 39 redo units (redo cleared)", m);
  assert.equal(m.builds.base, 1);
  assert.equal(m.result.base?.documentRevision, bigNext.documentRevision);
  assert.deepEqual(m.result.redo, [], "unproved redo does not survive the advance");
  assert.equal(m.result.entries, redoHeavy.entries);

  // A 1.9 MiB draft pays for two pairs.
  const near = nearLimit(150_000), nearNext = remote(near, [slack]);
  m = measure({ ...emptyOutbox, base: near, entries: renames(stepIds, 2, 2) }, nearNext);
  report("1.9 MiB draft, 2 active units with drops (advances)", m);
  assert.equal(m.allowed, 2);
  assert.equal(m.builds.base, 2);
  assert.equal(m.result.base?.documentRevision, nearNext.documentRevision);
  m = measure({ ...emptyOutbox, base: near, entries: renames(stepIds, 3) }, nearNext);
  assert.equal(m.builds.base, 2, "a third active unit is unproved");
  assert.ok(m.declined);

  // A small draft: the 16-pair cap binds. 40 active units are frozen; 10 active plus 30 redo advance with redo cleared.
  const small = saved(), smallNext = remote(small, [rename(1, end, "Theirs")]);
  const long = renames([start, mid], 40), longUnits = long.map((entry) => [entry]);
  m = measure({ ...emptyOutbox, base: small, entries: long }, smallNext);
  report("small draft, 40 active units (frozen by the 16-pair cap)", m);
  assert.equal(m.builds.base, MAX_PAIRS);
  assert.equal(m.builds.fresh, MAX_PAIRS);
  assert.ok(m.declined);
  const split10: Outbox = { ...emptyOutbox, base: small, entries: longUnits.slice(0, 10).flat(), redo: longUnits.slice(10).reverse() };
  m = measure(split10, smallNext);
  report("small draft, 10 active + 30 redo units (redo cleared)", m);
  assert.equal(m.builds.base, MAX_PAIRS);
  assert.equal(m.result.base?.documentRevision, smallNext.documentRevision);
  assert.deepEqual(m.result.redo, []);
  const fits: Outbox = { ...emptyOutbox, base: small, entries: longUnits.slice(0, 10).flat(), redo: longUnits.slice(10, 14).reverse() };
  m = measure(fits, smallNext);
  report("small draft, 10 active + 4 redo units (all proved, redo kept)", m);
  assert.equal(m.builds.base, 14, "one pair per reachable prefix, none rebuilt for the full-chain check");
  assert.equal(m.result.redo.length, 4);

  // A 256 KiB draft: the 16-pair cap still binds and the byte budget does not (16 x 0.5 MiB), the costliest mid-size
  // shape: 16 units, each followed by a drop, on a draft that must be validated again for every prefix.
  const midSized = fattened(21), midNext = remote(midSized, [rename(1, end, "Theirs")]);
  const midOutbox: Outbox = { ...emptyOutbox, base: midSized, entries: renames([start, nodeAt(0)], 16, 16).map((entry) => (entry.kind === "drop" ? { ...entry, flowId } : entry)) };
  m = measure(midOutbox, midNext);
  report("256 KiB draft, 16 units with drops (16 pairs, advances)", m);
  assert.equal(m.builds.base, MAX_PAIRS);
  assert.equal(m.result.base?.documentRevision, midNext.documentRevision);

  // The fallback path: every command is stale on both drafts, so each prefix is applied command by command (skipped,
  // reported as no longer applying) on both bases, and the drops still run the final size check.
  const stale = midOutbox.entries.map((entry) => (entry.kind === "command" && entry.command.command === "UPDATE_NODE" ? { ...entry, command: { ...entry.command, expectedEntityVersion: 99 } } : entry));
  m = measure({ ...midOutbox, entries: stale }, midNext);
  report("256 KiB draft, 16 units with drops, every command stale on both (fallback path)", m);
  assert.equal(m.builds.base, MAX_PAIRS);
  assert.equal(m.result.base?.documentRevision, midNext.documentRevision);

  console.log(`advance cost, worst of 3 runs each:\n  ${measured.join("\n  ")}`);
});
