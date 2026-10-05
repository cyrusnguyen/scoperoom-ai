import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { adminClient, cleanupUsers, openDatabase } from "./support";
import { fillPrivateField } from "../support/recovery-sensitive-input.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

const modeFile = process.env.RECOVERY_FAULT_FILE;
const resultFile = process.env.RECOVERY_FAULT_RESULT_FILE;
if (!modeFile || !resultFile) throw new Error("Recovery fault tests require their isolated production server files.");

type Event = { operation: string; status: number };
function setFault(mode = "") {
  writeFileSync(modeFile!, `${mode}\n`);
  writeFileSync(resultFile!, "[]\n");
}
function events(): Event[] {
  const value: unknown = JSON.parse(readFileSync(resultFile!, "utf8"));
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.operation !== "string" || !Number.isInteger(item.status))) {
    throw new Error("The recovery fault recorder returned an invalid bounded event list.");
  }
  return value as Event[];
}
async function expectFault(operation: string, status: number) {
  await expect.poll(() => events().some((event) => event.operation === operation && event.status === status)).toBe(true);
}

async function createAccount(email: string, password = `Recovery-${randomUUID()}!`) {
  const admin = adminClient();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("Could not create the isolated recovery fixture.");
  return { admin, userId: created.data.user.id, email, password };
}

async function cleanupAccount(account: Awaited<ReturnType<typeof createAccount>>, page?: import("@playwright/test").Page) {
  const database = await openDatabase();
  try { await cleanupUsers(database, account.admin, [account.userId], page); }
  finally { await database.end(); }
}

async function requestCode(page: import("@playwright/test").Page, email: string) {
  setFault();
  await page.goto("/forgot-password");
  await fillPrivateField(page.getByLabel("Email address"), email);
  await page.getByRole("button", { name: "Send reset code" }).click();
  await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);
}

async function deliveredCode(email: string) {
  const mailpit = process.env.E2E_MAILPIT_URL!;
  let code: string | null = null;
  await expect.poll(async () => {
    const response = await fetch(`${mailpit}/api/v1/messages`);
    const list = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
    const message = list.messages.find((item) => item.To.some((recipient) => recipient.Address === email));
    if (!message) return false;
    const detail = await fetch(`${mailpit}/api/v1/message/${message.ID}`);
    const content = await detail.json() as { Subject?: string; Text?: string; HTML?: string };
    expect(content.Subject).toBe("Reset your ScopeRoom password");
    const body = content.Text ?? content.HTML ?? "";
    expect(body.includes("10 minutes")).toBe(true);
    code = body.match(/\b[0-9]{6}\b/)?.[0] ?? null;
    return Boolean(code);
  }, { timeout: 15_000, intervals: [100, 250, 500] }).toBe(true);
  if (!code) throw new Error("The local recovery message did not include a usable code.");
  return code;
}

async function submitCode(page: import("@playwright/test").Page, email: string, code: string, password = `Changed-${randomUUID()}!`) {
  const emailField = page.getByLabel("Email address");
  if (await emailField.count()) await fillPrivateField(emailField, email);
  await fillPrivateField(page.getByLabel("Verification code"), code);
  await fillPrivateField(page.getByLabel("New password", { exact: true }), password);
  await fillPrivateField(page.getByLabel("Confirm new password"), password);
  await page.getByRole("button", { name: "Reset password" }).click();
  return password;
}

test("request outage returns an ambiguous confirmation without revealing account existence", async ({ page }) => {
  const email = `fault-request-${randomUUID()}@example.test`;
  setFault("request-outage");
  await page.goto("/forgot-password");
  await fillPrivateField(page.getByLabel("Email address"), email);
  await page.getByRole("button", { name: "Send reset code" }).click();
  await expect(page).toHaveURL(/\/forgot-password\/reset\?status=send-unknown$/);
  await expect(page.getByRole("status")).toContainText("Check your email");
  await expectFault("recover", 503);

});

test("a lost send acknowledgement tells the user to check email before retrying", async ({ page }) => {
  const account = await createAccount(`fault-send-lost-${randomUUID()}@example.test`);
  try {
    setFault("request-lost");
    await page.goto("/forgot-password");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page).toHaveURL(/\/forgot-password\/reset\?status=send-unknown$/);
    await expect(page.getByRole("status")).toContainText("Check your email");
    await expectFault("recover", 200);
    await deliveredCode(account.email);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("fresh anonymous contexts reach provider resend suppression with the same public response", async ({ browser }) => {
  const account = await createAccount(`fault-fresh-send-${randomUUID()}@example.test`);
  const unknownEmail = `fault-fresh-unknown-${randomUUID()}@example.test`;
  async function requestInFreshContext(email: string) {
    const context = await browser.newContext();
    try {
      const hadNoCookies = (await context.cookies()).length === 0;
      const page = await context.newPage();
      await page.goto("/forgot-password");
      await fillPrivateField(page.getByLabel("Email address"), email);
      await page.getByRole("button", { name: "Send reset code" }).click();
      await expect(page).toHaveURL(/\/forgot-password\/reset\?status=sent$/);
      return { hadNoCookies, message: await page.getByRole("status").textContent() };
    } finally {
      await context.close();
    }
  }

  try {
    setFault("observe");
    const knownFirst = await requestInFreshContext(account.email);
    await deliveredCode(account.email);
    const knownRepeat = await requestInFreshContext(account.email);
    const unknownFirst = await requestInFreshContext(unknownEmail);
    const unknownRepeat = await requestInFreshContext(unknownEmail);
    expect([knownFirst, knownRepeat, unknownFirst, unknownRepeat].every((item) => item.hadNoCookies)).toBe(true);
    const notices = [knownFirst.message, knownRepeat.message, unknownFirst.message, unknownRepeat.message];
    expect(notices.every((message) => message === "If an account exists for this email, we have sent a reset code.")).toBe(true);
    await expect.poll(() => events().filter((event) => event.operation === "recover").length).toBe(4);
    const recoveries = events().filter((event) => event.operation === "recover");
    expect(recoveries.length === 4).toBe(true);
    expect(recoveries[1]?.status === 429).toBe(true);
    const mailpit = process.env.E2E_MAILPIT_URL!;
    const messages = await (await fetch(`${mailpit}/api/v1/messages`)).json() as { messages: Array<{ To: Array<{ Address: string }> }> };
    expect(messages.messages.filter((message) => message.To.some((recipient) => recipient.Address === account.email)).length === 1).toBe(true);
    expect(messages.messages.some((message) => message.To.some((recipient) => recipient.Address === unknownEmail))).toBe(false);
  } finally {
    setFault();
    await cleanupAccount(account);
  }
});

test("resend stays disabled while its server action is pending", async ({ page }) => {
  const account = await createAccount(`fault-resend-${randomUUID()}@example.test`);
  const candidate = "Unused-" + randomUUID() + "!";
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  try {
    setFault("request-delay");
    await page.goto("/forgot-password/reset");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Verification code"), code);
    await fillPrivateField(page.getByLabel("New password", { exact: true }), candidate);
    await fillPrivateField(page.getByLabel("Confirm new password"), candidate);
    const resend = page.getByRole("button", { name: "Resend code", exact: true });
    await resend.click();
    await expect(resend).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("temporarily unavailable");
    await expect(resend).toBeEnabled();
    await expectFault("recover", 400);
    expect(await page.evaluate(({ code, candidate }) => Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password], input[autocomplete=one-time-code]")).every((input) => input.value === (input.name === "code" ? code : candidate)), { code, candidate })).toBe(true);
    expect(events().some((event) => event.operation === "update")).toBe(false);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("identity outage blocks a request from an existing session", async ({ page }) => {
  const account = await createAccount(`fault-identity-${randomUUID()}@example.test`);
  try {
    await page.goto("/login");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Password"), account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app$/);
    const cookieNames = (await page.context().cookies()).map((cookie) => cookie.name).sort();
    setFault("identity-outage");
    await page.goto("/forgot-password");
    await fillPrivateField(page.getByLabel("Email address"), `fault-identity-target-${randomUUID()}@example.test`);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page.locator("#recovery-request-error")).toContainText("temporarily unavailable");
    await expectFault("identity", 503);
    expect((await page.context().cookies()).map((cookie) => cookie.name).sort()).toEqual(cookieNames);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("verification transport outage is unavailable and does not consume the code", async ({ page }) => {
  const account = await createAccount(`fault-verify-${randomUUID()}@example.test`);
  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("verify-outage");
    await submitCode(page, account.email, code);
    await expect(page.locator("#recovery-result")).toContainText("temporarily unavailable");
    await expectFault("verify", 503);

  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("expired verification is reported without password mutation", async ({ page }) => {
  const account = await createAccount(`fault-expired-${randomUUID()}@example.test`);
  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("verify-expired");
    await submitCode(page, account.email, code);
    await expect(page.locator("#recovery-result")).toHaveText("The code is invalid or expired. Try again or request a new code.");
    await expectFault("verify", 400);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("an update outage does not replay the submitted password", async ({ page }) => {
  const account = await createAccount(`fault-update-${randomUUID()}@example.test`);
  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("update-outage");
    await submitCode(page, account.email, code);
    await expect(page.locator("#recovery-result")).toContainText("could not confirm the password change");
    await expectFault("update", 503);
    await expect.poll(() => events().filter((event) => event.operation === "update").length).toBe(1);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("a lost update acknowledgement does not replay and ordinary sign-in resolves the outcome", async ({ page }) => {
  const account = await createAccount(`fault-update-lost-${randomUUID()}@example.test`);
  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("update-lost");
    const acknowledgedLate = await submitCode(page, account.email, code);
    await expect(page.locator("#recovery-result")).toContainText("could not confirm the password change");
    await expectFault("update", 200);
    await expect.poll(() => events().filter((event) => event.operation === "update").length).toBe(1);
    await expect.poll(() => events().filter((event) => event.operation === "verify").length).toBe(1);

    setFault();
    await page.goto("/login");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Password"), acknowledgedLate);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.goto("/login");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Password"), account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\?error=invalid$/);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

test("a lost server-action acknowledgement after a real update stays unknown and resolves by normal sign-in", async ({ page }) => {
  const account = await createAccount(`fault-action-ack-${randomUUID()}@example.test`);
  const newPassword = `Changed-${randomUUID()}!`;
  const actionUrl = (url: URL) => url.pathname === "/forgot-password/reset";
  let releaseResponse = () => {};
  const heldResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let acknowledgeServerResponse: (status: number) => void = () => {};
  const serverResponse = new Promise<number>((resolve) => { acknowledgeServerResponse = resolve; });
  let routeFinished = () => {};
  const completedAbort = new Promise<void>((resolve) => { routeFinished = resolve; });

  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("observe");
    await fillPrivateField(page.getByLabel("Verification code"), code);
    await fillPrivateField(page.getByLabel("New password", { exact: true }), newPassword);
    await fillPrivateField(page.getByLabel("Confirm new password"), newPassword);
    await page.route(actionUrl, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
      try {
        const response = await route.fetch();
        acknowledgeServerResponse(response.status());
        await heldResponse;
        await response.dispose();
        await route.abort("failed");
      } catch {
        acknowledgeServerResponse(0);
        try { await route.abort("failed"); } catch { /* The browser may have closed after a failed assertion. */ }
      } finally { routeFinished(); }
    });

    const submit = page.getByRole("button", { name: "Reset password" });
    let clickFailed = false;
    const click = submit.click().catch(() => { clickFailed = true; });
    await expect.poll(() => serverResponse).toBe(200);
    await expect(page.getByRole("button", { name: "Resetting…" })).toBeDisabled();
    await expect.poll(() => events().filter((event) => event.operation === "verify").length).toBe(1);
    await expect.poll(() => events().filter((event) => event.operation === "update").length).toBe(1);
    await expect.poll(() => events().filter((event) => event.operation === "global-signout").length).toBe(1);
    expect(events().filter((event) => ["verify", "update", "global-signout"].includes(event.operation)).map((event) => event.status)).toEqual([200, 200, 204]);

    releaseResponse();
    await expect(page.locator("#recovery-result")).toHaveText("We could not confirm the password change. Try signing in with your new password, or request a new code.");
    await click;
    expect(clickFailed).toBe(false);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password], input[autocomplete=one-time-code]")).every((input) => input.value === ""))).toBe(true);
    expect(events().filter((event) => ["verify", "update", "global-signout"].includes(event.operation)).length).toBe(3);
    await page.unroute(actionUrl);
    setFault();
    await page.goto("/login");
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Password"), newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app$/);
  } finally {
    releaseResponse();
    await Promise.race([completedAbort, new Promise((resolve) => setTimeout(resolve, 1000))]);
    setFault();
    await page.unroute(actionUrl).catch(() => {});
    await cleanupAccount(account, page);
  }
});

test("global revocation outage reports the confirmed password update warning", async ({ page }) => {
  const account = await createAccount(`fault-revoke-${randomUUID()}@example.test`);
  try {
    await requestCode(page, account.email);
    const code = await deliveredCode(account.email);
    setFault("signout-outage");
    const password = await submitCode(page, account.email, code);
    await expect(page).toHaveURL(/\/login\?status=password-reset-warning$/);
    await expectFault("global-signout", 503);
    await expect.poll(() => events().filter((event) => event.operation === "update").length).toBe(1);

    setFault();
    await fillPrivateField(page.getByLabel("Email address"), account.email);
    await fillPrivateField(page.getByLabel("Password"), password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app$/);
  } finally {
    setFault();
    await cleanupAccount(account, page);
  }
});

for (const mode of ["request-outage", "request-lost", "action-ack-lost"] as const) {
  test(`resend clears obsolete secrets after ${mode} and preserves email and continuation`, async ({ page }) => {
    const account = await createAccount(`fault-resend-clear-${randomUUID()}@example.test`);
    const continuation = "/invite/" + "a".repeat(43);
    const actionUrl = (url: URL) => url.pathname === "/forgot-password/reset";
    const candidate = "Unused-" + randomUUID() + "!";
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const resendFields: string[][] = [];
    let serverAcknowledged = false;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        resendFields.push(Array.from((request.postDataBuffer()?.toString() ?? "").matchAll(/name="([^"]+)"/g), (match) => match[1]!.replace(/^_[0-9]+_/, "")).filter((name) => name !== "0").sort());
      }
    });
    try {
      setFault(mode === "action-ack-lost" ? "observe" : mode);
      try { await page.goto("/forgot-password/reset?continue=" + encodeURIComponent(continuation)); }
      catch { throw new Error("Could not open the resend continuation fixture."); }
      await fillPrivateField(page.getByLabel("Email address"), account.email);
      await fillPrivateField(page.getByLabel("Verification code"), code);
      await fillPrivateField(page.getByLabel("New password", { exact: true }), candidate);
      await fillPrivateField(page.getByLabel("Confirm new password"), candidate);
      if (mode === "action-ack-lost") await page.route(actionUrl, async (route) => {
        if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
        const response = await route.fetch();
        serverAcknowledged = response.status() === 200;
        await response.dispose();
        await route.abort("failed");
      });
      try { await page.getByRole("button", { name: "Resend code", exact: true }).click(); }
      catch { throw new Error("Could not submit the resend continuation fixture."); }
      await expect(page.getByRole("status")).toContainText("Check your email");
      expect(resendFields).toEqual([["continue", "email"]]);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password], input[autocomplete=one-time-code]")).every((input) => input.value.length === 0))).toBe(true);
      expect(await page.locator('input[name="email"]').evaluate((input: HTMLInputElement, expected) => input.value === expected, account.email)).toBe(true);
      expect(new URL(page.url()).searchParams.get("continue") === continuation).toBe(true);
      await expectFault("recover", mode === "request-outage" ? 503 : 200);
      if (mode !== "request-outage") await deliveredCode(account.email);
      if (mode === "action-ack-lost") expect(serverAcknowledged).toBe(true);
      expect(events().some((event) => event.operation === "update")).toBe(false);
    } finally {
      await page.unroute(actionUrl).catch(() => {});
      setFault();
      await cleanupAccount(account, page);
    }
  });
}
