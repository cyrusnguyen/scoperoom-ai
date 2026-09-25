"use client";

import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";

type Role = "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER";
type ProjectStatus = "ACTIVE" | "ARCHIVED";
type Status = { status: ProjectStatus; workspaceStatus?: ProjectStatus; version: number; settingsVersion: number; approvalPolicyVersion: number; membershipVersion: number; designatedApproverId: string | null };
type Member = { profileId: string; displayName: string; role: Role; version: number; designatedApprover: boolean };
type ApiError = { error?: { message?: string } };
type Mutation = { method: "PATCH" | "POST" | "DELETE"; url: string; body: Record<string, unknown>; confirmation: string; onSuccess?: () => void };

async function errorMessage(response: Response, fallback: string) {
  try { return (await response.json() as ApiError).error?.message || fallback; } catch { return fallback; }
}
function roleLabel(role: Role) { return role[0] + role.slice(1).toLowerCase(); }
const rank = { VIEWER: 1, REVIEWER: 2, EDITOR: 3 } as const;

export default function ProjectManagement({ projectId, role, projectName, projectStatus, workspaceArchived, onProjectChange, openRequest = 0, embedded = false }: {
  projectId: string;
  role: Role;
  projectName: string;
  projectStatus: ProjectStatus;
  workspaceArchived: boolean;
  onProjectChange: (next: Partial<{ name: string; status: ProjectStatus }>) => void;
  openRequest?: number;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [name, setName] = useState(projectName);
  const [editingName, setEditingName] = useState(false);
  const [approver, setApprover] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [pendingRole, setPendingRole] = useState<{ member: Member; role: Exclude<Role, "OWNER"> } | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [removePending, setRemovePending] = useState<Member | null>(null);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameEditorWasOpen = useRef(false);
  const owner = role === "OWNER";
  const archived = (status?.status ?? projectStatus) === "ARCHIVED";
  const workspaceReadOnly = workspaceArchived || status?.workspaceStatus === "ARCHIVED";
  const readOnly = archived || workspaceReadOnly;
  const visible = embedded || open;

  const refresh = useCallback(async (clearMessage = true) => {
    try {
      const [statusResponse, membersResponse] = await Promise.all([fetch(`/api/projects/${projectId}/status`, { cache: "no-store" }), fetch(`/api/projects/${projectId}/members`, { cache: "no-store" })]);
      if (!statusResponse.ok) throw new Error(await errorMessage(statusResponse, "Project management is unavailable."));
      if (!membersResponse.ok) throw new Error(await errorMessage(membersResponse, "Project management is unavailable."));
      const nextStatus = await statusResponse.json() as Status;
      const nextMembers = await membersResponse.json() as { members: Member[] };
      setStatus(nextStatus); setMembers(nextMembers.members); setApprover(nextStatus.designatedApproverId);
      if (nextStatus.status === "ARCHIVED" || nextStatus.workspaceStatus === "ARCHIVED") { setEditingName(false); setName(projectName); }
      if (clearMessage) setMessage("");
      return true;
    } catch (error) {
      setStatus(null); setMembers(null); setMessage(error instanceof Error ? error.message : "Project management is unavailable.");
      return false;
    }
  }, [projectId, projectName]);

  useEffect(() => { if (openRequest) { const timer = window.setTimeout(() => { setOpen(true); setEditingName(true); }, 0); return () => window.clearTimeout(timer); } }, [openRequest]);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => { void refresh(false); }, 0);
    return () => window.clearTimeout(timer);
  }, [visible, refresh]);

  const mutate = async (mutation: Mutation, requestKey = crypto.randomUUID()) => {
    setBusy(true); setRetryAvailable(false);
    try {
      const response = await fetch(mutation.url, { method: mutation.method, headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify(mutation.body) });
      if (!response.ok) {
        setMessage(await errorMessage(response, "Project changes are unavailable."));
        if (response.status >= 500) { retryRef.current = () => mutate(mutation, requestKey); setRetryAvailable(true); }
        return;
      }
      const result = await response.json() as Status & { name?: string };
      setStatus((current) => current ? { ...current, ...result } : result);
      if (result.status === "ARCHIVED") { setEditingName(false); setName(projectName); }
      if (result.name) { setName(result.name); onProjectChange({ name: result.name }); }
      if (result.status === "ACTIVE" || result.status === "ARCHIVED") onProjectChange({ status: result.status });
      retryRef.current = null;
      mutation.onSuccess?.();
      const refreshed = await refresh(false);
      setMessage((current) => refreshed ? mutation.confirmation : `${mutation.confirmation} ${current}`);
    } catch {
      retryRef.current = () => mutate(mutation, requestKey); setRetryAvailable(true);
      setMessage("We could not confirm that change. Retry uses the same request.");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!editingName) { nameEditorWasOpen.current = false; return; }
    if (!visible || !status || nameEditorWasOpen.current) return;
    nameEditorWasOpen.current = true;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [editingName, visible, status]);

  const saveName = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status && owner && !readOnly) void mutate({ method: "PATCH", url: `/api/projects/${projectId}/settings`, body: { name, expectedSettingsVersion: status.settingsVersion }, confirmation: "Project name updated.", onSuccess: () => setEditingName(false) });
  };
  const saveApprover = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status && owner && !readOnly) void mutate({ method: "PATCH", url: `/api/projects/${projectId}/approval-policy`, body: { designatedApproverId: approver, expectedApprovalPolicyVersion: status.approvalPolicyVersion }, confirmation: "Approver updated." });
  };
  const applyRole = (member: Member, nextRole: Exclude<Role, "OWNER">) => {
    setPendingRole(null);
    if (status && owner && !workspaceReadOnly && (!archived || rank[nextRole] < rank[member.role as Exclude<Role, "OWNER">])) void mutate({ method: "PATCH", url: `/api/projects/${projectId}/members/${member.profileId}`, body: { role: nextRole, expectedMemberVersion: member.version }, confirmation: "Member role updated." });
  };
  const remove = (member: Member) => {
    setRemovePending(null);
    if (status && owner && !workspaceReadOnly) void mutate({ method: "DELETE", url: `/api/projects/${projectId}/members/${member.profileId}`, body: { expectedMemberVersion: member.version }, confirmation: "Member removed." });
  };
  const lifecycle = () => {
    if (!status || !owner || workspaceReadOnly) return;
    const restoring = status.status === "ARCHIVED";
    if (!restoring && !archiveReason.trim()) return;
    setArchivePending(false);
    void mutate({ method: "POST", url: `/api/projects/${projectId}/${restoring ? "restore" : "archive"}`, body: restoring ? { expectedProjectVersion: status.version } : { expectedProjectVersion: status.version, reason: archiveReason }, confirmation: restoring ? "Project restored." : "Project archived." });
  };

  return <section className="project-management" aria-labelledby="project-management-title">
    {!embedded && <button className="context-share-button" type="button" aria-expanded={open} aria-controls="project-management-panel" onClick={() => setOpen((value) => !value)}>Manage project</button>}
    {visible && <div id="project-management-panel" className="project-management-panel">
      <div className="workspace-list-heading"><h3 id="project-management-title">Project management</h3><button className="utility-button" type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
      {!status || !members ? <p>{message || "Loading project management..."}</p> : <>
        <span className={`lifecycle-badge lifecycle-${status.status.toLowerCase()}`}>{status.status === "ARCHIVED" ? "Archived" : "Active"}</span>
        {workspaceReadOnly ? <p className="management-notice">This workspace is archived. Project controls are read-only until the workspace is restored.</p> : archived && <p className="management-notice">This project is archived. Settings and role increases are unavailable; the owner can reduce or remove member access.</p>}
        <div className="project-name-settings"><span className="project-name-label">Project name</span>{editingName && owner && !readOnly ? <form className="share-form" onSubmit={saveName}><label className="sr-only" htmlFor="project-settings-name">Project name</label><input ref={nameRef} id="project-settings-name" aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} required maxLength={120} /><div className="share-actions"><button className="context-share-button" type="submit" disabled={busy || !name.trim() || name.trim() === projectName}>Save name</button><button className="context-action" type="button" onClick={() => { setName(projectName); setEditingName(false); }} disabled={busy}>Cancel</button></div></form> : <div className="project-name-summary"><p className="project-name-value">{name}</p>{owner && !readOnly && <button className="context-action" type="button" onClick={() => setEditingName(true)}>Edit project name</button>}</div>}</div>
        <div className="management-members"><h4>Project members <span>{members.length}</span></h4><ul>{members.map((member) => <li key={member.profileId}>
          <span><strong>{member.displayName}</strong><small>{member.designatedApprover ? "Designated approver" : roleLabel(member.role)}</small></span>
          {owner && member.role !== "OWNER" && !workspaceReadOnly ? <span className="member-actions"><select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={(event) => { const nextRole = event.target.value as Exclude<Role, "OWNER">; if (rank[nextRole] < rank[member.role as Exclude<Role, "OWNER">]) setPendingRole({ member, role: nextRole }); else applyRole(member, nextRole); }} disabled={busy}>{(["EDITOR", "REVIEWER", "VIEWER"] as const).filter((value) => !archived || rank[value] <= rank[member.role as Exclude<Role, "OWNER">]).map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select><button className="utility-button danger-action" type="button" onClick={() => setRemovePending(member)} disabled={busy}>Remove</button></span> : <span className="member-role">{roleLabel(member.role)}</span>}
        </li>)}</ul></div>
        {pendingRole && <div className="management-confirm"><p>Changing {pendingRole.member.displayName} to {roleLabel(pendingRole.role)} reduces their project access.</p><button className="context-action" type="button" onClick={() => applyRole(pendingRole.member, pendingRole.role)} disabled={busy}>Confirm role change</button><button className="context-action" type="button" onClick={() => setPendingRole(null)} disabled={busy}>Cancel</button></div>}
        {removePending && <div className="management-confirm"><p>Removing {removePending.displayName} revokes their project access.</p><button className="utility-button danger-action" type="button" onClick={() => remove(removePending)} disabled={busy}>Confirm removal</button><button className="context-action" type="button" onClick={() => setRemovePending(null)} disabled={busy}>Cancel</button></div>}
        <form className="share-form" onSubmit={saveApprover}><label htmlFor="designated-approver">Designated approver</label><select id="designated-approver" value={approver ?? ""} onChange={(event) => setApprover(event.target.value || null)} disabled={!owner || readOnly || busy}><option value="">No designated approver</option>{members.filter((member) => member.role !== "VIEWER").map((member) => <option key={member.profileId} value={member.profileId}>{member.displayName} / {roleLabel(member.role)}</option>)}</select>{owner && !readOnly && <button className="context-share-button" type="submit" disabled={busy || approver === status.designatedApproverId}>Save approver</button>}</form>
        {owner && !workspaceReadOnly && <div className="management-lifecycle">{status.status === "ARCHIVED" ? <button className="utility-button" type="button" onClick={lifecycle} disabled={busy}>Restore project</button> : archivePending ? <div className="management-confirm"><p>Archiving keeps this project readable and revokes pending invitations.</p><label htmlFor="archive-reason">Archive reason</label><input id="archive-reason" value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} disabled={busy} required maxLength={1000} /><button className="utility-button" type="button" onClick={lifecycle} disabled={busy || !archiveReason.trim()}>Confirm archive</button><button className="context-action" type="button" onClick={() => { setArchivePending(false); setArchiveReason(""); }} disabled={busy}>Cancel</button></div> : <button className="utility-button danger-action" type="button" onClick={() => setArchivePending(true)} disabled={busy}>Archive project</button>}</div>}
      </>}
      {retryAvailable && <button className="context-action" type="button" onClick={() => void retryRef.current?.()} disabled={busy}>Retry project change</button>}
      <p className="share-message" role="status" aria-live="polite">{message}</p>
    </div>}
  </section>;
}
