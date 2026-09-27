// Inspector edit buffers (UI02 "Dirty fields and acknowledged saves"): pure functions over a map the shell's per-project
// store holds, so typed text survives closing the panel, switching entities and every refetch.
export type EntityKind = "FLOW" | "NODE" | "EDGE";
export type Fields = Record<string, string>;
export type EntityBuffer = {
  kind: EntityKind; id: string;
  /** The saved record version these edits were made against. */
  baseVersion: number;
  /** Saved values when editing began, or after an explicit rebase. */
  original: Fields;
  /** What the form shows. A field is dirty while it differs from `original`. */
  values: Fields;
  /** The changed fields in flight, or awaiting a same-key retry after an uncertain result. */
  sent: Fields | null;
  /** Idempotency key of `sent`. */
  key: string | null;
  /** The last save was refused because someone saved this record first. */
  conflict: boolean;
};
export type Buffers = Record<string, EntityBuffer>;
export type Saved = { kind: EntityKind; id: string; version: number; fields: Fields };

export const bufferKey = (kind: EntityKind, id: string) => `${kind}:${id}`;

export function dirtyFields(buffer: EntityBuffer): string[] {
  return Object.keys(buffer.values).filter((field) => buffer.values[field] !== buffer.original[field]);
}

/** Changed fields and their typed values: exactly what a Save sends. */
export function changes(buffer: EntityBuffer): Fields {
  return Object.fromEntries(dirtyFields(buffer).map((field) => [field, buffer.values[field]!]));
}

/** Counted by the unsaved-changes guard: typed text, a request whose outcome is unknown, or an unresolved conflict. */
export const isDirty = (buffer: EntityBuffer) => buffer.sent !== null || buffer.conflict || dirtyFields(buffer).length > 0;

function put(buffers: Buffers, buffer: EntityBuffer): Buffers {
  const key = bufferKey(buffer.kind, buffer.id);
  const rest = { ...buffers };
  delete rest[key];
  return isDirty(buffer) ? { ...rest, [key]: buffer } : rest;
}

/** Records a typed value. The first edit captures the saved version and values; a buffer that matches them again disappears. */
export function edit(buffers: Buffers, saved: Saved, field: string, value: string): Buffers {
  return editFields(buffers, saved, { [field]: value });
}

/** A multi-field gesture is atomic: becoming briefly clean between fields must not recapture a newer base. */
export function editFields(buffers: Buffers, saved: Saved, values: Fields): Buffers {
  const current = buffers[bufferKey(saved.kind, saved.id)]
    ?? { kind: saved.kind, id: saved.id, baseVersion: saved.version, original: saved.fields, values: { ...saved.fields }, sent: null, key: null, conflict: false };
  return put(buffers, { ...current, values: { ...current.values, ...values } });
}

/** Save pressed: remember what was sent and its key. An uncertain save retries exactly that request until it settles. */
export function send(buffers: Buffers, key: string, requestKey: string): Buffers {
  const buffer = buffers[key];
  if (!buffer || buffer.sent) return buffers;
  return { ...buffers, [key]: { ...buffer, sent: changes(buffer), key: requestKey, conflict: false } };
}

/** Saved at `version`: fields still showing their sent value become clean; text typed after sending stays dirty. */
export function acknowledge(buffers: Buffers, key: string, version: number): Buffers {
  const buffer = buffers[key];
  if (!buffer?.sent) return buffers;
  return put(buffers, { ...buffer, original: { ...buffer.original, ...buffer.sent }, baseVersion: version, sent: null, key: null });
}

/** A certain refusal: nothing was saved and the typed values stay. `conflict` marks a stale-version refusal. */
export function refuse(buffers: Buffers, key: string, conflict: boolean): Buffers {
  const buffer = buffers[key];
  return buffer ? put(buffers, { ...buffer, sent: null, key: null, conflict }) : buffers;
}

/** Explicit "save my edit" after a conflict: refresh clean values and retain only edits made against the previous base. */
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
 * Our own save also advanced other records (a node save bumps its flow's record version). Follow a buffer to the new
 * version only when that save was the sole change since its base; otherwise its next Save conflicts, as it should.
 */
export function follow(buffers: Buffers, versions: Record<string, number>): Buffers {
  const next = { ...buffers };
  for (const [key, buffer] of Object.entries(buffers)) {
    const version = versions[buffer.id];
    if (version !== undefined && !buffer.sent && !buffer.conflict && buffer.baseVersion === version - 1) next[key] = { ...buffer, baseVersion: version };
  }
  return next;
}
