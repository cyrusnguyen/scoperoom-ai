// Strict parsing primitives for the draft contracts (Data02 "Authoritative shape and bounded primitives").
// Every failure throws Error("INVALID_INPUT"); server callers map it to the shared error envelope.
export const MAX_VERSION = 2_147_483_647;
/** Server-generated ids are lowercase v1–v5 UUIDs; anything else is not an id this app issued. */
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function invalid(): never {
  throw new Error("INVALID_INPUT");
}

/** A plain JSON object: not null, an array or a class instance. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}

/** Every required key is present, and nothing outside required + optional is. */
export function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some((key) => !Object.hasOwn(value, key))) invalid();
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

/** Plain text bounded in Unicode code points; lone surrogates are rejected. `required` also rejects blank text. */
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\u0000") || [...value].length > max || (required && !value.trim())) invalid();
  return value;
}

export function id(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
  return value;
}

/** Record, behaviour, position and revision counters: positive integers that fit PostgreSQL `integer`. */
export function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) invalid();
  return value;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

/** Distinct ids, at most `max`. */
export function idList(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) invalid();
  return ids;
}

/** A map keyed by record id: at most `limit` entries, and each key equals its record's parsed id. */
export function records<T extends { id: string }>(value: unknown, limit: number, parse: (entry: unknown) => T): Record<string, T> {
  const entries = Object.entries(object(value));
  if (entries.length > limit) invalid();
  return Object.fromEntries(entries.map(([key, entry]) => {
    const parsed = parse(entry);
    if (parsed.id !== key) invalid();
    return [key, parsed];
  }));
}

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
