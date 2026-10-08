"use client";

import { useEffect, useRef, useState } from "react";
import { apiRead, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import {
  LIMITS,
  SOURCE_REF_LIMITS,
  type RequirementRecord,
  type SourceRef,
  type TraceLinkRecord,
} from "@/features/drafts/contracts/scope-document";
import {
  citationMatches,
  type SourceVersionView,
} from "@/features/sources/contracts/source-version";
import { useSourceList } from "@/features/sources/ui/sources-view";
import type { SpecsUi } from "@/features/shell/ui/project-ui";
import Dialog from "@/features/shell/ui/dialog";
import { useStudio } from "@/features/studio/ui/studio-context";
import { linkState, requirementPlan } from "../domain/scope";
import { requirementTextError } from "./requirement-text";

type RequirementActionsProps = {
  requirement: RequirementRecord;
  update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void;
  drafts: Record<string, string>;
  setDraft: (key: string, value: string | undefined) => void;
  canEdit: boolean;
  locked: boolean;
  send: (
    label: string,
    build: (
      saved: ReturnType<typeof useStudio>["savedDraft"],
    ) => Record<string, unknown> | null,
  ) => void;
};

export default function RequirementActions({
  requirement,
  update,
  drafts,
  setDraft,
  canEdit,
  locked,
  send,
}: RequirementActionsProps) {
  const { projectId, savedDraft } = useStudio();
  const { status } = useSync();
  const sourceList = useSourceList(projectId, "user", status.sourcesRevision);
  const sources = sourceList.page?.items ?? [];
  const cite = `specs:req:${requirement.id}:cite:`;
  const link = `specs:req:${requirement.id}:link:`;
  const get = (key: string) => drafts[key] ?? "";
  const set = (key: string, value: string) => setDraft(key, value || undefined);
  const [source, setSource] = useState<SourceVersionView | null>(null);
  const [sourceError, setSourceError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [citationViews, setCitationViews] = useState<
    Record<string, SourceVersionView>
  >({});
  const [citationErrors, setCitationErrors] = useState<Record<string, string>>(
    {},
  );
  const [citationAttempt, setCitationAttempt] = useState(0);
  const citationCache = useRef<Record<string, SourceVersionView>>({});
  const sourceVersionId = get(`${cite}source`);
  const start = get(`${cite}start`);
  const end = get(`${cite}end`);
  const excerpt = get(`${cite}excerpt`);
  const first = Number(start);
  const last = Number(end);
  const validLines =
    Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    first >= 1 &&
    last >= first &&
    source?.id === sourceVersionId &&
    last <= source.lineStarts.length;
  const lineError = Boolean(
    start.trim() && end.trim() && source?.id === sourceVersionId && !validLines,
  );
  const citation =
    source && validLines
      ? { sourceVersionId: source.id, startLine: first, endLine: last, excerpt }
      : null;
  const citationError =
    !citation || !source || !excerpt
      ? ""
      : requirementTextError(
          excerpt,
          SOURCE_REF_LIMITS.excerpt,
          "Excerpt",
          true,
        ) ||
        (!citationMatches(source.text, citation)
          ? "Excerpt must be text from the selected lines."
          : "") ||
        (requirement.sourceRefs.some(
          (ref) =>
            ref.sourceVersionId === citation.sourceVersionId &&
            ref.startLine === citation.startLine &&
            ref.endLine === citation.endLine &&
            ref.excerpt === citation.excerpt,
        )
          ? "This exact citation is already added."
          : "") ||
        (requirement.sourceRefs.length >= SOURCE_REF_LIMITS.count
          ? `A requirement can have at most ${SOURCE_REF_LIMITS.count} citations.`
          : "");
  const citationVersionIds = [
    ...new Set(requirement.sourceRefs.map((ref) => ref.sourceVersionId)),
  ].sort();
  const citationVersionKey = citationVersionIds.join(",");
  useEffect(() => {
    if (!sourceVersionId) return;
    const controller = new AbortController();
    void apiRead<SourceVersionView>(
      `/api/projects/${projectId}/source-versions/${sourceVersionId}`,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted || sessionEnded(result)) return;
      if (result.ok) {
        setSource(result.data);
        setSourceError(null);
      } else setSourceError({ id: sourceVersionId, message: result.message });
    });
    return () => controller.abort();
  }, [projectId, sourceVersionId, sourceAttempt]);
  useEffect(() => {
    if (!citationVersionKey) return;
    const controller = new AbortController();
    for (const sourceVersionId of citationVersionKey.split(","))
      if (!citationCache.current[sourceVersionId])
        void apiRead<SourceVersionView>(
          `/api/projects/${projectId}/source-versions/${sourceVersionId}`,
          controller.signal,
        ).then((result) => {
          if (controller.signal.aborted || sessionEnded(result)) return;
          if (result.ok) {
            if (citationCache.current[result.data.id]) return;
            citationCache.current = {
              ...citationCache.current,
              [result.data.id]: result.data,
            };
            setCitationViews((current) =>
              current[result.data.id]
                ? current
                : { ...current, [result.data.id]: result.data },
            );
          } else
            setCitationErrors((current) => ({
              ...current,
              [sourceVersionId]: result.message,
            }));
        });
    return () => controller.abort();
  }, [citationAttempt, citationVersionKey, projectId]);
  useEffect(() => {
    if (!source || !validLines || excerpt) return;
    setDraft(
      `${cite}excerpt`,
      Array.from(
        source.text
          .split("\n")
          .slice(first - 1, last)
          .join("\n"),
      )
        .slice(0, SOURCE_REF_LIMITS.excerpt)
        .join(""),
    );
  }, [cite, excerpt, first, last, setDraft, source, validLines]);
  const selectedSource = source?.id === sourceVersionId ? source : null;
  const sourceFor = (ref: SourceRef) =>
    sources.find((item) => item.currentVersionId === ref.sourceVersionId);
  const links = Object.values(savedDraft.document.traceLinks).filter(
    (entry) => entry.requirementId === requirement.id,
  );
  const removedLinkEdits = Object.keys(drafts).filter(
    (key) =>
      key.startsWith(link) &&
      key.endsWith(":explanation") &&
      !savedDraft.document.traceLinks[
        key.slice(link.length, -":explanation".length)
      ],
  );
  const nodes = Object.values(savedDraft.document.nodes);
  const flows = savedDraft.document.flows;
  const availableNodes = nodes.filter(
    (node) => !links.some((entry) => entry.nodeId === node.id),
  );
  const selectedNodeId = get(`${link}node`);
  const selectedNodeAvailable = availableNodes.some(
    (node) => node.id === selectedNodeId,
  );
  const newExplanation = get(`${link}new-explanation`);
  const newExplanationError = requirementTextError(
    newExplanation,
    LIMITS.longText,
    "Explanation",
  );
  const addCitation = () => {
    if (!citation || !selectedSource || !excerpt.trim() || citationError)
      return;
    send("Add citation", () => ({
      commandSchemaVersion: 1,
      command: "UPDATE_REQUIREMENT",
      expectedEntityVersion: requirement.version,
      payload: {
        requirementId: requirement.id,
        sourceRefs: [...requirement.sourceRefs, citation],
      },
    }));
  };
  const addLink = () => {
    if (!selectedNodeAvailable || newExplanationError) return;
    send("Add link", (saved) => ({
      commandSchemaVersion: 1,
      command: "ADD_TRACE_LINK",
      expectedDocumentRevision: saved.documentRevision,
      payload: {
        requirementId: requirement.id,
        nodeId: selectedNodeId,
        explanation: newExplanation,
      },
    }));
  };
  const linkStatus = (entry: TraceLinkRecord) => {
    const node = savedDraft.document.nodes[entry.nodeId];
    if (!node || linkState(savedDraft.document, entry) === "PROPOSED")
      return "Proposed";
    if (linkState(savedDraft.document, entry) === "CURRENT") return "Reviewed";
    return entry.reviewedRequirementBehaviourVersion !==
      requirement.behaviourVersion
      ? "Needs review: requirement changed"
      : "Needs review: step changed";
  };
  const [deleting, setDeleting] = useState<string[] | null>(null);
  return (
    <>
      <section className="detail-section">
        <h4>Citations</h4>
        <ul className="plain-list">
          {requirement.sourceRefs.map((ref) => {
            const head = sourceFor(ref);
            const view = citationViews[ref.sourceVersionId];
            return (
              <li key={JSON.stringify(ref)}>
                <button
                  type="button"
                  className="text-link"
                  disabled={!head && !view}
                  onClick={() =>
                    update(() => ({
                      section: "sources",
                      selected: {
                        kind: "source",
                        sourceId: head?.id ?? view?.sourceId ?? "",
                        versionId: ref.sourceVersionId,
                        range: {
                          startLine: ref.startLine,
                          endLine: ref.endLine,
                        },
                        back: { kind: "requirement", id: requirement.id },
                      },
                    }))
                  }
                >
                  {head?.title ?? view?.title ?? "Source"} v
                  {head?.currentSequence ?? view?.sequence ?? "?"}, lines{" "}
                  {ref.startLine}-{ref.endLine}
                </button>
                {!view && citationErrors[ref.sourceVersionId] && (
                  <p role="alert">
                    {citationErrors[ref.sourceVersionId]}{" "}
                    <button
                      type="button"
                      className="button small"
                      onClick={() => setCitationAttempt((value) => value + 1)}
                    >
                      Retry citation
                    </button>
                  </p>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="button quiet small"
                    disabled={locked}
                    onClick={() =>
                      send("Remove citation", () => ({
                        commandSchemaVersion: 1,
                        command: "UPDATE_REQUIREMENT",
                        expectedEntityVersion: requirement.version,
                        payload: {
                          requirementId: requirement.id,
                          sourceRefs: requirement.sourceRefs.filter(
                            (item) => item !== ref,
                          ),
                        },
                      }))
                    }
                  >
                    Remove citation
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && sourceList.error && (
          <p role="alert">
            {sourceList.error}{" "}
            <button
              type="button"
              className="button small"
              onClick={sourceList.retry}
            >
              Retry sources
            </button>
          </p>
        )}
        {canEdit && sourceError?.id === sourceVersionId && (
          <p role="alert">
            {sourceError.message}{" "}
            <button
              type="button"
              className="button small"
              onClick={() => setSourceAttempt((value) => value + 1)}
            >
              Retry source text
            </button>
          </p>
        )}
        {canEdit &&
          sourceVersionId &&
          source?.id !== sourceVersionId &&
          sourceError?.id !== sourceVersionId && (
            <p role="status">Loading source text...</p>
          )}
        {canEdit && (
          <>
            <div className="field">
              <label htmlFor="cite-source">Cite source</label>
              <select
                id="cite-source"
                value={sourceVersionId}
                disabled={locked}
                onChange={(event) => {
                  set(`${cite}source`, event.target.value);
                  set(`${cite}start`, "");
                  set(`${cite}end`, "");
                  set(`${cite}excerpt`, "");
                }}
              >
                <option value="">Choose a source</option>
                {sources.map((item) => (
                  <option
                    key={item.currentVersionId}
                    value={item.currentVersionId}
                  >
                    {item.title}
                  </option>
                ))}
                {selectedSource &&
                  !sources.some(
                    (item) => item.currentVersionId === sourceVersionId,
                  ) && (
                    <option value={sourceVersionId}>
                      {selectedSource.title} v{selectedSource.sequence}
                    </option>
                  )}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cite-start">Start line</label>
              <input
                id="cite-start"
                inputMode="numeric"
                aria-invalid={lineError || undefined}
                aria-describedby={
                  lineError ? "citation-lines-error" : undefined
                }
                readOnly={locked}
                value={start}
                onChange={(event) => {
                  set(`${cite}start`, event.target.value);
                  set(`${cite}excerpt`, "");
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="cite-end">End line</label>
              <input
                id="cite-end"
                inputMode="numeric"
                aria-invalid={lineError || undefined}
                aria-describedby={
                  lineError ? "citation-lines-error" : undefined
                }
                readOnly={locked}
                value={end}
                onChange={(event) => {
                  set(`${cite}end`, event.target.value);
                  set(`${cite}excerpt`, "");
                }}
              />
            </div>
            {lineError && (
              <p id="citation-lines-error" role="alert">
                Choose whole line numbers from 1 to {source?.lineStarts.length},
                with the end at or after the start.
              </p>
            )}
            <div className="field">
              <label htmlFor="cite-excerpt">Excerpt</label>
              <textarea
                id="cite-excerpt"
                aria-invalid={Boolean(citationError) || undefined}
                aria-describedby={
                  citationError ? "citation-excerpt-error" : undefined
                }
                readOnly={locked}
                value={excerpt}
                onChange={(event) => set(`${cite}excerpt`, event.target.value)}
              />
              {citationError && (
                <p id="citation-excerpt-error" role="alert">
                  {citationError}
                </p>
              )}
            </div>
            <button
              type="button"
              className="button small"
              disabled={
                locked ||
                !selectedSource ||
                !citation ||
                !excerpt.trim() ||
                Boolean(citationError)
              }
              onClick={addCitation}
            >
              Add citation
            </button>
          </>
        )}
      </section>
      <section className="detail-section">
        <h4>Links</h4>
        <ul className="plain-list">
          {links.map((entry) => {
            const node = savedDraft.document.nodes[entry.nodeId];
            const flow = node && flows[node.flowId];
            const explanationKey = `${link}${entry.id}:explanation`;
            const versionKey = `${link}${entry.id}:version`;
            const explanation = drafts[explanationKey] ?? entry.explanation;
            const explanationError = requirementTextError(
              explanation,
              LIMITS.longText,
              "Explanation",
            );
            const version = Number(drafts[versionKey] ?? entry.version);
            const conflicted =
              drafts[versionKey] !== undefined && version !== entry.version;
            return (
              <li key={entry.id}>
                <strong>
                  {flow?.title ?? "Flow"} / {node?.label ?? "Removed step"}
                </strong>{" "}
                <span className="specs-badge">{linkStatus(entry)}</span>
                {!canEdit && explanation && <p>{explanation}</p>}
                {canEdit && node && (
                  <>
                    <div className="field">
                      <label htmlFor={`link-${entry.id}`}>Explanation</label>
                      <input
                        id={`link-${entry.id}`}
                        aria-invalid={Boolean(explanationError) || undefined}
                        aria-describedby={
                          explanationError
                            ? `link-${entry.id}-error`
                            : undefined
                        }
                        readOnly={locked}
                        value={explanation}
                        onChange={(event) => {
                          if (event.target.value === entry.explanation) {
                            setDraft(explanationKey, undefined);
                            setDraft(versionKey, undefined);
                          } else {
                            if (!drafts[versionKey])
                              setDraft(versionKey, String(entry.version));
                            setDraft(explanationKey, event.target.value);
                          }
                        }}
                      />
                      {explanationError && (
                        <p id={`link-${entry.id}-error`} role="alert">
                          {explanationError}
                        </p>
                      )}
                    </div>
                    {conflicted && (
                      <section className="inline-note" role="alert">
                        <p>
                          This link changed. Your explanation is kept; review
                          the saved explanation before saving again.
                        </p>
                        <div className="field">
                          <label htmlFor={`saved-link-${entry.id}`}>
                            Current saved explanation
                          </label>
                          <textarea
                            id={`saved-link-${entry.id}`}
                            rows={3}
                            readOnly
                            value={entry.explanation}
                          />
                        </div>
                        <div className="view-actions">
                          <button
                            type="button"
                            className="button small"
                            disabled={locked}
                            onClick={() =>
                              setDraft(versionKey, String(entry.version))
                            }
                          >
                            Use my explanation on latest version
                          </button>
                          <button
                            type="button"
                            className="button quiet small"
                            disabled={locked}
                            onClick={() => {
                              setDraft(explanationKey, undefined);
                              setDraft(versionKey, undefined);
                            }}
                          >
                            Use saved explanation
                          </button>
                        </div>
                      </section>
                    )}
                    {explanation !== entry.explanation && (
                      <p className="muted">
                        Save explanation before confirming.
                      </p>
                    )}
                    <div className="view-actions">
                      <button
                        type="button"
                        className="button small"
                        disabled={
                          locked ||
                          conflicted ||
                          explanation !== entry.explanation ||
                          linkStatus(entry) === "Reviewed"
                        }
                        onClick={() =>
                          send("Confirm link", () => ({
                            commandSchemaVersion: 1,
                            command: "CONFIRM_TRACE_LINK",
                            expectedEntityVersion: version,
                            payload: {
                              linkId: entry.id,
                              expectedRequirementBehaviourVersion:
                                requirement.behaviourVersion,
                              expectedNodeBehaviourVersion:
                                node.behaviourVersion,
                            },
                          }))
                        }
                      >
                        Confirm link
                      </button>
                      <button
                        type="button"
                        className="button small"
                        disabled={
                          locked || conflicted || Boolean(explanationError)
                        }
                        onClick={() =>
                          send("Edit explanation", () => ({
                            commandSchemaVersion: 1,
                            command: "UPDATE_TRACE_LINK",
                            expectedEntityVersion: version,
                            payload: { linkId: entry.id, explanation },
                          }))
                        }
                      >
                        Edit explanation
                      </button>
                      <button
                        type="button"
                        className="button quiet small"
                        disabled={locked}
                        onClick={() =>
                          send("Remove link", (saved) => ({
                            commandSchemaVersion: 1,
                            command: "DELETE_TRACE_LINK",
                            expectedDocumentRevision: saved.documentRevision,
                            payload: { linkId: entry.id },
                          }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {removedLinkEdits.map((key) => (
          <section className="inline-note" key={key}>
            <p>This link was removed. Your explanation is kept for copying.</p>
            <div className="field">
              <label htmlFor={`removed-${key}`}>
                Retained explanation for removed link
              </label>
              <textarea
                id={`removed-${key}`}
                rows={3}
                readOnly
                value={drafts[key]}
              />
            </div>
            <button
              type="button"
              className="button quiet small"
              disabled={locked}
              onClick={() => {
                setDraft(key, undefined);
                setDraft(key.replace(":explanation", ":version"), undefined);
              }}
            >
              Discard removed link edits
            </button>
          </section>
        ))}
        {canEdit && (
          <>
            <div className="field">
              <label htmlFor="link-step">Link to step</label>
              <select
                id="link-step"
                value={selectedNodeId}
                disabled={locked}
                onChange={(event) => set(`${link}node`, event.target.value)}
              >
                <option value="">Choose a step</option>
                {availableNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {flows[node.flowId]?.title ?? "Flow"} / {node.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="link-explanation">Explanation</label>
              <input
                id="link-explanation"
                aria-invalid={Boolean(newExplanationError) || undefined}
                aria-describedby={
                  newExplanationError ? "link-new-error" : undefined
                }
                readOnly={locked}
                value={newExplanation}
                onChange={(event) =>
                  set(`${link}new-explanation`, event.target.value)
                }
              />
              {newExplanationError && (
                <p id="link-new-error" role="alert">
                  {newExplanationError}
                </p>
              )}
            </div>
            <button
              type="button"
              className="button small"
              disabled={
                locked || !selectedNodeAvailable || Boolean(newExplanationError)
              }
              onClick={addLink}
            >
              Add link
            </button>
          </>
        )}
      </section>
      {canEdit && (
        <button
          type="button"
          className="button danger"
          disabled={locked}
          onClick={() =>
            setDeleting(
              requirementPlan(savedDraft.document, requirement.id).traceLinkIds,
            )
          }
        >
          Delete requirement
        </button>
      )}
      {deleting && (
        <Dialog
          title={`Delete ${requirement.displayId}?`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button
                type="button"
                className="button quiet"
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button danger"
                disabled={locked}
                onClick={() =>
                  send("Delete requirement", (saved) => {
                    const current = requirementPlan(
                      saved.document,
                      requirement.id,
                    ).traceLinkIds;
                    if (JSON.stringify(current) !== JSON.stringify(deleting)) {
                      setDeleting(current);
                      return null;
                    }
                    return {
                      commandSchemaVersion: 1,
                      command: "DELETE_REQUIREMENT",
                      expectedDocumentRevision: saved.documentRevision,
                      payload: {
                        requirementId: requirement.id,
                        removeLinkIds: deleting,
                      },
                    };
                  })
                }
              >
                Delete requirement
              </button>
            </>
          }
        >
          <p>
            Also removes {deleting.length} requirement{" "}
            {deleting.length === 1 ? "link" : "links"}.
          </p>
        </Dialog>
      )}
    </>
  );
}
