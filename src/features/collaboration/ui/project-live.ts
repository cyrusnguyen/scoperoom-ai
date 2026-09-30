import type { DraftView } from "../../drafts/contracts/scope-document.ts";
import { parseHint, parsePeerMessage, parsePresence, type DragItem, type PresenceState } from "../contracts/messages.ts";
import { realtimeTopics } from "../contracts/topics.ts";
import { createPreviewStore, MAX_SESSIONS, type PreviewSnapshot, type SavedView } from "./preview-store.ts";
import type { LiveConnection, LiveState, RealtimeTransport } from "./realtime-transport.ts";

// The Realtime side of one visible project (Stage 04.3), beside the 04.2 status controller. Pure like it: the transport, clock and
// timers are injected, so node tests drive it with fakes. Nothing here saves, enqueues or advances a revision: a hint or SUBSCRIBED only
// asks the status controller to revalidate, and previews and Presence are advisory. Every connection has a generation; anything
// from an older one is ignored.
export const HINT_DEBOUNCE_MS = 100;
export const MOVEMENT_MS = 125; // at most 8 movement packets per second
export const PRESENCE_MS = 1000;

export type LiveScope = {
  projectId: string; epoch: string; draftId: string; profileId: string;
  /** ACTIVE project and OWNER or EDITOR: only they send cursor and drag Broadcast. Every member tracks Presence. */
  canSend: boolean;
};
export type PresenceClaim = { flowId: string | null; selection: PresenceState["selection"] };
type Movement = { type: "CURSOR"; x: number; y: number } | { type: "DRAG_PREVIEW"; gestureId: string; items: DragItem[] } | { type: "DRAG_END"; gestureId: string };

export type LiveOptions = {
  transport: RealtimeTransport;
  /** One per provider mount; the sender's `sequence` counts up per session for the provider's whole lifetime. */
  sessionId: string;
  setTimer: (run: () => void, ms: number) => () => void;
  now: () => number;
  revalidate: (reason: "hint" | "subscribed") => void;
  /** Feeds the status controller's cadence: true while realtime is delayed. */
  degraded: (on: boolean) => void;
};

export type ProjectLive = {
  /** The same epoch and draft keeps the connection; a change (or null) disposes it and joins the new topics under a new generation. */
  setScope: (scope: LiveScope | null) => void;
  /** Call after every adoption of saved data (Studio reads and bootstraps): previews are validated against it. */
  setSavedView: (view: SavedView) => void;
  setPresence: (claim: PresenceClaim) => void;
  /** Flow coordinates; null when the pointer leaves the canvas (a peer's cursor then expires). */
  sendCursor: (position: { x: number; y: number } | null) => void;
  sendDrag: (gestureId: string, items: DragItem[]) => void;
  endDrag: (gestureId: string) => void;
  state: () => LiveState;
  /** Other sessions of this project, epoch and draft (own excluded). */
  roster: () => PresenceState[];
  /** The same object while its contents are unchanged (safe for useSyncExternalStore). Expiry shows on the next read: the consumer's one scheduler re-reads before PREVIEW_TTL_MS. */
  snapshot: () => PreviewSnapshot;
  /** When the earliest shown preview expires (epoch ms), or null: the consumer's one scheduler re-reads `snapshot` then. */
  nextExpiry: () => number | null;
  /** Any change of state, roster or previews. */
  subscribe: (listener: () => void) => () => void;
};

/** The narrowest saved view the preview store needs, from an adopted draft. */
export function savedViewOf(draft: DraftView): SavedView {
  return {
    draftId: draft.id,
    node: (nodeId) => {
      const node = draft.document.nodes[nodeId], position = draft.layout.positions[nodeId];
      return node && position ? { flowId: node.flowId, positionVersion: position.version } : undefined;
    },
  };
}

/** The provider adds `presence_ref` to each tracked payload; it is bookkeeping, not part of the claim. */
function unwrap(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const claim: Record<string, unknown> = { ...value };
  delete claim.presence_ref;
  return claim;
}

export function createProjectLive(o: LiveOptions): ProjectLive {
  const store = createPreviewStore();
  const listeners = new Set<() => void>();
  let generation = 0, scope: LiveScope | null = null, connection: LiveConnection | null = null;
  let state: LiveState = "connecting", degraded = false, saved: SavedView | null = null;
  let claim: PresenceClaim = { flowId: null, selection: null }, roster: PresenceState[] = [], rosterKey = "[]";
  let shot: PreviewSnapshot = { cursors: [], drags: [] }, shotKey = JSON.stringify(shot);
  let sequence = 0, pending: Movement | null = null, lastTracked = -Infinity;
  let cancelHint: (() => void) | null = null, cancelMove: (() => void) | null = null, cancelPresence: (() => void) | null = null;

  const emit = () => { for (const listener of [...listeners]) listener(); };
  const setDegraded = (on: boolean) => { if (on !== degraded) { degraded = on; o.degraded(on); } };
  /** setContext always precedes syncSessions: a changed context rebuilds the store's sessions from the roster. */
  function applyContext() {
    store.setContext(scope && claim.flowId ? { projectId: scope.projectId, epoch: scope.epoch, draftId: scope.draftId, flowId: claim.flowId, sessionId: o.sessionId } : null);
    store.syncSessions(roster.map((entry) => entry.sessionId));
  }
  const sendable = () => Boolean(connection && scope?.canSend && claim.flowId && state === "subscribed");

  function teardown() {
    generation++;
    cancelHint?.(); cancelMove?.(); cancelPresence?.();
    cancelHint = cancelMove = cancelPresence = null;
    pending = null; lastTracked = -Infinity; roster = []; rosterKey = "[]"; state = "connecting";
    store.setContext(null);
    setDegraded(false);
    const old = connection;
    connection = null;
    old?.dispose().catch(() => undefined);
    emit();
  }

  function schedulePresence() {
    if (state !== "subscribed" || !connection || cancelPresence) return;
    cancelPresence = o.setTimer(() => {
      cancelPresence = null;
      if (state !== "subscribed" || !connection || !scope) return;
      lastTracked = o.now();
      const full: PresenceState = { projectId: scope.projectId, epoch: scope.epoch, draftId: scope.draftId, flowId: claim.flowId, sessionId: o.sessionId, profileId: scope.profileId, selection: claim.selection };
      connection.trackPresence(parsePresence(full) ? full : { ...full, selection: null }); // an oversize selection is not shared
    }, Math.max(0, lastTracked + PRESENCE_MS - o.now()));
  }

  function flushMovement() {
    cancelMove = null;
    const move = pending;
    pending = null;
    if (!move || !scope || !claim.flowId || !sendable()) return;
    const message = { projectId: scope.projectId, epoch: scope.epoch, draftId: scope.draftId, flowId: claim.flowId, sessionId: o.sessionId, sequence: sequence + 1, ...move };
    if (!parsePeerMessage(message)) return; // the sender obeys the wire limits too
    sequence++;
    connection!.sendPeer(message);
  }
  function queue(move: Movement) {
    if (!sendable()) return;
    if (move.type === "CURSOR" && pending?.type === "DRAG_END") return; // an unsent end is never replaced by movement
    pending = move; // only the newest pending movement is kept; DRAG_END supersedes a pending preview
    cancelMove ??= o.setTimer(flushMovement, MOVEMENT_MS);
  }

  function connect(next: LiveScope) {
    const mine = ++generation;
    const current = (run: () => void) => { if (mine === generation) run(); };
    const conn = o.transport.connect({ projectId: next.projectId, epoch: next.epoch, topics: realtimeTopics(next.projectId, next.epoch) }, {
      state: (value) => current(() => {
        if (value === state) return;
        state = value;
        if (value === "subscribed") {
          setDegraded(false);
          o.revalidate("subscribed"); // closes the bootstrap-to-subscribe gap, and any gap after a drop
          schedulePresence();
        } else {
          store.clear(); // overlays are gone; the roster waits for the next sync
          cancelMove?.(); cancelMove = null; pending = null;
          if (value === "degraded") setDegraded(true);
        }
        emit();
      }),
      hint: (value) => current(() => {
        const hint = parseHint(value);
        if (!hint || !scope || hint.projectId !== scope.projectId || hint.epoch !== scope.epoch || cancelHint) return;
        // The controller already coalesces to one request in flight and one trailing; this only batches a burst.
        cancelHint = o.setTimer(() => { cancelHint = null; current(() => o.revalidate("hint")); }, HINT_DEBOUNCE_MS);
      }),
      peer: (value) => current(() => {
        const message = parsePeerMessage(value);
        if (message && saved && store.receive(message, saved, o.now())) emit();
      }),
      presence: (values) => current(() => {
        if (!scope || !Array.isArray(values)) return;
        const seen = new Set<string>();
        const next: PresenceState[] = [];
        for (const value of values) {
          const entry = parsePresence(unwrap(value));
          if (!entry || entry.projectId !== scope.projectId || entry.epoch !== scope.epoch || entry.draftId !== scope.draftId || entry.sessionId === o.sessionId || seen.has(entry.sessionId)) continue;
          seen.add(entry.sessionId);
          if (next.push(entry) >= MAX_SESSIONS) break;
        }
        const key = JSON.stringify(next);
        const changed = key !== rosterKey;
        if (changed) { roster = next; rosterKey = key; }
        applyContext(); // after the roster, so the store's sessions follow it
        if (changed) emit();
      }),
    });
    connection = conn;
    applyContext();
    schedulePresence(); // a transport that reported subscribed before connect returned
  }

  return {
    setScope(next) {
      const before = scope;
      scope = next;
      if (!next) { if (before || connection) teardown(); return; }
      if (before && before.projectId === next.projectId && before.epoch === next.epoch && before.draftId === next.draftId && connection) {
        if (!next.canSend) { pending = null; cancelMove?.(); cancelMove = null; }
        return;
      }
      teardown();
      connect(next);
    },
    setSavedView(view) { saved = view; store.reconcile(view); emit(); },
    setPresence(next) {
      if (next.flowId === claim.flowId && JSON.stringify(next.selection) === JSON.stringify(claim.selection)) return;
      const flowChanged = next.flowId !== claim.flowId;
      claim = next;
      if (flowChanged) { pending = null; cancelMove?.(); cancelMove = null; applyContext(); emit(); }
      schedulePresence();
    },
    sendCursor: (position) => { if (position) queue({ type: "CURSOR", x: position.x, y: position.y }); else if (pending?.type === "CURSOR") pending = null; },
    sendDrag: (gestureId, items) => queue({ type: "DRAG_PREVIEW", gestureId, items }),
    endDrag: (gestureId) => queue({ type: "DRAG_END", gestureId }),
    state: () => state,
    roster: () => roster,
    snapshot: () => {
      const next = store.snapshot(o.now()), key = JSON.stringify(next);
      if (key !== shotKey) { shot = next; shotKey = key; }
      return shot;
    },
    nextExpiry: () => store.nextExpiry(o.now()),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
