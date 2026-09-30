import type { DragItem, PeerContext, PeerMessage } from "../contracts/messages.ts";

// The remote-preview store (Stage 04.3): what peers' cursors and drag ghosts look like right now. Pure and time-free:
// callers pass `now`, and Task 5's single scheduler decides when to re-read `snapshot`. Nothing here is saved data; a
// preview never moves a canonical node and never counts as a save. Validation is against the SAVED draft, so a delayed
// packet cannot draw a ghost for a node that was deleted, moved by a save, or belongs to another flow or draft.
export const PREVIEW_TTL_MS = 2000;
export const MAX_SESSIONS = 64;

/** The narrowest saved view the store needs: the current draft id and, per node, its flow and saved position version. */
export type SavedView = { draftId: string; node: (nodeId: string) => { flowId: string; positionVersion: number } | undefined };
export type StoreContext = PeerContext & { sessionId: string };
export type PreviewSnapshot = {
  cursors: { sessionId: string; x: number; y: number }[];
  drags: { sessionId: string; gestureId: string; items: { nodeId: string; x: number; y: number }[] }[];
};

type Session = { last: number; cursor?: { x: number; y: number; at: number }; drag?: { gestureId: string; items: DragItem[]; at: number } };

export type PreviewStore = {
  /** True when the message was accepted (visuals may have changed). Rejected messages leave the watermark untouched. */
  receive: (message: PeerMessage, saved: SavedView, now: number) => boolean;
  /** Render-ready, excluding entries older than PREVIEW_TTL_MS; expiry drops visuals only, never watermarks. */
  snapshot: (now: number) => PreviewSnapshot;
  /** The earliest moment a currently shown entry expires (its last update plus PREVIEW_TTL_MS); null when nothing is shown. */
  nextExpiry: (now: number) => number | null;
  /** After every adoption of saved data: drops drags whose targets vanished, left the flow or changed saved position version. */
  reconcile: (saved: SavedView) => void;
  /** Disconnect: drops every visual; keeps the roster and watermarks so pre-disconnect packets cannot return. */
  clear: () => void;
  /** A changed context clears visuals and watermarks; the roster survives only within the same project and epoch. Null tears down. */
  setContext: (context: StoreContext | null) => void;
  /** The Presence roster: only these sessions (own excluded, first MAX_SESSIONS) may draw. Departed sessions lose visuals and watermark. */
  syncSessions: (sessionIds: readonly string[]) => void;
};

const fresh = (): Session => ({ last: -1 });

export function createPreviewStore(): PreviewStore {
  let context: StoreContext | null = null;
  let sessions = new Map<string, Session>();

  const matches = (saved: SavedView, item: DragItem) => {
    const node = saved.node(item.nodeId);
    return node !== undefined && node.flowId === context!.flowId && node.positionVersion === item.basePositionVersion;
  };
  const dropVisuals = () => { for (const session of sessions.values()) { delete session.cursor; delete session.drag; } };

  return {
    receive(message, saved, now) {
      if (!context || message.sessionId === context.sessionId) return false;
      const session = sessions.get(message.sessionId);
      if (!session || message.sequence <= session.last) return false;
      if (message.projectId !== context.projectId || message.epoch !== context.epoch || message.draftId !== context.draftId || message.flowId !== context.flowId || saved.draftId !== context.draftId) return false;
      if (message.type === "CURSOR") session.cursor = { x: message.x, y: message.y, at: now };
      else if (message.type === "DRAG_PREVIEW") {
        if (!message.items.every((item) => matches(saved, item))) return false;
        session.drag = { gestureId: message.gestureId, items: message.items, at: now };
      } else if (session.drag?.gestureId === message.gestureId) delete session.drag;
      session.last = message.sequence;
      return true;
    },
    snapshot(now) {
      const live = (at: number) => now - at < PREVIEW_TTL_MS;
      const result: PreviewSnapshot = { cursors: [], drags: [] };
      for (const [sessionId, { cursor, drag }] of sessions) {
        if (cursor && live(cursor.at)) result.cursors.push({ sessionId, x: cursor.x, y: cursor.y });
        if (drag && live(drag.at)) result.drags.push({ sessionId, gestureId: drag.gestureId, items: drag.items.map(({ nodeId, x, y }) => ({ nodeId, x, y })) });
      }
      return result;
    },
    nextExpiry(now) {
      let earliest: number | null = null;
      for (const { cursor, drag } of sessions.values()) {
        for (const entry of [cursor, drag]) if (entry && entry.at + PREVIEW_TTL_MS > now && (earliest === null || entry.at + PREVIEW_TTL_MS < earliest)) earliest = entry.at + PREVIEW_TTL_MS;
      }
      return earliest;
    },
    reconcile(saved) {
      if (!context) return;
      if (saved.draftId !== context.draftId) return dropVisuals();
      for (const session of sessions.values()) if (session.drag && !session.drag.items.every((item) => matches(saved, item))) delete session.drag;
    },
    clear: dropVisuals,
    setContext(next) {
      if (next && context && (Object.keys(next) as (keyof StoreContext)[]).every((key) => next[key] === context![key])) return;
      const sameChannel = next && context && next.projectId === context.projectId && next.epoch === context.epoch;
      sessions = new Map(sameChannel ? [...sessions.keys()].map((id) => [id, fresh()]) : []);
      context = next;
    },
    syncSessions(sessionIds) {
      const next = new Map<string, Session>();
      for (const id of sessionIds) {
        if (next.size >= MAX_SESSIONS) break;
        if (id !== context?.sessionId) next.set(id, sessions.get(id) ?? fresh());
      }
      sessions = next;
    },
  };
}
