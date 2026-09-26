"use client";

import { useEffect, useRef, useState } from "react";
import { apiMutate } from "@/client/api";
import type { MyInvitation } from "@/features/projects/contracts/invitation";
import type { ProjectAccessRole, ProjectCapacity, ProjectListItem, ProjectLists } from "@/features/projects/contracts/project";
import { roleLabel } from "@/features/projects/ui/format";
import { Icon } from "./icon";
import type { LifecycleKind } from "./lifecycle-dialog";
import { tabListKeyDown, useOverlay } from "./right-panel";

export const LIST_TABS = ["owned", "shared", "archived", "invites"] as const;
export type ListTab = (typeof LIST_TABS)[number];
export type InviteRow = MyInvitation & { expiry: { text: string; soon: boolean } };
type ProjectTab = Exclude<ListTab, "invites">;
type RowAction = { kind: LifecycleKind; label: string; disabled?: boolean };

const tabCopy: Record<ListTab, { label: string; name: string; empty: string }> = {
  owned: { label: "Owned", name: "Owned projects", empty: "No projects yet." },
  shared: { label: "Shared", name: "Shared with me", empty: "Nothing shared with you." },
  archived: { label: "Archived", name: "Archived projects", empty: "No archived projects." },
  invites: { label: "Invites", name: "Invitations", empty: "No pending invitations." },
};

export default function ProjectsSidebar({ lists, invites, state, onRetry, tab, onTabChange, openProjectId, onOpenProject, hidden, overlay, onHide, onNewProject, onAction, onInviteSettled }: {
  lists: ProjectLists | null; invites: { items: InviteRow[]; truncated: boolean } | null; state: "loading" | "ready" | "error"; onRetry: () => void;
  tab: ListTab; onTabChange: (tab: ListTab) => void; openProjectId?: string; onOpenProject: (id: string) => void;
  hidden: boolean; overlay: boolean; onHide: () => void; onNewProject: () => void;
  onAction: (kind: LifecycleKind, item: ProjectListItem) => void; onInviteSettled: (text: string, error?: boolean) => void;
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
      : tab === "invites" ? <InvitesList invites={data.invites.items} onSettled={onInviteSettled} />
      : <>
        <ul className="projects-list">{rows.map((item) => <ProjectRow key={item.id} item={item} tab={tab} capacity={data.lists.capacity} open={item.id === openProjectId} onOpen={() => onOpenProject(item.id)} onAction={(kind) => onAction(kind, item)} />)}</ul>
        {!rows.length && <p className="projects-empty">{filter ? <>No matches for &ldquo;{query.trim()}&rdquo;. <button type="button" className="button quiet small" onClick={() => setQuery("")}>Clear</button></> : tabCopy[tab].empty}</p>}
      </>}
      {truncated && <p className="projects-truncated">{tab === "invites" ? "Showing the first 50." : "Showing the first 100. Use Filter to narrow."}</p>}
    </div>
    <footer className="projects-footer">{lists && <CapacityFooter capacity={lists.capacity} onNewProject={onNewProject} />}</footer>
  </nav>;
}

/** Owned: archive. Shared or archived-and-not-owner: leave. Archived-and-owner: restore, disabled with its reason when capacity says no. */
function rowActions(item: ProjectListItem, tab: ProjectTab, capacity: ProjectCapacity): RowAction[] {
  if (tab === "owned") return [{ kind: "archive", label: "Archive…" }];
  if (item.role !== "OWNER") return [{ kind: "leave", label: "Leave…" }];
  if (capacity.canCreate) return [{ kind: "restore", label: "Restore…" }];
  return [{ kind: "restore", label: capacity.entitled ? `Restore — at limit (${capacity.activeOwned}/${capacity.maxOwned})` : "Restore — not enabled for this account", disabled: true }];
}

function ProjectRow({ item, tab, capacity, open, onOpen, onAction }: { item: ProjectListItem; tab: ProjectTab; capacity: ProjectCapacity; open: boolean; onOpen: () => void; onAction: (kind: LifecycleKind) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    items()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Tab") {
        // Capture phase + stopPropagation: Esc closes only this menu, not an overlay sidebar around it.
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        setMenuOpen(false);
        triggerRef.current?.focus();
        return;
      }
      const list = items(), index = list.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (index + 1) % list.length : event.key === "ArrowUp" ? (index - 1 + list.length) % list.length : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); list[next]?.focus(); }
    }
    function onPointer(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("mousedown", onPointer); };
  }, [menuOpen]);

  // Focus the trigger before the dialog opens, so closing the dialog returns focus to this row.
  const choose = (kind: LifecycleKind) => { setMenuOpen(false); triggerRef.current?.focus(); onAction(kind); };
  return <li className="projects-row-wrap">
    <button type="button" className="project-row" aria-current={open ? "true" : undefined} title={item.name} onClick={onOpen}>
      <span className="project-row-name">{item.name}</span>
      {item.role !== "OWNER" && <small>{item.ownerName} · {roleLabel(item.role)}</small>}
    </button>
    <div className="projects-row-menu">
      <button ref={triggerRef} type="button" className="button quiet small more-button" aria-label={`Actions for ${item.name}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon name="more" size={14} /></button>
      {menuOpen && <div ref={menuRef} role="menu" aria-label={`Actions for ${item.name}`} className="projects-row-menu-list">
        {rowActions(item, tab, capacity).map((action) => <button key={action.kind} type="button" role="menuitem" tabIndex={-1} className="menu-item" aria-disabled={action.disabled || undefined} onClick={action.disabled ? undefined : () => choose(action.kind)}>{action.label}</button>)}
      </div>}
    </div>
  </li>;
}

function without(record: Record<string, string>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Invitation metadata only (name, inviter, role, expiry), never project content. Accept uses POST /api/invitations/accept
 * with the invitation id. An uncertain result keeps that row's key for Retry; accepting never changes the tab or the open project.
 */
function InvitesList({ invites, onSettled }: { invites: InviteRow[]; onSettled: (text: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!invites.length) return <p className="projects-empty">{tabCopy.invites.empty}</p>;

  async function accept(invite: InviteRow) {
    const key = keys[invite.id] ?? crypto.randomUUID();
    setKeys((current) => ({ ...current, [invite.id]: key }));
    setErrors((current) => without(current, invite.id));
    setBusy(invite.id);
    const result = await apiMutate<{ projectId: string; role: ProjectAccessRole }>("/api/invitations/accept", key, { invitationId: invite.id });
    setBusy(null);
    if (!result.ok && result.uncertain) { setErrors((current) => ({ ...current, [invite.id]: "We could not confirm this. Retry uses the same request." })); return; }
    setKeys((current) => without(current, invite.id));
    if (result.ok) onSettled(`Joined ${invite.projectName} as ${roleLabel(result.data.role)}.`);
    else if (result.code === "COLLABORATOR_LIMIT") setErrors((current) => ({ ...current, [invite.id]: result.message }));
    else onSettled(result.code === "NOT_FOUND" ? "This invitation is no longer available." : result.message, result.code !== "ALREADY_MEMBER" && result.code !== "NOT_FOUND");
  }

  return <ul className="projects-list">{invites.map((invite) => <li key={invite.id} className="invite-row">
    <div className="invite-row-text">
      <span className="invite-row-name" title={invite.projectName}>{invite.projectName}</span>
      <small>From {invite.inviterName} · {roleLabel(invite.role)} · <span className={invite.expiry.soon ? "invite-expiry-soon" : undefined}>{invite.expiry.text}</span></small>
    </div>
    <button type="button" className="button small" disabled={busy === invite.id} aria-label={`${keys[invite.id] && busy !== invite.id ? "Retry accepting" : "Accept"} ${invite.projectName}`}
      aria-describedby={errors[invite.id] ? `invite-error-${invite.id}` : undefined} onClick={() => void accept(invite)}>
      {busy === invite.id ? "Accepting…" : keys[invite.id] ? "Retry" : "Accept"}
    </button>
    {errors[invite.id] && <small className="invite-error" id={`invite-error-${invite.id}`}>{errors[invite.id]}</small>}
  </li>)}</ul>;
}

function CapacityFooter({ capacity, onNewProject }: { capacity: ProjectCapacity; onNewProject: () => void }) {
  if (!capacity.entitled) return <p className="projects-footer-note">Creating projects isn&rsquo;t enabled for this account.</p>;
  return <>
    <button type="button" className="button small" disabled={!capacity.canCreate} aria-describedby="capacity-note" onClick={onNewProject}><Icon name="plus" size={13} />New project</button>
    <span id="capacity-note" className="projects-footer-note">{capacity.activeOwned} of {capacity.maxOwned} active{capacity.canCreate ? "" : " · archive one to add another"}</span>
  </>;
}
