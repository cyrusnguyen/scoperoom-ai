"use client";

import type { SpecsUi } from "@/features/shell/ui/project-ui";
import SourcesView from "@/features/sources/ui/sources-view";

export default function SpecsPanel({ ui, update, drafts, setDraft }: {
  ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void;
}) {
  return <div className="specs-panel">
    {ui.message && <p className="specs-message" role="status">{ui.message}</p>}
    <SourcesView ui={ui} update={update} drafts={drafts} setDraft={setDraft} />
  </div>;
}
