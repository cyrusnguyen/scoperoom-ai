import type { TaskKind } from "../contracts/tasks.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ModelRequest = Readonly<{
  runId: string; task: TaskKind; systemInstruction: string; prompt: string;
  context: Json; outputSchema: Json; model: string;
  maxInputTokens: number; maxOutputTokens: number; timeoutMs: number;
}>;
export type ModelReply =
  | { kind: "completed"; output: unknown; requestId?: string;
      usage: { inputTokens: number | null; outputTokens: number | null } }
  | { kind: "refused" | "incomplete" | "unavailable" | "unknown";
      retryAfterMs?: number; requestId?: string };
export interface ModelGateway {
  /** True when this worker can route `model` (an `AI_MODEL` value) and holds its provider's key: checked before any SQL claim. */
  supports(model: string): boolean;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export type JobRequest = Readonly<{
  runId: string; dispatchId: string; executionBinding: string; deadlineAt: string;
}>;
export interface JobDispatcher {
  dispatch(request: JobRequest): Promise<
    { kind: "accepted"; taskId: string } | { kind: "unavailable" }
  >;
}
