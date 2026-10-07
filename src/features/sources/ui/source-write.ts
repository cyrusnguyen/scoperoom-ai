import type { ProjectUi, SpecsRequest } from "../../shell/ui/project-ui.ts";

/** Clear submitted fields and settle their request together. Duplicate/late acknowledgements cannot erase newer input. */
export function finishSourceWrite(ui: ProjectUi, request: SpecsRequest): ProjectUi {
  if (ui.specs.pending?.key !== request.key) return ui;
  const drafts = { ...ui.drafts };
  let selected = ui.specs.selected;
  const [, id] = request.path.split("/");
  if (request.path === "sources") {
    delete drafts["specs:new-source:title"]; delete drafts["specs:new-source:text"]; delete drafts["specs:new-source:uploaded"];
  } else if (request.path.endsWith("/graph-sources")) {
    delete drafts["specs:flow-source:title"]; delete drafts["specs:flow-source:id"];
  }
  else if (request.path.endsWith("/versions")) {
    delete drafts[`specs:correct:${id}:title`]; delete drafts[`specs:correct:${id}:text`];
    if (selected?.kind === "source" && selected.sourceId === id) selected = { ...selected, versionId: null };
  }
  return { ...ui, drafts, specs: { ...ui.specs, selected, pending: null, message: `${request.label}: saved.` } };
}
