"use client";
import { useState } from "react";
import type { SourceRef } from "@/features/drafts/contracts/scope-document";
import { linkState } from "@/features/scope/domain/scope";
import { roleLabel } from "@/features/projects/ui/format";
import SourceLines from "@/features/sources/ui/source-lines";
import type { PublishedSnapshot, ReviewDetail } from "../contracts/review";

export default function CandidateReader({ detail }: { detail: ReviewDetail | PublishedSnapshot }) {
  const { snapshot: s, decision } = detail;
  const published = "publicationSequence" in detail ? detail : null;
  const review = "review" in detail ? detail.review : null;
  const draftChanges = "draftChanges" in detail ? detail.draftChanges : null;
  const doc = s.documentJson;
  const approved = Boolean(published || review?.state === "APPROVED");
  const [citation, setCitation] = useState<SourceRef | null>(null);
  const refs = (items: SourceRef[]) => items.length > 0 && <ul aria-label="Captured citations">{items.map((ref, index) => <li key={index}>
      <button type="button" className="button quiet small" onClick={() => { setCitation(ref); requestAnimationFrame(() => document.getElementById(`captured-source-${ref.sourceVersionId}`)?.scrollIntoView({ block: "start" })); }}>{s.evidenceManifest.find(e => e.id === ref.sourceVersionId)?.title ?? ref.sourceVersionId}, lines {ref.startLine}-{ref.endLine}</button>
      <blockquote>{ref.excerpt}</blockquote>
      </li>)}</ul>;
  return <article className="candidate-reader" aria-label={published ? "Published baseline" : "Frozen candidate"}>
    <h2>{published ? `Approved baseline ${published.publicationSequence}` : review?.state === "APPROVED" ? "Approved candidate" : review?.state === "CHANGES_REQUESTED" ? "Candidate - changes requested" : review?.state === "REJECTED" ? "Candidate - rejected" : "Candidate - not approved"}</h2>
    <dl className="detail-facts">
      <dt>Captured project name</dt>
      <dd>{s.projectName}</dd>
      <dt>Review</dt>
      <dd>{published?.reviewId ?? review?.reviewId}</dd>
      <dt>State</dt>
      <dd>{published ? "APPROVED" : review?.state}</dd>
      <dt>{published ? "Snapshot" : "Candidate"}</dt>
      <dd>{s.id}</dd>
      <dt>Review hash</dt>
      <dd>{s.reviewHash}</dd>
      <dt>Content hash</dt>
      <dd>{s.contentHash}</dd>
      <dt>Captured approver ID</dt>
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
    {draftChanges && (draftChanges.contentChanged || draftChanges.layoutChanged || draftChanges.replaced) && <p>The current draft {draftChanges.replaced ? "has been replaced" : "has newer saved changes"}. This captured candidate is unchanged.</p>}
    {decision && <section className="detail-section" aria-label="Human decision">
      <h3>Human decision</h3>
      <dl className="detail-facts">
        <dt>Decision</dt><dd>{decision.decision === "APPROVE" ? "Approved" : decision.decision === "REQUEST_CHANGES" ? "Changes requested" : "Rejected"}</dd>
        <dt>Actor</dt><dd>{decision.actorDisplayName ?? "Not captured"}</dd>
        <dt>Actor role</dt><dd>{decision.actorRole ? roleLabel(decision.actorRole) : "Not captured"}</dd>
        <dt>Actor ID</dt><dd>{decision.actorId}</dd>
        {decision.decision === "APPROVE" && decision.actorRole === "OWNER" && <><dt>Approval type</dt><dd>Self/internal approval</dd></>}
        <dt>Decided</dt><dd>{decision.createdAt}</dd>
        <dt>Reviewed hash</dt><dd>{decision.reviewedHash}</dd>
        {(published?.publicationSequence ?? review?.publicationSequence) != null && <><dt>Published baseline</dt><dd>{published?.publicationSequence ?? review?.publicationSequence}</dd></>}
        {(published?.publishedAt ?? review?.publishedAt) && <><dt>Published</dt><dd>{published?.publishedAt ?? review?.publishedAt}</dd></>}
      </dl>
      {decision.comment && <p>Decision reason: {decision.comment}</p>}
    </section>}
    {!decision && review?.reason && <p>Closed reason: {review.reason}</p>}
    {doc.projectGoal && <section className="detail-section">
      <h3>Project goal</h3>
      <p>{doc.projectGoal}</p>
      </section>}
    <section className="detail-section">
      <h3>Frozen flows</h3>{Object.values(doc.flows).map(flow => <section key={flow.id}>
      <h4>{flow.title}</h4>
      <p>{flow.inclusion} · {flow.classification}</p>
      <p>{flow.inclusion === "EXCLUDED" ? "Excluded background. Not approved behavior." : flow.inclusion === "UNDECIDED" ? "Undecided / exploratory background. Not approved." : approved ? "Included in approved scope." : "Included candidate scope. Not approved."}</p>
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
      <p>{req.inclusion === "EXCLUDED" ? "Excluded background. Not approved behavior." : req.inclusion === "UNDECIDED" ? "Undecided / exploratory background. Not approved." : approved ? "Included in approved scope." : "Included candidate scope. Not approved."}</p>
      <p>{req.statement}</p>
      <p>Owner ID: {req.ownerId ?? "Unassigned"}</p>{req.verificationMethod && <p>Verification: {req.verificationMethod.description} · Responsible role: {req.verificationMethod.responsibleRole}</p>}
      {refs(req.sourceRefs)}</section>
    )}</section>
    <section className="detail-section">
      <h3>Frozen trace links</h3>
      <ul>{Object.values(doc.traceLinks).map(link => {
        const included = doc.requirements[link.requirementId]?.inclusion === "INCLUDED" && doc.flows[doc.nodes[link.nodeId]?.flowId ?? ""]?.inclusion === "INCLUDED";
        const state = linkState(doc, link);
        return <li key={link.id}>{doc.requirements[link.requirementId]?.displayId} → {doc.nodes[link.nodeId]?.label}
          <p>{!included ? "Background trace link. Not approved." : state !== "CURRENT" ? "Unreviewed included trace link. Not approved." : approved ? "Reviewed included link. Approved scope." : "Reviewed included candidate link. Not approved."}</p>
          <p>Link review: {state === "CURRENT" ? "Current" : state === "PROPOSED" ? "Not reviewed" : "Needs review"}</p>
          <p>{link.explanation}</p>
        </li>;
      })}</ul>
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
