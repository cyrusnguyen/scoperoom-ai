import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges } from "./support";

const production = process.env.SCOPEROOM_E2E_SERVER === "production";
test.skip(!e2eReady || !production, "Needs the isolated stack and the production build the runner just made");

// Stage 04.2 Task 5: the real status route and the real Supabase SDK, with Auth failing on command. Supabase's server URL
// is compiled into the build, so a second `next start` of the same build runs on its own port with a preloaded fetch
// wrapper (tests/support/auth-fault.mjs) that fails only that process's Auth calls. The shared stack never stops.
const port = Number(new URL(appUrl).port) + 50;
const origin = `http://127.0.0.1:${port}`;
const faultDir = mkdtempSync(join(tmpdir(), "scoperoom-auth-fault-"));
const faultFile = join(faultDir, "mode");
const fault = (mode: string) => writeFileSync(faultFile, mode);
let server: ChildProcess | undefined;

const status = (page: Page) => page.locator(".studio-status");
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const focusWindow = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
const quiet = (page: Page) => page.waitForTimeout(500);
const statusUrl = (projectId: string) => `${origin}/api/projects/${projectId}/status`;

test.beforeAll(async () => {
  fault("");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env, SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: origin, AUTH_FAULT_FILE: faultFile,
      NODE_OPTIONS: `--import ${resolve("tests/support/auth-fault.mjs").replaceAll("\\", "/").replace(/^([A-Za-z]):/, "file:///$1:")}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* still starting */ }
    if (Date.now() > deadline) throw new Error("The fault-injected server did not start.");
    await new Promise((done) => setTimeout(done, 250));
  }
});
test.afterAll(() => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGKILL");
  }
  rmSync(faultDir, { recursive: true, force: true });
});
test.afterEach(() => fault(""));

async function seed(page: Page) {
  const projectId = await createProjectViaApi(page, "Auth outage project");
  const [flowId, startId, payId, shipId] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  const node = (id: string, kind: string, label: string) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [id] });
  const draftId = await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Outage", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    node(startId, "START", "Start"), node(payId, "ACTION", "Pay"), node(shipId, "ACTION", "Ship"),
    { command: "ADD_EDGE", payload: { flowId, fromId: startId, toId: payId, condition: "" }, proposedIds: [randomUUID()] },
  ]);
  return { projectId, draftId, payId, shipId };
}

async function connect(page: Page, fromId: string, toId: string) {
  await nodeAt(page, fromId).locator('.react-flow__handle[data-handleid="bottom"]').first().dragTo(nodeAt(page, toId).locator('.react-flow__handle[data-handleid="top"]').first());
}

test("the status route separates a definitive 401 from an Auth outage, and never runs a handler on either", async ({ page }) => {
  test.setTimeout(90_000);
  const { projectId, draftId } = await seed(page);
  const url = statusUrl(projectId);
  const before = await (await page.request.get(url)).json() as { documentRevision: number };

  // Healthy: the second server behaves like the first, and a request with no session is a plain 401.
  expect((await page.request.get(url)).status()).toBe(200);
  const anonymous = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const response = await anonymous.request.get(url);
    expect(response.status()).toBe(401);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  } finally { await anonymous.close(); }

  for (const mode of ["down", "502", "503", "504", "429"]) {
    fault(mode);
    const response = await page.request.get(url);
    expect(response.status(), mode).toBe(503);
    expect((await response.json() as { error: { code: string; retryable: boolean } }).error, mode).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(response.headers()["cache-control"], mode).toBe("private, no-store");
    expect(response.headers()["x-request-id"], mode).toMatch(/^[0-9a-f-]{36}$/);
  }
  // A mutation is refused before its handler runs: the draft does not move on either failure.
  const attempt = () => page.request.post(`${origin}/api/projects/${projectId}/drafts/${draftId}/changes`, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: { commands: [{ commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: before.documentRevision, payload: { title: "Never", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [randomUUID()] }], moves: [] },
  });
  for (const [mode, code, expected] of [["down", "UNAVAILABLE", 503], ["401", "UNAUTHENTICATED", 401]] as const) {
    fault(mode);
    const write = await attempt();
    expect(write.status(), mode).toBe(expected);
    expect((await write.json() as { error: { code: string } }).error.code, mode).toBe(code);
  }
  fault("");
  expect((await (await page.request.get(url)).json() as { documentRevision: number }).documentRevision).toBe(before.documentRevision);

  // Definitive denials, last: the SDK also drops the session cookies on session-missing.
  for (const mode of ["401", "session-missing"]) {
    fault(mode);
    const response = await page.request.get(url);
    expect(response.status(), mode).toBe(401);
    expect((await response.json() as { error: { code: string } }).error.code, mode).toBe("UNAUTHENTICATED");
    expect(response.headers()["cache-control"], mode).toBe("private, no-store");
  }
});

test("an Auth outage keeps entries and inspector text, shows Not saved, never leaves for sign-in, and a later revalidation resumes", async ({ page }) => {
  test.setTimeout(90_000);
  const { projectId, payId, shipId } = await seed(page);
  const writes: string[] = [];
  const navigations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/(changes|positions)$/.test(request.url())) writes.push(request.url()); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname); });
  await page.goto(`${origin}/app/projects/${projectId}`);
  await expect(nodeAt(page, payId)).toBeVisible();
  await connect(page, payId, shipId);
  await expect(status(page)).toContainText("Unsaved changes");
  await nodeAt(page, shipId).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const field = page.locator("#right-panel").getByLabel("Name", { exact: true });
  await field.fill("Typed during the outage");

  // Auth goes down: focus revalidates against the real route, which answers 503 (not 401).
  fault("down");
  const outage = page.waitForResponse((response) => response.url() === statusUrl(projectId));
  await focusWindow(page);
  expect((await outage).status()).toBe(503);
  await headerSave(page).click();
  await expect(status(page)).toContainText("Not saved");
  await quiet(page);
  expect(writes).toHaveLength(0);
  expect(navigations.filter((path) => path === "/login")).toHaveLength(0);
  await expect(field).toHaveValue("Typed during the outage");
  await expect(status(page)).toContainText("2 connections");

  // Auth returns: the next revalidation succeeds and the same Save goes out.
  fault("");
  await headerSave(page).click();
  await expect.poll(() => writes.length).toBe(1);
  // The typed name is still an unsaved buffer, so the line stays "Unsaved changes"; the connection itself is saved.
  await expect(status(page)).not.toContainText("Not saved");
  await expect.poll(async () => Object.keys(((await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json()) as { draft: { document: { edges: object } } }).draft.document.edges).length).toBe(2);
  await expect(field).toHaveValue("Typed during the outage");
  expect(navigations.filter((path) => path === "/login")).toHaveLength(0);
});

test("a definitive 401 clears the protected state before the page navigates to sign-in", async ({ page }) => {
  test.setTimeout(90_000);
  const { projectId, payId, shipId } = await seed(page);
  const writes: string[] = [];
  const seen: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/(changes|positions)$/.test(request.url())) writes.push(request.url()); });
  await page.exposeFunction("captureAtSessionEnd", (text: string) => { seen.push(text); });
  await page.goto(`${origin}/app/projects/${projectId}`);
  await expect(nodeAt(page, payId)).toBeVisible();
  await connect(page, payId, shipId);
  await expect(status(page)).toContainText("Unsaved changes");
  // The shell handles the session-ended event first (it registered first); this listener runs right after it and before
  // the page is replaced, so it sees exactly what is left on screen when the navigation begins.
  await page.evaluate(() => {
    window.addEventListener("scoperoom:session-ended", () => { void (window as unknown as { captureAtSessionEnd: (text: string) => Promise<void> }).captureAtSessionEnd(document.body.innerText); });
  });

  fault("session-missing");
  await focusWindow(page);
  await expect(page).toHaveURL(/\/login/);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("Your session ended");
  for (const gone of ["Auth outage project", "Unsaved changes", "Start", "Pay", "Ship"]) expect(seen[0], gone).not.toContain(gone);
  expect(writes).toHaveLength(0);
});


for (const mode of ["503", "504"]) {
  for (const destination of ["project", "app"]) {
    test(`initial ${mode} Auth outage at ${destination} keeps the route private and Retry recovers there`, async ({ page }) => {
      const { projectId, payId } = await seed(page);
      const url = `${origin}${destination === "project" ? `/app/projects/${projectId}` : "/app"}`;
      const session = async () => JSON.stringify((await page.context().cookies(origin)).filter((cookie) => cookie.name.startsWith("sb-")).sort((a, b) => a.name.localeCompare(b.name)));
      const cookiesBefore = await session();
      const privateReads: string[] = [];
      page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) privateReads.push(request.url()); });
      await page.addInitScript(() => {
        const capture = () => {
          if (document.querySelector(".app-shell, .react-flow__node")) (window as unknown as { privateShellMounted: boolean }).privateShellMounted = true;
        };
        new MutationObserver(capture).observe(document, { childList: true, subtree: true });
      });
      fault(mode);
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "ScopeRoom is temporarily unavailable" })).toBeVisible();
      expect(page.url() === url).toBe(true);
      await expect(page.locator(".app-shell, .react-flow__node")).toHaveCount(0);
      expect(await page.evaluate(() => Boolean((window as unknown as { privateShellMounted?: boolean }).privateShellMounted))).toBe(false);
      expect(privateReads).toHaveLength(0);
      expect(await session() === cookiesBefore).toBe(true);

      fault("");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      expect(page.url().replace(/\?$/, "") === url).toBe(true);
      if (destination === "project") await expect(nodeAt(page, payId)).toBeVisible();
      else await expect(page.getByRole("heading", { name: "No project open" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "ScopeRoom is temporarily unavailable" })).toHaveCount(0);
    });
  }
}

test("an initial definitive Auth 401 still requires sign-in", async ({ page }) => {
  const { projectId } = await seed(page);
  fault("401");
  await page.goto(`${origin}/app/projects/${projectId}`);
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByRole("heading", { name: "Sign in to ScopeRoom" })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
});

test("a protected page without a session still requires sign-in", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto(`${origin}/app`);
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByRole("heading", { name: "Sign in to ScopeRoom" })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
});

for (const mode of ["unconfirmed", "anonymous"]) {
  test(`a healthy ${mode} identity still requires email verification`, async ({ page }) => {
    await page.context().addCookies([{ name: "scoperoom.pending-email", value: "page-gate@example.test", domain: "127.0.0.1", path: "/signup", httpOnly: true, sameSite: "Lax" }]);
    fault(mode);
    await page.goto(`${origin}/app`);
    await expect(page).toHaveURL(`${origin}/signup/verify`);
    await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });
}

test("healthy verified page switches preserve the shell and per-project view, selection and panel", async ({ page }) => {
  const { projectId, payId } = await seed(page);
  const otherId = await createProjectViaApi(page, "Other admitted project");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/app/projects/${projectId}`);
  await expect(nodeAt(page, payId)).toBeVisible();
  const shell = await page.locator(".app-shell").elementHandle();
  await page.locator(".studio-toolbar").getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Pay/ }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const panel = page.locator("#right-panel");
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Pay");
  await page.locator("#projects-nav").getByRole("button", { name: "Other admitted project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Other admitted project" })).toBeVisible();
  expect(await shell!.evaluate((element) => element === document.querySelector(".app-shell"))).toBe(true);
  await expect(panel).toHaveCount(0);
  await page.locator("#projects-nav").getByRole("button", { name: "Auth outage project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Auth outage project" })).toBeVisible();
  expect(await shell!.evaluate((element) => element === document.querySelector(".app-shell"))).toBe(true);
  await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Pay");
  expect(page.url() === `${origin}/app/projects/${projectId}`).toBe(true);
  expect(otherId !== projectId).toBe(true);
});

test("a committed page Auth outage removes the retained shell until same-route Retry", async ({ page }) => {
  const { projectId, payId } = await seed(page);
  const otherId = await createProjectViaApi(page, "Unavailable destination");
  await page.goto(`${origin}/app/projects/${projectId}`);
  await expect(nodeAt(page, payId)).toBeVisible();
  const shell = await page.locator(".app-shell").elementHandle();
  fault("503");
  await page.locator("#projects-nav").getByRole("button", { name: "Unavailable destination", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ScopeRoom is temporarily unavailable" })).toBeVisible();
  expect(page.url() === `${origin}/app/projects/${otherId}`).toBe(true);
  await expect(page.locator(".app-shell, .react-flow__node")).toHaveCount(0);
  expect(await shell!.evaluate((element) => element.isConnected)).toBe(false);
  fault("");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Unavailable destination" })).toBeVisible();
  expect(page.url().replace(/\?$/, "") === `${origin}/app/projects/${otherId}`).toBe(true);
});
