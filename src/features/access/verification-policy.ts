// Keep these values aligned with Supabase Auth's email OTP configuration.
export const CODE_VALIDITY_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 60;

export function secondsRemaining(sentAt: number | null, durationSeconds: number, now: number): number {
  if (sentAt === null) return 0;
  return Math.max(0, Math.ceil((sentAt + durationSeconds * 1000 - now) / 1000));
}
