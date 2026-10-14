"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import { apiRead, sessionEnded } from "@/client/api";
import type { AccountView } from "@/features/admin/contracts/admin";
import { absoluteTime, accountTag, planLabel, projectsLabel, relativeTime, roleName, usageLabel } from "./format";

type Page = { accounts: AccountView[]; nextCursor: string | null };
// Mirrors QUERY_MAX in contracts/admin.ts (the contracts module also holds Node-only cursor helpers, so the browser keeps its own copy).
const SEARCH_MAX = 100;

/** The staff account list: search by display name, keyset paging with "Load more". */
export default function AccountsView() {
  const [input, setInput] = useState("");
  const [applied, setApplied] = useState("");
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const ticket = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // A new search or retry replaces the previous read; a late answer to an earlier one is dropped.
  const load = useCallback(async (query: string, cursor?: string) => {
    const mine = ++ticket.current;
    controller.current?.abort();
    const { signal } = (controller.current = new AbortController());
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (cursor) params.set("cursor", cursor);
    if (cursor) setMore(true); else setState("loading");
    setError("");
    const result = await apiRead<Page>(`/api/admin/accounts${params.size ? `?${params}` : ""}`, signal);
    if (mine !== ticket.current || signal.aborted || sessionEnded(result)) return;
    setMore(false);
    if (!result.ok) { setError(result.message); if (!cursor) setState("error"); return; }
    setNow(Date.now());
    setAccounts((current) => (cursor ? [...current, ...result.data.accounts] : result.data.accounts));
    setNext(result.data.nextCursor);
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(""); }, 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  const search = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = input.trim();
    setApplied(query);
    void load(query);
  };

  return <>
    <h1>Accounts</h1>
    <form className="admin-search" role="search" onSubmit={search}>
      <label htmlFor="admin-search">Search by name</label>
      <div className="admin-search-row">
        <input id="admin-search" type="search" value={input} maxLength={SEARCH_MAX} autoComplete="off" onChange={(event) => setInput(event.target.value)} />
        <button type="submit" className="button primary">Search</button>
      </div>
    </form>
    {state === "loading" ? <p className="admin-note" role="status">Loading accounts…</p>
    : state === "error" ? <div className="error-message" role="alert"><p>{error}</p><button type="button" className="button small" onClick={() => void load(applied)}>Retry</button></div>
    : !accounts.length ? <p className="admin-note">No accounts match.</p>
    : <div className="admin-table-scroll" role="region" aria-label="Accounts" tabIndex={0}>
      <table className="admin-table">
        <thead><tr>
          <th scope="col">Name</th><th scope="col">Role</th><th scope="col">Plan</th><th scope="col">Projects</th>
          <th scope="col">AI total</th><th scope="col">AI today</th><th scope="col">Last activity</th>
        </tr></thead>
        <tbody>{accounts.map((account) => <tr key={account.profileId}>
          <th scope="row"><Link href={`/app/admin/accounts/${account.profileId}`}>{account.displayName}</Link><span className="admin-tag">{accountTag(account)}</span></th>
          <td>{account.staffRole ? roleName(account.staffRole) : ""}</td>
          <td>{planLabel(account, now)}</td>
          <td>{projectsLabel(account)}</td>
          <td>{usageLabel(account.aiUsed.total, account.limits.aiTotalRuns)}</td>
          <td>{usageLabel(account.aiUsed.today, account.limits.aiDailyRuns)}</td>
          <td>{account.lastActivityAt ? <time dateTime={account.lastActivityAt} title={absoluteTime(account.lastActivityAt)}>{relativeTime(account.lastActivityAt, now)}</time> : "Never"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {state === "ready" && error && <p className="error-message" role="alert">{error}</p>}
    {state === "ready" && next && <button type="button" className="button" disabled={more} onClick={() => void load(applied, next)}>{more ? "Loading…" : "Load more"}</button>}
  </>;
}
