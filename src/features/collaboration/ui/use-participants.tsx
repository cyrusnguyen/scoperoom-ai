"use client";

import { useId, useMemo, useRef, useState } from "react";
import { roleLabel } from "@/features/projects/ui/format";
import { resolveParticipants, selectorsByItem, type Person } from "./participants";
import { useSync } from "./sync-context";

/** The other people here (one per profile) and, for a flow, who has each item selected. Advisory; a claim is not authorship. */
export function useParticipants(flowId?: string) {
  const { roster, directory, status: { viewerId } } = useSync();
  const people = useMemo(() => resolveParticipants(roster, directory, viewerId), [roster, directory, viewerId]);
  const selectedBy = useMemo(() => (flowId ? selectorsByItem(roster, people, flowId, viewerId) : new Map<string, Person[]>()), [roster, people, flowId, viewerId]);
  return { people, selectedBy };
}

/** A token-colored dot per person who has the item selected, with their names in text for a screen reader (not a live region). */
export function SelectedBy({ people }: { people: Person[] | undefined }) {
  if (!people?.length) return null;
  const names = people.map((person) => person.name).join(", ");
  return <span className="presence-marks" title={`Also selected by ${names}`}>
    {people.map((person) => <span key={person.profileId} className="presence-dot" data-presence={person.color} aria-hidden="true" />)}
    <span className="sr-only">Also selected by {names}</span>
  </span>;
}

/** The Studio header's count of other people here, expandable to a list. Names come from the members list; presence is a self-reported claim. */
export function Participants({ flowId }: { flowId: string }) {
  const { people } = useParticipants(flowId);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  return <div className="participants" onKeyDown={(event) => { if (event.key === "Escape" && open) { setOpen(false); toggle.current?.focus(); } }}>
    <button ref={toggle} type="button" className="button quiet small" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
      {people.length === 1 ? "1 other person here" : `${people.length} other people here`}
    </button>
    <div id={listId} className="participants-list" hidden={!open}>
      {people.length ? <ul className="plain-list">{people.map((person) => <li key={person.profileId}>
        <span className="presence-dot" data-presence={person.color} aria-hidden="true" />
        <strong>{person.name}</strong>
        {person.role && <span className="muted"> {roleLabel(person.role)}</span>}
        {person.sessions > 1 && <span className="muted"> · {person.sessions} tabs</span>}
      </li>)}</ul> : <p className="muted">No one else has reported being here right now.</p>}
      <p className="muted">Names and roles come from the project’s member list. Who is here and what they have selected is reported by each browser; it is not verified and does not show who made a change.</p>
    </div>
  </div>;
}
