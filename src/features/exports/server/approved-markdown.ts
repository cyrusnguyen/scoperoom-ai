import type { SourceRef } from "../../drafts/contracts/scope-document.ts";
import { canonicalJson } from "../../proposals/domain/capture.ts";
import type { ProjectIdentity } from "../../projects/contracts/project.ts";
import type { PublishedSnapshot } from "../../reviews/contracts/review.ts";
import { readSnapshot } from "../../reviews/server/read-reviews.ts";
import { exportFilename } from "../domain/flow-file.ts";

// Entity punctuation is encoded before Markdown is parsed, so bare URLs and email addresses stay inert too.
function safeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~=\-]/g, "\\$&").replace(/:/g, "&#58;").replace(/@/g, "&#64;")
    .replace(/^[ \t]+/g, value => [...value].map(c => c === " " ? "&#32;" : "&#9;").join(""))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, c => `&#${c.charCodeAt(0)};`);
}
const sorted = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Stable handoff from captured content only. No current project, source, profile or clock lookup. */
export function formatApprovedMarkdown(value: PublishedSnapshot): string {
  const { snapshot: s, decision: d } = value, doc = s.documentJson;
  const blocks: string[] = [];
  const add = (text: string) => { blocks.push(text); };
  const field = (label: string, text: string) => add(`${label}:\n\n${text.replace(/\r\n?/g, "\n").split("\n").map(line => `> ${safeText(line)}`).join("\n")}`);
  const citations = (refs: SourceRef[]) => {
    for (const ref of [...refs].sort((a, b) => a.sourceVersionId < b.sourceVersionId ? -1 : a.sourceVersionId > b.sourceVersionId ? 1 : a.startLine - b.startLine || a.endLine - b.endLine || (a.excerpt < b.excerpt ? -1 : a.excerpt > b.excerpt ? 1 : 0))) {
      add(`Source version: ${ref.sourceVersionId}; lines ${ref.startLine}-${ref.endLine}`);
      field("Captured excerpt", ref.excerpt);
    }
  };
  add("# Approved scope"); field("Project", s.projectName); field("Project goal", doc.projectGoal);
  add("## Immutable approval");
  add([
    `Baseline sequence: ${value.publicationSequence}`, `Project ID: ${s.projectId}`, `Snapshot ID: ${s.id}`, `Review ID: ${value.reviewId}`,
    `Content hash: ${s.contentHash}`, `Review hash: ${s.reviewHash}`, `Parent baseline: ${s.parentSnapshotId ?? "None"}`,
    `Source draft: ${s.sourceDraftId}`, `Captured revisions: document ${s.capturedDocumentRevision}, layout ${s.capturedLayoutRevision}`,
    `Captured by ID: ${s.createdBy}`, `Captured at (UTC): ${s.createdAt}`, `Approval policy version: ${s.policySnapshot.approvalPolicyVersion}`,
    `Decision ID: ${d.id}`, `Approved actor ID: ${d.actorId}`, `Approved actor role: ${d.actorRole ?? "Not captured"}`, `Approved at (UTC): ${d.createdAt}`, `Published at (UTC): ${value.publishedAt}`,
  ].map(line => `- ${line}`).join("\n"));
  field("Approved actor name", d.actorDisplayName ?? "Not captured");
  if (d.actorRole === "OWNER") add("Approval type: Self/internal approval");
  if (d.comment !== null) field("Approval comment", d.comment);
  for (const [inclusion, heading, disclosure] of [
    ["INCLUDED", "Included scope", "Only INCLUDED flows, requirements and their reviewed included links form the approved scope."],
    ["EXCLUDED", "Excluded", "Excluded items are not approved behavior."],
    ["UNDECIDED", "Undecided / exploratory background", "Background is not approved."],
  ] as const) {
    add(`## ${heading}`); add(disclosure);
    const flows = sorted(Object.values(doc.flows).filter(f => f.inclusion === inclusion)), requirements = sorted(Object.values(doc.requirements).filter(r => r.inclusion === inclusion));
    if (!flows.length && !requirements.length) add("None.");
    for (const flow of flows) {
      add(`### Flow ${flow.id}`);
      add(`- Inclusion: ${inclusion}\n- Classification: ${flow.classification}\n- Direction: ${s.layoutJson.directions[flow.id]}\n- Behaviour version: ${flow.behaviourVersion}`);
      if (flow.confirmation) add(`- Confirmed by ID: ${flow.confirmation.actorId}\n- Confirmed at (UTC): ${flow.confirmation.confirmedAt}`);
      field("Title", flow.title); field("Purpose", flow.purpose);
      add("#### Steps");
      const nodes = sorted(Object.values(doc.nodes).filter(n => n.flowId === flow.id));
      if (!nodes.length) add("None.");
      for (const node of nodes) {
        add(`Step ID: ${node.id}\n\n- Kind: ${node.kind}\n- Origin: ${node.origin}\n- Behaviour version: ${node.behaviourVersion}`);
        field("Label", node.label); field("Description", node.description); field("Actor", node.actorLabel);
        for (const note of node.assumptionNotes) field("Assumption", note);
        citations(node.sourceRefs);
      }
      add("#### Connections");
      const edges = sorted(Object.values(doc.edges).filter(e => e.flowId === flow.id));
      if (!edges.length) add("None.");
      for (const edge of edges) {
        add(`Connection ID: ${edge.id}\n\n- From: ${edge.fromId}\n- To: ${edge.toId}\n- Origin: ${edge.origin}`);
        field("Branch label", edge.condition); citations(edge.sourceRefs);
      }
    }
    for (const req of requirements) {
      add(`### Requirement ${req.displayId}`);
      add(`- ID: ${req.id}\n- Inclusion: ${inclusion}\n- Category: ${req.category}\n- Origin: ${req.origin}\n- Owner ID: ${req.ownerId ?? "Unassigned"}\n- Behaviour version: ${req.behaviourVersion}${req.confirmation ? `\n- Confirmed by ID: ${req.confirmation.actorId}\n- Confirmed at (UTC): ${req.confirmation.confirmedAt}` : ""}`);
      field("Title", req.title); field("Statement", req.statement); citations(req.sourceRefs);
    }
  }
  const includedLink = (link: (typeof doc.traceLinks)[string]) => doc.requirements[link.requirementId].inclusion === "INCLUDED" && doc.flows[doc.nodes[link.nodeId].flowId].inclusion === "INCLUDED";
  for (const approved of [true, false]) {
    add(approved ? "## Reviewed included links" : "## Background trace links");
    if (!approved) add("Background links are not approved.");
    const links = sorted(Object.values(doc.traceLinks).filter(link => includedLink(link) === approved));
    if (!links.length) add("None.");
    for (const link of links) {
      add(`### Link ${link.id}`);
      add(`- Requirement: ${doc.requirements[link.requirementId].displayId} (${link.requirementId})\n- Step: ${link.nodeId}\n- Reviewed requirement behaviour: ${link.reviewedRequirementBehaviourVersion ?? "Not reviewed"}\n- Reviewed step behaviour: ${link.reviewedNodeBehaviourVersion ?? "Not reviewed"}\n- Reviewed by ID: ${link.reviewedBy ?? "Not reviewed"}\n- Reviewed at (UTC): ${link.reviewedAt ?? "Not reviewed"}`);
      field("Explanation", link.explanation);
    }
  }
  add("## Intended verification definitions"); add("Definitions are intended checks, not executed results.");
  const definitions = sorted(Object.values(doc.requirements).filter(r => r.verificationMethod));
  if (!definitions.length) add("None.");
  for (const req of definitions) {
    add(`### ${req.displayId} (${req.id})\n\nInclusion: ${req.inclusion}${req.inclusion === "INCLUDED" ? "" : "; not approved"}`);
    field("Definition", req.verificationMethod!.description); field("Responsible role", req.verificationMethod!.responsibleRole);
  }
  add("## Captured evidence"); add("Exact immutable source versions; citations above retain their original line ranges.");
  if (!s.evidenceManifest.length) add("None.");
  for (const source of sorted(s.evidenceManifest)) {
    add(`### Source version ${source.id}`);
    add(`- Source ID: ${source.sourceId}\n- Version sequence: ${source.sequence}\n- Kind: ${source.kind}\n- Content hash: ${source.contentHash}\n- Created by ID: ${source.createdBy}\n- Created at (UTC): ${source.createdAt}`);
    field("Title", source.title); field("Captured source text", source.text); field("Captured origin", canonicalJson(source.origin));
  }
  return blocks.join("\n\n") + "\n";
}

export async function exportApprovedMarkdown(identity: ProjectIdentity, projectId: string, snapshotId: string): Promise<{ filename: string; text: string }> {
  const published = await readSnapshot(identity, projectId, snapshotId);
  return { filename: exportFilename(published.snapshot.projectName).replace(/\.scoperoom-flow\.json$/, ".md"), text: formatApprovedMarkdown(published) };
}
