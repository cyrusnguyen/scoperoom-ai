import type { ProjectUi, SpecsRequest } from "../../shell/ui/project-ui.ts";

/** Clear submitted fields and settle their request together. Duplicate/late acknowledgements cannot erase newer input. */
export function finishSourceWrite(ui: ProjectUi, request: SpecsRequest): ProjectUi {
  if (ui.specs.pending?.key !== request.key) return ui;
  const drafts = { ...ui.drafts };
  let selected = ui.specs.selected;
  let sourceCorrections = ui.specs.sourceCorrections;
  const [, id] = request.path.split("/");
  if (request.path === "sources") {
    delete drafts["specs:new-source:title"]; delete drafts["specs:new-source:text"]; delete drafts["specs:new-source:uploaded"]; delete drafts["specs:new-source:upload-name"];
  } else if (request.path.endsWith("/graph-sources")) {
    delete drafts["specs:flow-source:title"]; delete drafts["specs:flow-source:id"];
  }
  else if (request.path.endsWith("/versions")) {
    sourceCorrections = { ...sourceCorrections };
    delete sourceCorrections[id!];
    if (selected?.kind === "source" && selected.sourceId === id) selected = { ...selected, versionId: null };
  }
  return { ...ui, drafts, specs: { ...ui.specs, ...(sourceCorrections ? { sourceCorrections } : {}), selected, pending: null, message: `${request.label}: saved.` } };
}
