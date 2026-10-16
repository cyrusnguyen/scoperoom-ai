import { AI_LIMITS } from "../contracts/tasks.ts";

/** The sentence shown for a failed run. A step-limit refusal says what to change; any other safe code is shown in plain words. */
export function failureText(code: string | null): string {
  if (code === "RESULT_GRAPH_LIMIT") {
    return `The AI proposed more than ${AI_LIMITS.maxGraphNodes} new steps or ${AI_LIMITS.maxGraphEdges} new connections, which is over the limit. Ask for fewer steps and try again.`;
  }
  return `The provider could not complete this run${code ? ` (${code.toLowerCase().replaceAll("_", " ")})` : ""}.`;
}
