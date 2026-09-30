"use client";

import { useCallback, useEffect, useState, type SubmitEvent } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { projectMemberRoles, type ProjectMemberRole } from "../contracts/invitation";
import { roleLabel } from "./format";

type Invitation = { id: string; verifiedEmail: string; role: ProjectMemberRole; expiresAt: string; status: string; version: number };
type Issue = Invitation & { url?: string; linkUnavailable: boolean; replayed: boolean };

/**
 * Details → Invite (owner of an ACTIVE project). The one-time link is held in memory only. A lost response can be replayed
 * for the invitation's metadata but never its link, so the owner is offered Revoke and reissue.
 */
export default function ProjectShare({ projectId, email, onEmailChange }: { projectId: string; email: string; onEmailChange: (value: string) => void }) {
  const sync = useSync();
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>("EDITOR");
  const [key, setKey] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [issued, setIssued] = useState<Issue | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeKeys, setRevokeKeys] = useState<Record<string, string>>({});

  const refresh = useCallback(async (clearMessage = true, signal?: AbortSignal) => {
    const result = await apiRead<{ invitations: Invitation[] }>(`/api/projects/${projectId}/invitations`, signal);
    if (signal?.aborted) return false;
    if (sessionEnded(result)) return false;
    if (!result.ok) { setInvitations(null); setRefreshFailed(true); setMessage(result.message); setMessageError(true); return false; }
    setInvitations(result.data.invitations);
    setRefreshFailed(false);
    if (clearMessage) { setMessage(""); setMessageError(false); }
    return true;
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(true, controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [refresh]);

  /** The write barrier: another window may have signed in as someone else since the last status read. */
  const writable = async () => {
    const authority = await sync.beforeWrite();
    if (authority.kind === "current") return true;
    // Denied: the shell's teardown or recovery view replaces this; if the Studio stays up, the person sees why nothing happened.
    setMessage(authority.kind === "unavailable" ? "Not saved. We couldn’t reach ScopeRoom." : "Checking your access…"); setMessageError(authority.kind === "unavailable");
    return false;
  };

  const issue = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestKey = key || crypto.randomUUID();
    const wasUncertain = uncertain;
    setIssuing(true);
    setUncertain(false);
    setMessage("");
    setMessageError(false);
    if (!await writable()) { setIssuing(false); setUncertain(wasUncertain); return; }
    setKey(requestKey);
    const result = await apiMutate<Issue>(`/api/projects/${projectId}/invitations`, requestKey, { verifiedEmail: email, role: inviteRole });
    setIssuing(false);
    if (sessionEnded(result)) return;
    if (!result.ok) {
      setUncertain(result.uncertain);
      setMessage(result.status === 0 ? "We could not confirm invitation creation. Retry uses the same invitation request." : result.message);
      setMessageError(true);
      if (!result.uncertain) setKey("");
      return;
    }
    const next = result.data;
    setIssued(next);
    setKey("");
    onEmailChange("");
    const confirmation = next.linkUnavailable ? "The invitation was already created, but its one-time link is no longer available." : next.replayed ? "This invitation was already created." : "Invitation created.";
    // Confirm with the link, so a Copy result reported during the list refresh is not overwritten.
    setMessage(confirmation);
    setMessageError(false);
    if (!await refresh(false)) setMessage((current) => `${confirmation} ${current}`);
  };

  const copy = async () => {
    if (!issued?.url) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setMessage("Invitation link copied.");
      setMessageError(false);
    } catch {
      setMessage("Copy did not complete. Select the link and copy it manually.");
      setMessageError(true);
    }
  };

  const setRevokeKey = (id: string, key?: string) => setRevokeKeys((current) => {
    const next = { ...current };
    if (key) next[id] = key;
    else delete next[id];
    return next;
  });

  /** An uncertain result keeps this row's key for Retry; a CONFLICT re-reads the list before the row's button re-enables. */
  const revoke = async (invitation: Invitation) => {
    const key = revokeKeys[invitation.id] ?? crypto.randomUUID();
    setRevoking(invitation.id);
    setMessage("");
    setMessageError(false);
    if (!await writable()) { setRevoking(null); return; }
    setRevokeKey(invitation.id, key);
    const result = await apiMutate(`/api/projects/${projectId}/invitations/${invitation.id}/revoke`, key, { expectedVersion: invitation.version });
    if (sessionEnded(result)) { setRevoking(null); return; }
    if (!result.ok && result.uncertain) {
      setRevoking(null);
      setMessage("We could not confirm that invitation was revoked. Retry uses the same request.");
      setMessageError(true);
      return;
    }
    setRevokeKey(invitation.id);
    if (!result.ok) {
      setMessage(result.message);
      setMessageError(true);
      if (result.code === "CONFLICT") await refresh(false);
      setRevoking(null);
      return;
    }
    setRevoking(null);
    setIssued((current) => current?.id === invitation.id ? null : current);
    const confirmation = "Invitation revoked. You can create a replacement invitation.";
    const refreshed = await refresh(false);
    setMessage((current) => refreshed ? confirmation : `${confirmation} ${current}`);
    setMessageError(!refreshed);
  };

  const pending = invitations?.filter((invitation) => invitation.status === "PENDING") ?? [];
  return <section className="detail-section" aria-labelledby="share-title">
    <h3 id="share-title">Invite</h3>
    <p className="muted">Editors can edit this whole project. Invitation links are one-time and expire after seven days.</p>
    <form onSubmit={issue}>
      <div className="field">
        <label htmlFor="invite-email">Verified email</label>
        <input id="invite-email" name="email" type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} disabled={issuing || uncertain} autoComplete="email" required maxLength={254} />
      </div>
      <div className="field">
        <label htmlFor="invite-role">Project role</label>
        <select id="invite-role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as ProjectMemberRole)} disabled={issuing || uncertain}>
          {projectMemberRoles.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}
        </select>
      </div>
      <div className="view-actions">
        <button type="submit" className="button small" disabled={issuing}>{issuing ? "Creating..." : uncertain ? "Retry invitation" : "Create invitation"}</button>
        {(uncertain || issued) && <button type="button" className="button quiet small" disabled={issuing} onClick={() => { setIssued(null); setKey(""); setUncertain(false); setMessage(""); }}>Cancel</button>}
      </div>
    </form>
    {issued?.url && <div className="field invite-link">
      <label htmlFor="invite-link">One-time invitation link</label>
      <input id="invite-link" value={issued.url} readOnly onFocus={(event) => event.currentTarget.select()} aria-describedby="invite-link-help" />
      <div className="view-actions"><button type="button" className="button small" onClick={() => void copy()}>Copy link</button></div>
      <small id="invite-link-help">Select this link to copy it manually if needed. It is not shown again after reload.</small>
    </div>}
    {issued?.linkUnavailable && <div className="inline-note">
      <p>Revoke this invitation before creating a replacement. The original link cannot be recovered.</p>
      <div className="view-actions"><button type="button" className="button small" onClick={() => void revoke(issued)} disabled={revoking === issued.id}>{revokeKeys[issued.id] && revoking !== issued.id ? "Retry revoke and reissue" : "Revoke and reissue"}</button></div>
    </div>}
    <p className="muted" role={messageError ? "alert" : "status"} aria-live="polite">{message}</p>
    <div className="section-heading">
      <h4>Pending invitations</h4>
      <button type="button" className="button quiet small" onClick={() => void refresh()} disabled={Boolean(revoking)}>Refresh</button>
    </div>
    {invitations === null ? <p className="muted">{refreshFailed ? "Invitation details could not be refreshed. Use Refresh to retry." : "Loading invitation details..."}</p>
    : pending.length ? <ul className="item-list">{pending.map((invitation) => <li key={invitation.id} className="item-row">
      <span><strong>{invitation.verifiedEmail}</strong><small>{roleLabel(invitation.role)} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span>
      <button type="button" className="button quiet small" onClick={() => void revoke(invitation)} disabled={revoking === invitation.id}>{revoking === invitation.id ? "Revoking..." : revokeKeys[invitation.id] ? "Retry revoke" : "Revoke"}</button>
    </li>)}</ul>
    : <p className="muted">No pending invitations.</p>}
  </section>;
}
