import type { FlowFileV1 } from "../../exchange/contracts/flow-file.ts";
import { invalid, keys, object, version } from "../../drafts/contracts/strict.ts";

export type ExportRequest = { format: "native"; expectedDocumentRevision: number; expectedLayoutRevision: number; includeLinkHints: false };
export type PreparedFlow = { filename: string; file: FlowFileV1 };

export function parseExportRequest(value: unknown): ExportRequest {
  const input = object(value);
  keys(input, ["format", "expectedDocumentRevision", "expectedLayoutRevision"], ["includeLinkHints"]);
  if (input.format !== "native" || (Object.hasOwn(input, "includeLinkHints") && input.includeLinkHints !== false)) invalid();
  return { format: "native", expectedDocumentRevision: version(input.expectedDocumentRevision), expectedLayoutRevision: version(input.expectedLayoutRevision), includeLinkHints: false };
}
