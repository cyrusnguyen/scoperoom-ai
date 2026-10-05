import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { adminClient, cleanupUsers, createProjectViaApi, entitle, openDatabase } from "./support";
import { requireEnv } from "../support/env.ts";
import { fillPrivateField, privateBrowserInput } from "../support/recovery-sensitive-input.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

const localRecoveryReady = requireEnv(["E2E_SUPABASE_URL", "E2E_SUPABASE_SECRET_KEY", "E2E_DATABASE_URL", "E2E_MAILPIT_URL"]);

async function submitRecovery(page: import("@playwright/test").Page, email: string, code: string, password: string, confirmation = password) {
  const emailField = page.getByLabel("Email address");
  if (await emailField.count()) await fillPrivateField(emailField, email);
  await fillPrivateField(page.getByLabel("Verification code"), code);
  await fillPrivateField(page.getByLabel("New password", { exact: true }), password);
  await fillPrivateField(page.getByLabel("Confirm new password"), confirmation);
  await page.getByRole("button", { name: "Reset password" }).click();
}

async function gotoRecoveryContinuation(page: import("@playwright/test").Page, path: string) {
  try { await page.goto(path); } catch { throw new Error("Recovery continuation navigation failed."); }
}

async function safeRecoveryAction(action: () => Promise<unknown>) {
  try { await action(); } catch { throw new Error("Recovery action failed."); }
}

async function deliveredRecoveryCode(mailpitUrl: string, email: string) {
  let code: string | null = null;
  await expect.poll(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/messages`);
    const list = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
    const message = list.messages.find((item) => item.To.some((recipient) => recipient.Address === email));
    if (!message) return false;
    const detail = await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`);
    const content = await detail.json() as { Subject?: string; Text?: string; HTML?: string };
    expect(content.Subject).toBe("Reset your ScopeRoom password");
    const plain = content.Text ?? content.HTML ?? "";
    expect(plain.includes("10 minutes")).toBe(true);
    const reset = plain.match(/https?:\/\/[^\s<"]+\/forgot-password\/reset/)?.[0];
    if (reset) expect(new URL(reset).search.length === 0).toBe(true);
    code = plain.match(/\b[0-9]{6}\b/)?.[0] ?? null;
    return Boolean(code && reset);
  }, { timeout: 15_000, intervals: [100, 250, 500] }).toBe(true);
  if (!code) throw new Error("Local recovery email did not include a usable code.");
  return code;
}

async function requestRecovery(page: import("@playwright/test").Page, email: string, continuation?: string) {
  if (continuation) await gotoRecoveryContinuation(page, `/forgot-password?continue=${encodeURIComponent(continuation)}`);
  else await page.goto("/forgot-password");
  await fillPrivateField(page.getByLabel("Email address"), email);
  if (continuation) await safeRecoveryAction(() => page.getByRole("button", { name: "Send reset code" }).click());
  else await page.getByRole("button", { name: "Send reset code" }).click();
  if (continuation) {
    await expect.poll(() => page.evaluate(() => {
      const current = new URL(location.href);
      return current.pathname === "/forgot-password/reset" && current.searchParams.get("status") === "sent" && /^\/invite\/[A-Za-z0-9_-]{43}$/.test(current.searchParams.get("continue") ?? "");
    })).toBe(true);
  } else await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);
  const status = page.getByRole("status");
  await expect(status).toHaveText("If an account exists for this email, we have sent a reset code.");
}

test("login links to recovery and direct reset entry asks for an email", async ({ page }) => {
  await page.goto("/login");
  const forgot = page.getByRole("link", { name: "Forgot password?" });
  await expect(forgot).toBeVisible();
  await forgot.click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Forgot password?" })).toBeVisible();

  await page.goto("/login");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");

  await page.goto("/forgot-password/reset");
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Verification code")).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Confirm new password")).toHaveAttribute("autocomplete", "new-password");
  expect(await page.locator("meta[name=robots]").getAttribute("content")).toContain("noindex");
  expect(new URL(page.url()).search).toBe("");

  await page.goto("/forgot-password?continue=https%3A%2F%2Fexample.invalid%2F");
  const unsafeSignIn = new URL(await page.getByRole("link", { name: "Back to sign in" }).getAttribute("href") ?? "", page.url());
  expect(unsafeSignIn.search).toBe("");
  await page.goto("/forgot-password/reset");

  const contrast = await page.evaluate(() => {
    const channels = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance = (color: string) => {
      const rgb = channels(color).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    };
    const ratio = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return (values[0]! + 0.05) / (values[1]! + 0.05);
    };
    const card = getComputedStyle(document.querySelector(".login-card")!).backgroundColor;
    const text = getComputedStyle(document.querySelector(".login-form label")!).color;
    const link = getComputedStyle(document.querySelector(".login-footnote a")!).color;
    const button = getComputedStyle(document.querySelector(".login-form button[type=submit]")!);
    const input = getComputedStyle(document.querySelector("#email")!);
    return [ratio(text, card), ratio(link, card), ratio(button.color, button.backgroundColor), ratio(input.color, input.backgroundColor)];
  });
  expect(contrast.every((ratio) => ratio >= 4.5)).toBe(true);
});

test("reset form keeps keyboard, paste, mismatch, narrow-screen and reduced-motion behavior", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/forgot-password/reset");

  const code = page.getByLabel("Verification code");
  const generatedDigits = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const pastedDigits = `${generatedDigits.slice(0, 3)}-${generatedDigits.slice(3)}`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await privateBrowserInput(async () => {
    await page.evaluate(async (value) => navigator.clipboard.writeText(value), pastedDigits);
    await code.focus();
    await page.keyboard.press("Control+V");
  });
  expect(await code.evaluate((input: HTMLInputElement) => input.value.length === 6)).toBe(true);
  await code.press("Tab");
  await expect(page.getByLabel("New password", { exact: true })).toBeFocused();

  await fillPrivateField(page.getByLabel("Email address"), `e2e-${randomUUID()}@example.test`);
  await fillPrivateField(page.getByLabel("New password", { exact: true }), randomUUID());
  const confirmation = page.getByLabel("Confirm new password");
  await fillPrivateField(confirmation, randomUUID());
  await page.getByRole("button", { name: "Reset password" }).click();
  const mismatch = page.locator("#password-match-error");
  await expect(mismatch).toHaveAttribute("role", "alert");
  await expect(mismatch).toHaveText("New passwords do not match.");
  await expect(confirmation).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/forgot-password/reset");

  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  // At 200% zoom, a 640px device viewport is a 320 CSS-pixel layout viewport.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .map((element) => ({ element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.split(" ").join(".")}` : ""}`, right: element.getBoundingClientRect().right }))
    .filter((entry) => entry.right > document.documentElement.clientWidth + 1));
  expect(overflow).toEqual([]);

  const longEmail = `${"a".repeat(307)}@example.test`;
  const presentationState = Buffer.from(JSON.stringify({ email: longEmail, sentAt: Date.now() - 65_000 })).toString("base64url");
  await page.context().addCookies([{ name: "scoperoom.pending-recovery", value: presentationState, domain: new URL(page.url()).hostname, path: "/forgot-password", httpOnly: true, sameSite: "Lax" }]);
  await page.reload();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("html, body, .login-card, .verification-recipient"));
    return elements.every((element) => element.scrollWidth <= element.clientWidth + 1)
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  })).toBe(true);
});

test.describe("local Auth password recovery", () => {
  test.skip(!localRecoveryReady, "Requires the prepared local Auth, database, and Mailpit runtime.");

  test("safe invitation continuation survives both recovery routes", async ({ page }) => {
    test.skip(process.env.SCOPEROOM_E2E_SERVER !== "production", "Run only on the production server because dev logs query strings.");
    const inviteToken = randomBytes(32).toString("base64url");
    const continuation = `/invite/${inviteToken}`;
    await gotoRecoveryContinuation(page, `/forgot-password?continue=${encodeURIComponent(continuation)}`);
    await fillPrivateField(page.getByLabel("Email address"), `continuation-${randomUUID()}@example.test`);
    await safeRecoveryAction(() => page.getByRole("button", { name: "Send reset code" }).click());
    await expect.poll(() => page.evaluate(() => {
      const current = new URL(location.href);
      return current.pathname === "/forgot-password/reset" && current.searchParams.get("status") === "sent" && /^\/invite\/[A-Za-z0-9_-]{43}$/.test(current.searchParams.get("continue") ?? "");
    })).toBe(true);
    expect(await page.evaluate(() => {
      const next = new URL(location.href).searchParams.get("continue") ?? "";
      return /^\/invite\/[A-Za-z0-9_-]{43}$/.test(next);
    })).toBe(true);
    const firstLogin = new URL(await page.getByRole("link", { name: "Back to sign in" }).getAttribute("href") ?? "", page.url());
    expect(firstLogin.pathname).toBe("/login");
    expect(Boolean(firstLogin.searchParams.get("continue")?.match(/^\/invite\/[A-Za-z0-9_-]{43}$/))).toBe(true);

    await gotoRecoveryContinuation(page, `/forgot-password/reset?continue=${encodeURIComponent(continuation)}`);
    const resetLogin = new URL(await page.getByRole("link", { name: "Back to sign in" }).getAttribute("href") ?? "", page.url());
    expect(resetLogin.pathname).toBe("/login");
    expect(Boolean(resetLogin.searchParams.get("continue")?.match(/^\/invite\/[A-Za-z0-9_-]{43}$/))).toBe(true);
    await page.goto("/forgot-password/reset?continue=https%3A%2F%2Fexample.invalid%2F");
    const unsafeLogin = new URL(await page.getByRole("link", { name: "Back to sign in" }).getAttribute("href") ?? "", page.url());
    expect(unsafeLogin.search).toBe("");
  });

  test("a recovery code works in a second browser and preserves the profile and project", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const admin = adminClient();
    const database = await openDatabase();
    const users: string[] = [];
    let recoveryContext: import("@playwright/test").BrowserContext | null = null;
    const email = `recovery-${randomUUID()}@example.test`;
    const oldPassword = `Recovery-${randomUUID()}!`;
    const newPassword = `Changed-${randomUUID()}!`;
    const inviteToken = randomBytes(32).toString("base64url");
    const continuation = `/invite/${inviteToken}`;
    const refreshProofClient = createClient(process.env.E2E_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
    let heldRefreshToken: string | null = null;

    try {
      const created = await admin.auth.admin.createUser({ email, password: oldPassword, email_confirm: true });
      if (created.error || !created.data.user) throw new Error("Could not create the local recovery account.");
      users.push(created.data.user.id);
      recoveryContext = await browser.newContext();
      const recoveryPage = await recoveryContext.newPage();

      await page.goto("/login");
      await fillPrivateField(page.getByLabel("Email address"), email);
      await fillPrivateField(page.getByLabel("Password"), oldPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/app$/);
      expect((await page.request.get("/api/me")).status()).toBe(200);
      await entitle(database, created.data.user.id);
      const projectId = await createProjectViaApi(page, "Recovery preservation");
      const profileBefore = await database.query("select id from app.user_profile where auth_user_id = $1", [created.data.user.id]);
      expect(profileBefore.rowCount).toBe(1);
      const profileId = profileBefore.rows[0].id as string;

      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/login$/);
      const separateSession = await refreshProofClient.auth.signInWithPassword({ email, password: oldPassword });
      if (separateSession.error || !separateSession.data.session?.refresh_token) throw new Error("Could not create the pre-recovery session proof.");
      heldRefreshToken = separateSession.data.session.refresh_token;
      await requestRecovery(page, email, continuation);
      const code = await deliveredRecoveryCode(process.env.E2E_MAILPIT_URL!, email);

      await fillPrivateField(page.getByLabel("Verification code"), code);
      await fillPrivateField(page.getByLabel("New password", { exact: true }), newPassword);
      await fillPrivateField(page.getByLabel("Confirm new password"), `Mismatch-${randomUUID()}!`);
      await page.getByRole("button", { name: "Reset password" }).click();
      await expect(page.locator("#password-match-error")).toBeVisible();

      let wrongCode = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
      if (wrongCode === code) wrongCode = String((Number(wrongCode) + 1) % 1_000_000).padStart(6, "0");
      await fillPrivateField(page.getByLabel("Verification code"), wrongCode);
      await fillPrivateField(page.getByLabel("New password", { exact: true }), newPassword);
      await fillPrivateField(page.getByLabel("Confirm new password"), newPassword);
      await page.getByRole("button", { name: "Reset password" }).click();
      await expect(page.locator("#recovery-result")).toHaveText("The code is invalid or expired. Try again or request a new code.");

      await gotoRecoveryContinuation(recoveryPage, new URL(`/forgot-password/reset?continue=${encodeURIComponent(continuation)}`, page.url()).toString());
      await fillPrivateField(recoveryPage.getByLabel("Email address"), email);
      await fillPrivateField(recoveryPage.getByLabel("Verification code"), code);
      await fillPrivateField(recoveryPage.getByLabel("New password", { exact: true }), newPassword);
      await fillPrivateField(recoveryPage.getByLabel("Confirm new password"), newPassword);
      await safeRecoveryAction(() => recoveryPage.getByRole("button", { name: "Reset password" }).click());
      await expect.poll(() => recoveryPage.evaluate(() => {
        const current = new URL(location.href);
        return current.pathname === "/login" && current.searchParams.get("status") === "password-reset" && /^\/invite\/[A-Za-z0-9_-]{43}$/.test(current.searchParams.get("continue") ?? "");
      })).toBe(true);
      const params = new URL(recoveryPage.url()).searchParams;
      expect(Array.from(params.keys())).toEqual(["status", "continue"]);
      expect(/^\/invite\/[A-Za-z0-9_-]{43}$/.test(params.get("continue") ?? "")).toBe(true);
      expect((await recoveryContext.cookies()).some((cookie) => cookie.name.startsWith("sb-") || cookie.name === "scoperoom.session")).toBe(false);
      expect(await recoveryPage.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("sb-")))).toBe(false);
      if (!heldRefreshToken) throw new Error("The pre-recovery session proof is unavailable.");
      let refreshWasDefinitivelyRevoked = false;
      try {
        const refreshResult = await refreshProofClient.auth.refreshSession({ refresh_token: heldRefreshToken });
        refreshWasDefinitivelyRevoked = refreshResult.error?.status === 400 && refreshResult.error.code === "refresh_token_not_found";
      }
      catch { throw new Error("Could not verify pre-recovery session revocation."); }
      expect(refreshWasDefinitivelyRevoked).toBe(true);
      heldRefreshToken = null;

      await recoveryPage.goto("/forgot-password/reset");
      await submitRecovery(recoveryPage, email, code, `Replay-${randomUUID()}!`);
      await expect(recoveryPage.locator("#recovery-result")).toHaveText("The code is invalid or expired. Try again or request a new code.");

      await page.goto("/login");
      await fillPrivateField(page.getByLabel("Email address"), email);
      await fillPrivateField(page.getByLabel("Password"), oldPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/login\?error=invalid$/);
      await gotoRecoveryContinuation(page, `/login?continue=${encodeURIComponent(continuation)}`);
      await fillPrivateField(page.getByLabel("Email address"), email);
      await fillPrivateField(page.getByLabel("Password"), newPassword);
      try { await page.getByRole("button", { name: "Sign in" }).click(); } catch { throw new Error("Recovery continuation sign-in failed."); }
      await expect.poll(() => page.evaluate(() => /^\/invite\/[A-Za-z0-9_-]{43}$/.test(location.pathname))).toBe(true);
      const meResponse = await page.request.get("/api/me");
      expect(meResponse.status()).toBe(200);

      const profileAfter = await database.query("select id from app.user_profile where auth_user_id = $1", [created.data.user.id]);
      const projectAfter = await database.query("select id from app.project where id = $1 and owner_id = $2", [projectId, profileId]);
      expect(profileAfter.rows[0]?.id).toBe(profileId);
      expect(projectAfter.rowCount).toBe(1);
    } finally {
      await recoveryContext?.close();
      await cleanupUsers(database, admin, users, page);
      await database.end();
    }
  });

  test("known and unknown requests show the same neutral confirmation", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = adminClient();
    const email = `enumeration-${randomUUID()}@example.test`;
    const unknownEmail = `unknown-${randomUUID()}@example.test`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("Could not create the local request fixture.");
    try {
      await requestRecovery(page, email);
      const mailpitUrl = process.env.E2E_MAILPIT_URL!;
      await deliveredRecoveryCode(mailpitUrl, email);
      await expect(page.locator(".verification-recipient")).toBeVisible();
      expect(new URL(page.url()).searchParams.has("email")).toBe(false);
      await page.reload();
      await expect(page.locator(".verification-recipient")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/forgot-password$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);

      const resend = page.getByRole("button", { name: /Resend code in/ });
      await expect(resend).toBeDisabled();
      const cooldownPage = await page.context().newPage();
      try {
        await cooldownPage.goto("/forgot-password");
        await fillPrivateField(cooldownPage.getByLabel("Email address"), email);
        await cooldownPage.getByRole("button", { name: "Send reset code" }).click();
        await expect(cooldownPage.locator("#recovery-request-error")).toContainText("A reset code was requested recently.");
      } finally {
        await cooldownPage.close();
      }
      await page.getByRole("button", { name: "Change email" }).click();
      await expect(page).toHaveURL(/\/forgot-password$/);
      await expect(page.getByLabel("Email address")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);
      await expect(page.getByLabel("Email address")).toBeVisible();
      expect(new URL(page.url()).searchParams.has("email")).toBe(false);

      await page.goto("/forgot-password");
      await fillPrivateField(page.getByLabel("Email address"), unknownEmail);
      await page.getByRole("button", { name: "Send reset code" }).click();
      await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);
      await expect(page.getByRole("status")).toHaveText("If an account exists for this email, we have sent a reset code.");
      const response = await fetch(`${mailpitUrl}/api/v1/messages`);
      const list = await response.json() as { messages: Array<{ To: Array<{ Address: string }> }> };
      expect(list.messages.some((message) => message.To.some((recipient) => recipient.Address === unknownEmail))).toBe(false);
    } finally {
      await admin.auth.admin.deleteUser(created.data.user.id);
    }
  });

  test("a stale anonymous reset page cannot submit after another tab signs in", async ({ page, browser }) => {
    test.setTimeout(60_000);
    const admin = adminClient();
    const email = `signed-in-gate-${randomUUID()}@example.test`;
    const password = `Gate-${randomUUID()}!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("Could not create the local action-gate fixture.");
    const otherContext = await browser.newContext();
    try {
      await page.goto("/forgot-password/reset");
      await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();

      const signedInPage = await otherContext.newPage();
      await signedInPage.goto(new URL("/login", page.url()).toString());
      await fillPrivateField(signedInPage.getByLabel("Email address"), email);
      await fillPrivateField(signedInPage.getByLabel("Password"), password);
      await signedInPage.getByRole("button", { name: "Sign in" }).click();
      await expect(signedInPage).toHaveURL(/\/app$/);

      const origin = new URL(page.url()).origin;
      await page.context().addCookies(await otherContext.cookies(origin));
      await fillPrivateField(page.getByLabel("Email address"), email);
      await fillPrivateField(page.getByLabel("Verification code"), String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"));
      const candidate = `Candidate-${randomUUID()}!`;
      await fillPrivateField(page.getByLabel("New password", { exact: true }), candidate);
      await fillPrivateField(page.getByLabel("Confirm new password"), candidate);
      await page.getByRole("button", { name: "Reset password" }).click();
      await expect(page.getByRole("heading", { name: "You are already signed in" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Return to app" })).toBeVisible();
    } finally {
      await otherContext.close();
      await admin.auth.admin.deleteUser(created.data.user.id);
    }
  });

});
