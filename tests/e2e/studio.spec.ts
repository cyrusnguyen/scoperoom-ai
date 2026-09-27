import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const panel = (page: Page) => page.locator("#right-panel");
const modal = (page: Page, name: string) => page.getByRole("dialog", { name });
const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

async function createFlowInUi(page: Page, title: string) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = modal(page, "New flow");
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText(title);
}

test.describe("Studio on a real draft", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Studio Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Studio project");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Studio project" })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("an editor creates flows from the empty state and the Flows dialog, and filters them by scope", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();
    await createFlowInUi(page, "Checkout");
    await expect(page.locator(".flow-switch")).toContainText("Checkout");
    await expect(toolbar(page).locator(".badge")).toHaveText("Exploratory");
    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    await flows.getByRole("button", { name: "New flow" }).click();
    const form = modal(page, "New flow");
    await form.getByLabel("Title").fill("Refunds");
    await form.getByLabel("Scope").selectOption({ label: "Included" });
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Refunds");
    await page.locator(".flow-switch").click();
    await flows.getByLabel("Show").selectOption({ label: "Included" });
    await expect(flows.getByRole("button", { name: /^Refunds/ })).toBeVisible();
    await expect(flows.getByRole("button", { name: /^Checkout/ })).toHaveCount(0);
    await flows.getByLabel("Show").selectOption({ label: "All flows" });
    await flows.getByRole("button", { name: /^Checkout/ }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Checkout");
    const draft = await draftOf(page, projectId);
    expect(Object.values(draft.document.flows).map((flow) => [flow.title, flow.inclusion]).sort()).toEqual([["Checkout", "UNDECIDED"], ["Refunds", "INCLUDED"]]);
  });
  test("uncertain creation retries the exact receipt, then duplicate and delete survive refresh", async ({ page }) => {
    const attempts: { key: string; body: string }[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await page.route("**/commands", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData()! });
      const response = await route.fetch();
      if (attempts.length === 1) await firstGate;
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "New flow" }).click();
    const form = modal(page, "New flow");
    await form.getByLabel("Title").fill("Retry once");
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(form.getByRole("button", { name: /^Creating/ })).toBeDisabled();
    await expect(form.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(form.getByLabel("Title")).toBeEditable();
    releaseFirst();
    await expect(form.getByRole("alert")).toContainText("Retry sends the same request");
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const original = await draftOf(page, projectId);
    expect(Object.keys(original.document.flows)).toHaveLength(1);
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "Duplicate Retry once" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Retry once");
    expect(Object.keys((await draftOf(page, projectId)).document.flows)).toHaveLength(2);
    await page.reload();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Retry once");
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: /^Delete Copy of Retry once/ }).click();
    const confirmation = modal(page, "Delete Copy of Retry once?");
    await expect(confirmation).toContainText("0 steps and 0 connections");
    await confirmation.getByRole("button", { name: "Delete flow", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    await expect(page.locator("#studio-flow-title")).toBeFocused();
    await page.reload();
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    expect(Object.keys((await draftOf(page, projectId)).document.flows)).toEqual(Object.keys(original.document.flows));
  });

});

test.describe("Studio read-only and narrow states (mocked project)", () => {
  const projectId = "a1111111-1111-4111-8111-111111111111";
  const flowId = "f1111111-1111-4111-8111-111111111111";
  const start = "b1111111-1111-4111-8111-111111111111";
  const end = "b2222222-2222-4222-8222-222222222222";
  const edgeId = "e1111111-1111-4111-8111-111111111111";
  const long = "b3333333-3333-4333-8333-333333333333";
  const longLabel = "Xác nhận thông tin người nộp đơn và kiểm tra đầy đủ các giấy tờ đính kèm trước khi chuyển hồ sơ sang bộ phận thẩm định";
  const node = (id: string, kind: string, label: string) => ({ id, flowId, version: 1, behaviourVersion: 1, kind, label, description: "Full description text", actorLabel: "Clerk", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] });
  /** One flow (plus `extraFlows` empty ones): Receive form → Filed, and an unconnected step with a long Vietnamese name. */
  const draft = (extraFlows = 0) => {
    const view = emptyDraftView();
    const extra = Array.from({ length: extraFlows }, (_, index) => `f${index + 2}111111-1111-4111-8111-111111111111`);
    return {
      ...view,
      document: {
        ...view.document,
        flows: Object.fromEntries([flowId, ...extra].map((id, index) => [id, { id, version: 1, behaviourVersion: 1, title: index ? `Flow ${index + 1}` : "Intake", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null }])),
        nodes: { [start]: node(start, "START", "Receive form"), [long]: node(long, "ACTION", longLabel), [end]: node(end, "OUTCOME", "Filed") },
        edges: { [edgeId]: { id: edgeId, flowId, version: 1, fromId: start, toId: end, condition: "", origin: "HUMAN", sourceRefs: [] } },
      },
      layout: { schemaVersion: 1, positions: { [start]: { x: 0, y: 0, version: 1 }, [long]: { x: 260, y: 80, version: 1 }, [end]: { x: 0, y: 160, version: 1 } }, directions: Object.fromEntries([flowId, ...extra].map((id) => [id, "TB"])) },
    };
  };
  const lists = (role: string, status = "ACTIVE") => {
    const row = { id: projectId, name: "Intake project", status, role, ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" };
    const group = (items: unknown[]) => ({ items, truncated: false });
    return { owned: group(role === "OWNER" && status === "ACTIVE" ? [row] : []), shared: group(role !== "OWNER" && status === "ACTIVE" ? [row] : []), archived: group(status === "ARCHIVED" ? [row] : []), capacity: { entitled: true, activeOwned: 1, maxOwned: 10, canCreate: true } };
  };
  async function mock(page: Page, role: string, status = "ACTIVE", extraFlows = 0) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/projects", (route) => route.fulfill({ json: lists(role, status) }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status, role, ownerId: projectId }, draft: draft(extraFlows) } }));
  }

  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Studio Reader");
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("a viewer reads Canvas and List without authoring controls or opening Inspect on selection", async ({ page }) => {
    await mock(page, "VIEWER");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.locator("#studio-flow-title")).toHaveText("Intake");
    await expect(toolbar(page).getByRole("button", { name: "Add step" })).toHaveCount(0);
    await expect(toolbar(page).getByRole("button", { name: "Connect" })).toHaveCount(0);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Receive form/ }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Receive form.*Filed/);
    await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  });

  test("an archived project shows its flow read-only, even to its owner", async ({ page }) => {
    await mock(page, "OWNER", "ARCHIVED");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByText("Archived · read-only")).toBeVisible();
    await expect(page.locator("#studio-flow-title")).toHaveText("Intake");
    await expect(toolbar(page).getByRole("button", { name: "Add step" })).toHaveCount(0);
  });

  test("at 390 px the Studio leads with the List and never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mock(page, "OWNER");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.locator("#studio-flow-title")).toHaveText("Intake");
    await expect(toolbar(page).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Steps" })).toContainText(longLabel);
    expect(await pageFits(page)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("studio-390.png") });
  });

  test("at five flows the Flows dialog explains the limit instead of offering New flow or Duplicate", async ({ page }) => {
    await mock(page, "OWNER", "ACTIVE", 4);
    await page.goto(`/app/projects/${projectId}`);
    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    await expect(flows.getByText("5 of 5 flows")).toBeVisible();
    await expect(flows.getByRole("button", { name: "New flow" })).toBeDisabled();
    await expect(flows.getByRole("button", { name: /^Duplicate/ })).toBeDisabled();
    await expect(flows.getByText("A project can have up to 5 flows.", { exact: false })).toBeVisible();
  });
  test("keyboard List selection survives filtering and Canvas pan, zoom and drag never write", async ({ page }) => {
    await mock(page, "OWNER");
    let writes = 0;
    await page.route("**/commands", async (route) => { writes++; await route.abort(); });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    const picked = page.getByRole("checkbox", { name: "Select Receive form" });
    await picked.focus();
    await page.keyboard.press("Space");
    await expect(picked).toBeChecked();
    await page.getByRole("searchbox", { name: "Find a step" }).fill("Filed");
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select Receive form" })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find a step" }).fill("");
    await expect(picked).not.toBeChecked();
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    const node = page.locator(`.react-flow__node[data-id="${start}"]`);
    await node.click();
    await expect(node).toHaveClass(/selected/);
    await expect(panel(page)).toHaveCount(0);
    const before = await node.getAttribute("style");
    await node.dragTo(node, { sourcePosition: { x: 50, y: 30 }, targetPosition: { x: 150, y: 60 } });
    await expect(node).toHaveAttribute("style", before!);
    await page.getByRole("button", { name: "Zoom In", exact: true }).click();
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    expect(writes).toBe(0);
    await page.screenshot({ path: test.info().outputPath("studio-canvas.png") });
  });

  test("an uncertain List deletion retries its exact request after switching views", async ({ page }) => {
    await mock(page, "OWNER");
    const attempts: { key: string; body: string }[] = [];
    const initial = draft();
    await page.route("**/drafts/" + initial.id, async (route) => route.fulfill({ json: { ...initial, documentRevision: 2, document: { ...initial.document, edges: {} } } }));
    await page.route("**/commands", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData()! });
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ json: { draftId: initial.id, documentRevision: 2, layoutRevision: 1, eventSequence: 1, createdIds: [], retiredIds: [edgeId], versions: {}, replayed: true } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: /^Delete connection Receive form/ }).click();
    await expect(page.getByRole("button", { name: "Retry last change", exact: true })).toBeVisible();
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    await page.getByRole("button", { name: "Retry last change", exact: true }).click();
    await expect(page.locator(".studio-status")).toContainText("0 connections");
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.getByRole("button", { name: "Retry last change", exact: true })).toHaveCount(0);
  });

  test("a narrow editor uses 44 px controls even on a wider screen", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 844 });
    await mock(page, "OWNER");
    await page.goto(`/app/projects/${projectId}`);
    const list = toolbar(page).getByRole("button", { name: "List", exact: true });
    await expect(list).toHaveAttribute("aria-pressed", "true");
    expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await toolbar(page).getByRole("button", { name: "Flow details" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await pageFits(page)).toBe(true);
  });

  test("an acknowledged change reports and recovers a failed draft refresh without sending another command", async ({ page }) => {
    await mock(page, "OWNER");
    const initial = draft();
    let reads = 0;
    let writes = 0;
    await page.route("**/drafts/" + initial.id, async (route) => {
      reads++;
      if (reads === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } });
      else await route.fulfill({ json: { ...initial, documentRevision: 2, document: { ...initial.document, edges: {} } } });
    });
    await page.route("**/commands", async (route) => {
      writes++;
      await route.fulfill({ json: { draftId: initial.id, documentRevision: 2, layoutRevision: 1, eventSequence: 1, createdIds: [], retiredIds: [edgeId], versions: {}, replayed: false } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: /^Delete connection Receive form/ }).click();
    await expect(page.locator(".studio-status")).toContainText("Change saved. The latest draft could not load.");
    await expect(page.locator(".studio-status")).not.toContainText("All changes saved");
    await page.getByRole("button", { name: "Retry read", exact: true }).click();
    await expect(page.locator(".studio-status")).toContainText("0 connections");
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });

  test("a role downgrade removes an already-open flow creation form", async ({ page }) => {
    await mock(page, "OWNER");
    let role = "OWNER";
    await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role, ownerId: projectId }, draft: draft() } }));
    await page.route("**/commands", async (route) => {
      role = "VIEWER";
      await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "Access changed" } } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "New flow" }).click();
    await modal(page, "New flow").getByLabel("Title").fill("No longer permitted");
    await modal(page, "New flow").getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator(".editor-header")).toContainText("Viewer");
    await expect(modal(page, "Flows")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create flow", exact: true })).toHaveCount(0);
    await expect(modal(page, "Flows").getByRole("button", { name: "New flow" })).toHaveCount(0);
  });

});
