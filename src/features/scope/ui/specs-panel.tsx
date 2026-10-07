"use client";

import { useState } from "react";
import type { SpecsRequest, SpecsUi } from "@/features/shell/ui/project-ui";
import SourcesView, { finishSourceWrite } from "@/features/sources/ui/sources-view";
import { useSpecsWrite } from "./use-specs-write";

export default function SpecsPanel({ ui, update, drafts, setDraft }: {
  ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
}) {
  const [saved, setSaved] = useState<{ request: SpecsRequest; data: unknown } | null>(null);
  // The store-bound part of a committed write runs even if this panel is closed by then; `saved` only reaches a mounted view.
  const write = useSpecsWrite(ui, update, (request, data) => { finishSourceWrite(request, update, setDraft); setSaved({ request, data }); });
  // Only a plain "saved" is a status; a refusal, an unconfirmed save or a hint interrupts.
  const calm = !ui.pending && ui.message.endsWith(": saved.");
  return <div className="specs-panel">
    {ui.message && <p className="specs-message" role={calm ? "status" : "alert"}>{ui.message}{ui.pending && !write.busy && <> <button type="button" className="button small" onClick={() => void write.retry()}>Retry</button></>}</p>}
    <SourcesView ui={ui} update={update} drafts={drafts} setDraft={setDraft} write={write} saved={saved} />
  </div>;
}
