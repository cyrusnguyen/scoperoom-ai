import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { DraftView, NodeKind } from "../../src/features/drafts/contracts/scope-document.ts";
import { STEP_SIZE } from "../../src/features/drafts/contracts/draft-layout.ts";
import { adminClient, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

async function createFlowInUi(page: Page, title: string) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = dialog(page, "New flow");
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText(title);
}

async function addStepInUi(page: Page, label: string, shape: "Start" | "Step" | "Decision" | "Outcome" | "Data store") {
  await toolbar(page).getByRole("button", { name: "Add step" }).click();
  const form = dialog(page, "Add step");
  await form.getByLabel("Shape").selectOption({ label: shape });
  await form.getByLabel("Name").fill(label);
  await form.getByRole("button", { name: "Add step" }).click();
  await expect(form).toBeHidden();
}

test.describe("Studio canvas shapes and handles (real draft)", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    admin = adminClient();
    database = await openDatabase();
    users = [];
    const { authUserId } = await signIn(page, admin, users, "Canvas Owner");
    await entitle(database, authUserId);
    projectId = await createProjectViaApi(page, "Canvas project");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Canvas project" })).toBeVisible();
    await createFlowInUi(page, "Shapes");
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("every kind renders at its fixed STEP_SIZE, and a DATA_STORE step draws as a cylinder that survives reload", async ({ page }) => {
    const shapes: [string, "Start" | "Step" | "Decision" | "Outcome" | "Data store", NodeKind][] = [
      ["Cart", "Start", "START"], ["Pay", "Step", "ACTION"], ["Paid?", "Decision", "DECISION"],
      ["Orders", "Data store", "DATA_STORE"], ["Done", "Outcome", "OUTCOME"],
    ];
    for (const [label, shape] of shapes) await addStepInUi(page, label, shape);
    const draft = await draftOf(page, projectId);
    const byLabel = Object.fromEntries(Object.values(draft.document.nodes).map((node) => [node.label, node.id]));
    for (const [label, , kind] of shapes) {
      const size = STEP_SIZE[kind];
      const node = nodeAt(page, byLabel[label]!);
      await expect(node).toHaveCSS("width", `${size.width}px`);
      await expect(node).toHaveCSS("height", `${size.height}px`);
    }
    const dataStoreNode = nodeAt(page, byLabel.Orders!);
    await expect(dataStoreNode.locator(".step-shape path.step-shape-fill")).toHaveCount(1);
    await expect(dataStoreNode.locator(".step-shape path.step-shape-lid")).toHaveCount(1);
    await expect(dataStoreNode.locator(".step-shape polygon")).toHaveCount(0);

    await page.reload();
    const reloaded = nodeAt(page, byLabel.Orders!);
    await expect(reloaded).toHaveCSS("width", `${STEP_SIZE.DATA_STORE.width}px`);
    await expect(reloaded).toHaveCSS("height", `${STEP_SIZE.DATA_STORE.height}px`);
    await expect(reloaded.locator(".step-shape path.step-shape-fill")).toHaveCount(1);
  });

  test("an editor sees four connectable handles per step, and a condition on a new edge shows as a label pill", async ({ page }) => {
    await addStepInUi(page, "Cart", "Start");
    await addStepInUi(page, "Done", "Outcome");
    const draft = await draftOf(page, projectId);
    const cartId = Object.values(draft.document.nodes).find((node) => node.label === "Cart")!.id;
    const cartNode = nodeAt(page, cartId);
    await expect(cartNode.locator(".react-flow__handle")).toHaveCount(4);
    await expect(cartNode.locator(".react-flow__handle.connectable")).toHaveCount(4);

    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = dialog(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Cart" });
    await connect.getByLabel("To").selectOption({ label: "Done" });
    await connect.getByLabel("Condition").fill("Payment succeeds");
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await expect(page.locator(".edge-label")).toHaveText("Payment succeeds");
    await expect(page.locator(".edge-label")).toBeVisible();
  });
});

test.describe("Studio canvas handles (read-only, mocked project)", () => {
  const projectId = "c1111111-1111-4111-8111-111111111111";
  const flowId = "d1111111-1111-4111-8111-111111111111";
  const start = "e1111111-1111-4111-8111-111111111111";
  const end = "e2222222-2222-4222-8222-222222222222";
  const node = (id: string, kind: string, label: string) => ({ id, flowId, version: 1, behaviourVersion: 1, kind, label, description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] });
  const draft = () => {
    const view = emptyDraftView();
    return {
      ...view,
      document: {
        ...view.document,
        flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: "Intake", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null } },
        nodes: { [start]: node(start, "START", "Receive form"), [end]: node(end, "OUTCOME", "Filed") },
        edges: {},
      },
      layout: { schemaVersion: 1, positions: { [start]: { x: 0, y: 0, version: 1 }, [end]: { x: 0, y: 160, version: 1 } }, directions: { [flowId]: "TB" } },
    };
  };

  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Canvas Reader");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [], truncated: false }, shared: { items: [{ id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" }], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerId: projectId }, draft: draft() } }));
    await page.goto(`/app/projects/${projectId}`);
  });

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("a reader's steps keep their four handles in the DOM, but none are connectable", async ({ page }) => {
    const startNode = nodeAt(page, start);
    await expect(startNode).toBeVisible();
    await expect(startNode.locator(".react-flow__handle")).toHaveCount(4);
    await expect(startNode.locator(".react-flow__handle.connectable")).toHaveCount(0);
  });
});
