import type { CommandResult } from "../../drafts/contracts/commands.ts";
import type { ProjectUi, SpecsRequest } from "../../shell/ui/project-ui.ts";

const fields = ["title", "statement", "category", "inclusion", "ownerId", "verificationDescription", "responsibleRole"] as const;

function submittedValue(payload: Record<string, unknown>, field: typeof fields[number]) {
  if (field === "verificationDescription") return (payload.verification as { description?: string } | undefined)?.description ?? "";
  if (field === "responsibleRole") return (payload.verification as { responsibleRole?: string } | undefined)?.responsibleRole ?? "";
  return String(payload[field] ?? "");
}

/** Clears only values that still equal the frozen request which just received an acknowledgement. */
export function finishRequirementWrite(ui: ProjectUi, request: SpecsRequest, data: unknown): ProjectUi {
  if (ui.specs.pending?.key !== request.key || !request.path.endsWith("/commands") || !request.body) return ui;
  const body = request.body, payload = body.payload as Record<string, unknown> | undefined;
  if (!payload || !["CREATE_REQUIREMENT", "UPDATE_REQUIREMENT", "CONFIRM_REQUIREMENT", "ADD_TRACE_LINK", "UPDATE_TRACE_LINK", "CONFIRM_TRACE_LINK", "DELETE_TRACE_LINK", "DELETE_REQUIREMENT"].includes(String(body.command))) return ui;
  const result = data as Partial<CommandResult>;
  const createdId = body.command === "CREATE_REQUIREMENT" ? result.createdIds?.[0] : undefined;
  const requirementId = createdId ?? (typeof payload.requirementId === "string" ? payload.requirementId : undefined);
  const prefix = `specs:req:${createdId ? "new" : requirementId ?? ""}:`;
  const drafts = { ...ui.drafts };
  for (const field of fields) {
    const payloadField = field === "verificationDescription" || field === "responsibleRole" ? "verification" : field;
    const key = `${prefix}${field}`;
    const value = drafts[key], normalized = field === "title" || field === "verificationDescription" || field === "responsibleRole" ? value?.trim() : value;
    if (Object.hasOwn(payload, payloadField) && normalized === submittedValue(payload, field)) delete drafts[key];
  }
  if (body.command === "ADD_TRACE_LINK" && typeof payload.requirementId === "string") {
    const linkPrefix = `specs:req:${payload.requirementId}:link:`;
    if (drafts[`${linkPrefix}node`] === String(payload.nodeId)) delete drafts[`${linkPrefix}node`];
    if (drafts[`${linkPrefix}new-explanation`] === String(payload.explanation)) delete drafts[`${linkPrefix}new-explanation`];
  }
  if (body.command === "UPDATE_TRACE_LINK" && typeof payload.linkId === "string") for (const key of Object.keys(drafts)) {
    if (key.endsWith(`:link:${payload.linkId}:explanation`) && drafts[key] === String(payload.explanation)) {
      delete drafts[key]; delete drafts[key.replace(":explanation", ":version")];
    }
  }
  if (body.command === "UPDATE_REQUIREMENT" && Array.isArray(payload.sourceRefs) && typeof payload.requirementId === "string") {
    const ref = payload.sourceRefs.at(-1) as Record<string, unknown> | undefined, citePrefix = `specs:req:${payload.requirementId}:cite:`;
    if (ref && drafts[`${citePrefix}source`] === String(ref.sourceVersionId) && drafts[`${citePrefix}start`] === String(ref.startLine) && drafts[`${citePrefix}end`] === String(ref.endLine) && drafts[`${citePrefix}excerpt`] === String(ref.excerpt)) for (const field of ["source", "start", "end", "excerpt"]) delete drafts[`${citePrefix}${field}`];
  }
  const requirementSave = body.command === "CREATE_REQUIREMENT" || body.command === "DELETE_REQUIREMENT" || (body.command === "UPDATE_REQUIREMENT" && fields.some((field) => Object.hasOwn(payload, field === "verificationDescription" || field === "responsibleRole" ? "verification" : field)));
  const remainingFields = fields.some((field) => drafts[`${prefix}${field}`] !== undefined);
  const remainingDeletedInput = body.command === "DELETE_REQUIREMENT" && Object.keys(drafts).some((key) => key.startsWith(prefix) && key !== `${prefix}base` && key !== `${prefix}expectedEntityVersion`);
  const selectedMatches = ui.specs.selected?.kind === "requirement" && (body.command === "CREATE_REQUIREMENT" ? ui.specs.selected.id === "new" : ui.specs.selected.id === requirementId);
  const closes = requirementSave && selectedMatches && !remainingFields && !remainingDeletedInput;
  const selected = closes ? null : ui.specs.selected;
  if (requirementSave && !remainingFields) { delete drafts[`${prefix}base`]; delete drafts[`${prefix}expectedEntityVersion`]; }
  if (requirementId && result.versions?.[requirementId] && drafts[`${prefix}expectedEntityVersion`] === String(body.expectedEntityVersion)) drafts[`${prefix}expectedEntityVersion`] = String(result.versions[requirementId]);
  return { ...ui, drafts, specs: { ...ui.specs, selected, pending: null, message: `${request.label}: saved.` } };
}
