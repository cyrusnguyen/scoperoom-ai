// Inspector edit buffers (UI02 "Dirty fields and acknowledged saves"): pure functions over a map the shell's per-project
// store holds, so typed text survives closing the panel, switching entities and every refetch. Applying a buffer queues
// its command in the Studio outbox (Task 14b) and clears the buffer: the text then lives in the queued command, and the
// outbox's batch save carries the idempotency key and its same-key retry.
export type EntityKind = "FLOW" | "NODE" | "EDGE";
export type Fields = Record<string, string>;
export type EntityBuffer = {
  kind: EntityKind; id: string;
  /** The record version these edits were made against. */
  baseVersion: number;
  /** Values when editing began, or after an explicit rebase. */
  original: Fields;
  /** What the form shows. A field is dirty while it differs from `original`. */
  values: Fields;
  /** Applying was refused because the record changed after these edits began: review before applying again. */
  conflict: boolean;
};
export type Buffers = Record<string, EntityBuffer>;
export type Saved = { kind: EntityKind; id: string; version: number; fields: Fields };

export const bufferKey = (kind: EntityKind, id: string) => `${kind}:${id}`;

export function dirtyFields(buffer: EntityBuffer): string[] {
  return Object.keys(buffer.values).filter((field) => buffer.values[field] !== buffer.original[field]);
}

/** Changed fields and their typed values: exactly what applying queues. */
export function changes(buffer: EntityBuffer): Fields {
  return Object.fromEntries(dirtyFields(buffer).map((field) => [field, buffer.values[field]!]));
}

/** Counted by the unsaved-changes guard: typed text or an unresolved conflict. */
export const isDirty = (buffer: EntityBuffer) => buffer.conflict || dirtyFields(buffer).length > 0;

/**
 * "Changed by someone else": typed text whose record moved on. Shown version differs from the one typed against (a read
 * moved the displayed record), or, while the view is frozen, the adopted record's version left the frozen base's. A refused
 * save's `conflict` has its own note.
 */
export function changedElsewhere(buffer: EntityBuffer, shown: number, adopted?: number, frozenBase?: number): boolean {
  return !buffer.conflict && dirtyFields(buffer).length > 0
    && (buffer.baseVersion !== shown || (adopted !== undefined && frozenBase !== undefined && adopted !== frozenBase));
}

function put(buffers: Buffers, buffer: EntityBuffer): Buffers {
  const key = bufferKey(buffer.kind, buffer.id);
  const rest = { ...buffers };
  delete rest[key];
  return isDirty(buffer) ? { ...rest, [key]: buffer } : rest;
}

/** Records a typed value. The first edit captures the version and values; a buffer that matches them again disappears. */
export function edit(buffers: Buffers, saved: Saved, field: string, value: string): Buffers {
  return editFields(buffers, saved, { [field]: value });
}

/** A multi-field gesture is atomic: becoming briefly clean between fields must not recapture a newer base. */
export function editFields(buffers: Buffers, saved: Saved, values: Fields): Buffers {
  const current = buffers[bufferKey(saved.kind, saved.id)]
    ?? { kind: saved.kind, id: saved.id, baseVersion: saved.version, original: saved.fields, values: { ...saved.fields }, conflict: false };
  return put(buffers, { ...current, values: { ...current.values, ...values } });
}

/** A refusal: nothing was queued and the typed values stay. `conflict` marks a stale-version refusal. */
export function refuse(buffers: Buffers, key: string, conflict: boolean): Buffers {
  const buffer = buffers[key];
  return buffer ? put(buffers, { ...buffer, conflict }) : buffers;
}

/** Explicit "apply my edit" after a conflict: refresh clean values and retain only edits made against the previous base. */
export function rebase(buffers: Buffers, saved: Saved): Buffers {
  const buffer = buffers[bufferKey(saved.kind, saved.id)];
  return buffer ? put(buffers, { ...buffer, baseVersion: saved.version, original: saved.fields, values: { ...saved.fields, ...changes(buffer) }, conflict: false }) : buffers;
}

export function discard(buffers: Buffers, key: string): Buffers {
  const rest = { ...buffers };
  delete rest[key];
  return rest;
}

/**
 * Our own change also advanced other records (a node edit bumps its flow's record version). Follow a buffer to the new
 * version only when that change was the sole one since its base; otherwise applying it conflicts, as it should.
 */
export function follow(buffers: Buffers, versions: Record<string, number>): Buffers {
  const next = { ...buffers };
  for (const [key, buffer] of Object.entries(buffers)) {
    const version = versions[buffer.id];
    if (version !== undefined && !buffer.conflict && buffer.baseVersion === version - 1) next[key] = { ...buffer, baseVersion: version };
  }
  return next;
}
