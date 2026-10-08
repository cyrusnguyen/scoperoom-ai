"use client";

import { useSync } from "@/features/collaboration/ui/sync-context";
import {
  LIMITS,
  type RequirementCategory,
  type RequirementRecord,
} from "@/features/drafts/contracts/scope-document";
import type { SpecsUi } from "@/features/shell/ui/project-ui";
import { useStudio } from "@/features/studio/ui/studio-context";
import { confirmationCurrent } from "../domain/scope";
import { requirementTextError } from "./requirement-text";
import type { useSpecsWrite } from "./use-specs-write";
import RequirementActions from "./requirement-actions";

type Props = {
  requirement: RequirementRecord | null;
  ui: SpecsUi;
  update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void;
  drafts: Record<string, string>;
  setDraft: (key: string, value: string | undefined) => void;
  write: ReturnType<typeof useSpecsWrite>;
  onClose: () => void;
};
type Values = {
  title: string;
  statement: string;
  category: RequirementCategory;
  inclusion: RequirementRecord["inclusion"];
  ownerId: string;
  verificationDescription: string;
  responsibleRole: string;
};
const categories: Array<[RequirementCategory, string]> = [
  ["FUNCTIONAL", "Functional"],
  ["NON_FUNCTIONAL", "Non-functional"],
  ["CONSTRAINT", "Constraint"],
];
const inclusions: Array<[RequirementRecord["inclusion"], string]> = [
  ["INCLUDED", "Included"],
  ["UNDECIDED", "Undecided"],
  ["EXCLUDED", "Excluded"],
];
const valuesOf = (requirement: RequirementRecord | null): Values => ({
  title: requirement?.title ?? "",
  statement: requirement?.statement ?? "",
  category: requirement?.category ?? "FUNCTIONAL",
  inclusion: requirement?.inclusion ?? "UNDECIDED",
  ownerId: requirement?.ownerId ?? "",
  verificationDescription: requirement?.verificationMethod?.description ?? "",
  responsibleRole: requirement?.verificationMethod?.responsibleRole ?? "",
});

export default function RequirementForm({
  requirement,
  ui,
  update,
  drafts,
  setDraft,
  write,
  onClose,
}: Props) {
  const { savedDraft } = useStudio();
  const { status, directory } = useSync();
  const id = requirement?.id ?? "new";
  const prefix = `specs:req:${id}:`;
  const baseKey = `${prefix}base`;
  const guardKey = `${prefix}expectedEntityVersion`;
  const saved = valuesOf(requirement);
  const base = (() => {
    try {
      return drafts[baseKey] ? (JSON.parse(drafts[baseKey]!) as Values) : saved;
    } catch {
      return saved;
    }
  })();
  // Unedited fields always reflect the newest saved record. The captured base remains only for change detection.
  const get = <K extends keyof Values>(key: K) =>
    drafts[`${prefix}${key}`] ?? saved[key];
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
    if (
      value === base[key] &&
      !Object.keys(saved).some(
        (field) => field !== key && drafts[`${prefix}${field}`] !== undefined,
      )
    ) {
      setDraft(baseKey, undefined);
      setDraft(guardKey, undefined);
      clearStale();
    }
  };
  const canEdit =
    status.status === "ACTIVE" &&
    (status.role === "OWNER" || status.role === "EDITOR");
  const locked = write.busy || ui.pending !== null;
  const edited = Object.keys(saved).some(
    (field) => drafts[`${prefix}${field}`] !== undefined,
  );
  const guard = Number(drafts[guardKey] ?? requirement?.version ?? 0);
  const stale = Boolean(
    requirement && ui.staleRequirements?.[requirement.id] === savedDraft.id,
  );
  const textErrors = {
    title: requirementTextError(
      get("title").trim(),
      LIMITS.title,
      "Title",
      true,
    ),
    statement: requirementTextError(
      get("statement"),
      LIMITS.longText,
      "Statement",
    ),
    verificationDescription: requirementTextError(
      get("verificationDescription").trim(),
      LIMITS.longText,
      "Verification description",
    ),
    responsibleRole: requirementTextError(
      get("responsibleRole").trim(),
      LIMITS.role,
      "Responsible role",
    ),
  };
  const ownerInvalid =
    (!requirement || drafts[`${prefix}ownerId`] !== undefined) &&
    Boolean(get("ownerId")) &&
    directory !== null &&
    !directory.some(
      (member) =>
        member.profileId === get("ownerId") &&
        ["OWNER", "EDITOR", "REVIEWER"].includes(member.role),
    );
  const verificationIncomplete =
    Boolean(get("verificationDescription").trim()) !==
    Boolean(get("responsibleRole").trim());
  const invalid =
    ownerInvalid ||
    verificationIncomplete ||
    Object.values(textErrors).some(Boolean);
  const verification = () => {
    const description = get("verificationDescription").trim();
    const responsibleRole = get("responsibleRole").trim();
    return description && responsibleRole
      ? { description, responsibleRole }
      : null;
  };
  const send = (
    label: string,
    build: (saved: typeof savedDraft) => Record<string, unknown> | null,
  ) => void write.sendDraft(`drafts/${savedDraft.id}/commands`, build, label);
  const save = () => {
    if (invalid) return;
    send("Save requirement", (current) => {
      const next = {
        title: get("title").trim(),
        statement: get("statement"),
        category: get("category") as RequirementCategory,
        inclusion: get("inclusion") as RequirementRecord["inclusion"],
        ownerId: get("ownerId") || null,
        verification: verification(),
      };
      if (!requirement)
        return {
          commandSchemaVersion: 1,
          command: "CREATE_REQUIREMENT",
          expectedDocumentRevision: current.documentRevision,
          payload: { ...next, sourceRefs: [] },
        };
      const changed = Object.fromEntries(
        Object.entries(next).filter(([key]) =>
          key === "verification"
            ? drafts[`${prefix}verificationDescription`] !== undefined ||
              drafts[`${prefix}responsibleRole`] !== undefined
            : drafts[`${prefix}${key}`] !== undefined,
        ),
      );
      return Object.keys(changed).length
        ? {
            commandSchemaVersion: 1,
            command: "UPDATE_REQUIREMENT",
            expectedEntityVersion: guard,
            payload: { requirementId: requirement.id, ...changed },
          }
        : null;
    });
  };
  const clearStale = () =>
    update((current) => {
      if (
        !requirement ||
        current.staleRequirements?.[requirement.id] !== savedDraft.id
      )
        return {};
      const staleRequirements = { ...current.staleRequirements };
      delete staleRequirements[requirement.id];
      return {
        staleRequirements: Object.keys(staleRequirements).length
          ? staleRequirements
          : undefined,
        message: "",
      };
    });
  const useSaved = () => {
    for (const key of [
      baseKey,
      guardKey,
      ...Object.keys(saved).map((field) => `${prefix}${field}`),
    ])
      setDraft(key, undefined);
    clearStale();
  };
  const useMineOnLatest = () => {
    if (!requirement || requirement.version <= guard) return;
    setDraft(baseKey, JSON.stringify(saved));
    setDraft(guardKey, String(requirement.version));
    clearStale();
  };
  const field = <K extends keyof Values>(
    key: K,
    label: string,
    control: "input" | "textarea" | "select",
    options?: readonly [string, string][],
    error = "",
    pairInvalid = false,
  ) => {
    const errorId = error ? `requirement-${key}-error` : undefined;
    const describedBy =
      [errorId, pairInvalid ? "verification-method-error" : undefined]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <div className="field">
        <label htmlFor={`requirement-${key}`}>{label}</label>
        {control === "textarea" ? (
          <textarea
            id={`requirement-${key}`}
            rows={key === "statement" ? 4 : 3}
            readOnly={!canEdit || locked}
            value={get(key)}
            aria-invalid={Boolean(error) || pairInvalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => set(key, event.target.value)}
          />
        ) : control === "select" ? (
          <select
            id={`requirement-${key}`}
            disabled={!canEdit || locked}
            value={get(key)}
            onChange={(event) => set(key, event.target.value)}
          >
            {options?.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`requirement-${key}`}
            readOnly={!canEdit || locked}
            value={get(key)}
            aria-invalid={Boolean(error) || pairInvalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => set(key, event.target.value)}
          />
        )}
        {error && (
          <p id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };
  return (
    <div className="requirement-form">
      <button type="button" className="button quiet small" onClick={onClose}>
        Back to requirements
      </button>
      <h3>
        {requirement
          ? `${requirement.displayId} ${requirement.title}`
          : "New requirement"}
      </h3>
      {stale && (
        <section className="inline-note" role="alert">
          <p>
            Someone saved this requirement first. Your text is kept; review the
            saved values, then save again.
          </p>
          <div className="view-actions">
            <button
              type="button"
              className="button small"
              disabled={locked || !requirement || requirement.version <= guard}
              onClick={useMineOnLatest}
            >
              Use my edits on latest version
            </button>
            <button
              type="button"
              className="button quiet small"
              disabled={locked}
              onClick={useSaved}
            >
              Use saved values
            </button>
          </div>
        </section>
      )}
      {field("title", "Title", "input", undefined, textErrors.title)}
      {field(
        "statement",
        "Statement",
        "textarea",
        undefined,
        textErrors.statement,
      )}
      {field("category", "Category", "select", categories)}
      {field("inclusion", "Inclusion", "select", inclusions)}
      <div className="field">
        <label htmlFor="requirement-owner">Owner</label>
        <select
          id="requirement-owner"
          aria-invalid={ownerInvalid || undefined}
          aria-describedby={
            ownerInvalid ? "requirement-owner-error" : undefined
          }
          disabled={!canEdit || locked}
          value={get("ownerId")}
          onChange={(event) => set("ownerId", event.target.value)}
        >
          <option value="">Unassigned</option>
          {directory
            ?.filter((member) => member.role !== "VIEWER")
            .map((member) => (
              <option key={member.profileId} value={member.profileId}>
                {member.displayName}
              </option>
            ))}
          {get("ownerId") &&
            !directory?.some(
              (member) =>
                member.profileId === get("ownerId") && member.role !== "VIEWER",
            ) && (
              <option value={get("ownerId")}>
                {directory?.find(
                  (member) => member.profileId === get("ownerId"),
                )?.displayName ?? "Former member"}
              </option>
            )}
        </select>
        {ownerInvalid && (
          <p id="requirement-owner-error" role="alert">
            Choose an active Owner, Editor, Reviewer, or Unassigned owner.
          </p>
        )}
      </div>
      {field(
        "verificationDescription",
        "Verification description",
        "textarea",
        undefined,
        textErrors.verificationDescription,
        verificationIncomplete,
      )}
      {field(
        "responsibleRole",
        "Responsible role",
        "input",
        undefined,
        textErrors.responsibleRole,
        verificationIncomplete,
      )}
      {verificationIncomplete && (
        <p id="verification-method-error" role="alert">
          Verification description and responsible role must both be filled or
          both be blank.
        </p>
      )}
      {canEdit && (
        <div className="view-actions">
          <button
            type="button"
            className="button primary"
            disabled={
              locked || invalid || stale || Boolean(requirement && !edited)
            }
            onClick={save}
          >
            Save requirement
          </button>
          {requirement && (
            <button
              type="button"
              className="button"
              disabled={locked || edited || confirmationCurrent(requirement)}
              onClick={() =>
                send("Confirm requirement", () => ({
                  commandSchemaVersion: 1,
                  command: "CONFIRM_REQUIREMENT",
                  expectedEntityVersion: guard,
                  payload: { requirementId: requirement.id },
                }))
              }
            >
              {!edited && confirmationCurrent(requirement)
                ? "Confirmed for this wording"
                : "Confirm requirement"}
            </button>
          )}
        </div>
      )}
      {canEdit && requirement && edited && (
        <p className="muted">Save changes before confirming.</p>
      )}
      {requirement && (
        <RequirementActions
          requirement={requirement}
          update={update}
          drafts={drafts}
          setDraft={setDraft}
          canEdit={canEdit}
          locked={locked}
          send={send}
        />
      )}
    </div>
  );
}
