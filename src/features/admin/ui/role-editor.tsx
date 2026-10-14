"use client";

import { useState, type SubmitEvent } from "react";
import type { AccountView, StaffRole } from "@/features/admin/contracts/admin";
import { CONFLICT_MESSAGE, REASON_MAX, reasonLength, useChange } from "./use-change";

type Choice = StaffRole | "NONE";

/** Admins only (the server refuses anyone else with ADMIN_ROLE_REQUIRED, and a change that would leave no Admin with LAST_ADMIN). */
export default function RoleEditor({ account, reloading, onSaved, onReload }: { account: AccountView; reloading: boolean; onSaved: () => Promise<void>; onReload: () => void }) {
  const [role, setRole] = useState<Choice>(account.staffRole ?? "NONE");
  const [reason, setReason] = useState("");
  const change = useChange(onSaved);
  const length = reasonLength(reason);
  const locked = change.busy || change.uncertain;
  const changed = role !== (account.staffRole ?? "NONE");

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void change.send(`/api/admin/accounts/${account.profileId}/role`, "PUT", { expectedVersion: account.roleVersion, reason: reason.trim(), role: role === "NONE" ? null : role });
  };

  return <section className="admin-section" aria-labelledby="role-heading">
    <h2 id="role-heading">Role</h2>
    <form onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="role-choice">Role</label>
        <select id="role-choice" value={role} disabled={locked} onChange={(event) => setRole(event.target.value as Choice)}>
          <option value="NONE">None</option><option value="MODERATOR">Moderator</option><option value="ADMIN">Admin</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="role-reason">Reason</label>
        <textarea id="role-reason" rows={2} maxLength={REASON_MAX} value={reason} disabled={locked} aria-describedby="role-reason-count" onChange={(event) => setReason(event.target.value)} />
        <small id="role-reason-count">{length} of {REASON_MAX} characters. Required.</small>
      </div>
      {change.error && <p className="error-message" role="alert">{change.error}</p>}
      {change.conflict && <div className="error-message" role="alert"><p>{CONFLICT_MESSAGE}</p><button type="button" className="button small" disabled={reloading} onClick={onReload}>Reload</button></div>}
      <button type="submit" className="button primary" disabled={change.busy || !length || (!changed && !change.uncertain)}>{change.busy ? "Saving…" : change.uncertain ? "Retry" : "Save role"}</button>
    </form>
  </section>;
}
