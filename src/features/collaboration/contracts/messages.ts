import { coordinate } from "../../drafts/contracts/draft-layout.ts";
import { invalid, keys, object, utf8Bytes, version } from "../../drafts/contracts/strict.ts";
import { CANONICAL_UUID } from "./topics.ts";

// Wire protocol of the `collab` channel (peer previews and Presence) and the `events` hint (Stage 04.3). Everything here
// is advisory and untrusted: the parsers return the typed value or null, never throw, never truncate and never log the
// rejected body. Ids are canonical lower-case UUIDs; the only free-form strings are `gestureId` and the provider's hint
// `id`, each capped at MAX_TEXT_BYTES UTF-8 bytes. No labels, emails or source text ever travel here.
export type PeerContext = { projectId: string; epoch: string; draftId: string; flowId: string };
export type DragItem = { nodeId: string; x: number; y: number; basePositionVersion: number };
export type PeerMessage = PeerContext & { sessionId: string; sequence: number } & (
  | { type: "CURSOR"; x: number; y: number }
  | { type: "DRAG_PREVIEW"; gestureId: string; items: DragItem[] }
  | { type: "DRAG_END"; gestureId: string }
);
export type PresenceState = {
  projectId: string; epoch: string; draftId: string; flowId: string | null; sessionId: string; profileId: string;
  selection: { kind: "NODES" | "EDGE" | "FLOW"; ids: string[] } | null;
};
export type ProjectHint = { type: "PROJECT_CHANGED"; projectId: string; epoch: string; eventSequence: number };

export const MAX_MESSAGE_BYTES = 8192;
export const MAX_TEXT_BYTES = 64;
export const MAX_DRAG_ITEMS = 20;
export const MAX_SELECTED_NODES = 20;

const uuid = (value: unknown): string => (typeof value === "string" && CANONICAL_UUID.test(value) ? value : invalid());
const sequence = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid());
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.isWellFormed() || !value || new TextEncoder().encode(value).length > MAX_TEXT_BYTES) invalid();
  return value;
};
const uuids = (value: unknown, min: number, max: number): string[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  const list = value.map(uuid);
  if (new Set(list).size !== list.length) invalid();
  return list;
};

/** Every parser runs through here: over-size input and every strict-parse failure (or hostile object) becomes null. */
function parse<T>(input: unknown, build: (value: Record<string, unknown>) => T): T | null {
  try {
    if (utf8Bytes(input) > MAX_MESSAGE_BYTES) return null;
    return build(object(input));
  } catch {
    return null;
  }
}

const context = (value: Record<string, unknown>) => ({ projectId: uuid(value.projectId), epoch: uuid(value.epoch), draftId: uuid(value.draftId), flowId: uuid(value.flowId) });
const PEER_KEYS = ["type", "projectId", "epoch", "draftId", "flowId", "sessionId", "sequence"];

function dragItem(entry: unknown): DragItem {
  const item = object(entry);
  keys(item, ["nodeId", "x", "y", "basePositionVersion"]);
  return { nodeId: uuid(item.nodeId), x: coordinate(item.x), y: coordinate(item.y), basePositionVersion: version(item.basePositionVersion) };
}

export function parsePeerMessage(input: unknown): PeerMessage | null {
  return parse(input, (value): PeerMessage => {
    const common = { ...context(value), sessionId: uuid(value.sessionId), sequence: sequence(value.sequence) };
    if (value.type === "CURSOR") {
      keys(value, [...PEER_KEYS, "x", "y"]);
      return { ...common, type: "CURSOR", x: coordinate(value.x), y: coordinate(value.y) };
    }
    if (value.type === "DRAG_PREVIEW") {
      keys(value, [...PEER_KEYS, "gestureId", "items"]);
      if (!Array.isArray(value.items) || !value.items.length || value.items.length > MAX_DRAG_ITEMS) invalid();
      const items = value.items.map(dragItem);
      if (new Set(items.map((item) => item.nodeId)).size !== items.length) invalid();
      return { ...common, type: "DRAG_PREVIEW", gestureId: text(value.gestureId), items };
    }
    if (value.type === "DRAG_END") {
      keys(value, [...PEER_KEYS, "gestureId"]);
      return { ...common, type: "DRAG_END", gestureId: text(value.gestureId) };
    }
    return invalid();
  });
}

/** One entry of the Presence roster: the caller strips provider bookkeeping (`presence_ref`) before parsing. */
export function parsePresence(input: unknown): PresenceState | null {
  return parse(input, (value) => {
    keys(value, ["projectId", "epoch", "draftId", "flowId", "sessionId", "profileId", "selection"]);
    let selection: PresenceState["selection"] = null;
    if (value.selection !== null) {
      const chosen = object(value.selection);
      keys(chosen, ["kind", "ids"]);
      if (chosen.kind === "NODES") selection = { kind: "NODES", ids: uuids(chosen.ids, 0, MAX_SELECTED_NODES) };
      else if (chosen.kind === "EDGE" || chosen.kind === "FLOW") selection = { kind: chosen.kind, ids: uuids(chosen.ids, 1, 1) };
      else invalid();
    }
    return {
      projectId: uuid(value.projectId), epoch: uuid(value.epoch), draftId: uuid(value.draftId), flowId: value.flowId === null ? null : uuid(value.flowId),
      sessionId: uuid(value.sessionId), profileId: uuid(value.profileId), selection,
    };
  });
}

/** The four contract keys plus the `id` the provider adds to a sent payload; the id is dropped, never trusted. */
export function parseHint(input: unknown): ProjectHint | null {
  return parse(input, (value) => {
    keys(value, ["type", "projectId", "epoch", "eventSequence"], ["id"]);
    if (Object.hasOwn(value, "id")) text(value.id);
    if (value.type !== "PROJECT_CHANGED") invalid();
    return { type: "PROJECT_CHANGED", projectId: uuid(value.projectId), epoch: uuid(value.epoch), eventSequence: sequence(value.eventSequence) };
  });
}
