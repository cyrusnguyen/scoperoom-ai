import { CHANGES_BODY_LIMIT, MAX_CHANGE_COMMANDS, MAX_CHANGE_MOVES, type Change, type Changes, type MoveGroup } from "../../drafts/contracts/changes.ts";
import type { GraphCommand } from "../../drafts/contracts/commands.ts";
import type { MoveItem } from "../../drafts/contracts/positions.ts";
import type { DraftView, ScopeDocument } from "../../drafts/contracts/scope-document.ts";
import { applyChanges } from "../../drafts/domain/changes.ts";
import { applyGraphCommand, checkDraft, GraphError } from "../../drafts/domain/graph.ts";
import { moveNodes } from "../../drafts/domain/moves.ts";
import { stepName } from "./graph-view.ts";

// The Studio's local outbox (Stage 03.3 Task 14b): every draft change is applied locally first and saved later with
// one POST D/changes (Save, the 10-second autosave, or before Arrange and switches). The browser replays the outbox
// with the server's own pure functions and the ids it proposed, so what is shown is exactly what the save produces.

export type Placement = { nodeId: string; x: number; y: number };
/**
 * One unsaved change, in order: a command with the ids it creates, or one drop of steps. `joined` binds a change to
 * the one before it for undo (a shape's drop point belongs to the step it created).
 */
export type Entry =
  | { kind: "command"; command: GraphCommand; proposedIds: string[]; joined?: true }
  | { kind: "drop"; flowId: string; items: Placement[]; joined?: true };
/**
 * The segment being saved: its requests in order (one unless it was over the batch limits), each all-or-nothing, and
 * the current one's key. `waiting`: not sent yet; `uncertain`: retried only with the same key and body; `refused`:
 * waits for "Apply my changes again" or "Discard my changes".
 */
export type Sending = { draftId: string; key: string; batches: Changes[]; state: "waiting" | "sending" | "uncertain" | "refused"; code?: string; message?: string };
/**
 * `base` is the saved draft the chain builds on; `entries` are unsent changes behind `sending`; `redo` holds undone
 * changes (cleared by any new change or save); `dropped` lists what the last "Apply my changes again" had to leave out.
 */
export type Outbox = { base: DraftView | null; sending: Sending | null; entries: Entry[]; redo: Entry[][]; dropped: string[] };
export const emptyOutbox: Outbox = { base: null, sending: null, entries: [], redo: [], dropped: [] };

/** A later read of the same draft: neither revision went backwards. Late responses fail this and are dropped. */
export function isNewer(candidate: DraftView, current: DraftView): boolean {
  return candidate.id === current.id && candidate.documentRevision >= current.documentRevision && candidate.layoutRevision >= current.layoutRevision;
}

/**
 * What unsaved changes build on. With nothing unsaved it is the saved draft, except just after a save whose re-read
 * has not landed (or failed): the locally replayed result of that save stays shown until a read catches up.
 */
export function baseOf(outbox: Outbox, saved: DraftView): DraftView {
  const { base } = outbox;
  if (!base) return saved;
  if (outbox.sending || outbox.entries.length) return base;
  return base.id === saved.id && !isNewer(saved, base) ? base : saved;
}

/** One batch exactly as the server applies it: documentRevision per effective command, layoutRevision once. */
export function applyBatch(view: DraftView, changes: Changes): DraftView {
  const applied = applyChanges(view, view.documentRevision, changes);
  return { ...view, document: applied.document, layout: applied.layout, documentRevision: applied.documentRevision, layoutRevision: view.layoutRevision + (applied.layoutChanged ? 1 : 0) };
}

const commandsOf = (entries: Entry[]): Change[] => entries.flatMap((entry) => (entry.kind === "command" ? [{ command: entry.command, proposedIds: entry.proposedIds }] : []));

function applyCommands(view: DraftView, commands: Change[]) {
  try {
    const applied = applyChanges(view, view.documentRevision, { commands, moves: [] });
    return { kept: commands, skipped: [] as Change[], document: applied.document, layout: applied.layout, documentRevision: applied.documentRevision, layoutChanged: applied.layoutChanged };
  } catch (error) {
    if (!(error instanceof GraphError)) throw error;
    // A queued command is checked against the state it is replayed on, so this only runs if that state changed under
    // it (or the whole chain would go over a size limit). Whatever no longer applies is skipped and reported, never
    // dropped silently: the Studio lists it and a save leaves it out.
    let current = { document: view.document, layout: view.layout, documentRevision: view.documentRevision, layoutChanged: false };
    const kept: Change[] = [], skipped: Change[] = [];
    for (const change of commands) {
      try {
        const applied = applyChanges(current, current.documentRevision, { commands: [change], moves: [] });
        current = { document: applied.document, layout: applied.layout, documentRevision: applied.documentRevision, layoutChanged: current.layoutChanged || applied.layoutChanged };
        kept.push(change);
      } catch (inner) { if (!(inner instanceof GraphError)) throw inner; skipped.push(change); }
    }
    return { kept, skipped, ...current };
  }
}

export type Built = { changes: Changes; draft: DraftView; skipped: Change[]; overLimit: boolean };

/**
 * The batch for a chain of unsent changes and its result. Commands come first, then every moved step's final spot,
 * guarded by the position version the commands left it at (a step created here is at version 1). Steps no longer in
 * the document, or dropped back where they are, send nothing. `skipped` lists commands that no longer apply;
 * `overLimit` is the server's own final size check (after the moves) failing, so such a batch is never sent.
 */
export function build(view: DraftView, entries: Entry[]): Built {
  const commands = commandsOf(entries);
  const applied = commands.length ? applyCommands(view, commands) : { kept: [], skipped: [], document: view.document, layout: view.layout, documentRevision: view.documentRevision, layoutChanged: false };
  const final = new Map<string, Placement>();
  for (const entry of entries) if (entry.kind === "drop") for (const item of entry.items) final.set(item.nodeId, item);
  const groups = new Map<string, MoveItem[]>();
  for (const { nodeId, x, y } of final.values()) {
    const node = applied.document.nodes[nodeId], at = applied.layout.positions[nodeId];
    if (!node || !at || (at.x === x && at.y === y)) continue;
    groups.set(node.flowId, [...(groups.get(node.flowId) ?? []), { nodeId, expectedPositionVersion: at.version, x, y }]);
  }
  const moves: MoveGroup[] = [...groups].map(([flowId, items]) => ({ flowId, items }));
  let layout = applied.layout;
  for (const group of moves) layout = moveNodes({ document: applied.document, layout }, { mode: "MOVE_NODES", ...group }, { check: false }).layout;
  const draft = {
    ...view, document: applied.document, layout, documentRevision: applied.documentRevision,
    layoutRevision: view.layoutRevision + (applied.layoutChanged || moves.length ? 1 : 0),
  };
  // The commands were checked by applyChanges; the server checks the final draft again after the moves.
  let overLimit = false;
  if (moves.length) {
    try { checkDraft(draft); } catch (error) { if (!(error instanceof GraphError)) throw error; overLimit = true; }
  }
  return { changes: { commands: applied.kept, moves }, draft, skipped: applied.skipped, overLimit };
}

export type Replayed = { draft: DraftView; skipped: string[]; overLimit: boolean };

/**
 * What every view shows: the saved draft with the segment being saved and the unsent changes replayed on it, plus a
 * description of anything that no longer applies (so it is listed, not silently missing) and the final size check.
 */
export function replay(outbox: Outbox, saved: DraftView): Replayed {
  let view = baseOf(outbox, saved);
  const names = view.document;
  const skipped: string[] = [];
  for (const batch of outbox.sending?.batches ?? []) {
    try { view = applyBatch(view, batch); } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      skipped.push(...batch.commands.map(({ command }) => describe(command, names)));
    }
  }
  if (!outbox.entries.length) return { draft: view, skipped, overLimit: false };
  const built = build(view, outbox.entries);
  return { draft: built.draft, skipped: [...skipped, ...built.skipped.map(({ command }) => describe(command, names))], overLimit: built.overLimit };
}

export function optimistic(outbox: Outbox, saved: DraftView): DraftView {
  return replay(outbox, saved).draft;
}

export type Enqueued = { entries: Entry[]; createdIds: string[]; versions: Record<string, number>; retiredIds: string[]; documentRevision: number };

const UPDATES = new Set(["UPDATE_FLOW", "UPDATE_NODE", "UPDATE_EDGE"]);
const recordId = (payload: object) => { const { flowId, nodeId, edgeId } = payload as Record<string, string | undefined>; return nodeId ?? edgeId ?? flowId; };
const sameKeys = (a: object, b: object) => Object.keys(a).sort().join() === Object.keys(b).sort().join();

/** Consecutive edits of the same fields of the same record become one command (and one undo step). */
function coalesces(last: Entry | undefined, command: GraphCommand): last is Extract<Entry, { kind: "command" }> {
  return last?.kind === "command" && !last.joined && UPDATES.has(command.command) && last.command.command === command.command
    && recordId(last.command.payload) === recordId(command.payload) && sameKeys(last.command.payload, command.payload);
}

/**
 * Checks a command against the shown (optimistic) draft and returns the new unsent chain. A refusal throws the same
 * GraphError the server would send. Created ids are generated here and are final: the save proposes them.
 */
export function enqueue(outbox: Outbox, saved: DraftView, command: GraphCommand, newId: () => string = () => crypto.randomUUID()): Enqueued {
  const current = optimistic(outbox, saved);
  const applied = applyGraphCommand(current, current.documentRevision, command, newId);
  if (!applied.documentChanged) return { entries: outbox.entries, createdIds: [], versions: {}, retiredIds: [], documentRevision: current.documentRevision };
  const last = outbox.entries.at(-1);
  if (coalesces(last, command)) {
    const earlier = outbox.entries.slice(0, -1);
    const merged = { ...last.command, payload: { ...last.command.payload, ...command.payload } } as GraphCommand;
    const before = optimistic({ ...outbox, entries: earlier }, saved);
    const again = applyGraphCommand(before, before.documentRevision, merged, () => { throw new Error("NO_IDS"); });
    if (!again.documentChanged) return { entries: earlier, createdIds: [], versions: {}, retiredIds: [], documentRevision: before.documentRevision };
    return { entries: [...earlier, { kind: "command", command: merged, proposedIds: [] }], createdIds: [], versions: again.versions, retiredIds: [], documentRevision: before.documentRevision + 1 };
  }
  return {
    entries: [...outbox.entries, { kind: "command", command, proposedIds: applied.createdIds }],
    createdIds: applied.createdIds, versions: applied.versions, retiredIds: applied.retiredIds, documentRevision: current.documentRevision + 1,
  };
}

/** Stores a new unsent chain. Any new change ends what could be redone. */
export function withEntries(outbox: Outbox, saved: DraftView, entries: Entry[]): Outbox {
  return { ...outbox, base: baseOf(outbox, saved), entries, redo: [] };
}

/** One drop of steps (a drag, the position form, or a new shape's drop point when `joined`). */
export function addDrop(outbox: Outbox, saved: DraftView, flowId: string, items: Placement[], joined = false): Outbox {
  return withEntries(outbox, saved, [...outbox.entries, { kind: "drop", flowId, items, ...(joined ? { joined: true as const } : {}) }]);
}

/** Removes the last unsent change (with anything joined to it). Nothing that is being or was saved can be undone. */
export function undo(outbox: Outbox): Outbox {
  const entries = [...outbox.entries];
  const unit: Entry[] = [];
  while (entries.length) {
    const entry = entries.pop()!;
    unit.unshift(entry);
    if (!entry.joined) break;
  }
  return unit.length ? { ...outbox, entries, redo: [...outbox.redo, unit] } : outbox;
}

/** Puts the last undone change back. Only undo and redo can run in between, so it still applies as it did. */
export function redo(outbox: Outbox): Outbox {
  const unit = outbox.redo.at(-1);
  return unit ? { ...outbox, entries: [...outbox.entries, ...unit], redo: outbox.redo.slice(0, -1) } : outbox;
}

/** The request body for one batch. */
export function wireBody({ commands, moves }: Changes) {
  return { commands: commands.map(({ command, proposedIds }) => ({ ...command, proposedIds })), moves };
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
/** Room below the 256 KiB body limit for the envelope and a new move group's header. */
const BATCH_BYTES = CHANGES_BODY_LIMIT - 4096;

/**
 * Sequential batches within the route's limits (100 commands, 200 moved steps, 256 KiB), in order: commands first,
 * moves after the last command, so applying them one after another equals applying the whole outbox at once.
 */
export function split({ commands, moves }: Changes): Changes[] {
  const batches: Changes[] = [];
  let current: Changes = { commands: [], moves: [] }, size = 0, moved = 0;
  const close = () => {
    if (current.commands.length || current.moves.length) batches.push(current);
    current = { commands: [], moves: [] }; size = 0; moved = 0;
  };
  for (const change of commands) {
    const add = bytes(wireBody({ commands: [change], moves: [] }).commands[0]) + 1;
    if (current.commands.length >= MAX_CHANGE_COMMANDS || size + add > BATCH_BYTES) close();
    current.commands.push(change);
    size += add;
  }
  for (const group of moves) {
    for (const item of group.items) {
      const add = bytes(item) + 1;
      if (moved >= MAX_CHANGE_MOVES || size + add > BATCH_BYTES) close();
      let target = current.moves.find((candidate) => candidate.flowId === group.flowId);
      if (!target) current.moves.push(target = { flowId: group.flowId, items: [] });
      target.items.push(item);
      size += add;
      moved += 1;
    }
  }
  close();
  return batches;
}

/**
 * Save pressed (or autosave): the unsent chain becomes the segment to send. Undone changes can no longer be redone.
 * Commands that no longer apply are left out and listed in `dropped`. A chain whose result would go over the draft's
 * size limit is not started at all (the outbox is returned unchanged; `overLimit` tells the caller).
 */
export function startSave(outbox: Outbox, saved: DraftView, key: string): Outbox {
  if (outbox.sending || !outbox.entries.length) return outbox;
  const base = baseOf(outbox, saved);
  const built = build(base, outbox.entries);
  if (built.overLimit) return outbox;
  const batches = split(built.changes);
  const dropped = [...outbox.dropped, ...built.skipped.map(({ command }) => describe(command, base.document))];
  return { ...outbox, base, entries: [], redo: [], dropped, sending: batches.length ? { draftId: base.id, key, batches, state: "waiting" } : null };
}

/** True when saving the unsent chain would go over the draft's size limit (checked like the server does). */
export function overLimit(outbox: Outbox, saved: DraftView): boolean {
  return Boolean(outbox.entries.length) && build(baseOf(outbox, saved), outbox.entries).overLimit;
}

/** The current batch is saved: the base advances by exactly that batch; the next one (if any) waits for its own key. */
export function acknowledged(outbox: Outbox, nextKey: string): Outbox {
  const { base, sending } = outbox;
  if (!base || !sending) return outbox;
  const [done, ...rest] = sending.batches;
  let next = base;
  try { next = applyBatch(base, done!); } catch (error) { if (!(error instanceof GraphError)) throw error; }
  return { ...outbox, base: next, sending: rest.length ? { draftId: sending.draftId, key: nextKey, batches: rest, state: "waiting" } : null };
}

/**
 * "Discard my changes": local changes go. A save in flight or unconfirmed may already have committed, so it stays with
 * its key for an exact retry. The base stays too: after an acknowledged save whose re-read failed it is what was saved.
 */
export function discardOutbox(outbox: Outbox): Outbox {
  const { sending, base } = outbox;
  return { ...emptyOutbox, base, sending: sending && (sending.state === "sending" || sending.state === "uncertain") ? sending : null };
}

/** Unsent and unconfirmed changes both wait to be saved: each command and each moved step counts once. */
export function pendingCount(outbox: Outbox): number {
  const sent = (outbox.sending?.batches ?? []).reduce((count, batch) => count + batch.commands.length + batch.moves.reduce((total, group) => total + group.items.length, 0), 0);
  return sent + outbox.entries.length;
}

/** The command's guard refreshed from the current draft: the person chose to apply it over what is saved now. */
function refreshed(command: GraphCommand, current: DraftView): GraphCommand {
  if ("expectedDocumentRevision" in command) return { ...command, expectedDocumentRevision: current.documentRevision };
  const id = recordId(command.payload)!;
  const record = current.document.flows[id] ?? current.document.nodes[id] ?? current.document.edges[id];
  return record ? { ...command, expectedEntityVersion: record.version } : command;
}

const FIELD_NAMES: Record<string, string> = {
  title: "title", purpose: "purpose", classification: "type", inclusion: "scope", label: "name", kind: "shape", description: "description", actorLabel: "actor", assumptionNotes: "assumptions",
};
function fieldText(payload: object) {
  return Object.entries(payload).filter(([key]) => FIELD_NAMES[key])
    .map(([key, value]) => `${FIELD_NAMES[key]} “${Array.isArray(value) ? value.join("; ") : String(value)}”`).join(", ");
}

/** A plain description of a change that no longer applies, including the text the person typed. */
export function describe(command: GraphCommand, names: ScopeDocument): string {
  const step = (nodeId: string) => stepName(names, nodeId);
  const flow = (flowId: string) => `“${names.flows[flowId]?.title ?? "Removed flow"}”`;
  const edge = (edgeId: string) => { const found = names.edges[edgeId]; return found ? `${step(found.fromId)} → ${step(found.toId)}` : "connection"; };
  switch (command.command) {
    case "CREATE_FLOW": return `New flow “${command.payload.title}”`;
    case "UPDATE_FLOW": return `Flow ${flow(command.payload.flowId)}: ${fieldText(command.payload)}`;
    case "DUPLICATE_FLOW": return `Copy of ${flow(command.payload.flowId)}`;
    case "DELETE_FLOW": return `Delete flow ${flow(command.payload.flowId)}`;
    case "ADD_NODE": return `New step “${command.payload.label}”`;
    case "UPDATE_NODE": return `Step “${step(command.payload.nodeId)}”: ${fieldText(command.payload)}`;
    case "DELETE_NODES": return `Delete ${command.payload.nodeIds.map(step).join(", ")}`;
    case "ADD_EDGE": return `Connection ${step(command.payload.fromId)} → ${step(command.payload.toId)}`;
    case "UPDATE_EDGE": return `Connection label “${command.payload.condition}”`;
    case "RECONNECT_EDGE": return `Reconnect ${step(command.payload.fromId)} → ${step(command.payload.toId)}`;
    case "DELETE_EDGE": return `Delete connection ${edge(command.payload.edgeId)}`;
  }
}

/** Every unsaved change in plain words (sent or not), so typed text stays readable when it can no longer be saved. */
export function describeAll(outbox: Outbox, names: ScopeDocument): string[] {
  const commands = [
    ...(outbox.sending?.batches ?? []).flatMap((batch) => batch.commands.map(({ command }) => command)),
    ...outbox.entries.flatMap((entry) => (entry.kind === "command" ? [entry.command] : [])),
  ];
  const moved = new Set([
    ...(outbox.sending?.batches ?? []).flatMap((batch) => batch.moves.flatMap((group) => group.items.map((item) => item.nodeId))),
    ...outbox.entries.flatMap((entry) => (entry.kind === "drop" ? entry.items.map((item) => item.nodeId) : [])),
  ]);
  return [...commands.map((command) => describe(command, names)), ...[...moved].map((nodeId) => `Move ${stepName(names, nodeId)}`)];
}

/**
 * "Apply my changes again" after a refused save: every unsaved change (the refused segment and anything behind it),
 * replayed in order on the newer saved draft with fresh guards and the same created ids. Only changes that no longer
 * apply are left out, and they are listed (`names` is the document they were made on, for their descriptions).
 */
export function rebase(outbox: Outbox, saved: DraftView, names: ScopeDocument): Outbox {
  const sent: Entry[] = (outbox.sending?.batches ?? []).flatMap((batch) => [
    ...batch.commands.map(({ command, proposedIds }): Entry => ({ kind: "command", command, proposedIds })),
    ...batch.moves.map(({ flowId, items }): Entry => ({ kind: "drop", flowId, items: items.map(({ nodeId, x, y }) => ({ nodeId, x, y })) })),
  ]);
  let current = saved;
  const entries: Entry[] = [];
  const dropped: string[] = [];
  for (const entry of [...sent, ...outbox.entries]) {
    if (entry.kind === "drop") {
      const live = entry.items.filter((item) => current.document.nodes[item.nodeId]);
      for (const item of entry.items) if (!current.document.nodes[item.nodeId]) dropped.push(`Move ${stepName(names, item.nodeId)}`);
      if (live.length) entries.push({ ...entry, items: live });
      continue;
    }
    const command = refreshed(entry.command, current);
    try {
      const next = applyBatch(current, { commands: [{ command, proposedIds: entry.proposedIds }], moves: [] });
      // Someone already made the same change: nothing is left to save for it.
      if (next.documentRevision !== current.documentRevision) entries.push({ ...entry, command });
      current = next;
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      dropped.push(describe(entry.command, names));
    }
  }
  return { base: saved, sending: null, entries, redo: [], dropped };
}

/** What a conflicting change targets, so "Keep theirs" can drop exactly that change. */
export type ConflictTarget = { kind: "command"; command: GraphCommand } | { kind: "move"; nodeId: string };
/** One of my unsaved changes whose record someone else changed first: their saved value, my edit, and the original. */
export type Conflict = { label: string; rows: { field: string; theirs: string; mine: string; before: string }[]; target: ConflictTarget };

const text = (value: unknown) => (Array.isArray(value) ? value.join("; ") : String(value ?? "")) || "(empty)";
const point = (at: { x: number; y: number }) => `(${at.x}, ${at.y})`;

/**
 * After a refused save (UI02 "never auto-resubmit stale text"): every unsaved change whose target (a field, a
 * connection's endpoints, a step's position) changed between the draft it was made on (\`outbox.base\`) and the newer
 * saved draft. Each is shown as Saved value / Your edit / Before your edit before anything is sent again; changes to
 * untouched records need no review. Records created locally, or deleted since, are not listed here: the replay lists
 * those as no longer applying.
 */
export function compareOutbox(outbox: Outbox, saved: DraftView, names: ScopeDocument): Conflict[] {
  const base = outbox.base;
  if (!base || base.id !== saved.id) return [];
  const commands = [
    ...(outbox.sending?.batches ?? []).flatMap((batch) => batch.commands.map(({ command }) => command)),
    ...outbox.entries.flatMap((entry) => (entry.kind === "command" ? [entry.command] : [])),
  ];
  const conflicts: Conflict[] = [];
  for (const command of commands) {
    if (UPDATES.has(command.command)) {
      const id = recordId(command.payload)!;
      const before = (base.document.flows[id] ?? base.document.nodes[id] ?? base.document.edges[id]) as Record<string, unknown> | undefined;
      const now = (saved.document.flows[id] ?? saved.document.nodes[id] ?? saved.document.edges[id]) as Record<string, unknown> | undefined;
      if (!before || !now) continue;
      const rows = Object.entries(command.payload as Record<string, unknown>)
        .filter(([field]) => field !== "flowId" && field !== "nodeId" && field !== "edgeId" && JSON.stringify(now[field]) !== JSON.stringify(before[field]))
        .map(([field, mine]) => ({ field: FIELD_NAMES[field] ?? field, theirs: text(now[field]), mine: text(mine), before: text(before[field]) }));
      if (rows.length) conflicts.push({ label: describe(command, names), rows, target: { kind: "command", command } });
    } else if (command.command === "RECONNECT_EDGE") {
      const before = base.document.edges[command.payload.edgeId], now = saved.document.edges[command.payload.edgeId];
      if (!before || !now || (before.fromId === now.fromId && before.toId === now.toId)) continue;
      const ends = (fromId: string, toId: string) => `${stepName(names, fromId)} → ${stepName(names, toId)}`;
      conflicts.push({ label: describe(command, names), target: { kind: "command", command },
        rows: [{ field: "connection", theirs: ends(now.fromId, now.toId), mine: ends(command.payload.fromId, command.payload.toId), before: ends(before.fromId, before.toId) }] });
    }
  }
  const moved = new Map<string, { x: number; y: number }>();
  for (const batch of outbox.sending?.batches ?? []) for (const group of batch.moves) for (const item of group.items) moved.set(item.nodeId, item);
  for (const entry of outbox.entries) if (entry.kind === "drop") for (const item of entry.items) moved.set(item.nodeId, item);
  for (const [nodeId, mine] of moved) {
    const before = base.layout.positions[nodeId], now = saved.layout.positions[nodeId];
    if (!before || !now || now.version === before.version) continue;
    conflicts.push({ label: `Move ${stepName(names, nodeId)}`, target: { kind: "move", nodeId }, rows: [{ field: "position", theirs: point(now), mine: point(mine), before: point(before) }] });
  }
  return conflicts;
}

/** "Keep theirs": drops exactly one of my unsaved changes (a command, or every unsaved move of one step). */
export function keepTheirs(outbox: Outbox, target: ConflictTarget): Outbox {
  const same = (command: GraphCommand) => target.kind === "command" && JSON.stringify(command) === JSON.stringify(target.command);
  const moveless = <T extends { nodeId: string }>(items: T[]) => items.filter((item) => target.kind !== "move" || item.nodeId !== target.nodeId);
  const sending = outbox.sending && {
    ...outbox.sending,
    batches: outbox.sending.batches.map((batch) => ({
      commands: batch.commands.filter(({ command }) => !same(command)),
      moves: batch.moves.map((group) => ({ ...group, items: moveless(group.items) })).filter((group) => group.items.length),
    })).filter((batch) => batch.commands.length || batch.moves.length),
  };
  const entries = outbox.entries.flatMap((entry): Entry[] => {
    if (entry.kind === "command") return same(entry.command) ? [] : [entry];
    const items = moveless(entry.items);
    return items.length ? [{ ...entry, items }] : [];
  });
  return { ...outbox, sending: sending && sending.batches.length ? sending : null, entries };
}
