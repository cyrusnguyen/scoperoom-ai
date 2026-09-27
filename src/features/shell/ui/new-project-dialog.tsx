"use client";

import { useState, type SubmitEvent } from "react";
import { apiMutate } from "@/client/api";
import type { CreatedProject } from "@/features/projects/contracts/project";
import Dialog from "./dialog";

/**
 * Owner creation. An uncertain result keeps the name and the same Idempotency-Key, so Retry cannot create a second project.
 * Esc is ignored while the request is in flight (Cancel is disabled then too); the shell re-reads its lists when this closes.
 */
export default function NewProjectDialog({ onClose, onCreated, onRefused }: { onClose: () => void; onCreated: (project: CreatedProject) => void; onRefused: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const requestKey = key ?? crypto.randomUUID();
    setKey(requestKey);
    setBusy(true);
    setError("");
    const result = await apiMutate<CreatedProject>("/api/projects", requestKey, { name });
    setBusy(false);
    if (result.ok) { onCreated(result.data); return; }
    if (result.uncertain) { setError("We could not confirm project creation. Retry uses the same request."); return; }
    setKey(null);
    setError(result.message);
    onRefused();
  };

  return <Dialog title="New project" onClose={busy ? () => {} : onClose} footer={<>
    <button type="button" className="button quiet" onClick={onClose} disabled={busy}>Cancel</button>
    <button type="submit" form="new-project-form" className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : key ? "Retry" : "Create"}</button>
  </>}>
    <form id="new-project-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="new-project-name">Project name</label>
        <input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy || key !== null} required maxLength={120} />
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
    </form>
  </Dialog>;
}
