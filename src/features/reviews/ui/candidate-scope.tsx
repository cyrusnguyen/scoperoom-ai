"use client";
import { useState } from "react";
import type { SourceRef } from "@/features/drafts/contracts/scope-document";
import { linkState } from "@/features/scope/domain/scope";
import { REQUIREMENT_CATEGORY_LABELS } from "@/features/scope/ui/requirement-form";
import SourceLines from "@/features/sources/ui/source-lines";
import { CLASSIFICATION_LABELS, KIND_LABELS } from "@/features/studio/ui/fields";
import type { CandidateSnapshot } from "../contracts/review";
import { InclusionBadge } from "./review-badges";
import { linkNote, linkReviewLabel, scopeNote } from "./review-format";

/** The captured scope with every item's approval status in words, then the exact cited source versions. */
export default function CandidateScope({ snapshot: s, approved }: { snapshot: CandidateSnapshot; approved: boolean }) {
  const doc = s.documentJson;
  const [citation, setCitation] = useState<SourceRef | null>(null);
  const flows = Object.values(doc.flows), requirements = Object.values(doc.requirements), links = Object.values(doc.traceLinks);
  const refs = (items: SourceRef[]) => items.length > 0 && <ul className="review-citations" aria-label="Captured citations">{items.map((ref, index) => <li key={index}>
    <button type="button" className="button quiet small" onClick={() => { setCitation(ref); requestAnimationFrame(() => document.getElementById(`captured-source-${ref.sourceVersionId}`)?.scrollIntoView({ block: "start" })); }}>{s.evidenceManifest.find(e => e.id === ref.sourceVersionId)?.title ?? ref.sourceVersionId}, lines {ref.startLine}-{ref.endLine}</button>
    <blockquote>{ref.excerpt}</blockquote>
  </li>)}</ul>;
  const heading = (title: string, count: number) => <div className="review-section-heading"><h3>{title}</h3><span className="review-count">{count}</span></div>;
  return <>
    {doc.projectGoal && <section className="review-section"><h3>Project goal</h3><p>{doc.projectGoal}</p></section>}
    <section className="review-section">
      {heading("Frozen flows", flows.length)}
      {!flows.length && <p className="review-empty">No flows were captured.</p>}
      {flows.map(flow => <section key={flow.id} className="review-scope-item" data-approved={approved && flow.inclusion === "INCLUDED"}>
        <header className="review-card-header"><h4>{flow.title}</h4><InclusionBadge inclusion={flow.inclusion} /></header>
        <p className="review-scope-note">{scopeNote(flow.inclusion, approved)}</p>
        <p className="review-intro">{CLASSIFICATION_LABELS[flow.classification]}</p>
        {flow.purpose && <p>{flow.purpose}</p>}
        <ol className="review-steps">{Object.values(doc.nodes).filter(node => node.flowId === flow.id).map(node => <li key={node.id}>
          <div className="review-step-title"><strong>{node.label}</strong><span className="review-kind">{KIND_LABELS[node.kind]}</span></div>
          {node.description && <p>{node.description}</p>}
          {node.actorLabel && <p className="review-intro">Actor: {node.actorLabel}</p>}
          {node.assumptionNotes.map((note, index) => <p key={index} className="review-intro">Assumption: {note}</p>)}
          {s.layoutJson.positions[node.id] && <p className="review-id">Saved position: {s.layoutJson.positions[node.id].x}, {s.layoutJson.positions[node.id].y}</p>}
          {refs(node.sourceRefs)}
        </li>)}</ol>
        <ul className="review-connections" aria-label="Frozen connections">{Object.values(doc.edges).filter(edge => edge.flowId === flow.id).map(edge => <li key={edge.id}>
          {doc.nodes[edge.fromId]?.label} → {doc.nodes[edge.toId]?.label}{edge.condition && `: ${edge.condition}`}{refs(edge.sourceRefs)}
        </li>)}</ul>
      </section>)}
    </section>
    <section className="review-section">
      {heading("Frozen requirements", requirements.length)}
      {!requirements.length && <p className="review-empty">No requirements were captured.</p>}
      {requirements.map(req => <section key={req.id} className="review-scope-item" data-approved={approved && req.inclusion === "INCLUDED"}>
        <header className="review-card-header"><h4>{req.displayId}: {req.title}</h4><InclusionBadge inclusion={req.inclusion} /></header>
        <p className="review-scope-note">{scopeNote(req.inclusion, approved)}</p>
        <p className="review-intro">{REQUIREMENT_CATEGORY_LABELS[req.category]}</p>
        <p>{req.statement}</p>
        <p className="review-intro">Owner ID: {req.ownerId ?? "Unassigned"}</p>
        {req.verificationMethod && <p className="review-intro">Verification: {req.verificationMethod.description} · Responsible role: {req.verificationMethod.responsibleRole}</p>}
        {refs(req.sourceRefs)}
      </section>)}
    </section>
    <section className="review-section">
      {heading("Frozen trace links", links.length)}
      {!links.length && <p className="review-empty">No trace links were captured.</p>}
      {links.length > 0 && <ul className="review-links">{links.map(link => {
        const included = doc.requirements[link.requirementId]?.inclusion === "INCLUDED" && doc.flows[doc.nodes[link.nodeId]?.flowId ?? ""]?.inclusion === "INCLUDED";
        const state = linkState(doc, link);
        return <li key={link.id} className="review-scope-item" data-approved={approved && included && state === "CURRENT"}>
          <p><strong>{doc.requirements[link.requirementId]?.displayId}</strong> → {doc.nodes[link.nodeId]?.label}</p>
          <p className="review-scope-note">{linkNote(included, state, approved)}</p>
          <p className="review-intro">Link review: {linkReviewLabel(state)}</p>
          {link.explanation && <p>{link.explanation}</p>}
        </li>;
      })}</ul>}
    </section>
    <section className="review-section">
      {heading("Captured evidence", s.evidenceManifest.length)}
      {s.evidenceManifest.length === 0 && <p className="review-empty">No source citations were captured.</p>}
      {s.evidenceManifest.map(source => <section key={source.id} id={`captured-source-${source.id}`} className="review-scope-item">
        <h4>{source.title} · Version {source.sequence}</h4>
        <p className="review-id">{source.kind} · {source.contentHash}</p>
        <SourceLines key={`${s.id}:${source.id}:${citation?.sourceVersionId === source.id ? `${citation.startLine}:${citation.endLine}` : "first"}`} text={source.text} range={citation?.sourceVersionId === source.id ? citation : undefined} />
      </section>)}
    </section>
  </>;
}
