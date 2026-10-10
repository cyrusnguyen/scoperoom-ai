"use client";
import { useEffect, useRef, useState } from "react";
import { apiReadText, SESSION_ENDED, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { exportFilename } from "@/features/exports/domain/flow-file";
import type { PublishedSnapshot } from "../contracts/review";

/** The component is keyed by exact selected snapshot; prepared text never outlives its project/access fence. */
export default function ApprovedMarkdown({ published, onAccessLost }: { published: PublishedSnapshot; onAccessLost: () => void }) {
  const sync = useSync(), mounted = useRef(true), working = useRef(false), request = useRef<AbortController | null>(null);
  const [prepared, setPrepared] = useState<{ text: string; live: () => boolean } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const intent = useRef<"download" | "copy">("download");
  const clear = () => { setPrepared(null); request.current?.abort(); };
  useEffect(() => {
    mounted.current = true;
    const ended = () => { mounted.current = false; clear(); };
    window.addEventListener(SESSION_ENDED, ended);
    return () => { mounted.current = false; request.current?.abort(); window.removeEventListener(SESSION_ENDED, ended); };
  }, []);
  useEffect(() => { queueMicrotask(() => { if (mounted.current && prepared && !prepared.live()) setPrepared(current => current === prepared ? null : current); }); }, [prepared, sync.status]);
  async function prepare(action: "download" | "copy") {
    if (working.current) return;
    working.current = true; intent.current = action; setBusy(true); setError("");
    const invocation = sync.fence(), current = () => mounted.current && invocation();
    try {
      const access = await sync.revalidate("manual");
      if (!current()) { if (mounted.current) setPrepared(null); return; }
      if (access.kind !== "current") {
        if (access.kind === "denied") { clear(); onAccessLost(); }
        else setError("We could not confirm your current access. Retry Markdown after access is checked.");
        return;
      }
      const admitted = sync.fence(access.generation), controller = new AbortController(); request.current = controller;
      const result = await apiReadText(`/api/projects/${published.snapshot.projectId}/snapshots/${published.snapshot.id}/export?format=markdown`, controller.signal);
      if (!current() || !admitted()) { if (mounted.current) setPrepared(null); return; }
      if (sessionEnded(result)) { clear(); return; }
      if (!result.ok) {
        if (result.status === 403 || result.status === 404) { clear(); onAccessLost(); }
        else setError(result.message);
        return;
      }
      const checked = await sync.revalidate("manual");
      if (!current() || !admitted()) { if (mounted.current) setPrepared(null); return; }
      if (checked.kind !== "current") {
        if (checked.kind === "denied") { clear(); onAccessLost(); }
        else setError("We could not confirm your current access. Retry Markdown after access is checked.");
        return;
      }
      setPrepared({ text: result.data, live: admitted });
      if (action === "download") {
        const url = URL.createObjectURL(new Blob([result.data], { type: "text/markdown; charset=utf-8" }));
        try {
          const link = document.createElement("a"); link.href = url; link.download = exportFilename(published.snapshot.projectName).replace(/\.scoperoom-flow\.json$/, ".md");
          document.body.append(link); link.click(); link.remove();
        } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0); }
      }
    } catch { if (current()) setError("The Markdown download could not be prepared. Retry Markdown or use the copy field."); }
    finally { working.current = false; request.current = null; if (mounted.current) setBusy(false); }
  }
  const text = prepared?.live() && !sync.failures ? prepared.text : null;
  return <section className="detail-section" aria-label="Approved Markdown export">
    <h3>Approved Markdown</h3>
    <p>Downloads this exact baseline. Labels, descriptions and captured evidence may contain confidential information.</p>
    <button type="button" className="button" disabled={busy} onClick={() => void prepare("download")}>Download Markdown</button>
    <button type="button" className="button quiet" disabled={busy} onClick={() => void prepare("copy")}>Show Markdown for copy</button>
    {busy && <p role="status">Preparing Markdown…</p>}
    {error && <p role="alert">{error} <button type="button" className="button small" disabled={busy} onClick={() => void prepare(intent.current)}>Retry Markdown</button></p>}
    {text !== null && <><p><label htmlFor="approved-markdown-copy">Approved Markdown</label></p><textarea id="approved-markdown-copy" rows={8} value={text} readOnly spellCheck={false} /></>}
  </section>;
}
