"use client";

import { useState } from "react";
import { tabListKeyDown } from "@/features/shell/ui/right-panel";
import type { SpecsRequest, SpecsUi } from "@/features/shell/ui/project-ui";
import SourcesView from "@/features/sources/ui/sources-view";
import ScopeBoard from "./scope-board";
import { useSpecsWrite } from "./use-specs-write";

const SECTIONS = ["sources", "scope"] as const;
const LABELS = { sources: "Sources", scope: "Scope" } as const;

export default function SpecsPanel({ ui, update, drafts, setDraft, onSaved }: {
  ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
  onSaved: (request: SpecsRequest, data: unknown) => void;
}) {
  const [saved, setSaved] = useState<{ request: SpecsRequest; data: unknown } | null>(null);
  // The store-bound part of a committed write runs even if this panel is closed by then; `saved` only reaches a mounted view.
  const write = useSpecsWrite(ui, update, (request, data) => { onSaved(request, data); setSaved({ request, data }); });
  // Only a plain "saved" is a status; a refusal, an unconfirmed save or a hint interrupts.
  const calm = !ui.pending && ui.message.endsWith(": saved.");
  return <div className="specs-panel">
    <div className="specs-tabs" role="tablist" aria-label="Specs sections">
      {SECTIONS.map((id, index) => <button key={id} type="button" role="tab" id={`specs-tab-${id}`} aria-selected={ui.section === id} aria-controls={`specs-body-${id}`} tabIndex={ui.section === id ? 0 : -1}
        data-active={ui.section === id} onClick={() => update(() => ({ section: id, selected: null }))} onKeyDown={(event) => tabListKeyDown(event, SECTIONS, index, (section) => update(() => ({ section, selected: null })))}>{LABELS[id]}</button>)}
    </div>
    {ui.pending?.body === null && <p className="specs-message" role="status">Saving…</p>}
    {ui.message && <p className="specs-message" role={calm ? "status" : "alert"}>{ui.message}{ui.pending?.body && !write.busy && <> <button type="button" className="button small" onClick={() => void write.retry()}>Retry</button></>}</p>}
    <div id={`specs-body-${ui.section}`} role="tabpanel" aria-labelledby={`specs-tab-${ui.section}`}>
      {ui.section === "sources"
        ? <SourcesView ui={ui} update={update} drafts={drafts} setDraft={setDraft} write={write} saved={saved} />
        : <ScopeBoard ui={ui} update={update} drafts={drafts} setDraft={setDraft} write={write} />}
    </div>
  </div>;
}
