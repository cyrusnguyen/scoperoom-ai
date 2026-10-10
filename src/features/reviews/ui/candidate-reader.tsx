"use client";
import { useState } from "react";
import type { SourceRef } from "@/features/drafts/contracts/scope-document";
import SourceLines from "@/features/sources/ui/source-lines";
import type { ReviewDetail } from "../contracts/review";

export default function CandidateReader({ detail }: { detail: ReviewDetail }) {
  const { snapshot: s, review, draftChanges } = detail;
  const doc = s.documentJson;
  const [citation, setCitation] = useState<SourceRef | null>(null);
  const refs = (items: SourceRef[]) => items.length > 0 && <ul aria-label="Captured citations">{items.map((ref, index) => <li key={index}>
      <button type="button" className="button quiet small" onClick={() => { setCitation(ref); requestAnimationFrame(() => document.getElementById(`captured-source-${ref.sourceVersionId}`)?.scrollIntoView({ block: "start" })); }}>{s.evidenceManifest.find(e => e.id === ref.sourceVersionId)?.title ?? ref.sourceVersionId}, lines {ref.startLine}-{ref.endLine}</button>
      <blockquote>{ref.excerpt}</blockquote>
      </li>)}</ul>;
  return <article className="candidate-reader" aria-label="Frozen candidate">
    <h2>Candidate - not approved</h2>
    <dl className="detail-facts">
      <dt>Captured project name</dt>
      <dd>{s.projectName}</dd>
      <dt>Review</dt>
      <dd>{review.reviewId}</dd>
      <dt>State</dt>
      <dd>{review.state}</dd>
      <dt>Candidate</dt>
      <dd>{s.id}</dd>
      <dt>Review hash</dt>
      <dd>{s.reviewHash}</dd>
      <dt>Content hash</dt>
      <dd>{s.contentHash}</dd>
      <dt>Captured approver</dt>
      <dd>{s.policySnapshot.designatedApproverId}</dd>
      <dt>Saved revisions</dt>
      <dd>Document {s.capturedDocumentRevision}, layout {s.capturedLayoutRevision}</dd>
      <dt>Approval policy</dt>
      <dd>{s.policySnapshot.approvalPolicyVersion}</dd>
      <dt>Created</dt>
      <dd>{s.createdAt}</dd>
      <dt>Parent baseline</dt>
      <dd>{s.parentSnapshotId ?? "None"}</dd>
      </dl>
    {(draftChanges.contentChanged || draftChanges.layoutChanged || draftChanges.replaced) && <p>The current draft {draftChanges.replaced ? "has been replaced" : "has newer saved changes"}. This captured candidate is unchanged.</p>}
    {review.reason && <p>Closed reason: {review.reason}</p>}
    {doc.projectGoal && <section className="detail-section">
      <h3>Project goal</h3>
      <p>{doc.projectGoal}</p>
      </section>}
    <section className="detail-section">
      <h3>Frozen flows</h3>{Object.values(doc.flows).map(flow => <section key={flow.id}>
      <h4>{flow.title}</h4>
      <p>{flow.inclusion} · {flow.classification}</p>
      <p>{flow.purpose}</p>
      <ol>{Object.values(doc.nodes).filter(n => n.flowId === flow.id).map(node => <li key={node.id}>
      <strong>{node.label}</strong> ({node.kind})<p>{node.description}</p>{node.actorLabel && <p>Actor: {node.actorLabel}</p>}
      {node.assumptionNotes.map((note,index) => <p key={index}>Assumption: {note}</p>)}{s.layoutJson.positions[node.id] && <p>Saved position: {s.layoutJson.positions[node.id].x}, {s.layoutJson.positions[node.id].y}</p>}
      {refs(node.sourceRefs)}</li>)}</ol>
      <ul aria-label="Frozen connections">{Object.values(doc.edges).filter(e => e.flowId === flow.id).map(edge => <li key={edge.id}>{doc.nodes[edge.fromId]?.label} → {doc.nodes[edge.toId]?.label}{edge.condition && `: ${edge.condition}`}{refs(edge.sourceRefs)}</li>)}</ul>
      </section>
    )}</section>
    <section className="detail-section">
      <h3>Frozen requirements</h3>{Object.values(doc.requirements).map(req => <section key={req.id}>
      <h4>{req.displayId}: {req.title}</h4>
      <p>{req.inclusion} · {req.category}</p>
      <p>{req.statement}</p>
      <p>Owner: {req.ownerId ?? "Unassigned"}</p>{req.verificationMethod && <p>Verification: {req.verificationMethod.description} · Responsible role: {req.verificationMethod.responsibleRole}</p>}
      {refs(req.sourceRefs)}</section>
    )}</section>
    <section className="detail-section">
      <h3>Frozen trace links</h3>
      <ul>{Object.values(doc.traceLinks).map(link => <li key={link.id}>{doc.requirements[link.requirementId]?.displayId} → {doc.nodes[link.nodeId]?.label}<p>{link.explanation}</p>
      </li>)}</ul>
      </section>
    <section className="detail-section">
      <h3>Captured evidence</h3>{s.evidenceManifest.length === 0 && <p>No source citations were captured.</p>}
      {s.evidenceManifest.map(source => <section key={source.id} id={`captured-source-${source.id}`}>
      <h4>{source.title} · Version {source.sequence}</h4>
      <p>{source.kind} · {source.contentHash}</p>
      <SourceLines key={`${s.id}:${source.id}:${citation?.sourceVersionId === source.id ? `${citation.startLine}:${citation.endLine}` : "first"}`} text={source.text} range={citation?.sourceVersionId === source.id ? citation : undefined} />
      </section>
    )}</section>
  </article>;
}
