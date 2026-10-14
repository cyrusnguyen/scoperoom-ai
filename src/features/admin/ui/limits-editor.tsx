"use client";

import { useState, type SubmitEvent } from "react";
import type { AccountView } from "@/features/admin/contracts/admin";
import Dialog, { CancelFocus } from "@/features/shell/ui/dialog";
import { expiryFor, limitsStart, MAX_LIMIT, parseLimit } from "./format";
import { CONFLICT_MESSAGE, REASON_MAX, reasonLength, useChange } from "./use-change";

type Props = { account: AccountView; defaults: AccountView["limits"]; reloading: boolean; onSaved: () => Promise<void>; onReload: () => void };

/** Limits, expiry and block for Admins and Moderators. The form edits the stored override, or starts from the default plan. */
export default function LimitsEditor({ account, defaults, reloading, onSaved, onReload }: Props) {
  const start = limitsStart(account, defaults);
  const [projects, setProjects] = useState(String(start.maxOwnedProjects));
  const [total, setTotal] = useState(start.aiTotalRuns === null ? "" : String(start.aiTotalRuns));
  const [totalUnlimited, setTotalUnlimited] = useState(start.aiTotalRuns === null);
  const [daily, setDaily] = useState(start.aiDailyRuns === null ? "" : String(start.aiDailyRuns));
  const [dailyUnlimited, setDailyUnlimited] = useState(start.aiDailyRuns === null);
  const original = account.override?.expiresAt ?? null;
  const [expires, setExpires] = useState(original ? original.slice(0, 10) : "");
  const [blocked, setBlocked] = useState(account.plan === "BLOCKED");
  const [reason, setReason] = useState("");
  const [resetting, setResetting] = useState(false);
  const change = useChange(onSaved);

  const projectsValue = parseLimit(projects), totalValue = totalUnlimited ? null : parseLimit(total), dailyValue = dailyUnlimited ? null : parseLimit(daily);
  const valid = projectsValue !== null && (totalUnlimited || totalValue !== null) && (dailyUnlimited || dailyValue !== null);
  const length = reasonLength(reason);
  const locked = change.busy || change.uncertain;
  const url = `/api/admin/accounts/${account.profileId}/entitlement`;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    void change.send(url, "PATCH", {
      expectedVersion: account.entitlementVersion, reason: reason.trim(), maxOwnedProjects: projectsValue, aiTotalRuns: totalValue, aiDailyRuns: dailyValue,
      expiresAt: expiryFor(expires, original), blocked,
    });
  };

  const limitField = (id: string, label: string, value: string, set: (value: string) => void, unlimited?: { on: boolean; set: (on: boolean) => void }) => {
    const bad = !unlimited?.on && parseLimit(value) === null;
    return <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="admin-limit-row">
        <input id={id} type="number" inputMode="numeric" min={0} max={MAX_LIMIT} step={1} value={value} disabled={locked || unlimited?.on} aria-invalid={bad || undefined} aria-describedby={bad ? `${id}-error` : undefined} onChange={(event) => set(event.target.value)} />
        {unlimited && <label className="admin-check"><input type="checkbox" checked={unlimited.on} disabled={locked} onChange={(event) => unlimited.set(event.target.checked)} />Unlimited<span className="sr-only"> {label}</span></label>}
      </div>
      {bad && <small id={`${id}-error`} className="admin-field-error">Enter a whole number from 0 to {MAX_LIMIT.toLocaleString("en-US")}.</small>}
    </div>;
  };

  return <section className="admin-section" aria-labelledby="limits-heading">
    <h2 id="limits-heading">Limits</h2>
    <form onSubmit={submit} noValidate>
      {account.staffRole && <p className="admin-note">{account.plan === "BLOCKED"
        ? "This staff account is blocked: a block overrides the staff role's unlimited AI."
        : "AI is unlimited while this account has a staff role. These limits apply if the role is removed."}</p>}
      {limitField("limit-projects", "Max owned projects", projects, setProjects)}
      {limitField("limit-ai-total", "AI total runs", total, setTotal, { on: totalUnlimited, set: setTotalUnlimited })}
      {limitField("limit-ai-daily", "AI daily runs", daily, setDaily, { on: dailyUnlimited, set: setDailyUnlimited })}
      <div className="field">
        <label htmlFor="limit-expires">Expires</label>
        <input id="limit-expires" type="date" value={expires} disabled={locked} aria-describedby="limit-expires-hint" onChange={(event) => setExpires(event.target.value)} />
        <small id="limit-expires-hint">Optional. Ends at the end of that day, UTC. After that the default plan applies.</small>
      </div>
      <div className="field">
        <label className="admin-check"><input type="checkbox" checked={blocked} disabled={locked} aria-describedby="limit-blocked-hint" onChange={(event) => setBlocked(event.target.checked)} />Blocked</label>
        <small id="limit-blocked-hint">A blocked account cannot own projects or run AI.</small>
      </div>
      <div className="field">
        <label htmlFor="limits-reason">Reason</label>
        <textarea id="limits-reason" rows={2} maxLength={REASON_MAX} value={reason} disabled={locked} aria-describedby="limits-reason-count" onChange={(event) => setReason(event.target.value)} />
        <small id="limits-reason-count">{length} of {REASON_MAX} characters. Required.</small>
      </div>
      {change.error && <p className="error-message" role="alert">{change.error}</p>}
      {change.conflict && <div className="error-message" role="alert"><p>{CONFLICT_MESSAGE}</p><button type="button" className="button small" disabled={reloading} onClick={onReload}>Reload</button></div>}
      <div className="admin-actions">
        <button type="submit" className="button primary" disabled={change.busy || !valid || !length}>{change.busy ? "Saving…" : change.uncertain ? "Retry" : "Save limits"}</button>
        {account.override && !locked && <button type="button" className="button" onClick={() => setResetting(true)}>Reset to default plan</button>}
      </div>
    </form>
    {resetting && <ResetDialog url={url} version={account.entitlementVersion} reloading={reloading} onSaved={onSaved} onReload={onReload} onClose={() => setResetting(false)} />}
  </section>;
}

/** The confirm step for a reset: its own reason and its own Idempotency-Key. */
function ResetDialog({ url, version, reloading, onSaved, onReload, onClose }: { url: string; version: number; reloading: boolean; onSaved: () => Promise<void>; onReload: () => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const change = useChange(async () => { await onSaved(); onClose(); });
  const length = reasonLength(reason);
  const locked = change.busy || change.uncertain;
  // An uncertain result keeps the request's key for Retry: closing would lose it, so the dialog stays open until it is settled.
  const close = locked ? () => {} : onClose;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void change.send(url, "PATCH", { expectedVersion: version, reason: reason.trim(), reset: true });
  };
  return <Dialog title="Reset to the default plan?" onClose={close} footer={<>
    <CancelFocus label="Cancel" onClick={close} disabled={locked} />
    <button type="submit" form="reset-form" className="button danger" disabled={change.busy || !length}>{change.busy ? "Working…" : change.uncertain ? "Retry" : "Reset"}</button>
  </>}>
    <form id="reset-form" onSubmit={submit} noValidate>
      <p>The custom limits, expiry and block are removed. This account returns to the default plan.</p>
      <div className="field">
        <label htmlFor="reset-reason">Reason</label>
        <textarea id="reset-reason" rows={2} maxLength={REASON_MAX} value={reason} disabled={locked} aria-describedby="reset-reason-count" onChange={(event) => setReason(event.target.value)} />
        <small id="reset-reason-count">{length} of {REASON_MAX} characters. Required.</small>
      </div>
      {change.error && <p className="error-message" role="alert">{change.error}</p>}
      {change.conflict && <div className="error-message" role="alert"><p>{CONFLICT_MESSAGE}</p><button type="button" className="button small" disabled={reloading} onClick={() => { onReload(); onClose(); }}>Reload</button></div>}
    </form>
  </Dialog>;
}
