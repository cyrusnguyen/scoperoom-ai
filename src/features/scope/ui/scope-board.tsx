"use client";

import { useState } from "react";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { useStudio } from "@/features/studio/ui/studio-context";
import { confirmationCurrent, linkState } from "../domain/scope";
import RequirementForm from "./requirement-form";
import type { SpecsUi } from "@/features/shell/ui/project-ui";
import type { useSpecsWrite } from "./use-specs-write";

export default function ScopeBoard(props: { ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void; drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void; write: ReturnType<typeof useSpecsWrite> }) {
  const { savedDraft } = useStudio();
  const { status } = useSync();
  const [filter, setFilter] = useState("");
  const canEdit = status.status === "ACTIVE" && (status.role === "OWNER" || status.role === "EDITOR");
  const selected = props.ui.selected?.kind === "requirement" ? props.ui.selected.id : null;
  const requirement = selected && selected !== "new" ? savedDraft.document.requirements[selected] ?? null : null;
  if (selected && selected !== "new" && !requirement) {
    const prefix = `specs:req:${selected}:`;
    const labels: Record<string, string> = { title: "Title", statement: "Statement", category: "Category", inclusion: "Inclusion", ownerId: "Owner", verificationDescription: "Verification description", responsibleRole: "Responsible role", start: "Start line", end: "End line", excerpt: "Excerpt", explanation: "Explanation", "new-explanation": "Explanation" };
    const retained = Object.entries(props.drafts).filter(([key]) => key.startsWith(prefix) && labels[key.split(":").at(-1)!]);
    return <div className="scope-board"><p role="status">This requirement was removed.</p>
      {retained.length > 0 && <section className="inline-note"><p>Your unsaved values are kept for copying.</p><div className="field"><label htmlFor="removed-requirement-edits">Retained requirement edits</label><textarea id="removed-requirement-edits" rows={6} readOnly value={retained.map(([key, value]) => `${labels[key.split(":").at(-1)!]}: ${value}`).join("\n")} /></div></section>}
      {Object.keys(props.drafts).some((key) => key.startsWith(prefix)) && <button type="button" className="button quiet small" disabled={props.write.busy || props.ui.pending !== null} onClick={() => { for (const key of Object.keys(props.drafts)) if (key.startsWith(prefix)) props.setDraft(key, undefined); }}>Discard requirement edits</button>}
      <button type="button" className="button quiet small" onClick={() => props.update(() => ({ selected: null }))}>Back to requirements</button>
    </div>;
  }
  if (selected) return <RequirementForm requirement={requirement} ui={props.ui} update={props.update} drafts={props.drafts} setDraft={props.setDraft} write={props.write} onClose={() => props.update(() => ({ selected: null }))} />;
  const all = Object.values(savedDraft.document.requirements).sort((a, b) => a.displayId.localeCompare(b.displayId, undefined, { numeric: true }));
  const shown = all.filter((item) => `${item.displayId} ${item.title}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="scope-board">
    <div className="scope-toolbar">
      <div className="field"><label htmlFor="scope-filter">Filter by label or ID</label><input id="scope-filter" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
      <span className="muted">Showing {shown.length} of {all.length}</span>
      {filter && <button type="button" className="button quiet small" onClick={() => setFilter("")}>Clear</button>}
      {canEdit && <button type="button" className="button primary" disabled={props.write.busy || props.ui.pending !== null} onClick={() => props.update(() => ({ selected: { kind: "requirement", id: "new" } }))}>New requirement</button>}
    </div>
    {(["INCLUDED", "UNDECIDED", "EXCLUDED"] as const).map((inclusion) => {
      const name = inclusion === "INCLUDED" ? "Included" : inclusion === "UNDECIDED" ? "Undecided" : "Excluded";
      const items = shown.filter((item) => item.inclusion === inclusion);
      return <section key={inclusion} className="specs-group" role="region" aria-label={name}>
        <h3>{name}</h3>
        {items.length ? <ul className="sources-list">{items.map((item) => {
          const links = Object.values(savedDraft.document.traceLinks).filter((link) => link.requirementId === item.id);
          const review = links.filter((link) => linkState(savedDraft.document, link) === "NEEDS_REVIEW").length;
          const confirmation = confirmationCurrent(item) ? "Confirmed" : item.confirmation ? "Confirmation out of date" : "Not confirmed";
          return <li key={item.id}><button type="button" className="specs-card" onClick={() => props.update(() => ({ selected: { kind: "requirement", id: item.id } }))}>
            <strong>{item.displayId} {item.title}</strong><span className="specs-badge">{confirmation} · {item.sourceRefs.length} citations · {links.length} links · {review} need review</span>
          </button></li>;
        })}</ul> : <p className="muted">No requirements.</p>}
      </section>;
    })}
  </div>;
}
