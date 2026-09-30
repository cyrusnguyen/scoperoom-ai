export type RealtimeTopics = { events: string; collab: string };
export type Topic = { projectId: string; epoch: string; purpose: "events" | "collab" };

// Canonical lower-case UUIDs only: the shared `uuid` validator is case-insensitive, and topic names must match the SQL policy byte for byte.
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function realtimeTopics(projectId: string, epoch: string): RealtimeTopics {
  return { events: `project:${projectId}:${epoch}:events`, collab: `project:${projectId}:${epoch}:collab` };
}

export function parseTopic(input: unknown): Topic | null {
  if (typeof input !== "string" || new TextEncoder().encode(input).length > 90) return null;
  const parts = input.split(":");
  if (parts.length !== 4) return null;
  const [prefix, projectId, epoch, purpose] = parts;
  if (prefix !== "project" || !CANONICAL_UUID.test(projectId!) || !CANONICAL_UUID.test(epoch!)) return null;
  if (purpose !== "events" && purpose !== "collab") return null;
  return { projectId: projectId!, epoch: epoch!, purpose };
}
