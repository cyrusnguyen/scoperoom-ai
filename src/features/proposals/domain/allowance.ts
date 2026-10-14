import type { AiAllowance, AllowanceCount } from "../contracts/tasks.ts";

const count = (used: number, limit: number | null): AllowanceCount => ({ used, limit, left: limit === null ? null : Math.max(0, limit - used) });

/** `limits` are the owner's plan (null is unlimited); `used` are counted exactly as admission counts them. */
export function aiAllowance(limits: { allowed: boolean; total: number | null; daily: number | null }, used: { total: number; today: number }, viewerIsOwner: boolean): AiAllowance {
  return { allowed: limits.allowed, viewerIsOwner, total: count(used.total, limits.total), today: count(used.today, limits.daily) };
}

export function allowanceText(allowance: AiAllowance): string {
  if (!allowance.allowed) return "AI requests are not enabled for this project's owner.";
  const { total, today } = allowance;
  const parts = [total.limit === null ? "Unlimited AI requests" : `${total.left} of ${total.limit} AI ${total.limit === 1 ? "request" : "requests"} left`];
  if (today.limit !== null) parts.push(`${today.left} of ${today.limit} left today`);
  return parts.join(" · ") + (allowance.viewerIsOwner ? "" : " (the project owner's allowance)");
}
