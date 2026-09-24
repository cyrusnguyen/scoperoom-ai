import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const password = `Test-${randomUUID()}-Pass!`;
const email = `canvas-${randomUUID()}@example.test`;
let admin: SupabaseClient;
let userId: string;

test("anonymous visitors reach login before the canvas", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to ScopeRoom" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blank canvas" })).toHaveCount(0);
  const centerOffset = await page.locator(".login-card").evaluate((card) => {
    const box = card.getBoundingClientRect();
    return Math.abs(box.left + box.width / 2 - window.innerWidth / 2);
  });
  expect(centerOffset).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("confirmation link drops the temporary auth code before sign-in", async ({ page }) => {
  await page.goto("/login?code=temporary");
  await expect(page).toHaveURL(/\/login\?status=confirmed$/);
  await expect(page.getByRole("status")).toHaveText("Email confirmed. Sign in to continue.");
});
test("signup and pending verification handle direct visits and email changes", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Confirm password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto("/signup/verify");
  await expect(page).toHaveURL(/\/signup$/);
  await page.context().addCookies([{ name: "scoperoom.pending-email", value: "pending@example.test", domain: "127.0.0.1", path: "/signup", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/signup/verify");
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  const codeInput = page.getByRole("textbox", { name: "Verification code" });
  await expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.locator(".verification-digit")).toHaveCount(6);
  await codeInput.fill("12a34");
  await expect(codeInput).toHaveValue("1234");
  await codeInput.fill("123456");
  await expect(page.locator(".verification-digit")).toHaveText(["1", "2", "3", "4", "5", "6"]);
  await codeInput.fill("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText(" 123456"));
  await codeInput.focus();
  await codeInput.press("ControlOrMeta+V");
  await expect(codeInput).toHaveValue("123456");
  await codeInput.press("Backspace");
  await expect(codeInput).toHaveValue("12345");
  await expect(page.getByText("pending@example.test")).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);
  await page.getByRole("button", { name: "Change" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  const pendingCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "scoperoom.pending-email");
  expect(pendingCookies).toHaveLength(0);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("local Supabase Auth", () => {
  test.skip(!authUrl || !secretKey, "Requires an isolated local Supabase stack");

  test.beforeAll(async () => {
    const url = new URL(authUrl!);
    if (url.hostname !== "127.0.0.1" || !["54321", "55321"].includes(url.port)) {
      throw new Error("Auth browser tests require a local Supabase URL.");
    }
    admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error("Could not create the local test account.");
    userId = data.user.id;
  });

  test.afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  test("blank signup name creates no Supabase identity", async ({ page }) => {
    const blankNameEmail = `blank-name-${randomUUID()}@example.test`;
    try {
      await page.goto("/signup");
      await page.getByLabel("Name", { exact: true }).fill("   ");
      await page.getByLabel("Email address").fill(blankNameEmail);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByLabel("Confirm password").fill(password);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/signup\?error=invalid$/);
      const { data } = await admin.auth.admin.listUsers();
      expect(data.users.some((user) => user.email === blankNameEmail)).toBe(false);
    } finally {
      const { data } = await admin.auth.admin.listUsers();
      const created = data.users.find((user) => user.email === blankNameEmail);
      if (created) await admin.auth.admin.deleteUser(created.id);
    }
  });
  test("mismatched signup passwords create no Supabase identity", async ({ page }) => {
    const mismatchedEmail = `mismatch-${randomUUID()}@example.test`;
    await page.goto("/signup");
    await page.getByLabel("Name", { exact: true }).fill("Ada Test");
    await page.getByLabel("Email address").fill(mismatchedEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill("Different-Password-2026!");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup\?error=invalid$/);
    const { data } = await admin.auth.admin.listUsers();
    expect(data.users.some((user) => user.email === mismatchedEmail)).toBe(false);
  });

  test("resend reaches local Supabase for a pending account", async ({ page }) => {
    const mailpitUrl = process.env.E2E_MAILPIT_URL;
    test.skip(!mailpitUrl, "Requires local email capture");
    const recipient = `resend-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email: recipient, password, email_confirm: false });
    if (error || !data.user) throw new Error("Could not create a pending local account.");
    try {
      await page.context().addCookies([{ name: "scoperoom.pending-email", value: recipient, domain: "127.0.0.1", path: "/signup", httpOnly: true, sameSite: "Lax" }]);
      await page.goto("/signup/verify");
      await page.getByRole("button", { name: "Resend code" }).click();
      await expect(page).toHaveURL(/\/signup\/verify\?status=resent$/);
      await expect.poll(async () => {
        const response = await fetch(`${mailpitUrl}/api/v1/messages`);
        const list = await response.json() as { messages: Array<{ To: Array<{ Address: string }> }> };
        return list.messages.some((message) => message.To.some((to) => to.Address === recipient));
      }, { timeout: 10_000 }).toBe(true);
    } finally {
      await admin.auth.admin.deleteUser(data.user.id);
    }
  });
  test("email signup needs a delivered code before the canvas opens", async ({ page }) => {
    test.setTimeout(60_000);
    const mailpitUrl = process.env.E2E_MAILPIT_URL;
    test.skip(!mailpitUrl, "Requires local email capture");
    const signupEmail = `signup-${randomUUID()}@example.test`;
    try {
      await page.goto("/signup");
      await page.getByLabel("Name", { exact: true }).fill("  Ada Lovelace  ");
      await page.getByLabel("Email address").fill(signupEmail);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByLabel("Confirm password").fill(password);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/signup\/verify\?status=sent$/);
      await expect(page.getByText(signupEmail)).toBeVisible();
      await expect(page.getByLabel("Email address")).toHaveCount(0);
      await expect(page.getByText(/Code expires in/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Resend code in/ })).toBeDisabled();
      await page.goto("/");
      await expect(page).toHaveURL(/\/login$/);

      const { data: users } = await admin.auth.admin.listUsers();
      const pending = users.users.find((user) => user.email === signupEmail);
      expect(pending?.email_confirmed_at).toBeFalsy();
      expect(pending?.user_metadata.full_name).toBe("Ada Lovelace");

      await page.goto("/login");
      await page.getByLabel("Email address").fill(signupEmail);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/signup\/verify\?status=pending$/, { timeout: 15_000 });
      await expect(page.getByText(signupEmail)).toBeVisible();

      await page.goto("/signup/verify");
      await page.getByLabel("Verification code").fill("000000");
      await page.getByRole("button", { name: "Verify email" }).click();
      await expect(page).toHaveURL(/error=invalid/);
      await page.goto("/");
      await expect(page).toHaveURL(/\/login$/);

      await page.goto("/signup/verify");
      // A scripted submit bypasses the disabled button to exercise the server guard.
      await page.getByRole("button", { name: /Resend code in/ }).evaluate((button: HTMLButtonElement) => {
        button.disabled = false;
        button.click();
      });
      await expect(page).toHaveURL(/error=cooldown/);

      let code: string | null = null;
      await expect.poll(async () => {
        const response = await fetch(`${mailpitUrl}/api/v1/messages`);
        const list = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
        const message = list.messages.find((item) => item.To.some((recipient) => recipient.Address === signupEmail));
        if (!message) return null;
        const detail = await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`);
        const email = await detail.json() as { Text?: string; HTML?: string };
        code = (email.Text ?? email.HTML ?? "").match(/\b[0-9]{6}\b/)?.[0] ?? null;
        return code;
      }, { timeout: 10_000 }).not.toBeNull();
      await page.goto("/signup/verify");

      await page.getByLabel("Verification code").fill(code!);
      await page.getByRole("button", { name: "Verify email" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible();
      const { data: verified } = await admin.auth.admin.getUserById(pending!.id);
      expect(verified.user?.email_confirmed_at).toBeTruthy();
    } finally {
      const { data: users } = await admin.auth.admin.listUsers();
      const created = users.users.find((user) => user.email === signupEmail);
      if (created) await admin.auth.admin.deleteUser(created.id);
    }
  });

  test("invalid credentials stay on login with a generic error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\?error=invalid$/);
    await expect(page.locator(".login-error")).toContainText("We could not sign you in");
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("account sign-in opens the canvas and sign-out closes access", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible();
    await expect(page.getByText("No project is connected yet.")).toBeVisible();
    expect(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor)).toBe("rgb(25, 28, 26)");
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Your starting point" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Project details" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});
