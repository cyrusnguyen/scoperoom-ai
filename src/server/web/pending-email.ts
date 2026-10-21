import "server-only";
import { cookies } from "next/headers";
import { sessionCookieOptions } from "@/features/access/session-cookies";

const COOKIE_NAME = "scoperoom.pending-email";
const COOKIE_PATH = "/signup";
const CODE_SENT_COOKIE = "scoperoom.code-sent-at";
const COOKIE_MAX_AGE = 60 * 60;
const options = () => ({ ...sessionCookieOptions(), path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE });

// This remembers where to send the code during signup. Supabase still verifies the
// email and token; the cookie grants no access to any project.
export async function getPendingEmail(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  return value && value.length <= 320 ? value : null;
}

export async function setPendingEmail(email: string): Promise<void> {
  (await cookies()).set(COOKIE_NAME, email, options());
}

export async function getCodeSentAt(email: string): Promise<number | null> {
  const value = (await cookies()).get(CODE_SENT_COOKIE)?.value;
  if (!value) return null;
  try {
    const state = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { email?: string; sentAt?: number };
    if (state.email !== email) return null;
    const sentAt = state.sentAt;
    return typeof sentAt === "number" && Number.isSafeInteger(sentAt) && sentAt > 0 && sentAt <= Date.now() ? sentAt : null;
  } catch {
    return null;
  }
}

export async function markCodeSent(email: string): Promise<void> {
  // The email binding survives an unconfirmed sign-in from /login, where /signup cookies are not sent.
  const value = Buffer.from(JSON.stringify({ email, sentAt: Date.now() })).toString("base64url");
  (await cookies()).set(CODE_SENT_COOKIE, value, options());
}

export async function clearPendingEmail(): Promise<void> {
  const store = await cookies();
  for (const name of [COOKIE_NAME, CODE_SENT_COOKIE]) {
    store.set(name, "", { path: COOKIE_PATH, maxAge: 0 });
  }
}