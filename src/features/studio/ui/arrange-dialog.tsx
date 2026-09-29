"use client";

import { useState } from "react";
import type { Direction } from "@/features/drafts/contracts/draft-layout";
import type { ArrangementPreview } from "@/features/drafts/contracts/positions";
import Dialog from "@/features/shell/ui/dialog";
import FlowCanvas from "./flow-canvas";
import { useStudio } from "./studio-context";

const DIRECTION_LABELS: Record<Direction, string> = { TB: "Top to bottom", LR: "Left to right" };
const staleCodes = new Set(["STALE_DOCUMENT_REVISION", "STALE_LAYOUT_REVISION", "ARRANGEMENT_PREVIEW_CHANGED"]);

/**
 * Arrange (UI02 "Position saves and arrangement"): the server computes a preview for the exact saved pair; Apply sends
 * only that preview's identity and hash, and a changed flow asks for a new preview instead of arranging something else.
 * Cancel saves nothing. It opens only once every unsaved change is saved, and works on the saved draft.
 */
export function ArrangeDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const { savedDraft: draft, busy, preview, place } = useStudio();
  const [direction, setDirection] = useState<Direction>(draft.layout.directions[flowId] ?? "TB");
  const [shown, setShown] = useState<ArrangementPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === flowId).length;

  const load = async () => {
    setLoading(true);
    setMessage("");
    const outcome = await preview({ flowId, expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, direction });
    setLoading(false);
    if (outcome.ok) setShown(outcome.result);
    else setMessage(staleCodes.has(outcome.code) ? "The flow changed. Preview again to see the current steps." : outcome.message);
  };
  const apply = async () => {
    if (!shown || busy) return;
    const key = retryKey ?? crypto.randomUUID();
    const outcome = await place({
      mode: "ARRANGE_FLOW", flowId, expectedDocumentRevision: shown.documentRevision, expectedLayoutRevision: shown.layoutRevision,
      direction: shown.direction, algorithmVersion: shown.algorithmVersion, arrangementHash: shown.arrangementHash,
    }, key);
    if (outcome.ok) { onClose(); return; }
    if (outcome.uncertain) { setRetryKey(key); setMessage("We couldn’t confirm the arrangement. Apply again repeats the same request."); return; }
    setRetryKey(null);
    setShown(null);
    setMessage(staleCodes.has(outcome.code) ? "The flow changed since this preview. Preview it again." : outcome.message);
  };

  return <Dialog title="Arrange flow" onClose={busy || loading ? () => {} : onClose} footer={<>
    <button type="button" className="button quiet" onClick={onClose} disabled={busy || loading}>Cancel</button>
    <button type="button" className="button" onClick={() => void load()} disabled={busy || loading}>{loading ? "Previewing…" : shown ? "Preview again" : "Preview"}</button>
    {shown && <button type="button" className="button primary" onClick={() => void apply()} disabled={busy || loading}>{busy ? "Applying…" : retryKey ? "Apply again" : "Apply arrangement"}</button>}
  </>}>
    <div className="field">
      <label htmlFor="arrange-direction">Direction</label>
      <select id="arrange-direction" value={direction} onChange={(event) => { setDirection(event.target.value as Direction); setShown(null); setRetryKey(null); }}>
        {(["TB", "LR"] as const).map((value) => <option key={value} value={value}>{DIRECTION_LABELS[value]}</option>)}
      </select>
    </div>
    {shown ? <>
      <p>Arranges {steps} {steps === 1 ? "step" : "steps"} {DIRECTION_LABELS[shown.direction].toLowerCase()}. Nothing changes until you apply it.</p>
      <div className="arrange-preview"><FlowCanvas flowId={flowId} preview={{ positions: shown.positions, direction: shown.direction }} /></div>
    </> : <p className="muted">Preview shows the new layout before anything is saved.</p>}
    {message && <p className="error-message" role="alert">{message}</p>}
  </Dialog>;
}
