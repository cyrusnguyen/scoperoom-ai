"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRead, sessionEnded } from "@/client/api";
import type { AccountView, AuditView, StaffRole } from "@/features/admin/contracts/admin";
import { absoluteTime, accountTag, actionLabel, limitsLocked, MODERATOR_SCOPE_NOTE, planLabel, projectsLabel, relativeTime, roleName, shortId, snapshotLabel, usageLabel, utcDate } from "./format";
import LimitsEditor from "./limits-editor";
import RoleEditor from "./role-editor";

type Detail = { account: AccountView; audit: AuditView[]; defaultLimits: AccountView["limits"] };

/** One account: summary, limits editor, role editor (Admins), history. `role` is the viewer's staff role, decided on the server. */
export default function AccountDetail({ profileId, role, viewerId }: { profileId: string; role: StaffRole; viewerId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(true);
  const [saved, setSaved] = useState("");
  const ticket = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // The latest read wins. The old detail stays on screen while a reload runs, so a form never vanishes under the reader.
  const load = useCallback(async (): Promise<boolean> => {
    const mine = ++ticket.current;
    controller.current?.abort();
    const { signal } = (controller.current = new AbortController());
    setReloading(true);
    const result = await apiRead<Detail>(`/api/admin/accounts/${encodeURIComponent(profileId)}`, signal);
    if (mine !== ticket.current || signal.aborted || sessionEnded(result)) return false;
    setReloading(false);
    if (!result.ok) { setError(result.message); return false; }
    setError("");
    setNow(Date.now());
    setDetail(result.data);
    return true;
  }, [profileId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  const saveDone = useCallback(async () => {
    const refreshed = await load();
    setSaved(refreshed ? "Saved." : "Saved. The latest details could not be loaded.");
  }, [load]);
  const reload = useCallback(() => { setSaved(""); void load(); }, [load]);
  // A change to the viewer's own role: when the read that follows fails, they are most likely no longer staff, so leave the
  // staff screen for the workspace (the server gate decides what they may see there).
  const ownRoleSaved = useCallback(async () => {
    if (await load()) setSaved("Saved.");
    else window.location.assign("/app");
  }, [load]);

  const account = detail?.account;
  // The viewer's own account carries their current role: a self-demotion takes effect here at once, not after a reload.
  const viewerRole = account?.profileId === viewerId ? account.staffRole ?? role : role;
  return <>
    <p className="admin-back"><Link href="/app/admin">Back to accounts</Link></p>
    {account ? <h1>{account.displayName}</h1> : <h1>Account</h1>}
    {account && <p className="admin-note">{accountTag(account)}</p>}
    <p className="admin-saved" role="status">{saved}</p>
    {error && <div className="error-message" role="alert"><p>{error}</p><button type="button" className="button small" disabled={reloading} onClick={reload}>Retry</button></div>}
    {!account ? (!error && <p className="admin-note">Loading account…</p>) : <>
      <Summary account={account} now={now} />
      {limitsLocked(viewerRole, viewerId, account)
        ? <section className="admin-section" aria-labelledby="limits-heading"><h2 id="limits-heading">Limits</h2><p className="admin-note">{MODERATOR_SCOPE_NOTE}</p></section>
        : <LimitsEditor key={`limits-${account.entitlementVersion}`} account={account} defaults={detail.defaultLimits} reloading={reloading} onSaved={saveDone} onReload={reload} />}
      {viewerRole === "ADMIN" && <RoleEditor key={`role-${account.roleVersion}`} account={account} reloading={reloading} onSaved={account.profileId === viewerId ? ownRoleSaved : saveDone} onReload={reload} />}
      <History audit={detail.audit} />
    </>}
  </>;
}

function Summary({ account, now }: { account: AccountView; now: number }) {
  const expires = account.override?.expiresAt;
  const rows: Array<[string, string]> = [
    ["Role", account.staffRole ? roleName(account.staffRole) : "None"],
    ["Plan", planLabel(account, now)],
    ["Projects", projectsLabel(account)],
    ["AI total", usageLabel(account.aiUsed.total, account.limits.aiTotalRuns)],
    ["AI today", usageLabel(account.aiUsed.today, account.limits.aiDailyRuns)],
    ["Last activity", account.lastActivityAt ? `${relativeTime(account.lastActivityAt, now)} (${absoluteTime(account.lastActivityAt)})` : "Never"],
  ];
  if (expires) rows.splice(2, 0, [Date.parse(expires) <= now ? "Limits expired" : "Limits expire", utcDate(expires)]);
  return <section className="admin-section" aria-labelledby="summary-heading">
    <h2 id="summary-heading">Summary</h2>
    <dl className="admin-summary">{rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

function History({ audit }: { audit: AuditView[] }) {
  return <section className="admin-section" aria-labelledby="history-heading">
    <h2 id="history-heading">History</h2>
    {!audit.length ? <p className="admin-note">No changes yet.</p> : <ol className="admin-history">{audit.map((entry) => <li key={entry.id}>
      <p className="admin-history-head"><strong>{actionLabel(entry.action)}</strong> by {entry.actorName ?? "a deleted account"} <span className="admin-tag">{shortId(entry.actorId)}</span> <time dateTime={entry.createdAt}>{absoluteTime(entry.createdAt)}</time></p>
      <dl>
        <div><dt>Before</dt><dd>{snapshotLabel(entry.action, entry.before)}</dd></div>
        <div><dt>After</dt><dd>{snapshotLabel(entry.action, entry.after)}</dd></div>
        <div><dt>Reason</dt><dd>{entry.reason}</dd></div>
      </dl>
    </li>)}</ol>}
  </section>;
}
