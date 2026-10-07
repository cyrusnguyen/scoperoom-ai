"use client";

import { useEffect, useState } from "react";
import { apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import type { RequirementCategory, RequirementRecord, SourceRef, TraceLinkRecord } from "@/features/drafts/contracts/scope-document";
import type { SourceVersionView } from "@/features/sources/contracts/source-version";
import { useSourceList } from "@/features/sources/ui/sources-view";
import type { SpecsUi } from "@/features/shell/ui/project-ui";
import Dialog from "@/features/shell/ui/dialog";
import { useStudio } from "@/features/studio/ui/studio-context";
import { confirmationCurrent, linkState, requirementPlan } from "../domain/scope";
import type { useSpecsWrite } from "./use-specs-write";

type Props = {
  requirement: RequirementRecord | null; ui: SpecsUi; update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void;
  drafts: Record<string, string>; setDraft: (key: string, value: string | undefined) => void; write: ReturnType<typeof useSpecsWrite>; onClose: () => void;
};
type Values = { title: string; statement: string; category: RequirementCategory; inclusion: RequirementRecord["inclusion"]; ownerId: string; verificationDescription: string; responsibleRole: string };
const categories: Array<[RequirementCategory, string]> = [["FUNCTIONAL", "Functional"], ["NON_FUNCTIONAL", "Non-functional"], ["CONSTRAINT", "Constraint"]];
const inclusions: Array<[RequirementRecord["inclusion"], string]> = [["INCLUDED", "Included"], ["UNDECIDED", "Undecided"], ["EXCLUDED", "Excluded"]];
const valuesOf = (requirement: RequirementRecord | null): Values => ({
  title: requirement?.title ?? "", statement: requirement?.statement ?? "", category: requirement?.category ?? "FUNCTIONAL", inclusion: requirement?.inclusion ?? "UNDECIDED",
  ownerId: requirement?.ownerId ?? "", verificationDescription: requirement?.verificationMethod?.description ?? "", responsibleRole: requirement?.verificationMethod?.responsibleRole ?? "",
});

export default function RequirementForm({ requirement, ui, update, drafts, setDraft, write, onClose }: Props) {
  const { savedDraft } = useStudio();
  const { status, directory } = useSync();
  const id = requirement?.id ?? "new", prefix = `specs:req:${id}:`, baseKey = `${prefix}base`, guardKey = `${prefix}expectedEntityVersion`;
  const saved = valuesOf(requirement);
  const base = (() => { try { return drafts[baseKey] ? JSON.parse(drafts[baseKey]!) as Values : saved; } catch { return saved; } })();
  // Unedited fields always reflect the newest saved record. The captured base remains only for change detection.
  const get = <K extends keyof Values>(key: K) => drafts[`${prefix}${key}`] ?? saved[key];
  const set = <K extends keyof Values>(key: K, value: string) => {
    // The first edit pins both the viewed values and version. A passive refresh keeps showing new saved values.
    if (requirement && !drafts[baseKey]) {
      const opened = valuesOf(requirement);
      setDraft(baseKey, JSON.stringify(opened));
      setDraft(guardKey, String(requirement.version));
      setDraft(`${prefix}${key}`, value === opened[key] ? undefined : value);
      return;
    }
    setDraft(`${prefix}${key}`, value === base[key] ? undefined : value);
    if (value === base[key] && !Object.keys(saved).some((field) => field !== key && drafts[`${prefix}${field}`] !== undefined)) {
      setDraft(baseKey, undefined);
      setDraft(guardKey, undefined);
    }
  };
  const canEdit = status.status === "ACTIVE" && (status.role === "OWNER" || status.role === "EDITOR");
  const locked = write.busy || ui.pending !== null;
  const edited = Object.keys(saved).some((field) => drafts[`${prefix}${field}`] !== undefined);
  const guard = Number(drafts[guardKey] ?? requirement?.version ?? 0);
  const stale = ui.message.includes("Someone saved this item first");
  const verification = () => {
    const description = get("verificationDescription").trim(), responsibleRole = get("responsibleRole").trim();
    return description || responsibleRole ? { description, responsibleRole } : null;
  };
  const send = (label: string, build: (saved: typeof savedDraft) => Record<string, unknown> | null) => void write.sendDraft(`drafts/${savedDraft.id}/commands`, build, label);
  const save = () => send("Save requirement", (current) => {
    const next = { title: get("title").trim(), statement: get("statement"), category: get("category") as RequirementCategory, inclusion: get("inclusion") as RequirementRecord["inclusion"], ownerId: get("ownerId") || null, verification: verification() };
    if (!requirement) return { commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: current.documentRevision, payload: { ...next, sourceRefs: [] } };
    const changed = Object.fromEntries(Object.entries(next).filter(([key]) => key === "verification"
      ? drafts[`${prefix}verificationDescription`] !== undefined || drafts[`${prefix}responsibleRole`] !== undefined
      : drafts[`${prefix}${key}`] !== undefined));
    return Object.keys(changed).length ? { commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: guard, payload: { requirementId: requirement.id, ...changed } } : null;
  });
  const useSaved = () => { for (const key of [baseKey, guardKey, ...Object.keys(saved).map((field) => `${prefix}${field}`)]) setDraft(key, undefined); };
  const field = <K extends keyof Values>(key: K, label: string, control: "input" | "textarea" | "select", options?: readonly [string, string][]) => <div className="field">
    <label htmlFor={`requirement-${key}`}>{label}</label>
    {control === "textarea" ? <textarea id={`requirement-${key}`} rows={key === "statement" ? 4 : 3} readOnly={!canEdit || locked} value={get(key)} onChange={(event) => set(key, event.target.value)} />
      : control === "select" ? <select id={`requirement-${key}`} disabled={!canEdit || locked} value={get(key)} onChange={(event) => set(key, event.target.value)}>{options?.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
        : <input id={`requirement-${key}`} readOnly={!canEdit || locked} value={get(key)} onChange={(event) => set(key, event.target.value)} />}
  </div>;
  return <div className="requirement-form">
    <button type="button" className="button quiet small" onClick={onClose}>Back to requirements</button>
    <h3>{requirement ? `${requirement.displayId} ${requirement.title}` : "New requirement"}</h3>
    {stale && <section className="inline-note" role="alert"><p>Someone saved this requirement first. Your text is kept; review the saved values, then save again.</p><button type="button" className="button small" onClick={useSaved}>Use saved values</button></section>}
    {field("title", "Title", "input")}{field("statement", "Statement", "textarea")}{field("category", "Category", "select", categories)}{field("inclusion", "Inclusion", "select", inclusions)}
    <div className="field"><label htmlFor="requirement-owner">Owner</label><select id="requirement-owner" disabled={!canEdit || locked} value={get("ownerId")} onChange={(event) => set("ownerId", event.target.value)}><option value="">Unassigned</option>{directory?.filter((member) => member.role !== "VIEWER").map((member) => <option key={member.profileId} value={member.profileId}>{member.displayName}</option>)}{get("ownerId") && !directory?.some((member) => member.profileId === get("ownerId") && member.role !== "VIEWER") && <option value={get("ownerId")}>{directory?.find((member) => member.profileId === get("ownerId"))?.displayName ?? "Former member"}</option>}</select></div>
    {field("verificationDescription", "Verification description", "textarea")}{field("responsibleRole", "Responsible role", "input")}
    {canEdit && <div className="view-actions"><button type="button" className="button primary" disabled={locked || !get("title").trim()} onClick={save}>Save requirement</button>{requirement && <button type="button" className="button" disabled={locked || edited || confirmationCurrent(requirement)} onClick={() => send("Confirm requirement", () => ({ commandSchemaVersion: 1, command: "CONFIRM_REQUIREMENT", expectedEntityVersion: guard, payload: { requirementId: requirement.id } }))}>{!edited && confirmationCurrent(requirement) ? "Confirmed for this wording" : "Confirm requirement"}</button>}</div>}
    {canEdit && requirement && edited && <p className="muted">Save changes before confirming.</p>}
    {requirement && <RequirementActions requirement={requirement} update={update} drafts={drafts} setDraft={setDraft} canEdit={canEdit} locked={locked} send={send} />}
  </div>;
}

function RequirementActions({ requirement, update, drafts, setDraft, canEdit, locked, send }: { requirement: RequirementRecord; update: Props["update"]; drafts: Record<string, string>; setDraft: Props["setDraft"]; canEdit: boolean; locked: boolean; send: (label: string, build: (saved: ReturnType<typeof useStudio>["savedDraft"]) => Record<string, unknown> | null) => void }) {
  const { projectId, savedDraft } = useStudio(); const { status } = useSync();
  const sourceList = useSourceList(projectId, "user", status.sourcesRevision), sources = sourceList.page?.items ?? [];
  const cite = `specs:req:${requirement.id}:cite:`, link = `specs:req:${requirement.id}:link:`;
  const get = (key: string) => drafts[key] ?? "", set = (key: string, value: string) => setDraft(key, value || undefined);
  const [source, setSource] = useState<SourceVersionView | null>(null);
  const [sourceError, setSourceError] = useState<{ id: string; message: string } | null>(null), [sourceAttempt, setSourceAttempt] = useState(0);
  const [citationViews, setCitationViews] = useState<Record<string, SourceVersionView>>({});
  const [citationErrors, setCitationErrors] = useState<Record<string, string>>({}), [citationAttempt, setCitationAttempt] = useState(0);
  const sourceVersionId = get(`${cite}source`), start = get(`${cite}start`), end = get(`${cite}end`), excerpt = get(`${cite}excerpt`);
  useEffect(() => {
    if (!sourceVersionId) return;
    const controller = new AbortController();
    void apiRead<SourceVersionView>(`/api/projects/${projectId}/source-versions/${sourceVersionId}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) { setSource(result.data); setSourceError(null); } else setSourceError({ id: sourceVersionId, message: result.message });
    });
    return () => controller.abort();
  }, [projectId, sourceVersionId, sourceAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    for (const ref of requirement.sourceRefs) if (!citationViews[ref.sourceVersionId]) void apiRead<SourceVersionView>(`/api/projects/${projectId}/source-versions/${ref.sourceVersionId}`, controller.signal).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) setCitationViews((current) => current[result.data.id] ? current : { ...current, [result.data.id]: result.data });
      else setCitationErrors((current) => ({ ...current, [ref.sourceVersionId]: result.message }));
    });
    return () => controller.abort();
  }, [citationViews, projectId, requirement.sourceRefs, citationAttempt]);
  useEffect(() => { const first = Number(start), last = Number(end); if (!source || source.id !== sourceVersionId || !first || !last || last < first || excerpt) return; setDraft(`${cite}excerpt`, [...source.text.split("\n").slice(first - 1, last).join("\n")].slice(0, 2_000).join("")); }, [cite, end, excerpt, setDraft, source, sourceVersionId, start]);
  const selectedSource = sources.find((item) => item.currentVersionId === sourceVersionId);
  const sourceFor = (ref: SourceRef) => sources.find((item) => item.currentVersionId === ref.sourceVersionId);
  const links = Object.values(savedDraft.document.traceLinks).filter((entry) => entry.requirementId === requirement.id);
  const removedLinkEdits = Object.keys(drafts).filter((key) => key.startsWith(link) && key.endsWith(":explanation") && !savedDraft.document.traceLinks[key.slice(link.length, -":explanation".length)]);
  const nodes = Object.values(savedDraft.document.nodes), flows = savedDraft.document.flows;
  const addCitation = () => { const startLine = Number(start), endLine = Number(end); if (!source || source.id !== sourceVersionId || !startLine || !endLine || endLine < startLine || !excerpt) return; const ref: SourceRef = { sourceVersionId: source.id, startLine, endLine, excerpt }; send("Add citation", () => ({ commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement.version, payload: { requirementId: requirement.id, sourceRefs: [...requirement.sourceRefs, ref] } })); };
  const linkStatus = (entry: TraceLinkRecord) => { const node = savedDraft.document.nodes[entry.nodeId]; if (!node || linkState(savedDraft.document, entry) === "PROPOSED") return "Proposed"; if (linkState(savedDraft.document, entry) === "CURRENT") return "Reviewed"; return entry.reviewedRequirementBehaviourVersion !== requirement.behaviourVersion ? "Needs review: requirement changed" : "Needs review: step changed"; };
  const [deleting, setDeleting] = useState<string[] | null>(null);
  return <>
    <section className="detail-section"><h4>Citations</h4><ul className="plain-list">{requirement.sourceRefs.map((ref) => { const head = sourceFor(ref), view = citationViews[ref.sourceVersionId]; return <li key={JSON.stringify(ref)}><button type="button" className="text-link" disabled={!head && !view} onClick={() => update(() => ({ section: "sources", selected: { kind: "source", sourceId: head?.id ?? view?.sourceId ?? "", versionId: ref.sourceVersionId, range: { startLine: ref.startLine, endLine: ref.endLine }, back: { kind: "requirement", id: requirement.id } } }))}>{head?.title ?? view?.title ?? "Source"} v{head?.currentSequence ?? view?.sequence ?? "?"}, lines {ref.startLine}-{ref.endLine}</button>{!view && citationErrors[ref.sourceVersionId] && <p role="alert">{citationErrors[ref.sourceVersionId]} <button type="button" className="button small" onClick={() => setCitationAttempt((value) => value + 1)}>Retry citation</button></p>}{canEdit && <button type="button" className="button quiet small" disabled={locked} onClick={() => send("Remove citation", () => ({ commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: requirement.version, payload: { requirementId: requirement.id, sourceRefs: requirement.sourceRefs.filter((item) => item !== ref) } }))}>Remove citation</button>}</li>; })}</ul>
      {canEdit && sourceList.error && <p role="alert">{sourceList.error} <button type="button" className="button small" onClick={sourceList.retry}>Retry sources</button></p>}
      {canEdit && sourceError?.id === sourceVersionId && <p role="alert">{sourceError.message} <button type="button" className="button small" onClick={() => setSourceAttempt((value) => value + 1)}>Retry source text</button></p>}
      {canEdit && sourceVersionId && source?.id !== sourceVersionId && sourceError?.id !== sourceVersionId && <p role="status">Loading source text...</p>}
      {canEdit && <><div className="field"><label htmlFor="cite-source">Cite source</label><select id="cite-source" value={sourceVersionId} disabled={locked} onChange={(event) => { set(`${cite}source`, event.target.value); set(`${cite}start`, ""); set(`${cite}end`, ""); set(`${cite}excerpt`, ""); }}><option value="">Choose a source</option>{sources.map((item) => <option key={item.currentVersionId} value={item.currentVersionId}>{item.title}</option>)}</select></div><div className="field"><label htmlFor="cite-start">Start line</label><input id="cite-start" inputMode="numeric" readOnly={locked} value={start} onChange={(event) => { set(`${cite}start`, event.target.value); set(`${cite}excerpt`, ""); }} /></div><div className="field"><label htmlFor="cite-end">End line</label><input id="cite-end" inputMode="numeric" readOnly={locked} value={end} onChange={(event) => { set(`${cite}end`, event.target.value); set(`${cite}excerpt`, ""); }} /></div><div className="field"><label htmlFor="cite-excerpt">Excerpt</label><textarea id="cite-excerpt" readOnly={locked} value={excerpt} onChange={(event) => set(`${cite}excerpt`, event.target.value)} /></div><button type="button" className="button small" disabled={locked || !selectedSource || source?.id !== sourceVersionId || !excerpt} onClick={addCitation}>Add citation</button></>}
    </section>
    <section className="detail-section"><h4>Links</h4><ul className="plain-list">{links.map((entry) => { const node = savedDraft.document.nodes[entry.nodeId], flow = node && flows[node.flowId], explanationKey = `${link}${entry.id}:explanation`, versionKey = `${link}${entry.id}:version`, explanation = drafts[explanationKey] ?? entry.explanation, version = Number(drafts[versionKey] ?? entry.version), conflicted = drafts[versionKey] !== undefined && version !== entry.version; return <li key={entry.id}><strong>{flow?.title ?? "Flow"} / {node?.label ?? "Removed step"}</strong> <span className="specs-badge">{linkStatus(entry)}</span>{!canEdit && explanation && <p>{explanation}</p>}{canEdit && node && <><div className="field"><label htmlFor={`link-${entry.id}`}>Explanation</label><input id={`link-${entry.id}`} readOnly={locked} value={explanation} onChange={(event) => { if (event.target.value === entry.explanation) { setDraft(explanationKey, undefined); setDraft(versionKey, undefined); } else { if (!drafts[versionKey]) setDraft(versionKey, String(entry.version)); setDraft(explanationKey, event.target.value); } }} /></div>{conflicted && <section className="inline-note" role="alert"><p>This link changed. Your explanation is kept; review the saved explanation before saving again.</p><div className="field"><label htmlFor={`saved-link-${entry.id}`}>Current saved explanation</label><textarea id={`saved-link-${entry.id}`} rows={3} readOnly value={entry.explanation} /></div><div className="view-actions"><button type="button" className="button small" disabled={locked} onClick={() => setDraft(versionKey, String(entry.version))}>Use my explanation on latest version</button><button type="button" className="button quiet small" disabled={locked} onClick={() => { setDraft(explanationKey, undefined); setDraft(versionKey, undefined); }}>Use saved explanation</button></div></section>}{explanation !== entry.explanation && <p className="muted">Save explanation before confirming.</p>}<div className="view-actions"><button type="button" className="button small" disabled={locked || conflicted || explanation !== entry.explanation || linkStatus(entry) === "Reviewed"} onClick={() => send("Confirm link", () => ({ commandSchemaVersion: 1, command: "CONFIRM_TRACE_LINK", expectedEntityVersion: version, payload: { linkId: entry.id, expectedRequirementBehaviourVersion: requirement.behaviourVersion, expectedNodeBehaviourVersion: node.behaviourVersion } }))}>Confirm link</button><button type="button" className="button small" disabled={locked} onClick={() => send("Edit explanation", () => ({ commandSchemaVersion: 1, command: "UPDATE_TRACE_LINK", expectedEntityVersion: version, payload: { linkId: entry.id, explanation } }))}>Edit explanation</button><button type="button" className="button quiet small" disabled={locked} onClick={() => send("Remove link", (saved) => ({ commandSchemaVersion: 1, command: "DELETE_TRACE_LINK", expectedDocumentRevision: saved.documentRevision, payload: { linkId: entry.id } }))}>Remove</button></div></>}</li>; })}</ul>
      {removedLinkEdits.map((key) => <section className="inline-note" key={key}><p>This link was removed. Your explanation is kept for copying.</p><div className="field"><label htmlFor={`removed-${key}`}>Retained explanation for removed link</label><textarea id={`removed-${key}`} rows={3} readOnly value={drafts[key]} /></div><button type="button" className="button quiet small" disabled={locked} onClick={() => { setDraft(key, undefined); setDraft(key.replace(":explanation", ":version"), undefined); }}>Discard removed link edits</button></section>)}
      {canEdit && <><div className="field"><label htmlFor="link-step">Link to step</label><select id="link-step" value={get(`${link}node`)} disabled={locked} onChange={(event) => set(`${link}node`, event.target.value)}><option value="">Choose a step</option>{nodes.map((node) => <option key={node.id} value={node.id}>{flows[node.flowId]?.title ?? "Flow"} / {node.label}</option>)}</select></div><div className="field"><label htmlFor="link-explanation">Explanation</label><input id="link-explanation" readOnly={locked} value={get(`${link}new-explanation`)} onChange={(event) => set(`${link}new-explanation`, event.target.value)} /></div><button type="button" className="button small" disabled={locked || !get(`${link}node`)} onClick={() => send("Add link", (saved) => ({ commandSchemaVersion: 1, command: "ADD_TRACE_LINK", expectedDocumentRevision: saved.documentRevision, payload: { requirementId: requirement.id, nodeId: get(`${link}node`), explanation: get(`${link}new-explanation`) } }))}>Add link</button></>}
    </section>
    {canEdit && <button type="button" className="button danger" disabled={locked} onClick={() => setDeleting(requirementPlan(savedDraft.document, requirement.id).traceLinkIds)}>Delete requirement</button>}
    {deleting && <Dialog title={`Delete ${requirement.displayId}?`} onClose={() => setDeleting(null)} footer={<><button type="button" className="button quiet" onClick={() => setDeleting(null)}>Cancel</button><button type="button" className="button danger" disabled={locked} onClick={() => send("Delete requirement", (saved) => { const current = requirementPlan(saved.document, requirement.id).traceLinkIds; if (JSON.stringify(current) !== JSON.stringify(deleting)) { setDeleting(current); return null; } return { commandSchemaVersion: 1, command: "DELETE_REQUIREMENT", expectedDocumentRevision: saved.documentRevision, payload: { requirementId: requirement.id, removeLinkIds: deleting } }; })}>Delete requirement</button></>}><p>Also removes {deleting.length} requirement {deleting.length === 1 ? "link" : "links"}.</p></Dialog>}
  </>;
}
