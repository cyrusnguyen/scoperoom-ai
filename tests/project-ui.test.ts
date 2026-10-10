import { defaultReviewUi } from "../src/features/reviews/ui/review-state.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Changes } from "../src/features/drafts/contracts/changes.ts";
import { edit, type Saved } from "../src/features/studio/ui/buffers.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import type { DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { acknowledgeExternalWrite, admits, afterDraftRead, canApplyAgain, covers, draftWriteBlocker, requireDraftRevision } from "../src/features/studio/ui/studio-ui.ts";
import { type AiRequest, currentAiRun, recoverUnavailableCurrentRun, acknowledgedApplyCovered, retainAiApply, finishAiApply, anyDirty, defaultUi, defaultSpecsUi, dirtyCount, discardDrafts, dropProject, fillSpecsRequest, setDraft, setRightOpen, setRightTab, settleSpecsRequest, startSpecsRequest, uiFor, updateUi } from "../src/features/shell/ui/project-ui.ts";
import { finishSourceWrite } from "../src/features/sources/ui/source-write.ts";
import { finishRequirementWrite } from "../src/features/scope/ui/requirement-write.ts";
import { editSourceCorrection, sourceCorrectionBody } from "../src/features/sources/ui/source-correction.ts";

test("receipt recovery reaches the original draft after replacement, downgrade or archive", () => {
  for (const role of ["OWNER", "EDITOR", "REVIEWER", "VIEWER"] as const) {
    for (const status of ["ACTIVE", "ARCHIVED"] as const) {
      assert.equal(draftWriteBlocker({ currentDraftId: "replacement", role, status }, "original", false), null, "existing canvas, AI and import retries must reach server receipt recovery");
    }
  }
});

test("first draft writes retain current-target and capability gates while recovery bypasses them", () => {
  const status = { currentDraftId: "replacement", role: "OWNER" as const, status: "ACTIVE" as const };
  assert.equal(draftWriteBlocker(status, "original", true)?.code, "DRAFT_REPLACED");
  assert.equal(draftWriteBlocker(status, "original", false, true)?.code, "DRAFT_REPLACED", "a fresh Specs write still requires its inspected draft");
  assert.equal(draftWriteBlocker(status, "replacement", true), null);
  assert.equal(draftWriteBlocker({ ...status, role: "VIEWER" }, "replacement", true)?.code, "FORBIDDEN");
  assert.equal(draftWriteBlocker({ ...status, status: "ARCHIVED" }, "replacement", true)?.code, "FORBIDDEN");
  assert.equal(draftWriteBlocker({ ...status, role: "REVIEWER" }, "replacement", false, true), null, "Specs capability remains server-authorized");
});

test("correction snapshots protect navigation, survive tabs and pending discard, and only their ACK clears them", () => {
  const correction = editSourceCorrection(undefined, { version: 1, currentVersionId: "v1" }, { id: "v1", sequence: 1, title: "Original", text: "Text" }, "title", "Local")!;
  const initial = updateUi({}, "a", () => ({ specs: { ...defaultSpecsUi, sourceCorrections: { source: correction, other: correction } } }));
  assert.equal(dirtyCount(initial, "a"), 2);
  assert.equal(anyDirty(initial), true);
  assert.equal(uiFor(setRightTab(setRightOpen(initial, "a", false), "a", "specs"), "a").specs.sourceCorrections?.source, correction);
  assert.deepEqual(uiFor(discardDrafts(initial, "a"), "a").specs.sourceCorrections, {});
  const pending = { key: "correction-key", method: "POST" as const, path: "sources/source/versions", label: "Save new version", body: sourceCorrectionBody(correction) };
  const store = updateUi(initial, "a", (ui) => ({ specs: { ...ui.specs, pending } }));
  const discarded = uiFor(discardDrafts(store, "a"), "a");
  assert.equal(discarded.specs.pending, pending);
  assert.deepEqual(discarded.specs.sourceCorrections, { source: correction }, "only the unresolved correction survives explicit discard");
  const before = uiFor(store, "a"), saved = finishSourceWrite(before, pending);
  assert.deepEqual(saved.specs.sourceCorrections, { other: correction });
  assert.equal(saved.specs.pending, null);
  const newer = { ...saved, specs: { ...saved.specs, sourceCorrections: { source: correction, other: correction } } };
  assert.equal(finishSourceWrite(newer, pending), newer, "a duplicate ACK never erases later input");
  const refused = { ...before, specs: settleSpecsRequest(before.specs, pending.key, "refused", "Stale") };
  assert.equal(refused.specs.sourceCorrections?.source, correction, "a stale refusal preserves the captured baseline and fields");
});

test("source acknowledgement clears matching input atomically and a duplicate keeps newer text and selection", () => {
  const request = { key: "first", method: "POST" as const, path: "sources", body: { title: "First", text: "Submitted" }, label: "Add source" };
  const current = { ...defaultUi, drafts: { "specs:new-source:title": "First", "specs:new-source:text": "Submitted", "specs:new-source:uploaded": "true", "specs:new-source:upload-name": "first.txt" }, specs: { ...defaultSpecsUi, staleRequirements: { r1: "draft" }, pending: request } };
  const saved = finishSourceWrite(current, request);
  assert.deepEqual(saved.drafts, {});
  assert.equal(saved.drafts["specs:new-source:upload-name"], undefined);
  assert.equal(saved.specs.pending, null);
  assert.equal(saved.specs.message, "Add source: saved.");
  assert.deepEqual(saved.specs.staleRequirements, { r1: "draft" }, "a source acknowledgement preserves requirement recovery");
  const newer = { ...saved, drafts: { "specs:new-source:text": "New text" }, specs: { ...saved.specs, pending: { ...request, key: "second" } } };
  assert.equal(finishSourceWrite(newer, request), newer, "old ACK never affects a newer request or its drafts");
  assert.equal(finishSourceWrite({ ...newer, specs: saved.specs }, request).drafts["specs:new-source:text"], "New text", "even without a newer request");
});

test("requirement acknowledgement clears only its frozen fields and a duplicate keeps newer input", () => {
  const request = { key: "requirement", method: "POST" as const, path: "drafts/draft/commands", label: "Save requirement", draft: true as const, body: {
    commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: "r1", title: "Submitted" },
  } };
  const current = { ...defaultUi, drafts: { "specs:req:r1:base": "{}", "specs:req:r1:expectedEntityVersion": "1", "specs:req:r1:title": "Submitted", "specs:req:r1:statement": "Later local text" }, specs: { ...defaultSpecsUi, staleRequirements: { r1: "draft" }, pending: request, selected: { kind: "requirement" as const, id: "r1" } } };
  const saved = finishRequirementWrite(current, request, { versions: { r1: 2 } });
  assert.equal(saved.drafts["specs:req:r1:title"], undefined);
  assert.equal(saved.drafts["specs:req:r1:statement"], "Later local text");
  assert.equal(saved.specs.pending, null);
  assert.equal(saved.specs.staleRequirements, undefined, "a matching guarded requirement acknowledgement resolves its recovery control");
  const newerDraft = finishRequirementWrite({ ...current, specs: { ...current.specs, staleRequirements: { r1: "newer-draft" } } }, request, { versions: { r1: 2 } });
  assert.deepEqual(newerDraft.specs.staleRequirements, { r1: "newer-draft" }, "an older draft acknowledgement cannot clear newer recovery");
  const newer = { ...saved, drafts: { ...saved.drafts, "specs:req:r1:title": "Newer text" }, specs: { ...saved.specs, pending: { ...request, key: "next" } } };
  assert.equal(finishRequirementWrite(newer, request, { versions: { r1: 3 } }).drafts["specs:req:r1:title"], "Newer text");
});

test("a citation acknowledgement never upgrades an older dirty requirement guard", () => {
  const request = { key: "citation", method: "POST" as const, path: "drafts/draft/commands", label: "Add citation", draft: true as const, body: {
    commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId: "r1", sourceRefs: [{ sourceVersionId: "v1", startLine: 1, endLine: 1, excerpt: "Evidence" }] },
  } };
  const current = { ...defaultUi, drafts: { "specs:req:r1:base": "{}", "specs:req:r1:expectedEntityVersion": "1", "specs:req:r1:title": "Dirty v1 text", "specs:req:r1:cite:source": "v1", "specs:req:r1:cite:start": "1", "specs:req:r1:cite:end": "1", "specs:req:r1:cite:excerpt": "Evidence" }, specs: { ...defaultSpecsUi, staleRequirements: { r1: "draft" }, pending: request, selected: { kind: "requirement" as const, id: "r1" } } };
  const saved = finishRequirementWrite(current, request, { versions: { r1: 3 } });
  assert.equal(saved.drafts["specs:req:r1:expectedEntityVersion"], "1");
  assert.equal(saved.drafts["specs:req:r1:title"], "Dirty v1 text");
  assert.equal(saved.drafts["specs:req:r1:cite:excerpt"], undefined);
  assert.deepEqual(saved.specs.staleRequirements, { r1: "draft" }, "a citation acknowledgement cannot clear recovery for an older wording guard");
  assert.deepEqual(saved.specs.selected, { kind: "requirement", id: "r1" });
  assert.equal(finishRequirementWrite({ ...saved, drafts: { ...saved.drafts, "specs:req:r1:title": "Newer input" } }, request, { versions: { r1: 4 } }).drafts["specs:req:r1:title"], "Newer input");
});

test("a citation acknowledgement advances its own matching guard through reader navigation", () => {
  const request = { key: "citation-in-reader", method: "POST" as const, path: "drafts/draft/commands", label: "Add citation", draft: true as const, body: {
    commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: "r1", sourceRefs: [{ sourceVersionId: "v1", startLine: 1, endLine: 1, excerpt: "Evidence" }] },
  } };
  const selected = { kind: "source" as const, sourceId: "s1", versionId: "v1", back: { kind: "requirement" as const, id: "r1" } };
  const current = { ...defaultUi, drafts: { "specs:req:r1:base": "{}", "specs:req:r1:expectedEntityVersion": "1", "specs:req:r1:title": "Local wording" }, specs: { ...defaultSpecsUi, pending: request, selected } };
  const saved = finishRequirementWrite(current, request, { versions: { r1: 2 } });
  assert.equal(saved.drafts["specs:req:r1:expectedEntityVersion"], "2", "an acknowledged own write cannot leave its form guarded against the prior version");
  assert.equal(saved.drafts["specs:req:r1:title"], "Local wording");
  assert.equal(saved.specs.selected, selected);
});

test("a saved requirement clears its edit snapshot after the person switches panels", () => {
  const request = { key: "switched", method: "POST" as const, path: "drafts/draft/commands", label: "Save requirement", draft: true as const, body: {
    commandSchemaVersion: 1, command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: "r1", title: "Submitted" },
  } };
  const selected = { kind: "requirement" as const, id: "r2" };
  const current = { ...defaultUi, drafts: { "specs:req:r1:base": "{}", "specs:req:r1:expectedEntityVersion": "1", "specs:req:r1:title": "Submitted" }, specs: { ...defaultSpecsUi, pending: request, selected } };
  const saved = finishRequirementWrite(current, request, { versions: { r1: 2 } });
  assert.deepEqual(saved.drafts, {}, "a completed save cannot leave a stale guard or dirty snapshot behind");
  assert.equal(saved.specs.selected, selected, "acknowledgement preserves the newer selection");
  assert.equal(anyDirty({ project: saved }), false);
});

test("a deleted requirement keeps its selected recovery when unsent link text remains", () => {
  const request = { key: "deleted", method: "POST" as const, path: "drafts/draft/commands", label: "Delete requirement", draft: true as const, body: {
    commandSchemaVersion: 1, command: "DELETE_REQUIREMENT", expectedDocumentRevision: 1, payload: { requirementId: "r1", removeLinkIds: [] },
  } };
  const selected = { kind: "requirement" as const, id: "r1" };
  const current = { ...defaultUi, drafts: { "specs:req:r1:link:new-explanation": "Copy this explanation" }, specs: { ...defaultSpecsUi, staleRequirements: { r1: "draft" }, pending: request, selected } };
  const saved = finishRequirementWrite(current, request, {});
  assert.equal(saved.specs.selected, selected, "the removed-state copy/discard controls must remain reachable");
  assert.equal(saved.drafts["specs:req:r1:link:new-explanation"], "Copy this explanation");
  assert.equal(saved.specs.staleRequirements, undefined, "a matching deleted requirement has no recovery target");
});

test("requirement acknowledgement matches the normalization applied before sending", () => {
  const request = { key: "normalized", method: "POST" as const, path: "drafts/draft/commands", label: "Save requirement", draft: true as const, body: {
    commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: { title: "Submitted", verification: { description: "Check it", responsibleRole: "Reviewer" } },
  } };
  const current = { ...defaultUi, drafts: { "specs:req:new:title": " Submitted ", "specs:req:new:verificationDescription": " Check it ", "specs:req:new:responsibleRole": " Reviewer " }, specs: { ...defaultSpecsUi, pending: request, selected: { kind: "requirement" as const, id: "new" } } };
  const saved = finishRequirementWrite(current, request, { createdIds: ["r1"], versions: { r1: 1 } });
  assert.deepEqual(saved.drafts, {});
  assert.equal(saved.specs.selected, null, "the saved creation closes instead of allowing another create");
  const newer = { ...current, drafts: { ...current.drafts, "specs:req:new:title": "Later title" } };
  assert.equal(finishRequirementWrite(newer, request, { createdIds: ["r1"] }).drafts["specs:req:new:title"], "Later title");
});

const closed = { review: defaultReviewUi, nativeImport: null, acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, rightOpen: false, rightMounted: false, rightTab: "details" as const, specs: { section: "sources" as const, selected: null, sourceScope: "user" as const, pending: null, message: "" }, ai: { instruction: "", action: "PROPOSE_FLOW" as const, selectedRunId: null, pendingRequest: null }, drafts: {}, buffers: {}, endpointBuffers: {}, positionBuffers: {}, outbox: emptyOutbox, request: null, flowId: null, selection: null, view: null };
const node: Saved = { kind: "NODE", id: "n1", version: 1, fields: { label: "Pay", description: "" } };

test("discard preserves an uncertain import's original per-project request; dropping access clears it", () => {
  const record = { actorId: "actor", projectId: "a", draftId: "original-draft", previewId: "preview", createKey: "create", discardKey: "discard", fingerprint: "a".repeat(64), previewHash: "b".repeat(64), attempt: { key: "apply", draftId: "original-draft", previewHash: "b".repeat(64) } };
  const nativeImport = { record, file: null, preview: null, state: "Applying" as const, message: "Unconfirmed" };
  const store = updateUi(updateUi({}, "a", () => ({ nativeImport })), "b", () => ({ flowId: "unrelated" }));
  const discarded = discardDrafts(store, "a");
  assert.equal(uiFor(discarded, "a").nativeImport, nativeImport);
  assert.deepEqual(uiFor(discarded, "a").nativeImport?.record.attempt, record.attempt);
  const dropped = dropProject(discarded, "a");
  assert.equal(uiFor(dropped, "a").nativeImport, null);
  assert.equal(uiFor(dropped, "b").flowId, "unrelated");
});

test("an unknown or absent project reads the closed default", () => {
  assert.deepEqual(uiFor({}, "a"), closed);
  assert.deepEqual(uiFor({}, undefined), defaultUi);
});

test("opening mounts the panel; closing hides it but keeps it mounted", () => {
  const opened = setRightOpen({}, "a", true);
  assert.deepEqual(uiFor(opened, "a"), { ...closed, rightOpen: true, rightMounted: true });
  assert.deepEqual(uiFor(setRightOpen(opened, "a", false), "a"), { ...closed, rightOpen: false, rightMounted: true });
  assert.equal(uiFor(setRightOpen({}, "a", false), "a").rightMounted, false);
});

test("AI prompt and uncertain request stay in per-project memory across panel close and project switches", () => {
  const pendingRequest = { kind: "start" as const, projectId: "a", draftId: "draft-a", key: "same-key", submittedText: "Original", body: { prompt: "Original" } };
  let store = updateUi({}, "a", () => ({ ai: { instruction: "Newer", action: "PROPOSE_FLOW", selectedRunId: null, pendingRequest } }));
  store = setRightTab(store, "a", "ai");
  store = setRightOpen(store, "a", false);
  store = setRightTab(store, "b", "ai");
  assert.equal(uiFor(store, "a").ai.instruction, "Newer");
  assert.equal(uiFor(store, "a").ai.pendingRequest, pendingRequest);
  assert.notEqual(uiFor(store, "b").ai.pendingRequest, pendingRequest);
});

for (const kind of ["start", "apply", "cancel", "discard"] as const) {
  test(`pending AI ${kind} alone protects unload across retained projects without becoming a draft edit`, () => {
    const body = Object.freeze({ draftId: "draft-a", expectedDocumentRevision: 3, selectedOperationIds: ["step"] });
    const pendingRequest: AiRequest = Object.freeze({ kind, projectId: "a", draftId: "draft-a", key: "original-key", body, submittedText: "Original", runId: "run-a" });
    let store = updateUi({}, "a", () => ({ ai: { instruction: "Newer instruction", action: "PROPOSE_FLOW", selectedRunId: "run-a", pendingRequest } }));
    assert.equal(dirtyCount(store, "a"), 0, "a receipt is not an unsaved draft edit");
    assert.equal(anyDirty(store), true, "an uncertain AI receipt must protect unload even with a clean Studio");
    store = setRightOpen(setRightTab(store, "a", "ai"), "a", false);
    store = setRightTab(store, "b", "ai");
    store = discardDrafts(setDraft(store, "a", "name", "Local edit"), "a");
    assert.equal(dirtyCount(store, "a"), 0);
    assert.equal(dirtyCount(store, "b"), 0);
    assert.equal(uiFor(store, "a").ai.pendingRequest, pendingRequest);
    assert.equal(uiFor(store, "a").ai.pendingRequest?.body, body);
    assert.equal(uiFor(store, "a").ai.pendingRequest?.key, "original-key");
    assert.equal(uiFor(store, "a").ai.instruction, "Newer instruction");
    assert.equal(anyDirty(store), true, "closing the panel and opening another project retain unload protection");
    const acknowledged = updateUi(store, "a", (ui) => ({ ai: { ...ui.ai, pendingRequest: null } }));
    assert.equal(anyDirty(acknowledged), false, "acknowledging the only pending receipt clears unload protection");
    const otherDirty = setDraft(acknowledged, "b", "name", "Still local");
    assert.equal(anyDirty(otherDirty), true, "ordinary unsaved edits still protect unload");
    assert.equal(dirtyCount(otherDirty, "b"), 1);
    assert.equal(anyDirty(dropProject(store, "a")), false, "dropping that project removes its pending state");
  });
}

test("an unconfirmed source write protects unload until it is resolved and survives closing the panel", () => {
  const pending = { key: "k1", method: "POST" as const, path: "sources", body: { title: "Brief", text: "Text" }, label: "Add source" };
  let store = updateUi({}, "a", () => ({ specs: { ...defaultSpecsUi, pending } }));
  assert.equal(dirtyCount(store, "a"), 0, "a pending write is not an unsaved field");
  assert.equal(anyDirty(store), true);
  store = setRightOpen(setRightTab(store, "a", "details"), "a", false);
  assert.equal(uiFor(store, "a").specs.pending, pending, "leaving the Specs tab keeps the exact key and body");
  assert.equal(anyDirty(store), true);
  store = updateUi(store, "a", (ui) => ({ specs: { ...ui.specs, pending: null } }));
  assert.equal(anyDirty(store), false);
});

test("one unresolved Specs request at a time, settled only by its own key", () => {
  const first = { key: "a".repeat(16), method: "POST" as const, path: "sources", body: { title: "Brief", text: "x" }, label: "Add source" };
  const second = { ...first, key: "b".repeat(16) };
  const started = startSpecsRequest(defaultSpecsUi, first)!;
  assert.equal(startSpecsRequest(started, second), null, "a second save cannot replace an unresolved one");
  const uncertain = settleSpecsRequest(started, first.key, "uncertain", "We couldn’t confirm it.");
  assert.deepEqual(uncertain.pending, first, "an unconfirmed request keeps its exact key and body");
  assert.equal(settleSpecsRequest(uncertain, second.key, "saved", "late").pending, first, "another key's late result changes nothing");
  assert.equal(settleSpecsRequest(uncertain, first.key, "saved", "Saved.").pending, null);
  assert.equal(anyDirty(updateUi({}, "p1", () => ({ specs: uncertain }))), true, "reload protection covers it");
});

test("stale requirement recovery remains scoped across unrelated Specs requests", () => {
  const requirement = { key: "a".repeat(16), method: "POST" as const, path: "drafts/draft-a/commands", body: { command: "UPDATE_REQUIREMENT", payload: { requirementId: "requirement-a" } }, label: "Save requirement", draft: true as const };
  const started = startSpecsRequest(defaultSpecsUi, requirement)!;
  assert.equal(settleSpecsRequest(started, "b".repeat(16), "refused", "Stale", "STALE_ENTITY_VERSION"), started, "another key cannot mark a stale target");
  assert.equal(settleSpecsRequest(started, requirement.key, "uncertain", "Unconfirmed", "STALE_ENTITY_VERSION").staleRequirements, undefined, "an uncertain result is not a stale conflict");
  for (const request of [
    { ...requirement, path: "sources/source-a/versions", body: { title: "Source" }, draft: undefined },
    { ...requirement, body: { command: "UPDATE_TRACE_LINK", payload: { linkId: "link-a" } } },
  ]) assert.equal(settleSpecsRequest(startSpecsRequest(defaultSpecsUi, request)!, request.key, "refused", "Stale", "STALE_ENTITY_VERSION").staleRequirements, undefined, "only requirement updates can set recovery");
  const stale = settleSpecsRequest(started, requirement.key, "refused", "Stale", "STALE_ENTITY_VERSION");
  assert.deepEqual(stale.staleRequirements, { "requirement-a": "draft-a" });
  const source = { key: "c".repeat(16), method: "POST" as const, path: "sources", body: { title: "Source", text: "Evidence" }, label: "Add source" };
  const savedSource = settleSpecsRequest(startSpecsRequest(stale, source)!, source.key, "saved", "Saved.");
  assert.deepEqual(savedSource.staleRequirements, { "requirement-a": "draft-a" }, "unrelated source saves retain requirement recovery");
  const other = { ...requirement, key: "d".repeat(16), path: "drafts/draft-b/commands", body: { command: "UPDATE_REQUIREMENT", payload: { requirementId: "requirement-b" } } };
  const bothStale = settleSpecsRequest(startSpecsRequest(savedSource, other)!, other.key, "refused", "Stale", "STALE_ENTITY_VERSION");
  assert.deepEqual(bothStale.staleRequirements, { "requirement-a": "draft-a", "requirement-b": "draft-b" }, "independent conflicts coexist");
  const discarded = uiFor(discardDrafts(updateUi({}, "p1", () => ({ specs: { ...bothStale, pending: source } })), "p1"), "p1").specs;
  assert.equal(discarded.pending, source, "discard retains an in-flight receipt");
  assert.equal(discarded.staleRequirements, undefined, "discard explicitly clears recovery controls");
});

test("an acknowledged requirement receipt keeps its exact recovery request until a covering read finishes it", () => {
  const request = { key: "a".repeat(16), method: "POST" as const, path: "drafts/d/commands", body: { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 7 }, label: "Save requirement", draft: true as const };
  const started = startSpecsRequest(defaultSpecsUi, request)!;
  const acknowledged = settleSpecsRequest(started, request.key, "acknowledged", "Save requirement was acknowledged. Refresh saved changes to finish.");
  assert.deepEqual(acknowledged.pending, { ...request, acknowledged: true }, "the acknowledged receipt remains recoverable by its exact key and body");
  assert.equal(anyDirty(updateUi({}, "p1", () => ({ specs: acknowledged }))), true, "an uncovered acknowledgement still protects unload");
  assert.equal(startSpecsRequest(acknowledged, { ...request, key: "b".repeat(16) }), null, "a later write cannot replace the acknowledged receipt");
  const interrupted = settleSpecsRequest(acknowledged, request.key, "uncertain", "We could not confirm this save.");
  assert.deepEqual(interrupted.pending, acknowledged.pending);
  assert.equal(interrupted.message, acknowledged.message, "a refresh failure cannot unconfirm a known committed receipt");
  const finished = settleSpecsRequest(interrupted, request.key, "saved", "Save requirement: saved.");
  assert.equal(finished.pending, null);
});

test("a draft write holds the reservation through save-first, then records its exact body", () => {
  const reserved = { key: "d".repeat(16), method: "POST" as const, path: "drafts/d/commands", body: null, label: "Save requirement", draft: true as const };
  const preparing = startSpecsRequest(defaultSpecsUi, reserved)!;
  const source = { key: "e".repeat(16), method: "POST" as const, path: "sources", body: { title: "B", text: "x" }, label: "Add source" };
  assert.equal(startSpecsRequest(preparing, source), null, "a source write started after a panel remount cannot take the reservation");
  const body = { commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: 7 };
  assert.equal(fillSpecsRequest(preparing, source.key, body), preparing, "only the owner fills it");
  const sent = fillSpecsRequest(preparing, reserved.key, body);
  assert.deepEqual(sent.pending, { ...reserved, body });
  assert.equal(anyDirty(updateUi({}, "p1", () => ({ specs: preparing }))), true);
});

test("Specs keeps its section and a frozen draft request across remounts", () => {
  const request = { key: "c".repeat(16), method: "POST" as const, path: "drafts/d/commands", body: { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 4 }, label: "Save requirement", draft: true as const };
  const started = startSpecsRequest({ ...defaultSpecsUi, section: "scope" }, request)!;
  const store = updateUi({}, "p1", () => ({ specs: settleSpecsRequest(started, request.key, "uncertain", "We couldn’t confirm it.") }));
  assert.deepEqual(uiFor(store, "p1").specs.pending, request, "a retry resends the guard the request was first sent with");
  assert.equal(uiFor(store, "p1").specs.section, "scope");
  assert.equal(defaultSpecsUi.section, "sources");
});

test("drafts belong to one project, and undefined clears a draft", () => {
  let store = setDraft({}, "a", "name", "New name");
  store = setDraft(store, "b", "approver", "p1");
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(dirtyCount(store, "b"), 1);
  assert.equal(dirtyCount(store, undefined), 0);
  store = setDraft(store, "a", "name", undefined);
  assert.equal(dirtyCount(store, "a"), 0);
  assert.equal(anyDirty(store), true);
});

test("Studio buffers count their dirty fields", () => {
  let store = updateUi({}, "a", (ui) => ({ buffers: edit(edit(ui.buffers, node, "label", "Pay now"), node, "description", "Card") }));
  assert.equal(dirtyCount(store, "a"), 2);
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Pay") }));
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "description", "") }));
  assert.equal(dirtyCount(store, "a"), 0, "typing back the saved values is clean again");
  assert.equal(anyDirty(store), false);
});

test("typed positions count for leave guards and explicit discard clears them", () => {
  const position: Saved = { kind: "NODE", id: "n1", version: 4, fields: { x: "10", y: "20" } };
  const store = updateUi({}, "a", (ui) => ({ ...ui, positionBuffers: edit({}, position, "x", "30") }));
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(anyDirty(store), true);
  const discarded = discardDrafts(store, "a");
  assert.equal(anyDirty(discarded), false);
});

test("updateUi merges a change computed from the current state", () => {
  const store = updateUi(updateUi({}, "a", () => ({ flowId: "f1" })), "a", (ui) => ({ selection: { kind: "FLOW", id: ui.flowId! } }));
  assert.deepEqual(uiFor(store, "a").selection, { kind: "FLOW", id: "f1" });
  assert.equal(uiFor(store, "a").flowId, "f1");
});

test("discard clears only that project's drafts and buffers and keeps its panel; drop forgets the project", () => {
  let store = setRightOpen(setDraft({}, "a", "name", "x"), "a", true);
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Typed") }));
  store = setDraft(store, "b", "name", "y");
  const discarded = discardDrafts(store, "a");
  assert.equal(dirtyCount(discarded, "a"), 0);
  assert.deepEqual(uiFor(discarded, "a").buffers, {});
  assert.equal(uiFor(discarded, "a").rightOpen, true);
  assert.equal(dirtyCount(discarded, "b"), 1);
  assert.deepEqual(uiFor(dropProject(store, "a"), "a"), defaultUi);
  assert.equal(anyDirty(dropProject(dropProject(store, "a"), "b")), false);
  assert.deepEqual(defaultUi, closed, "the shared default is never mutated");
});

test("endpoint choices count as unsaved and discard clears only their project", () => {
  const saved: Saved = { kind: "EDGE", id: "e1", version: 1, fields: { fromId: "a", toId: "b" } };
  let store = updateUi({}, "a", () => ({ endpointBuffers: edit({}, saved, "toId", "c") }));
  store = updateUi(store, "b", () => ({ endpointBuffers: edit({}, saved, "toId", "d") }));
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(anyDirty(store), true);
  const discarded = discardDrafts(store, "a");
  assert.equal(dirtyCount(discarded, "a"), 0);
  assert.deepEqual(uiFor(discarded, "a").endpointBuffers, {});
  assert.equal(dirtyCount(discarded, "b"), 1);
});

test("reads must cover both acknowledged revision floors and clear only the qualifying draft", () => {
  let floors = requireDraftRevision({}, { draftId: "d1", documentRevision: 5, layoutRevision: 7 });
  floors = requireDraftRevision(floors, { draftId: "d1", documentRevision: 4, layoutRevision: 6 });
  floors = requireDraftRevision(floors, { draftId: "d2", documentRevision: 3, layoutRevision: 2 });
  assert.deepEqual(floors.d1, { documentRevision: 5, layoutRevision: 7 }, "replayed older receipts never lower either floor");
  const ui = { ...defaultUi, acknowledgedRevisions: floors, refreshFailed: true };
  for (const view of [{ id: "d1", documentRevision: 4, layoutRevision: 7 }, { id: "d1", documentRevision: 5, layoutRevision: 6 }]) {
    assert.deepEqual(afterDraftRead(ui, view), { acknowledgedRevisions: floors, refreshFailed: true });
  }
  const read = afterDraftRead(ui, { id: "d1", documentRevision: 5, layoutRevision: 7 });
  assert.equal(read.refreshFailed, false);
  assert.deepEqual(read.acknowledgedRevisions, { d2: floors.d2 });
  assert.deepEqual(ui.acknowledgedRevisions, floors, "the original per-project state is immutable");
});

test("a replayed Apply receipt pins its original draft without raising the replacement draft floor", () => {
  const floors = {
    oldDraft: { documentRevision: 4, layoutRevision: 2 },
    currentDraft: { documentRevision: 8, layoutRevision: 5 },
  };
  const receipt = { draftId: "oldDraft", documentRevision: 9, layoutRevision: 7 };
  const ack = acknowledgeExternalWrite("currentDraft", floors, receipt);
  assert.equal(ack.currentDraft, false);
  assert.deepEqual(ack.currentFloor, floors.currentDraft);
  assert.deepEqual(ack.acknowledgedRevisions, {
    oldDraft: { documentRevision: 9, layoutRevision: 7 },
    currentDraft: floors.currentDraft,
  });
});

test("one admission predicate: a read must be current, not older than the adopted draft, and cover the floor", () => {
  const draft = (documentRevision: number, layoutRevision: number, draftId = "d1") => ({ id: draftId, documentRevision, layoutRevision }) as DraftView;
  const ui = { ...defaultUi, acknowledgedRevisions: requireDraftRevision({}, { draftId: "d1", documentRevision: 6, layoutRevision: 3 }) };
  const adopted = draft(5, 3);
  assert.equal(admits(ui, adopted, draft(5, 3)), false, "below the document floor");
  assert.equal(admits(ui, adopted, draft(6, 2)), false, "below the layout floor");
  assert.equal(admits(ui, adopted, draft(6, 3)), true);
  assert.equal(admits(ui, adopted, draft(7, 3, "d2")), false, "another draft is never admitted");
  assert.equal(admits(ui, draft(8, 3), draft(6, 3)), false, "older than the adopted draft");
  assert.equal(admits(defaultUi, adopted, draft(5, 3)), true, "no floor: any not-older read");
  assert.equal(covers(draft(5, 3), undefined), true);
  // Only an admitted read clears the floor.
  assert.deepEqual(afterDraftRead(ui, draft(6, 3)).acknowledgedRevisions, {});
});

test("Apply my changes again waits for a readable saved draft that covers the acknowledged floor", () => {
  const draft = (documentRevision: number) => ({ id: "d1", documentRevision, layoutRevision: 3 }) as DraftView;
  const ui = { ...defaultUi, acknowledgedRevisions: requireDraftRevision({}, { draftId: "d1", documentRevision: 6, layoutRevision: 3 }) };
  assert.equal(canApplyAgain(ui, draft(5)), false, "shown saved draft is below the floor: rebasing would hide the acknowledged edit");
  assert.equal(canApplyAgain(ui, draft(6)), true);
  assert.equal(canApplyAgain({ ...ui, refreshFailed: true }, draft(6)), false, "a failed read keeps conflict actions disabled");
  assert.equal(canApplyAgain(defaultUi, draft(5)), true);
});

const deleteEdge = { commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: 3, payload: { edgeId: "e1" } } as const;
const batch: Changes = { commands: [{ command: deleteEdge, proposedIds: [] }], moves: [] };
const withSave = (state: "waiting" | "sending" | "uncertain" | "refused"): Outbox => ({
  ...emptyOutbox, entries: [{ kind: "drop", flowId: "f", items: [{ nodeId: "n1", x: 1, y: 2 }] }], sending: { draftId: "d1", key: "receipt-1", batches: [batch], state },
});

test("unsaved changes guard navigation; discard drops them and a refused save, never one that may have committed", () => {
  const failed = { state: "failed", message: "Your changes weren’t saved." } as const;
  for (const state of ["waiting", "refused"] as const) {
    const store = updateUi({}, "a", () => ({ outbox: withSave(state), save: failed }));
    assert.equal(dirtyCount(store, "a"), 2);
    assert.equal(anyDirty(store), true);
    const discarded = uiFor(discardDrafts(store, "a"), "a");
    assert.deepEqual([discarded.outbox, discarded.save], [emptyOutbox, { state: "idle", message: "" }]);
  }
  for (const state of ["sending", "uncertain"] as const) {
    const store = setDraft(updateUi({}, "a", () => ({ outbox: withSave(state), save: failed })), "a", "name", "Local text");
    const discarded = uiFor(discardDrafts(store, "a"), "a");
    assert.deepEqual(discarded.drafts, {});
    assert.deepEqual(discarded.outbox.entries, [], "local changes behind it go");
    assert.equal(discarded.outbox.sending?.key, "receipt-1", "the batch stays retryable with its key");
    assert.deepEqual(discarded.save, failed);
    assert.equal(dirtyCount(discardDrafts(store, "a"), "a"), 1);
  }
});

test("pending Apply and control recovery identity beats a conflicting deep link and latest run", async () => {
  const choose = currentAiRun;
  for (const kind of ["apply", "cancel", "discard"] as const) {
    const pendingRequest = {kind,projectId:"a",draftId:"draft",runId:"recover",key:"exact-key",body:Object.freeze({selectedOperationIds:["step"]})};
    const ai = {...defaultUi.ai,selectedRunId:"old",pendingRequest};
    assert.equal(choose?.(ai,"conflicting","latest"),"recover"); assert.equal(ai.pendingRequest,pendingRequest);
  }
});

test("acknowledged Apply phase survives retained store and clears only a covering saved read", async () => {
  const covered=acknowledgedApplyCovered;
  const phase={key:'exact',projectId:'a',state:'acknowledged' as const,runId:'run',draftId:'draft',documentRevision:9,layoutRevision:7};
  let store=updateUi({},'a',ui=>({ai:{...ui.ai,applyPhase:phase}}));store=setRightTab(setRightTab(store,'a','details'),'b','ai');
  assert.equal(uiFor(store,'a').ai.applyPhase,phase);
  assert.equal(covered?.(phase,{id:'draft',documentRevision:9,layoutRevision:7}),true);
  for(const saved of [{id:'draft',documentRevision:8,layoutRevision:7},{id:'draft',documentRevision:9,layoutRevision:6},{id:'replacement',documentRevision:20,layoutRevision:20}])assert.equal(covered?.(phase,saved),false);
});

test("only an exact Apply receipt establishes retained acknowledgement", () => {
  const body=Object.freeze({draftId:'draft',expectedDocumentRevision:5,selectedOperationIds:['step']});
  const pending:AiRequest={kind:'apply',projectId:'a',draftId:'draft',runId:'run',key:'exact',body};
  const ai={...defaultUi.ai,pendingRequest:pending};
  const receipt={applicationId:'application',runId:'run',draftId:'draft',documentRevision:6,layoutRevision:3,eventSequence:1,aiRevision:1,replayed:false};
  const retained=retainAiApply(ai,pending,receipt);
  assert.deepEqual(retained.applyPhase,{key:'exact',projectId:'a',runId:'run',draftId:'draft',state:'acknowledged',documentRevision:6,layoutRevision:3});
  assert.equal(retained.pendingRequest,pending);assert.equal(retained.pendingRequest?.body,body);
  assert.equal(retainAiApply(ai,pending,{...receipt,runId:'other'}),ai);
  assert.equal(retainAiApply(ai,pending,{...receipt,draftId:'other'}),ai);
  for(const changed of [{...pending,key:'other'},{...pending,projectId:'other'},{...pending,runId:'other'},{...pending,draftId:'other'}]) assert.equal(retainAiApply({...ai,pendingRequest:changed},pending,receipt).applyPhase,undefined);
  assert.equal(retainAiApply(ai,pending,{...receipt,adopted:true}).pendingRequest,null);
});

test("only an eligible matching missing Current selection clears", () => {
  const eligible = { ...defaultUi.ai, selectedRunId: "gone" };
  const live = { id: "gone", isLive: () => true };
  assert.equal(recoverUnavailableCurrentRun(eligible, live).selectedRunId, null);
  const replacement = { ...eligible, selectedRunId: "newer" };
  assert.equal(recoverUnavailableCurrentRun(replacement, live), replacement, "a stale 404 cannot clear a replacement");
  assert.equal(recoverUnavailableCurrentRun(eligible, { id: "gone", isLive: () => false }), eligible, "the functional write rechecks the reader ticket");
  for (const kind of ["start", "apply", "cancel", "discard"] as const) {
    const body = Object.freeze({ expectedDocumentRevision: 3 });
    const pending = { kind, projectId: "a", draftId: "draft", runId: "gone", key: "exact", submittedText: "Original", body } as AiRequest;
    const current = { ...eligible, pendingRequest: pending };
    assert.equal(recoverUnavailableCurrentRun(current, live), current, `${kind} receipt remains byte-for-byte retryable`);
    for (const state of ["uncertain", "acknowledged"] as const) assert.equal(recoverUnavailableCurrentRun({ ...eligible, applyPhase: { key: "exact", projectId: "a", draftId: "draft", runId: "gone", state } }, live).selectedRunId, "gone");
    assert.equal(body, pending.body);
  }
  const adopted = { key: "exact", projectId: "a", draftId: "draft", runId: "gone", state: "adopted" as const };
  const recovered = recoverUnavailableCurrentRun({ ...eligible, applyPhase: adopted }, live);
  assert.equal(recovered.selectedRunId, null, "a completed adopted receipt does not pin an unavailable selection");
  assert.equal(recovered.applyPhase, adopted, "recovery preserves the exact completed receipt");
});

test("an unrelated newer Save floor cannot acknowledge a pending Apply", () => {
  const pending:AiRequest={kind:'apply',projectId:'a',draftId:'draft',runId:'run',key:'exact',body:{draftId:'draft',expectedDocumentRevision:5}};
  const ai={...defaultUi.ai,pendingRequest:pending};
  const unrelatedFloor={draft:{documentRevision:99,layoutRevision:99}};
  assert.equal(retainAiApply(ai,pending),ai);
  assert.equal(ai.applyPhase,undefined);assert.equal(ai.pendingRequest,pending);
  assert.equal(acknowledgedApplyCovered({key:'exact',projectId:'a',state:'uncertain',runId:'run',draftId:'draft'}, {id:'draft',...unrelatedFloor.draft}),false);
});

test("definitive Apply refusal clears only the matching pending attempt and presentation phase", async () => {
  const finish = finishAiApply;
  const request:AiRequest={kind:'apply',projectId:'a',draftId:'draft',runId:'run',key:'exact',body:Object.freeze({selectedOperationIds:['step']})};
  const phase={key:'exact',projectId:'a',draftId:'draft',runId:'run',state:'uncertain' as const};
  const current={...defaultUi.ai,pendingRequest:request,applyPhase:phase};
  const finished=finish(current,request);assert.equal(finished.pendingRequest,null);assert.equal(finished.applyPhase,undefined);
  for(const field of ['key','projectId','draftId','runId'] as const){
    const pending:AiRequest={...request,[field]:'newer'};const newer:typeof current={...current,pendingRequest:pending};assert.equal(finish(newer,request),newer);
    const otherPhase={...phase,[field]:'newer'};assert.equal(finish({...current,applyPhase:otherPhase},request).applyPhase,otherPhase);
  }
  assert.equal(request.body,current.pendingRequest.body);assert.equal(finish({...current,applyPhase:{...phase,state:'acknowledged'}},request).applyPhase,undefined);
});

test("opening Specs mounts the panel on that tab with empty Specs state", () => {
  const store = setRightTab({}, "p1", "specs");
  assert.equal(uiFor(store, "p1").rightTab, "specs");
  assert.equal(uiFor(store, "p1").rightOpen, true);
  assert.deepEqual(uiFor(store, "p1").specs, defaultSpecsUi);
});

test("review attempts and reason protect navigation and survive tabs and pending discard", () => {
  const request={key:"review",method:"POST" as const,path:"reviews/r/withdraw",body:{reason:"Submitted"},label:"Withdraw candidate",acknowledged:false};
  const store=updateUi({},"a",ui=>({review:{...ui.review,pending:request,reason:"Newer reason"}}));
  assert.equal(anyDirty(store),true);assert.equal(dirtyCount(store,"a"),1);
  const remounted=uiFor(setRightTab(setRightOpen(store,"a",false),"a","review"),"a");assert.equal(remounted.review.pending,request);
  assert.equal(uiFor(discardDrafts(store,"a"),"a").review.reason,"Newer reason");
  assert.deepEqual(uiFor(dropProject(store,"a"),"a").review,defaultReviewUi);
});
