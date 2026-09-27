import type { ProjectAccessRole } from "../contracts/project.ts";

export function roleLabel(role: ProjectAccessRole): string {
  return role[0] + role.slice(1).toLowerCase();
}

/** Computed when invitations load (never during render): "Expires today" inside 24 hours, otherwise "Expires Oct 15". */
export function expiryLabel(expiresAt: string, now: number): { text: string; soon: boolean } {
  if (Date.parse(expiresAt) - now < 86_400_000) return { text: "Expires today", soon: true };
  return { text: `Expires ${new Date(expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, soon: false };
}
