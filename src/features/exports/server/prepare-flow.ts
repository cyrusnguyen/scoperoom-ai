import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { getDraft } from "../../drafts/server/execute-command.ts";
import { serializeFlowFile } from "../../exchange/domain/flow-file.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { parseExportRequest, type ExportRequest, type PreparedFlow } from "../contracts/flow-export.ts";
import { exportFilename, nativeFlowFile } from "../domain/flow-file.ts";

export async function prepareFlow(identity: ProjectIdentity, projectId: string, draftId: string, flowId: string, input: unknown): Promise<PreparedFlow> {
  let request: ExportRequest;
  try { request = parseExportRequest(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  if (!uuid.test(flowId)) throw new ProjectError("NOT_FOUND");
  // getDraft owns current read authority and one coherent saved row in a read-only snapshot.
  const draft = await getDraft(identity, projectId, draftId);
  const canonicalFlowId = flowId.toLowerCase();
  if (!Object.hasOwn(draft.document.flows, canonicalFlowId)) throw new ProjectError("NOT_FOUND");
  if (draft.documentRevision !== request.expectedDocumentRevision || draft.layoutRevision !== request.expectedLayoutRevision) throw new ProjectError("EXPORT_REVISION_CHANGED");
  const file = nativeFlowFile(draft, canonicalFlowId, new Date().toISOString());
  // The existing codec checks the supported native shape and its 1 MiB download/import bound.
  try { serializeFlowFile(file); } catch { throw new ProjectError("LIMIT_EXCEEDED"); }
  return { filename: exportFilename(file.flow.title), file };
}
