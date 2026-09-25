"use client";

import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";

type Role = "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER";
type Invitation = { id: string; verifiedEmail: string; role: Exclude<Role, "OWNER">; expiresAt: string; status: string; version: number };
type Issue = Invitation & { url?: string; linkUnavailable: boolean; replayed: boolean };
type ApiError = { error?: { message?: string } };

async function errorMessage(response: Response, fallback: string) {
  try { return (await response.json() as ApiError).error?.message || fallback; } catch { return fallback; }
}

function roleLabel(role: Role) { return role[0] + role.slice(1).toLowerCase(); }

export default function ProjectShare({ projectId, role, openRequest = 0, showTrigger = true, embedded = false }: { projectId: string; role: Role; openRequest?: number; showTrigger?: boolean; embedded?: boolean }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Invitation["role"]>("EDITOR");
  const [key, setKey] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [issued, setIssued] = useState<Issue | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const visible = embedded || open;

  const refresh = useCallback(async (clearMessage = true) => {
    try {
      const response = await fetch(`/api/projects/${projectId}/invitations`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "Invitation details are unavailable."));
      const body = await response.json() as { invitations: Invitation[] };
      setInvitations(body.invitations);
      setRefreshFailed(false);
      if (clearMessage) setMessage("");
      return true;
    } catch (error) {
      setInvitations(null);
      setRefreshFailed(true);
      setMessage(error instanceof Error ? error.message : "Invitation details are unavailable.");
      return false;
    }
  }, [projectId]);

  useEffect(() => { if (openRequest) { const timer = window.setTimeout(() => setOpen(true), 0); return () => window.clearTimeout(timer); } }, [openRequest]);
  useEffect(() => {
    if (!visible || role !== "OWNER") return;
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [visible, refresh, role]);

  useEffect(() => { if (visible && (open || openRequest)) { const timer = window.setTimeout(() => emailRef.current?.focus(), 0); return () => window.clearTimeout(timer); } }, [visible, open, openRequest]);

  if (role !== "OWNER") return null;

  const issue = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestKey = key || crypto.randomUUID();
    setKey(requestKey);
    setIssuing(true);
    setUncertain(false);
    setMessage("");
    try {
      const response = await fetch(`/api/projects/${projectId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
        body: JSON.stringify({ verifiedEmail: email, role: inviteRole }),
      });
      if (!response.ok) {
        setMessage(await errorMessage(response, "We could not create this invitation."));
        setUncertain(response.status >= 500);
        if (response.status < 500) setKey("");
        return;
      }
      const next = await response.json() as Issue;
      setIssued(next);
      setKey("");
      setUncertain(false);
      const refreshed = await refresh(false);
      const confirmation = next.linkUnavailable ? "The invitation was already created, but its one-time link is no longer available." : next.replayed ? "This invitation was already created." : "Invitation created.";
      setMessage((current) => refreshed ? confirmation : `${confirmation} ${current}`);
    } catch {
      setUncertain(true);
      setMessage("We could not confirm invitation creation. Retry uses the same invitation request.");
    } finally {
      setIssuing(false);
    }
  };

  const copy = async () => {
    if (!issued?.url) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setMessage("Invitation link copied.");
    } catch {
      setMessage("Copy did not complete. Select the link and copy it manually.");
    }
  };

  const revoke = async (invitation: Invitation) => {
    const requestKey = crypto.randomUUID();
    setRevoking(invitation.id);
    setMessage("");
    try {
      const response = await fetch(`/api/projects/${projectId}/invitations/${invitation.id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
        body: JSON.stringify({ expectedVersion: invitation.version }),
      });
      if (!response.ok) {
        setMessage(await errorMessage(response, "We could not revoke this invitation."));
        return;
      }
      setIssued((current) => current?.id === invitation.id ? null : current);
      const refreshed = await refresh(false);
      const confirmation = "Invitation revoked. You can create a replacement invitation.";
      setMessage((current) => refreshed ? confirmation : `${confirmation} ${current}`);
    } catch {
      setMessage("We could not confirm that invitation was revoked. Refresh before trying again.");
    } finally {
      setRevoking(null);
    }
  };

  const pending = invitations?.filter((invitation) => invitation.status === "PENDING") ?? [];
  return (
    <section className="share-project" aria-labelledby="share-title">
      {showTrigger && !embedded && <button className="context-share-button" type="button" aria-expanded={open} aria-controls="share-panel" onClick={() => setOpen((value) => !value)}>Share project</button>}
      {visible && <div id="share-panel" className="share-panel">
        <h3 id="share-title">Share this project</h3>
        {!embedded && <button className="context-action" type="button" onClick={() => setOpen(false)}>Close sharing</button>}
        <p className="share-notice">Editors can edit this whole project. Invitation links are one-time and expire after seven days.</p>
        <form className="share-form" onSubmit={issue}>
          <label htmlFor="invite-email">Verified email</label>
          <input ref={emailRef} id="invite-email" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={issuing || uncertain} autoComplete="email" required maxLength={254} />
          <label htmlFor="invite-role">Project role</label>
          <select id="invite-role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Invitation["role"])} disabled={issuing || uncertain}>
            {(["EDITOR", "REVIEWER", "VIEWER"] as const).map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}
          </select>
          <div className="share-actions">
            <button className="context-share-button" type="submit" disabled={issuing}>{issuing ? "Creating..." : uncertain ? "Retry invitation" : "Create invitation"}</button>
            {(uncertain || issued) && <button className="context-action" type="button" disabled={issuing} onClick={() => { setIssued(null); setKey(""); setUncertain(false); setMessage(""); }}>Cancel</button>}
          </div>
        </form>
        {issued?.url && <div className="invite-link">
          <label htmlFor="invite-link">One-time invitation link</label>
          <input id="invite-link" value={issued.url} readOnly onFocus={(event) => event.currentTarget.select()} aria-describedby="invite-link-help" />
          <button className="utility-button" type="button" onClick={() => void copy()}>Copy link</button>
          <p id="invite-link-help">Select this link to copy it manually if needed. It is not shown again after reload.</p>
        </div>}
        {issued?.linkUnavailable && <div className="invite-recovery">
          <p>Revoke this invitation before creating a replacement. The original link cannot be recovered.</p>
          <button className="utility-button danger-action" type="button" onClick={() => void revoke(issued)} disabled={revoking === issued.id}>Revoke and reissue</button>
        </div>}
        <p className="share-message" role="status" aria-live="polite">{message}</p>
        <div className="pending-invitations">
          <div className="workspace-list-heading"><h4>Pending invitations</h4><button className="utility-button" type="button" onClick={() => void refresh()} disabled={Boolean(revoking)}>Refresh</button></div>
          {invitations === null ? <p>{refreshFailed ? "Invitation details could not be refreshed. Use Refresh to retry." : "Loading invitation details..."}</p> : pending.length ? <ul>
            {pending.map((invitation) => <li key={invitation.id}>
              <span><strong>{invitation.verifiedEmail}</strong><small>{roleLabel(invitation.role)} - expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span>
              <button className="utility-button danger-action" type="button" onClick={() => void revoke(invitation)} disabled={revoking === invitation.id}>{revoking === invitation.id ? "Revoking..." : "Revoke"}</button>
            </li>)}
          </ul> : <p>No pending invitations.</p>}
        </div>
      </div>}
    </section>
  );
}