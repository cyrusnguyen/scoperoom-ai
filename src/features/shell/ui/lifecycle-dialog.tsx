"use client";

import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import { accountChanged, apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import Dialog, { CancelFocus } from "./dialog";

export type LifecycleKind = "archive" | "restore" | "leave";

const copy: Record<LifecycleKind, { verb: string; body: string; tone: "danger" | "primary" }> = {
  archive: { verb: "Archive", body: "It becomes read-only for everyone and stops counting toward your limit. Pending invitations are revoked; its history stays readable.", tone: "danger" },
  restore: { verb: "Restore", body: "It becomes editable again and counts toward your active project limit. Revoked invitations stay revoked.", tone: "primary" },
  leave: { verb: "Leave", body: "You’ll need a new invitation to return.", tone: "danger" },
};

/**
 * Archive, restore or leave one project. Every kind first reads the project status (a fresh preview); a CONFLICT keeps
 * the dialog and reads it again before the user can confirm. A project whose status already changed (archived or restored
 * elsewhere) can't be confirmed at all. An uncertain result keeps the same key and input. This dialog renders outside the
 * sync controller, so it checks the account itself: a status read right before sending must be for the account the page
 * opened with (`viewer`), else the page tears down and nothing is sent. With no project open there is no such account; the
 * one the dialog's own opening read saw stands in, and Confirm waits for that read.
 */
export default function LifecycleDialog({ kind, project, viewer, onClose, onDone }: { kind: LifecycleKind; project: { id: string; name: string }; viewer: () => string | null; onClose: () => void; onDone: () => void }) {
  const { verb, body, tone } = copy[kind];
  const opened = useRef<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [readFailed, setReadFailed] = useState(false);

  const preview = useCallback(async (signal?: AbortSignal) => {
    const result = await apiRead<ProjectStatusView>(`/api/projects/${project.id}/status`, signal);
    if (signal?.aborted || sessionEnded(result)) return;
    if (!result.ok) { setReadFailed(true); setError(result.message); return; }
    opened.current ??= result.data.viewerId;
    // The server refuses archive unless ACTIVE and restore unless ARCHIVED, whatever the version: confirming can't succeed.
    if (kind !== "leave" && result.data.status !== (kind === "archive" ? "ACTIVE" : "ARCHIVED")) { setError(result.data.status === "ARCHIVED" ? "This project is already archived." : "This project is already active."); return; }
    setVersion(result.data.version);
  }, [project.id, kind]);
  const retryPreview = () => {
    // This button unmounts now: keep focus inside the modal on its safe choice.
    document.getElementById("lifecycle-cancel")?.focus();
    setReadFailed(false);
    setError("");
    void preview();
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void preview(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [preview]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || version === null) return;
    setBusy(true);
    setError("");
    // Read again now: the account can change while the dialog is open, which the opening read can't see.
    const fresh = await apiRead<ProjectStatusView>(`/api/projects/${project.id}/status`);
    if (sessionEnded(fresh)) return;
    if (!fresh.ok) { setBusy(false); setError(fresh.message); return; }
    if (fresh.data.viewerId !== (viewer() ?? opened.current)) { accountChanged(); return; }
    const input = kind === "archive" ? { expectedProjectVersion: version, reason } : kind === "restore" ? { expectedProjectVersion: version } : {};
    const result = await apiMutate(`/api/projects/${project.id}/${kind}`, key, input);
    setBusy(false);
    if (result.ok) { onDone(); return; }
    if (sessionEnded(result)) return;
    setUncertain(result.uncertain);
    setError(result.uncertain ? "We could not confirm this change. Retry uses the same request." : result.message);
    if (result.uncertain) return;
    setKey(crypto.randomUUID());
    if (result.code === "CONFLICT") { setVersion(null); void preview(); }
  };

  const ready = version !== null;
  // Closing while the request is in flight would drop its key, its uncertain result and the Retry path.
  const close = busy ? () => {} : onClose;
  return <Dialog title={`${verb} ${project.name}?`} onClose={close} footer={<>
    {kind === "archive" ? <button id="lifecycle-cancel" type="button" className="button quiet" onClick={close} disabled={busy}>Cancel</button> : <CancelFocus id="lifecycle-cancel" label="Cancel" onClick={close} disabled={busy} />}
    <button type="submit" form="lifecycle-form" className={`button ${tone}`} disabled={busy || !ready || (kind === "archive" && !reason.trim())}>{busy ? "Working…" : uncertain ? "Retry" : verb}</button>
  </>}>
    <form id="lifecycle-form" onSubmit={submit}>
      <p>{body}</p>
      {kind === "archive" && <div className="field">
        <label htmlFor="archive-reason">Reason</label>
        <input id="archive-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy || uncertain} required maxLength={1000} />
      </div>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {readFailed && <button type="button" className="button small" onClick={retryPreview}>Retry</button>}
    </form>
  </Dialog>;
}
