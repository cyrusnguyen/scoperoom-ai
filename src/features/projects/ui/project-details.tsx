"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SubmitEvent } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { MAX_COLLABORATORS, projectMemberRoles, type ProjectMemberRole } from "../contracts/invitation";
import type { ProjectAccessRole, ProjectBootstrap } from "../contracts/project";
import { roleLabel } from "./format";
import ProjectShare from "./project-share";

type Member = { profileId: string; displayName: string; role: ProjectAccessRole; version: number; designatedApprover: boolean };
/** `focus` is the id of the control that takes focus once the change settles (the button that started it may be gone). */
type Mutation = { url: string; method?: "PATCH" | "DELETE"; body: Record<string, unknown>; confirmation: string; clears?: string; focus: string };
type Confirming = { member: Member; role?: ProjectMemberRole };

const rank: Record<ProjectMemberRole, number> = { VIEWER: 1, REVIEWER: 2, EDITOR: 3 };

/**
 * The right panel's Details tab: project facts, members, invitations, approver, and archive or leave. Unsaved name,
 * approver and invite-email values live in the shell's per-project store (`drafts`), so closing the panel or switching
 * away never drops them silently. Mutations carry the versions read here; an uncertain result retries with the same key.
 */
export default function ProjectDetails({ bootstrap, drafts, setDraft, onChanged, onLifecycle }: {
  bootstrap: ProjectBootstrap; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
  onChanged: () => void; onLifecycle: (kind: "archive" | "leave") => void;
}) {
  const { project, draft } = bootstrap;
  const owner = project.role === "OWNER";
  const active = project.status === "ACTIVE";
  const manage = owner && active;
  const sync = useSync();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<{ mutation: Mutation; key: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    // After each render: once the pending target is enabled again, focus it, but only if focus was lost (the button that
    // started the change unmounted or was disabled); never pull focus from where the user moved it meanwhile.
    // An uncertain result focuses Retry change instead.
    if (!focusAfter.current || busy) return;
    const element = document.getElementById(retry ? "details-retry" : focusAfter.current) as HTMLButtonElement | null;
    if (!element || element.disabled) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (!active || active === document.body) element.focus();
  });

  // Versions come from the shared status (one controller per project); the members list stays this tab's own read.
  // Both are fenced: an answer that the controller has since replaced (project switch, replaced draft) changes nothing.
  const { status: shared, revalidate, fence } = sync;
  const membershipVersion = shared.membershipVersion;
  // Guards come from the data shown (the bootstrap's name and approver), never from the polled status: a version that has
  // moved without the shown value moving would let a save overwrite another tab's change unseen. When the polled
  // version passes the shown one and the person has not typed into that field, the bootstrap is refreshed so the shown
  // value and its guard move together; a typed draft is kept, and its save conflicts into the re-read recovery.
  const shownVersions = bootstrap.status;
  const settingsAhead = shared.settingsVersion > shownVersions.settingsVersion, policyAhead = shared.approvalPolicyVersion > shownVersions.approvalPolicyVersion;
  const stale = (settingsAhead && "name" in drafts) || (policyAhead && "approver" in drafts);
  const refresh = useRef(onChanged);
  useLayoutEffect(() => { refresh.current = onChanged; });
  useEffect(() => { if ((settingsAhead || policyAhead) && !stale) refresh.current(); }, [settingsAhead, policyAhead, stale]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = fence();
    const [authority, nextMembers] = await Promise.all([revalidate("manual"), apiRead<{ members: Member[] }>(`/api/projects/${project.id}/members`, signal)]);
    if (signal?.aborted || !current()) return false;
    if (sessionEnded(nextMembers)) return false;
    if (authority.kind !== "current" || !nextMembers.ok) { setMembers(null); setLoadError(nextMembers.ok ? "ScopeRoom is unavailable right now. Try again." : nextMembers.message); return false; }
    setMembers(nextMembers.data.members);
    setLoadError("");
    return true;
  }, [project.id, revalidate, fence]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, project.status, membershipVersion]); // an archive, restore or membership change reloads the versions this tab writes with

  const mutate = async (mutation: Mutation, key = crypto.randomUUID()) => {
    focusAfter.current = mutation.focus;
    setBusy(true);
    setRetry(null);
    setMessage("");
    setMessageError(false);
    // The write barrier: another window may have signed in as someone else since the last status read.
    const authority = await sync.beforeWrite();
    if (authority.kind !== "current") {
      setBusy(false);
      if (retry?.key === key) setRetry(retry);
      // Denied: the shell's teardown or recovery view replaces this; if the Studio stays up, the person sees why nothing happened.
      setMessage(authority.kind === "unavailable" ? "Not saved. We couldn’t reach ScopeRoom." : "Checking your access…"); setMessageError(authority.kind === "unavailable");
      return;
    }
    const result = await apiMutate(mutation.url, key, mutation.body, mutation.method ?? "PATCH");
    if (sessionEnded(result)) { setBusy(false); return; }
    if (!result.ok) {
      if (result.uncertain) {
        setBusy(false);
        setRetry({ mutation, key });
        setMessage("We could not confirm that change. Retry uses the same request.");
        setMessageError(true);
        return;
      }
      setMessage(result.message);
      setMessageError(true);
      // A conflict re-reads the versions before the button re-enables, so a fast retry can't reuse a stale one,
      // and re-reads the project so the header shows the current saved name beside the kept attempt.
      if (result.code === "CONFLICT") { await load(); onChanged(); }
      setBusy(false);
      return;
    }
    setBusy(false);
    if (mutation.clears) setDraft(mutation.clears, undefined);
    const refreshed = await load();
    setMessage(refreshed ? mutation.confirmation : `${mutation.confirmation} Details could not be refreshed.`);
    setMessageError(!refreshed);
    onChanged();
  };

  // An uncertain change may still commit: drop its key and re-read what is saved.
  const discardRetry = () => {
    if (!retry) return;
    if (retry.mutation.clears) setDraft(retry.mutation.clears, undefined);
    focusAfter.current = retry.mutation.focus;
    setRetry(null);
    setMessage("");
    setMessageError(false);
    void load();
    onChanged();
  };

  const name = drafts.name ?? project.name;
  // A failed read disables the forms, as before: their versions would be a guess.
  const status = loadError ? null : shared;
  // The approver is shown from the same bootstrap as its guard (`shownVersions`), never from the polled status.
  const savedApprover = status ? shownVersions.designatedApproverId ?? "" : "";
  const approver = drafts.approver ?? savedApprover;
  const ownerName = members?.find((member) => member.role === "OWNER")?.displayName;
  const flowCount = Object.keys(draft.document.flows).length;

  const saveName = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status) void mutate({ url: `/api/projects/${project.id}/settings`, body: { name, expectedSettingsVersion: shownVersions.settingsVersion }, confirmation: "Project name updated.", clears: "name", focus: "project-settings-name" });
  };
  const saveApprover = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status) void mutate({ url: `/api/projects/${project.id}/approval-policy`, body: { designatedApproverId: approver || null, expectedApprovalPolicyVersion: shownVersions.approvalPolicyVersion }, confirmation: "Approver updated.", clears: "approver", focus: "designated-approver" });
  };
  const changeRole = (member: Member, role: ProjectMemberRole) => void mutate({ url: `/api/projects/${project.id}/members/${member.profileId}`, body: { role, expectedMemberVersion: member.version }, confirmation: "Member role updated.", focus: `role-${member.profileId}` });
  const removeMember = (member: Member) => void mutate({ url: `/api/projects/${project.id}/members/${member.profileId}`, method: "DELETE", body: { expectedMemberVersion: member.version }, confirmation: "Member removed.", focus: "details-members" });
  // A reduction names its effect before confirmation (UI01); an increase applies directly.
  const pickRole = (member: Member, role: ProjectMemberRole) => {
    if (rank[role] < rank[member.role as ProjectMemberRole]) setConfirming({ member, role });
    else changeRole(member, role);
  };
  const cancelConfirm = () => {
    if (confirming) focusAfter.current = confirming.role ? `role-${confirming.member.profileId}` : `remove-${confirming.member.profileId}`;
    setConfirming(null);
  };
  const confirm = () => {
    if (!confirming) return;
    const { member, role } = confirming;
    setConfirming(null);
    if (role) changeRole(member, role);
    else removeMember(member);
  };
  // The server clears the designated approver on removal or a downgrade to Viewer.
  const confirmText = !confirming ? "" : (confirming.role
    ? `Changing ${confirming.member.displayName} to ${roleLabel(confirming.role)} reduces their project access.`
    : `Removing ${confirming.member.displayName} revokes their project access.`)
    + (confirming.member.designatedApprover && (!confirming.role || confirming.role === "VIEWER") ? " They are the designated approver, so the project will have none." : "");

  return <>
    <section className="detail-section" aria-labelledby="details-project">
      <h3 id="details-project">Project</h3>
      {manage ? <form className="form-row" onSubmit={saveName}>
        <label className="sr-only" htmlFor="project-settings-name">Project name</label>
        <input id="project-settings-name" value={name} onChange={(event) => setDraft("name", event.target.value === project.name ? undefined : event.target.value)} disabled={busy || !status || Boolean(retry)} required maxLength={120} />
        <button type="submit" className="button small" disabled={busy || !status || Boolean(retry) || !name.trim() || name.trim() === project.name}>Save</button>
      </form> : <p className="detail-name">{project.name}</p>}
      <dl className="detail-facts">
        <div><dt>Owner</dt><dd>{ownerName ?? "—"}</dd></div>
        <div><dt>Your role</dt><dd>{roleLabel(project.role)}</dd></div>
        <div><dt>Status</dt><dd>{active ? "Active" : "Archived"}</dd></div>
        <div><dt>Draft</dt><dd>{flowCount ? `${flowCount} ${flowCount === 1 ? "flow" : "flows"}` : "Empty draft"} · revision {draft.documentRevision}</dd></div>
      </dl>
      {retry && <div className="view-actions">
        <button id="details-retry" type="button" className="button small" disabled={busy} onClick={() => void mutate(retry.mutation, retry.key)}>Retry change</button>
        <button type="button" className="button quiet small" disabled={busy} onClick={discardRetry}>Discard change</button>
      </div>}
      <p className="muted" role={messageError ? "alert" : "status"} aria-live="polite">{message}</p>
    </section>
    <section className="detail-section" aria-labelledby="details-members">
      {!members ? <>
        <h3 id="details-members">Members</h3>
        <p className="muted" role={loadError ? "alert" : undefined}>{loadError || "Loading details…"}</p>
        {loadError && <button type="button" className="button small" onClick={() => void load()}>Retry</button>}
      </> : <>
        <h3 id="details-members" tabIndex={-1}>Members <span className="muted">{members.length} of {MAX_COLLABORATORS}</span></h3>
        {owner && !active && <p className="muted">Settings and role increases are unavailable; the owner can reduce or remove member access.</p>}
        <ul className="item-list">{members.map((member) => <li key={member.profileId} className="member-row">
          <div><strong>{member.displayName}</strong><small>{member.role === "OWNER" ? "Owner" : `${roleLabel(member.role)}${member.designatedApprover ? " · Designated approver" : ""}`}</small></div>
          {owner && member.role !== "OWNER" && <>
            <label className="sr-only" htmlFor={`role-${member.profileId}`}>{`Role for ${member.displayName}`}</label>
            <select id={`role-${member.profileId}`} value={member.role} disabled={busy || Boolean(retry)} onChange={(event) => pickRole(member, event.target.value as ProjectMemberRole)}>
              {projectMemberRoles.filter((role) => active || rank[role] <= rank[member.role as ProjectMemberRole]).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
            </select>
            <button id={`remove-${member.profileId}`} type="button" className="button quiet small" disabled={busy || Boolean(retry)} aria-label={`Remove ${member.displayName}`} onClick={() => setConfirming({ member })}>Remove</button>
          </>}
        </li>)}</ul>
        {confirming && <div key={`${confirming.member.profileId}-${confirming.role ?? "remove"}`} className="inline-note" role="group" aria-label="Confirm access change">
          <p id="access-change-note">{confirmText}</p>
          <div className="view-actions">
            <button type="button" className="button danger small" disabled={busy} onClick={confirm} aria-describedby="access-change-note">{confirming.role ? "Confirm role change" : "Confirm removal"}</button>
            <button type="button" className="button quiet small" onClick={cancelConfirm} autoFocus aria-describedby="access-change-note">Cancel</button>
          </div>
        </div>}
      </>}
    </section>
    {manage && <ProjectShare projectId={project.id} email={drafts["invite-email"] ?? ""} onEmailChange={(value) => setDraft("invite-email", value || undefined)} />}
    {manage && members && <section className="detail-section" aria-labelledby="details-approver">
      <h3 id="details-approver">Approver</h3>
      <form className="form-row" onSubmit={saveApprover}>
        <label className="sr-only" htmlFor="designated-approver">Designated approver</label>
        <select id="designated-approver" value={approver} disabled={busy || Boolean(retry)} onChange={(event) => setDraft("approver", event.target.value === savedApprover ? undefined : event.target.value)}>
          <option value="">No designated approver</option>
          {members.filter((member) => member.role !== "VIEWER").map((member) => <option key={member.profileId} value={member.profileId}>{member.displayName} · {roleLabel(member.role)}</option>)}
        </select>
        <button type="submit" className="button small" disabled={busy || Boolean(retry) || approver === savedApprover}>Save approver</button>
      </form>
    </section>}
    {(active || !owner) && <section className="detail-section">
      {owner
        ? <button type="button" className="button danger small" onClick={() => onLifecycle("archive")}>Archive project…</button>
        : <button type="button" className="button danger small" onClick={() => onLifecycle("leave")}>Leave project…</button>}
    </section>}
  </>;
}
