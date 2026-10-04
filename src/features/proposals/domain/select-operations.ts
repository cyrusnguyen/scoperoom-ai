import { AI_LIMITS, LOCAL_REF, type ProposalOperation } from "../contracts/tasks.ts";

const conflict = (): never => { throw new Error("DEPENDENCY_CONFLICT"); };

/** One bounded checker for stored declarations and application-derived creation references. Never auto-selects. */
export function selectOperations(operations: readonly ProposalOperation[], selectedIds: readonly string[]): ProposalOperation[] {
  if (operations.length > AI_LIMITS.operations || selectedIds.length > operations.length) conflict();
  const byId = new Map(operations.map(operation => [operation.id, operation]));
  if (byId.size !== operations.length || operations.some(operation => !LOCAL_REF.test(operation.id))) conflict();
  const creators = new Map<string, string>();
  for (const operation of operations) {
    const edit = operation.edit;
    if (edit.command === "CREATE_FLOW" || edit.command === "ADD_NODE") {
      if (creators.has(edit.payload.ref)) conflict();
      creators.set(edit.payload.ref, operation.id);
    }
  }
  const dependencies = new Map<string, Set<string>>();
  for (const operation of operations) {
    if (operation.dependsOn.length > AI_LIMITS.dependsOn || new Set(operation.dependsOn).size !== operation.dependsOn.length) conflict();
    const deps = new Set(operation.dependsOn);
    for (const [key, value] of Object.entries(operation.edit.payload)) {
      if (!key.endsWith("Id") && !key.endsWith("Ids")) continue;
      for (const entityId of Array.isArray(value) ? value : [value]) {
        if (typeof entityId === "string" && LOCAL_REF.test(entityId)) deps.add(creators.get(entityId) ?? conflict());
      }
    }
    if (deps.has(operation.id) || [...deps].some(id => !byId.has(id))) conflict();
    dependencies.set(operation.id, deps);
  }
  const ordered: ProposalOperation[] = [], visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) conflict();
    visiting.add(id);
    for (const dep of [...dependencies.get(id)!].sort()) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id)!);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length || [...selected].some(id => !byId.has(id))) conflict();
  for (const id of selected) if ([...dependencies.get(id)!].some(dep => !selected.has(dep))) conflict();
  return ordered.filter(operation => selected.has(operation.id));
}
