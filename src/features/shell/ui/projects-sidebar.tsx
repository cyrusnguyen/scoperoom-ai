"use client";

import { useRef, useState } from "react";
import type { MyInvitation } from "@/features/projects/contracts/invitation";
import type { ProjectCapacity, ProjectListItem, ProjectLists } from "@/features/projects/contracts/project";
import { roleLabel } from "@/features/projects/ui/format";
import { Icon } from "./icon";
import { tabListKeyDown, useOverlay } from "./right-panel";

export const LIST_TABS = ["owned", "shared", "archived", "invites"] as const;
export type ListTab = (typeof LIST_TABS)[number];
export type InviteRow = MyInvitation & { expiry: { text: string; soon: boolean } };

const tabCopy: Record<ListTab, { label: string; name: string; empty: string }> = {
  owned: { label: "Owned", name: "Owned projects", empty: "No projects yet." },
  shared: { label: "Shared", name: "Shared with me", empty: "Nothing shared with you." },
  archived: { label: "Archived", name: "Archived projects", empty: "No archived projects." },
  invites: { label: "Invites", name: "Invitations", empty: "No pending invitations." },
};

export default function ProjectsSidebar({ lists, invites, state, onRetry, tab, onTabChange, openProjectId, onOpenProject, hidden, overlay, onHide, onNewProject }: {
  lists: ProjectLists | null; invites: { items: InviteRow[]; truncated: boolean } | null; state: "loading" | "ready" | "error"; onRetry: () => void;
  tab: ListTab; onTabChange: (tab: ListTab) => void; openProjectId?: string; onOpenProject: (id: string) => void;
  hidden: boolean; overlay: boolean; onHide: () => void; onNewProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);
  useOverlay(navRef, overlay, onHide);
  const changeTab = (next: ListTab) => { setQuery(""); onTabChange(next); };
  const pending = invites?.items.length ?? 0;
  const data = state === "ready" && lists && invites ? { lists, invites } : null;
  const group = data && tab !== "invites" ? data.lists[tab] : null;
  const filter = query.trim().toLowerCase();
  const rows = group?.items.filter((item) => item.name.toLowerCase().includes(filter)) ?? [];
  const truncated = !data ? false : tab === "invites" ? data.invites.truncated : Boolean(group?.truncated);

  return <nav ref={navRef} id="projects-nav" className="projects-nav" aria-label="Projects" hidden={hidden} role={overlay ? "dialog" : undefined} aria-modal={overlay || undefined}>
    <header className="projects-nav-header">
      <span className="brand"><span className="brand-mark" aria-hidden="true">s<span className="brand-r">r</span></span>Projects</span>
      <button type="button" className="button quiet small" onClick={onHide} aria-label="Hide projects" aria-expanded={!hidden} aria-controls="projects-nav"><Icon name="panel" /></button>
    </header>
    <div className="projects-tabs" role="tablist" aria-label="Project lists">
      {LIST_TABS.map((id, index) => <button key={id} type="button" role="tab" id={`tab-${id}`} aria-controls="projects-list" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} data-active={tab === id}
        aria-label={id === "invites" ? `Invitations, ${pending} pending` : tabCopy[id].name} onClick={() => changeTab(id)} onKeyDown={(event) => tabListKeyDown(event, LIST_TABS, index, changeTab)}>
        {tabCopy[id].label}{id === "invites" && pending > 0 && <span className="badge" aria-hidden="true">{pending}</span>}
      </button>)}
    </div>
    {tab !== "invites" && <div className="projects-search">
      <label className="sr-only" htmlFor="projects-filter">{`Filter ${tab} projects`}</label>
      <input id="projects-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter" />
    </div>}
    <div id="projects-list" role="tabpanel" aria-labelledby={`tab-${tab}`} className="projects-list-panel">
      {state === "error" ? <div className="projects-empty" role="alert"><p>Projects couldn&rsquo;t load.</p><button type="button" className="button small" onClick={onRetry}>Retry</button></div>
      : !data ? <><span className="sr-only">Loading projects</span><ul className="projects-list" aria-busy="true">{[0, 1, 2].map((index) => <li key={index} className="project-row-skeleton" />)}</ul></>
      : tab === "invites" ? <InvitesList invites={data.invites.items} />
      : <>
        <ul className="projects-list">{rows.map((item) => <ProjectRow key={item.id} item={item} open={item.id === openProjectId} onOpen={() => onOpenProject(item.id)} />)}</ul>
        {!rows.length && <p className="projects-empty">{filter ? <>No matches for &ldquo;{query.trim()}&rdquo;. <button type="button" className="button quiet small" onClick={() => setQuery("")}>Clear</button></> : tabCopy[tab].empty}</p>}
      </>}
      {truncated && <p className="projects-truncated">{tab === "invites" ? "Showing the first 50." : "Showing the first 100. Use Filter to narrow."}</p>}
    </div>
    <footer className="projects-footer">{lists && <CapacityFooter capacity={lists.capacity} onNewProject={onNewProject} />}</footer>
  </nav>;
}

function ProjectRow({ item, open, onOpen }: { item: ProjectListItem; open: boolean; onOpen: () => void }) {
  return <li className="projects-row-wrap">
    <button type="button" className="project-row" aria-current={open ? "true" : undefined} title={item.name} onClick={onOpen}>
      <span className="project-row-name">{item.name}</span>
      {item.role !== "OWNER" && <small>{item.ownerName} · {roleLabel(item.role)}</small>}
    </button>
  </li>;
}

/** Invitation metadata only (name, inviter, role, expiry): never project content. */
function InvitesList({ invites }: { invites: InviteRow[] }) {
  if (!invites.length) return <p className="projects-empty">{tabCopy.invites.empty}</p>;
  return <ul className="projects-list">{invites.map((invite) => <li key={invite.id} className="invite-row">
    <div className="invite-row-text">
      <span className="invite-row-name" title={invite.projectName}>{invite.projectName}</span>
      <small>From {invite.inviterName} · {roleLabel(invite.role)} · <span className={invite.expiry.soon ? "invite-expiry-soon" : undefined}>{invite.expiry.text}</span></small>
    </div>
  </li>)}</ul>;
}

function CapacityFooter({ capacity, onNewProject }: { capacity: ProjectCapacity; onNewProject: () => void }) {
  if (!capacity.entitled) return <p className="projects-footer-note">Creating projects isn&rsquo;t enabled for this account.</p>;
  return <>
    <button type="button" className="button small" disabled={!capacity.canCreate} aria-describedby="capacity-note" onClick={onNewProject}><Icon name="plus" size={13} />New project</button>
    <span id="capacity-note" className="projects-footer-note">{capacity.activeOwned} of {capacity.maxOwned} active{capacity.canCreate ? "" : " · archive one to add another"}</span>
  </>;
}
