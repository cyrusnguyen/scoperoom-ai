export type ModelProvider = "google" | "anthropic";

/**
 * `AI_MODEL` names its provider: `anthropic/<id>` or `google/<id>`. An id with no `/` is Google, the original bare form. Anything else
 * (an unknown or misspelled provider, an empty id, a nested path) is unroutable, so admission refuses it before any reservation.
 */
export function modelRoute(model: string): { provider: ModelProvider; id: string } | null {
  const slash = model.indexOf("/");
  // A bare Claude id would go to Google and waste a claimed call: it must carry the `anthropic/` prefix.
  if (slash === -1) return model && !model.startsWith("claude") ? { provider: "google", id: model } : null;
  const provider = model.slice(0, slash), id = model.slice(slash + 1);
  return (provider === "google" || provider === "anthropic") && id && !id.includes("/") ? { provider, id } : null;
}
