import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import { MAX_SELECTED_NODES, type PresenceState } from "../contracts/messages.ts";
import type { PresenceClaim } from "./project-live";

/** What the authorized members list gives a peer; the directory, not the peer's claim, decides names and roles. */
export type DirectoryMember = { profileId: string; displayName: string; role: ProjectAccessRole };
/** One person (not one tab): `sessions` is secondary. `role` is null for an id the directory does not list. */
export type Person = { profileId: string; name: string; role: ProjectAccessRole | null; sessions: number; color: number };

export const UNKNOWN_PARTICIPANT = "Unknown participant";
export const PALETTE_SIZE = 6;

/** A stable 1..PALETTE_SIZE slot per profile (the `--presence-N` tokens); the same person has the same color on every screen. */
export function paletteIndex(profileId: string): number {
  let hash = 0;
  for (const char of profileId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % PALETTE_SIZE) + 1;
}

/**
 * The other people present, deduplicated by profile. Presence is only a claim: the name and role come from the directory,
 * an id the directory lacks (not loaded yet, or a removed member on a cached socket) is neutral, and the viewer's own
 * profile is left out, including their other tabs.
 */
export function resolveParticipants(roster: PresenceState[], directory: DirectoryMember[] | null, viewerId: string): Person[] {
  const listed = new Map(directory?.map((member) => [member.profileId, member]));
  const sessions = new Map<string, number>();
  for (const entry of roster) if (entry.profileId !== viewerId) sessions.set(entry.profileId, (sessions.get(entry.profileId) ?? 0) + 1);
  return [...sessions].map(([profileId, count]) => {
    const member = listed.get(profileId);
    return { profileId, name: member?.displayName ?? UNKNOWN_PARTICIPANT, role: member?.role ?? null, sessions: count, color: paletteIndex(profileId) };
  }).sort((a, b) => (a.role === null ? 1 : 0) - (b.role === null ? 1 : 0) || a.name.localeCompare(b.name) || a.profileId.localeCompare(b.profileId));
}

/** Who else has each step, connection or flow selected in this flow (a person once per item, however many tabs). */
export function selectorsByItem(roster: PresenceState[], people: Person[], flowId: string, viewerId: string): Map<string, Person[]> {
  const byProfile = new Map(people.map((person) => [person.profileId, person]));
  const items = new Map<string, Person[]>();
  for (const entry of roster) {
    const person = byProfile.get(entry.profileId);
    if (!person || entry.profileId === viewerId || entry.flowId !== flowId || !entry.selection) continue;
    for (const id of entry.selection.ids) {
      const list = items.get(id) ?? [];
      if (!list.includes(person)) items.set(id, [...list, person]);
    }
  }
  return items;
}

type StudioSelection = { kind: "NODES"; ids: string[] } | { kind: "EDGE"; id: string } | { kind: "FLOW"; id: string } | null;

/** The advisory claim for the local flow and selection. More steps than the wire allows, or none, is sent as no selection. */
export function claimOf(flowId: string | null, selection: StudioSelection): PresenceClaim {
  if (!flowId || !selection) return { flowId, selection: null };
  if (selection.kind !== "NODES") return { flowId, selection: { kind: selection.kind, ids: [selection.id] } };
  return { flowId, selection: selection.ids.length && selection.ids.length <= MAX_SELECTED_NODES ? { kind: "NODES", ids: selection.ids } : null };
}

/**
 * The members list is read once and again whenever the membership version moves. A response the controller has since
 * replaced (project switch, generation change) or a newer request has superseded is dropped; a failed read keeps the last
 * list and is tried again on the next `update`.
 */
export function createDirectory({ read, fence, publish }: {
  read: () => Promise<DirectoryMember[] | null>; fence: () => () => boolean; publish: (members: DirectoryMember[]) => void;
}) {
  let loaded: number | null = null, inFlight: { version: number; valid: () => boolean } | null = null, latest = 0;
  return {
    async update(version: number) {
      if (loaded === version || (inFlight?.version === version && inFlight.valid())) return;
      const mine = ++latest, valid = fence();
      inFlight = { version, valid };
      const members = await read();
      if (mine !== latest || !valid()) return;
      inFlight = null;
      if (members) { loaded = version; publish(members); }
    },
  };
}
