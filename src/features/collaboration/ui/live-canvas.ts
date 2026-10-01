import { MAX_DRAG_ITEMS, type DragItem, type PresenceState } from "../contracts/messages.ts";
import { paletteIndex, UNKNOWN_PARTICIPANT, type Person } from "./participants.ts";
import type { PreviewSnapshot, SavedView } from "./preview-store.ts";

// Pure helpers for the live canvas overlay (Stage 04.3 Task 5): what a local drag may preview, and what remote previews show.

type Moved = { id: string; position: { x: number; y: number } };

/**
 * The saved position version of each dragged node of this flow, captured once when a gesture starts. A never-saved node has no
 * entry and is never previewed. More than MAX_DRAG_ITEMS saved targets previews nothing (the local move is unaffected).
 */
export function gestureBases(dragged: Moved[], saved: SavedView, flowId: string): Map<string, number> {
  const bases = new Map<string, number>();
  for (const { id } of dragged) {
    const node = saved.node(id);
    if (node && node.flowId === flowId) bases.set(id, node.positionVersion);
  }
  return bases.size > MAX_DRAG_ITEMS ? new Map() : bases;
}

/** The preview items for the current pointer position of a gesture, at the versions captured when it began. */
export function gestureItems(bases: ReadonlyMap<string, number>, dragged: Moved[]): DragItem[] {
  return dragged.flatMap(({ id, position }) => (bases.has(id) ? [{ nodeId: id, x: position.x, y: position.y, basePositionVersion: bases.get(id)! }] : []));
}

/** Remote motion never overlays a step the local user is dragging: those items are left out. */
export function visibleDrags(snapshot: PreviewSnapshot, localDragging: ReadonlySet<string>): PreviewSnapshot["drags"] {
  return snapshot.drags.flatMap((drag) => {
    const items = drag.items.filter((item) => !localDragging.has(item.nodeId));
    return items.length ? [{ ...drag, items }] : [];
  });
}

/** How long the one expiry timer waits: until the earliest shown entry has expired (one ms past it, since the store treats the TTL edge as expired). Null: nothing is shown. */
export function expiryDelay(expiresAt: number | null, now: number): number | null {
  return expiresAt === null ? null : Math.max(0, expiresAt - now) + 1;
}

/** A name and palette slot per peer session: the directory-resolved person, never a claim; the viewer's other tabs are theirs. */
export function sessionLabels(roster: PresenceState[], people: Person[], viewerId: string): Map<string, { name: string; color: number }> {
  const byProfile = new Map(people.map((person) => [person.profileId, person]));
  return new Map(roster.map(({ sessionId, profileId }) => {
    const person = byProfile.get(profileId);
    return [sessionId, { name: person?.name ?? (profileId === viewerId ? "Your other tab" : UNKNOWN_PARTICIPANT), color: person?.color ?? paletteIndex(profileId) }];
  }));
}
