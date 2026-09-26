"use client";

import { useCallback, useEffect, useState, type SubmitEvent } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import Dialog, { CancelFocus } from "./dialog";

export type LifecycleKind = "archive" | "restore" | "leave";

const copy: Record<LifecycleKind, { verb: string; body: string; tone: "danger" | "primary" }> = {
  archive: { verb: "Archive", body: "It becomes read-only for everyone and stops counting toward your limit. Pending invitations are revoked; its history stays readable.", tone: "danger" },
  restore: { verb: "Restore", body: "It becomes editable again and counts toward your active project limit. Revoked invitations stay revoked.", tone: "primary" },
  leave: { verb: "Leave", body: "You’ll need a new invitation to return.", tone: "danger" },
};

/**
 * Archive, restore or leave one project. Archive and restore first read the current project version (a fresh preview);
 * a CONFLICT keeps the dialog and reads it again before the user can confirm. An uncertain result keeps the same key and input.
 */
export default function LifecycleDialog({ kind, project, onClose, onDone }: { kind: LifecycleKind; project: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const { verb, body, tone } = copy[kind];
  const needsVersion = kind !== "leave";
  const [version, setVersion] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");

  const preview = useCallback(async (signal?: AbortSignal) => {
    const result = await apiRead<ProjectStatusView>(`/api/projects/${project.id}/status`, signal);
    if (signal?.aborted || sessionEnded(result)) return;
    if (result.ok) setVersion(result.data.version);
    else setError(result.message);
  }, [project.id]);

  useEffect(() => {
    if (!needsVersion) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void preview(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [needsVersion, preview]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || (needsVersion && version === null)) return;
    setBusy(true);
    setError("");
    const input = kind === "archive" ? { expectedProjectVersion: version, reason } : kind === "restore" ? { expectedProjectVersion: version } : {};
    const result = await apiMutate(`/api/projects/${project.id}/${kind}`, key, input);
    setBusy(false);
    if (result.ok) { onDone(); return; }
    setUncertain(result.uncertain);
    setError(result.uncertain ? "We could not confirm this change. Retry uses the same request." : result.message);
    if (result.uncertain) return;
    setKey(crypto.randomUUID());
    if (result.code === "CONFLICT") { setVersion(null); void preview(); }
  };

  const ready = !needsVersion || version !== null;
  return <Dialog title={`${verb} ${project.name}?`} onClose={onClose} footer={<>
    {kind === "archive" ? <button type="button" className="button quiet" onClick={onClose}>Cancel</button> : <CancelFocus label="Cancel" onClick={onClose} />}
    <button type="submit" form="lifecycle-form" className={`button ${tone}`} disabled={busy || !ready || (kind === "archive" && !reason.trim())}>{busy ? "Working…" : uncertain ? "Retry" : verb}</button>
  </>}>
    <form id="lifecycle-form" onSubmit={submit}>
      <p>{body}</p>
      {kind === "archive" && <div className="field">
        <label htmlFor="archive-reason">Reason</label>
        <input id="archive-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy || uncertain} required maxLength={1000} />
      </div>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </form>
  </Dialog>;
}
