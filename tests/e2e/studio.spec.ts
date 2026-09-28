import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, emptyDraftView, entitle, headerSave, openDatabase, saveStudio, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const panel = (page: Page) => page.locator("#right-panel");
const modal = (page: Page, name: string) => page.getByRole("dialog", { name });
const openModals = (page: Page) => page.locator("dialog[open]");
/** The save's recovery note (Task 14b): Retry, Apply my changes again, Discard my changes. */
const note = (page: Page) => page.locator(".save-note");
const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** A command from "another tab" of the same account. */
async function command(page: Page, projectId: string, draftId: string, body: Record<string, unknown>) {
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/commands`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { commandSchemaVersion: 1, ...body } });
  expect(response.status()).toBe(200);
}


async function createFlowInUi(page: Page, title: string) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = modal(page, "New flow");
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText(title);
  await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
}

async function addStepInUi(page: Page, label: string, shape?: "Start" | "Step" | "Decision" | "Outcome") {
  await toolbar(page).getByRole("button", { name: "Add step" }).click();
  const form = modal(page, "Add step");
  if (shape) await form.getByLabel("Shape").selectOption({ label: shape });
  await form.getByLabel("Name").fill(label);
  await form.getByRole("button", { name: "Add step" }).click();
  await expect(form).toBeHidden();
}

/** The inspector's Save: applies the typed fields, then saves every unsaved change. */
const saveButton = (page: Page) => panel(page).getByRole("button", { name: "Save", exact: true });

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
  test("the toolbox adds and connects steps; the List reads top to bottom and deletes a connection", async ({ page }) => {
    await createFlowInUi(page, "Checkout");
    await addStepInUi(page, "Cart", "Start");
    await addStepInUi(page, "Pay");
    await addStepInUi(page, "Done", "Outcome");
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = modal(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Cart" });
    await connect.getByLabel("To").selectOption({ label: "Pay" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await expect(page.locator(".studio-status")).toContainText("3 steps · 1 connection");
    await expect(page.locator(".react-flow").getByText("Done")).toBeVisible();
    await saveStudio(page);
    expect(Object.keys((await draftOf(page, projectId)).document.edges)).toHaveLength(1);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await expect(page.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveText([/Cart/, /Pay/, /Done/]);
    await page.getByRole("button", { name: "Delete connection Cart → Pay" }).click();
    await expect(page.getByText("Connection deleted.")).toBeVisible();
    await saveStudio(page);
    const draft = await draftOf(page, projectId);
    expect(Object.keys(draft.document.edges)).toHaveLength(0);
    expect(Object.keys(draft.document.nodes)).toHaveLength(3);
  });

  test("Delete never removes steps while someone types in the Studio; on a focused step it asks first and keeps focus on the flow", async ({ page }) => {
    await createFlowInUi(page, "Orders");
    await addStepInUi(page, "Pack", "Start");
    await addStepInUi(page, "Ship");
    await saveStudio(page);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    const search = page.getByLabel("Find a step");
    await search.fill("Sh");
    await search.press("Backspace");
    await search.press("Delete");
    await expect(openModals(page)).toHaveCount(0);
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
    expect(Object.keys((await draftOf(page, projectId)).document.nodes)).toHaveLength(2);

    await search.fill("");
    const ship = page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Ship/ });
    await ship.focus();
    await ship.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, isComposing: true })));
    await expect(openModals(page)).toHaveCount(0);
    await ship.press("Delete");
    const confirm = modal(page, "Delete step");
    await expect(confirm.getByText("Ship")).toBeVisible();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator("#studio-flow-title")).toBeFocused();
    await saveStudio(page);
    expect(Object.values((await draftOf(page, projectId)).document.nodes).map((node) => node.label)).toEqual(["Pack"]);
  });

  test("Add step validates code points without truncating; an unconfirmed save retries its exact batch and later steps save behind it", async ({ page }) => {
    await createFlowInUi(page, "Intake");
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const form = modal(page, "Add step");
    const tooLong = String.fromCodePoint(0x1f600).repeat(161);
    await form.getByLabel("Name").fill(tooLong);
    await form.getByRole("button", { name: "Add step" }).click();
    await expect(form.getByLabel("Name")).toBeFocused();
    await expect(form.getByLabel("Name")).toHaveValue(tooLong);
    await expect(form.getByText(/Name can be up to 160 characters/)).toBeVisible();

    const attempts: { key: string; body: string }[] = [];
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      const response = await route.fetch();
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    await form.getByLabel("Name").fill("Submitted step");
    await form.getByRole("button", { name: "Add step" }).click();
    await expect(form).toBeHidden();
    await headerSave(page).click();
    await expect(note(page)).toContainText("We couldn’t confirm your changes.");
    // Editing continues behind the unconfirmed save.
    await addStepInUi(page, "Newer step");
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]!.key).not.toBe(attempts[0]!.key);
    expect(Object.values((await draftOf(page, projectId)).document.nodes).map((node) => node.label).sort()).toEqual(["Newer step", "Submitted step"]);
  });

  test("Connect adds a connection at once; one made while a save is in flight is saved right after it", async ({ page }) => {
    await createFlowInUi(page, "Decision");
    await addStepInUi(page, "Ask", "Start");
    await addStepInUi(page, "Answer");
    const connectWith = async (condition: string) => {
      await toolbar(page).getByRole("button", { name: "Connect" }).click();
      const form = modal(page, "Connect steps");
      await form.getByLabel("Condition").fill(condition);
      await form.getByRole("button", { name: "Connect" }).click();
      await expect(form).toBeHidden();
    };
    const bodies: { commands: { command: string }[] }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/changes", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) await gate;
      await route.continue();
    });
    await connectWith("Submitted branch");
    await headerSave(page).click();
    await expect(page.locator(".studio-status")).toContainText("Saving…");
    await connectWith("Newer branch");
    await expect(page.locator(".studio-status")).toContainText("2 connections");
    release();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(bodies.map((body) => body.commands.map((command) => command.command))).toEqual([["ADD_NODE", "ADD_NODE", "ADD_EDGE"], ["ADD_EDGE"]]);
    expect(Object.values((await draftOf(page, projectId)).document.edges).map((edge) => edge.condition).sort()).toEqual(["Newer branch", "Submitted branch"]);
  });

  test("Delete step previews its incident connection, and an unconfirmed save of it retries the exact batch", async ({ page }) => {
    await createFlowInUi(page, "Orders");
    await addStepInUi(page, "Pack", "Start");
    await addStepInUi(page, "Ship");
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = modal(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Pack" });
    await connect.getByLabel("To").selectOption({ label: "Ship" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await saveStudio(page);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Ship/ }).press("Delete");
    const confirm = modal(page, "Delete step");
    await expect(confirm).toContainText("This also removes 1 connection");
    await expect(confirm).toContainText("Pack → Ship");
    const attempts: { key: string; body: string }[] = [];
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      const response = await route.fetch();
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await headerSave(page).click();
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(JSON.parse(attempts[0]!.body).commands.map((command: { command: string }) => command.command)).toEqual(["DELETE_NODES"]);
    const draft = await draftOf(page, projectId);
    expect(Object.values(draft.document.nodes).map((node) => node.label)).toEqual(["Pack"]);
    expect(Object.keys(draft.document.edges)).toHaveLength(0);
  });

  test("deleting a flow restores focus after the native modal closes", async ({ page }) => {
    await createFlowInUi(page, "Original");
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "Duplicate Original" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Original");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: /^Delete Copy of Original/ }).click();

    // Simulate an animation callback running before React commits the dialog close.
    await page.evaluate(() => {
      const native = window.requestAnimationFrame.bind(window);
      (window as typeof window & { __focusFrameProbe?: number }).__focusFrameProbe = 0;
      window.requestAnimationFrame = (callback) => {
        if (callback.toString().includes("studio-flow-title")) {
          (window as typeof window & { __focusFrameProbe?: number }).__focusFrameProbe!++;
          callback(performance.now());
          return 0;
        }
        return native(callback);
      };
    });
    await modal(page, "Delete Copy of Original?").getByRole("button", { name: "Delete flow", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Original");
    expect(await page.evaluate(() => (window as typeof window & { __focusFrameProbe?: number }).__focusFrameProbe)).toBeGreaterThan(0);
    await expect(page.locator("#studio-flow-title")).toBeFocused();

    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: /^Delete Original/ }).click();
    await modal(page, "Delete Original?").getByRole("button", { name: "Delete flow", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();
    await expect(page.locator("#editor-main h1")).toBeFocused();
  });

  test("an unconfirmed flow creation keeps the flow, Retry repeats its exact batch, and duplicate and delete survive refresh", async ({ page }) => {
    const attempts: { key: string; body: string }[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      const response = await route.fetch();
      if (attempts.length === 1) await firstGate;
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "New flow" }).click();
    const form = modal(page, "New flow");
    await form.getByLabel("Title").fill("Retry once");
    await form.getByRole("button", { name: "Create flow" }).click();
    // While the new flow saves, the form is read-only, so nothing typed can be lost when it closes.
    await expect(form.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(form.getByLabel("Title")).not.toBeEditable();
    releaseFirst();
    // The flow was created (locally): it opens, and its form closes, so it can never create an identical second one.
    await expect(form).toHaveCount(0);
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    await expect(page.locator(".react-flow")).toBeVisible();
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const original = await draftOf(page, projectId);
    expect(Object.keys(original.document.flows)).toHaveLength(1);
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "Duplicate Retry once" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Retry once");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
    expect(Object.keys((await draftOf(page, projectId)).document.flows)).toHaveLength(2);
    await page.reload();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Retry once");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: /^Delete Copy of Retry once/ }).click();
    const confirmation = modal(page, "Delete Copy of Retry once?");
    await expect(confirmation).toContainText("0 steps and 0 connections");
    await confirmation.getByRole("button", { name: "Delete flow", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    await expect(page.locator("#studio-flow-title")).toBeFocused();
    await saveStudio(page);
    await page.reload();
    await expect(page.locator("#studio-flow-title")).toHaveText("Retry once");
    expect(Object.keys((await draftOf(page, projectId)).document.flows)).toEqual(Object.keys(original.document.flows));
  });

  test("one save carries a flow deletion and the next flow's creation, and an unconfirmed one retries the exact batch", async ({ page }) => {
    await createFlowInUi(page, "Existing");
    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    await flows.getByRole("button", { name: "Duplicate Existing" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Existing");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
    await page.locator(".flow-switch").click();
    await flows.getByRole("button", { name: /^Delete Copy of Existing/ }).click();
    await modal(page, "Delete Copy of Existing?").getByRole("button", { name: "Delete flow", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Existing");
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    const attempts: { key: string; body: string }[] = [];
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      const response = await route.fetch();
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    await page.locator(".flow-switch").click();
    await flows.getByRole("button", { name: "New flow" }).click();
    const form = modal(page, "New flow");
    await form.getByLabel("Title").fill("Second");
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator("#studio-flow-title")).toHaveText("Second");
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(JSON.parse(attempts[0]!.body).commands.map((command: { command: string }) => command.command)).toEqual(["DELETE_FLOW", "CREATE_FLOW"]);
    expect(Object.values((await draftOf(page, projectId)).document.flows).map((flow) => flow.title).sort()).toEqual(["Existing", "Second"]);
  });

  test("Duplicate is disabled while the duplicate's save-first is held, so one click makes exactly one copy", async ({ page }) => {
    await createFlowInUi(page, "Original");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    await page.route("**/changes", async (route) => {
      writes++;
      if (writes === 1) await gate;
      await route.continue();
    });
    await page.locator(".flow-switch").click();
    const flows = modal(page, "Flows");
    const duplicate = flows.getByRole("button", { name: "Duplicate Original" });
    await duplicate.click();
    await expect.poll(() => writes).toBe(1);
    await expect(duplicate).toBeDisabled();
    await duplicate.click({ force: true }); // a second click during the slow save queues nothing
    release();
    await expect(flows).toHaveCount(0);
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Original");
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(writes).toBe(1);
    expect(Object.values((await draftOf(page, projectId)).document.flows).map((flow) => flow.title).sort()).toEqual(["Copy of Original", "Original"]);
  });

  for (const populated of [false, true]) test(`flow creation locks its form while the new flow saves, so no typed value is lost (populated: ${populated})`, async ({ page }) => {
    if (populated) { await createFlowInUi(page, "Existing"); await page.locator(".flow-switch").click(); }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    await page.route("**/changes", async (route) => {
      writes++;
      if (writes === 1) await gate;
      await route.continue();
    });
    await page.getByRole("button", { name: "New flow", exact: true }).click();
    const form = modal(page, "New flow");
    await form.getByLabel("Title").fill("Submitted title");
    await form.getByLabel("Type").selectOption("BUSINESS_PROCESS");
    await form.getByRole("button", { name: "Create flow" }).click();
    await expect(form.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(form.getByLabel("Title")).not.toBeEditable();
    await expect(form.getByLabel("Type")).toBeDisabled();
    await expect(form.getByLabel("Scope")).toBeDisabled();
    release();
    await expect(form).toHaveCount(0);
    await expect(page.locator("#studio-flow-title")).toHaveText("Submitted title");
    const saved = Object.values((await draftOf(page, projectId)).document.flows).find((flow) => flow.title === "Submitted title")!;
    expect([saved.classification, saved.inclusion]).toEqual(["BUSINESS_PROCESS", "UNDECIDED"]);
    expect(writes).toBe(1);
  });

  test("create, connect, edit and duplicate a flow; a reload shows the same saved ids and content", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();
    await createFlowInUi(page, "Checkout");
    await addStepInUi(page, "Cart", "Start");
    await addStepInUi(page, "Pay");
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = modal(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Cart" });
    await connect.getByLabel("To").selectOption({ label: "Pay" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await expect(page.locator(".studio-status")).toContainText("2 steps · 1 connection");

    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Pay/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Name").fill("Pay by card");
    await saveButton(page).click();
    await expect(panel(page).getByText("Saved.")).toBeVisible();
    const before = await draftOf(page, projectId);

    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "Duplicate Checkout" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Copy of Checkout");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished

    await page.reload();
    await expect(page.locator("#studio-flow-title")).toHaveText("Checkout");
    await expect(page.locator(".react-flow").getByText("Pay by card")).toBeVisible();
    const after = await draftOf(page, projectId);
    expect(Object.keys(after.document.flows)).toHaveLength(2);
    for (const [id, node] of Object.entries(before.document.nodes)) expect(after.document.nodes[id]).toEqual(node);
    expect(Object.values(after.document.nodes).filter((node) => node.label === "Pay by card")).toHaveLength(2);
    expect(Object.keys(after.document.edges)).toHaveLength(2);
  });

  test("keyboard only: create a flow, add and connect steps, and rename one", async ({ page }) => {
    const press = async (target: Locator, key = "Enter") => { await target.focus(); await page.keyboard.press(key); };
    await press(page.getByRole("button", { name: "New flow" }));
    await page.keyboard.type("Returns");
    await page.keyboard.press("Enter");
    await expect(page.locator("#studio-flow-title")).toHaveText("Returns");
    await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
    for (const label of ["Request return", "Refund issued"]) {
      await press(toolbar(page).getByRole("button", { name: "Add step" }));
      await page.keyboard.press("Tab"); // Shape → Name
      await page.keyboard.type(label);
      await page.keyboard.press("Enter");
      await expect(modal(page, "Add step")).toBeHidden();
    }
    // Connect opens with the last added step ("Refund issued") as the source.
    await press(toolbar(page).getByRole("button", { name: "Connect" }));
    await page.keyboard.press("ArrowUp"); // From: Request return
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown"); // To: Refund issued
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(modal(page, "Connect steps")).toBeHidden();

    await press(toolbar(page).getByRole("button", { name: "List" }));
    await press(page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Refund issued/ }));
    await press(page.getByRole("button", { name: "Inspect" }));
    await panel(page).getByLabel("Name").focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" to card");
    await page.keyboard.press("Enter");
    await expect(panel(page).getByText("Saved.")).toBeVisible();
    // Delete inside a text field edits text only; it never reaches the graph.
    await panel(page).getByLabel("Name").press("Delete");
    await expect(openModals(page)).toHaveCount(0);

    const draft = await draftOf(page, projectId);
    const nodes = Object.values(draft.document.nodes);
    const request = nodes.find((node) => node.label === "Request return")!;
    const refund = nodes.find((node) => node.label === "Refund issued to card")!;
    expect(Object.values(draft.document.edges).map((edge) => [edge.fromId, edge.toId])).toEqual([[request.id, refund.id]]);
  });

  test("typed text survives someone else's change; the person applies their changes again", async ({ page }) => {
    await createFlowInUi(page, "Billing");
    await addStepInUi(page, "Invoice", "Start");
    await saveStudio(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    const name = panel(page).getByLabel("Name");
    await name.fill("Invoice (mine)");

    const draft = await draftOf(page, projectId);
    const invoice = Object.values(draft.document.nodes)[0]!;
    await command(page, projectId, draft.id, { command: "UPDATE_NODE", expectedEntityVersion: invoice.version, payload: { nodeId: invoice.id, label: "Invoice (theirs)" } });

    // Adding a step is local: nothing refuses it until the save meets the other tab's change.
    await addStepInUi(page, "Paid");
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Invoice/ }).click();
    await expect(name).toHaveValue("Invoice (mine)");
    await saveButton(page).click();
    await expect(note(page)).toContainText("Someone else changed this draft first, so your changes weren’t saved.");
    await expect(page.getByRole("list", { name: "Steps" })).toContainText("Invoice (mine)");
    expect((await draftOf(page, projectId)).document.nodes[invoice.id]!.label).toBe("Invoice (theirs)");
    // Before anything is sent again, the overlap is shown: their saved value, my edit and the original.
    const compared = note(page).locator(".conflict-list");
    await expect(compared).toContainText("Saved valueInvoice (theirs)");
    await expect(compared).toContainText("Your editInvoice (mine)");
    await expect(compared).toContainText("Before your editInvoice");
    await expect(compared.getByRole("button", { name: "Keep theirs" })).toBeVisible();
    await note(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    const saved = await draftOf(page, projectId);
    expect(saved.document.nodes[invoice.id]!.label).toBe("Invoice (mine)");
    expect(Object.values(saved.document.nodes).map((node) => node.label).sort()).toEqual(["Invoice (mine)", "Paid"]);
  });

  test("text typed while a save is in flight stays unsaved after the acknowledgement", async ({ page }) => {
    await createFlowInUi(page, "Support");
    await addStepInUi(page, "Ticket", "Start");
    await page.getByRole("button", { name: "Inspect" }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/drafts/*/changes", async (route) => { await held; await route.continue(); });
    const name = panel(page).getByLabel("Name");
    await name.fill("Ticket opened");
    await saveButton(page).click();
    await expect(page.locator(".studio-status")).toContainText("Saving…");
    await name.press("End");
    await name.pressSequentially(" by email");
    release();
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    await expect(panel(page).getByText("Saved.", { exact: true })).toHaveCount(0);
    await expect(name).toHaveValue("Ticket opened by email");
    await expect(saveButton(page)).toBeEnabled();
    await page.unroute("**/drafts/*/changes");
    expect(Object.values((await draftOf(page, projectId)).document.nodes)[0]!.label).toBe("Ticket opened");
    await saveButton(page).click();
    await expect.poll(async () => Object.values((await draftOf(page, projectId)).document.nodes)[0]!.label).toBe("Ticket opened by email");
  });

  test("an unconfirmed save keeps its key, and Retry repeats the same request once", async ({ page }) => {
    await createFlowInUi(page, "Onboarding");
    await addStepInUi(page, "Welcome", "Start");
    await page.getByRole("button", { name: "Inspect" }).click();
    const keys: string[] = [];
    let lose = true;
    await page.route("**/drafts/*/changes", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (!lose) return route.continue();
      lose = false;
      await route.fetch(); // the server commits, then the acknowledgement is lost
      return route.abort("connectionreset");
    });
    await panel(page).getByLabel("Name").fill("Welcome aboard");
    await saveButton(page).click();
    await expect(note(page)).toContainText("We couldn’t confirm your changes.");
    await expect(panel(page).getByText("Saved.", { exact: true })).toHaveCount(0);
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    await page.unroute("**/drafts/*/changes");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const node = Object.values((await draftOf(page, projectId)).document.nodes)[0]!;
    expect([node.label, node.version]).toEqual(["Welcome aboard", 2]);
  });

  for (const leaveInspector of [false, true]) test(`Retry settles an unconfirmed save and preserves newer typing (leave: ${leaveInspector})`, async ({ page }) => {
    await createFlowInUi(page, "Recovery");
    await addStepInUi(page, "Initial", "Start");
    await page.getByRole("button", { name: "Inspect" }).click();
    const attempts: { key: string; body: string }[] = [];
    await page.route("**/drafts/*/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (attempts.length === 1) { await route.fetch(); await route.abort("connectionreset"); }
      else await route.continue();
    });
    const name = panel(page).getByLabel("Name");
    await name.fill("Acknowledged");
    await saveButton(page).click();
    await expect(note(page).getByRole("button", { name: "Retry" })).toBeVisible();
    await name.fill("Newer typing");
    if (leaveInspector) {
      await panel(page).getByRole("button", { name: /Project$/ }).focus();
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("tab", { name: "Details" })).toBeFocused();
    }
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Acknowledged/ }).click();
    await expect(name).toHaveValue("Newer typing");
    await expect(note(page)).toHaveCount(0);
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect.poll(async () => Object.values((await draftOf(page, projectId)).document.nodes)[0]!.label).toBe("Newer typing");
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]!.key).not.toBe(attempts[0]!.key);
    expect(JSON.parse(attempts[2]!.body).commands[0].expectedEntityVersion).toBe(2);
  });

  test("a step deleted in another tab keeps the typed text for copying and is never re-created", async ({ page }) => {
    await createFlowInUi(page, "Claims");
    await addStepInUi(page, "Assess", "Start");
    await saveStudio(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Description").fill("Check the policy number first");
    const draft = await draftOf(page, projectId);
    const flowId = Object.keys(draft.document.flows)[0]!;
    const nodeId = Object.keys(draft.document.nodes)[0]!;
    await command(page, projectId, draft.id, { command: "DELETE_NODES", expectedDocumentRevision: draft.documentRevision, payload: { flowId, nodeIds: [nodeId], removeEdgeIds: [] } });
    // The next save meets the deletion; applying again on the newer draft keeps only what still applies.
    await addStepInUi(page, "Probe");
    await headerSave(page).click();
    await note(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(note(page)).toHaveCount(0);
    // The typed description still counts as unsaved: it belongs to the removed step.
    await expect.poll(async () => Object.values((await draftOf(page, projectId)).document.nodes).map((node) => node.label)).toEqual(["Probe"]);
    await page.locator(".studio-status").getByRole("button", { name: "Unsaved text for a removed item" }).click();
    await expect(panel(page).getByRole("heading", { name: "This step was removed" })).toBeVisible();
    await expect(panel(page).getByLabel("Your unsaved text")).toHaveValue("Description: Check the policy number first");
    await panel(page).getByRole("button", { name: "Discard" }).click();
    await expect(panel(page).getByRole("heading", { name: "Project" })).toBeVisible();
    expect(Object.values((await draftOf(page, projectId)).document.nodes).map((node) => node.label)).toEqual(["Probe"]);
  });

  test("switching projects guards Studio edits and Discard clears a refused save", async ({ page }) => {
    await createProjectViaApi(page, "Other project");
    await page.reload();
    await createFlowInUi(page, "Intake");
    await addStepInUi(page, "Receive", "Start");
    await saveStudio(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    const name = panel(page).getByLabel("Name");
    await name.fill("Receive claim");
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Unsaved changes in Studio project" });
    await expect(guard.getByText("1 unsaved field(s).")).toBeVisible();
    await guard.getByRole("button", { name: "Stay" }).click();
    await expect(guard).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}$`));
    await expect(name).toHaveValue("Receive claim");
    await page.route("**/drafts/*/changes", (route) => route.fulfill({ status: 400, json: { error: { code: "INVALID_INPUT", message: "Rejected Studio save" } } }));
    await saveButton(page).click();
    await expect(page.locator(".studio-status")).toContainText("Your changes weren’t saved.");
    await expect(note(page)).toContainText("Rejected Studio save");
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
    await page.locator("#projects-nav").getByRole("button", { name: "Studio project", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Intake");
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Receive/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(name).toHaveValue("Receive");
    await expect(page.locator(".studio-status")).not.toContainText("weren’t saved");
    await expect(note(page)).toHaveCount(0);
  });

  test("deleting from the inspector returns keyboard focus to the surviving flow", async ({ page }) => {
    await createFlowInUi(page, "Focus");
    await addStepInUi(page, "Remove me", "Start");
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByRole("button", { name: /Delete step/ }).click();
    await modal(page, "Delete step").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator("#studio-flow-title")).toBeFocused();
  });

  test("flow and connection inspectors save fields and reconnect through the real draft", async ({ page }) => {
    await createFlowInUi(page, "Triage");
    await addStepInUi(page, "Received", "Start");
    await addStepInUi(page, "Reviewed");
    await addStepInUi(page, "Closed", "Outcome");
    await toolbar(page).getByRole("button", { name: "Flow details" }).click();
    await panel(page).getByLabel("Title", { exact: true }).fill("Case triage");
    await panel(page).getByLabel("Purpose").fill("Review cases");
    await panel(page).getByLabel("Type", { exact: true }).selectOption("BUSINESS_PROCESS");
    await panel(page).getByLabel("Scope", { exact: true }).selectOption("INCLUDED");
    await saveButton(page).click();
    await expect(panel(page).getByText("Saved.", { exact: true })).toBeVisible();
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = modal(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Received" });
    await connect.getByLabel("To").selectOption({ label: "Reviewed" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Connections" }).getByRole("button", { name: /^Received/ }).click();
    await panel(page).getByLabel("To", { exact: true }).selectOption({ label: "Closed" });
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Received/ }).click();
    await page.getByRole("list", { name: "Connections" }).getByRole("button", { name: /^Received/ }).click();
    await expect(panel(page).getByLabel("To", { exact: true })).toHaveValue(Object.values((await draftOf(page, projectId)).document.nodes).find((node) => node.label === "Closed")!.id);
    await panel(page).getByLabel("Condition").fill("Valid case");
    await saveButton(page).click();
    await expect(saveButton(page)).toBeDisabled();
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    await expect(panel(page).getByLabel("To", { exact: true }).locator("option:checked")).toHaveText("Closed");
    await panel(page).getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Received.*Closed/);
    await panel(page).getByLabel("To", { exact: true }).selectOption({ label: "Reviewed" });
    const requests: { key: string; body: string }[] = [];
    await page.route("**/drafts/*/changes", async (route) => {
      requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (requests.length === 1) { await route.fetch(); await route.abort("connectionreset"); }
      else await route.continue();
    });
    await headerSave(page).click();
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(note(page)).toHaveCount(0);
    expect(requests[1]).toEqual(requests[0]);
    const sent = JSON.parse(requests[0]!.body).commands as { command: string; payload: Record<string, unknown> }[];
    expect(sent.map((item) => item.command)).toEqual(["RECONNECT_EDGE"]);
    expect(sent[0]!.payload.condition).toBeUndefined();
    const draft = await draftOf(page, projectId);
    const flow = Object.values(draft.document.flows)[0]!;
    expect([flow.title, flow.purpose, flow.classification, flow.inclusion]).toEqual(["Case triage", "Review cases", "BUSINESS_PROCESS", "INCLUDED"]);
    const edge = Object.values(draft.document.edges)[0]!;
    expect(edge.condition).toBe("Valid case");
    expect(draft.document.nodes[edge.toId]!.label).toBe("Closed");
    await expect(panel(page).getByLabel("To", { exact: true }).locator("option:checked")).toHaveText("Reviewed");
    await expect(panel(page).getByRole("button", { name: "Reconnect" })).toBeEnabled();
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    await page.unroute("**/drafts/*/changes");
    await panel(page).getByRole("button", { name: "Reconnect" }).click();
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Received.*Reviewed/);
    await panel(page).getByRole("button", { name: "Delete connection", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: "Project", exact: true })).toBeVisible();
    await saveStudio(page);
    expect(Object.keys((await draftOf(page, projectId)).document.edges)).toHaveLength(0);
  });

  test("endpoint edits made against an older draft need an explicit, inspected reapply", async ({ page }) => {
    await createFlowInUi(page, "Connections");
    await addStepInUi(page, "Start", "Start");
    await addStepInUi(page, "Original");
    await addStepInUi(page, "Mine");
    await addStepInUi(page, "Remote");
    await saveStudio(page);
    let draft = await draftOf(page, projectId);
    const nodes = Object.fromEntries(Object.values(draft.document.nodes).map((node) => [node.label, node.id]));
    const flowId = Object.keys(draft.document.flows)[0]!;
    await command(page, projectId, draft.id, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId, fromId: nodes.Start, toId: nodes.Original, condition: "" } });
    await page.reload();
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Connections" }).getByRole("button", { name: /^Start/ }).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await panel(page).getByLabel("To", { exact: true }).selectOption(nodes.Mine!);
    const before = await draftOf(page, projectId);
    const edge = Object.values(before.document.edges)[0]!;
    await command(page, projectId, before.id, { command: "RECONNECT_EDGE", expectedDocumentRevision: before.documentRevision,
      payload: { edgeId: edge.id, fromId: nodes.Remote, toId: nodes.Original } });
    // A condition save meets the remote reconnect; discarding it re-reads the draft while the endpoint choice stays local.
    await panel(page).getByLabel("Condition").fill("My condition");
    await saveButton(page).click();
    await expect(note(page)).toContainText("Someone else changed this draft first");
    await note(page).getByRole("button", { name: "Discard my changes" }).click();
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Remote.*Original/);
    const requests: Record<string, unknown>[] = [];
    await page.route("**/drafts/*/changes", async (route) => { requests.push(route.request().postDataJSON()); await route.continue(); });
    await page.getByRole("list", { name: "Connections" }).getByRole("button", { name: /^Remote/ }).click();
    await panel(page).getByRole("button", { name: "Reconnect", exact: true }).click();
    const conflict = panel(page).getByRole("alert");
    await expect(conflict).toContainText("Saved connectionRemote");
    await expect(conflict).toContainText("Your connectionStart");
    await expect(conflict).toContainText("Before your editStart");
    await expect(panel(page).getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
    expect(Object.values((await draftOf(page, projectId)).document.edges)[0]!.fromId).toBe(nodes.Remote);
    await conflict.getByRole("button", { name: "Apply my connection" }).click();
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Start.*Mine/);
    expect(requests).toHaveLength(0);
    await saveStudio(page);
    draft = await draftOf(page, projectId);
    expect(Object.values(draft.document.edges)[0]).toMatchObject({ fromId: nodes.Start, toId: nodes.Mine });
    expect(requests).toHaveLength(1);
    expect((requests[0]!.commands as { expectedDocumentRevision: number }[])[0]!.expectedDocumentRevision).toBe(before.documentRevision + 1);
  });

  test("an unconfirmed List delete survives Stay, Discard and a project switch, and every retry repeats the exact request", async ({ page }) => {
    const otherId = await createProjectViaApi(page, "Other project");
    await page.reload();
    await createFlowInUi(page, "Recovery");
    await addStepInUi(page, "From", "Start");
    await addStepInUi(page, "To", "Outcome");
    await saveStudio(page);
    let draft = await draftOf(page, projectId);
    const nodes = Object.values(draft.document.nodes);
    await command(page, projectId, draft.id, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId: nodes[0]!.flowId, fromId: nodes[0]!.id, toId: nodes[1]!.id, condition: "" } });
    await page.reload();
    await toolbar(page).getByRole("button", { name: "List" }).click();
    const requests: { key: string; body: string }[] = [];
    await page.route("**/drafts/*/changes", async (route) => {
      requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (requests.length <= 3) {
        await route.fetch();
        await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      } else await route.continue();
    });
    await page.getByRole("button", { name: /^Delete connection/ }).click();
    await headerSave(page).click();
    await expect(note(page).getByRole("button", { name: "Retry" })).toBeVisible();
    const committed = await draftOf(page, projectId);
    expect(Object.keys(committed.document.edges)).toHaveLength(0);
    expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    // A switch saves first: the unconfirmed batch is retried with its own key, and stays unconfirmed.
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    const guard = modal(page, "Unsaved changes in Studio project");
    await expect(guard).toContainText("unconfirmed change");
    await guard.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}$`));
    await expect(note(page).getByRole("button", { name: "Retry" })).toBeVisible();
    await page.locator("#projects-nav").getByRole("button", { name: "Other project", exact: true }).click();
    await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${otherId}$`));
    await expect(note(page)).toHaveCount(0);
    await page.locator("#projects-nav").getByRole("button", { name: "Studio project", exact: true }).click();
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request).toEqual(requests[0]);
    draft = await draftOf(page, projectId);
    expect(draft.documentRevision).toBe(committed.documentRevision);
    expect(Object.keys(draft.document.edges)).toHaveLength(0);
    expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  });

  for (const { uncertain, failedRead } of [{ uncertain: false, failedRead: false }, { uncertain: true, failedRead: false }, { uncertain: false, failedRead: true }]) test(`an in-flight save stays locked after browser history remount (uncertain: ${uncertain}, failed read: ${failedRead})`, async ({ page }) => {
    await createProjectViaApi(page, "History project");
    await page.reload();
    await createFlowInUi(page, "History recovery");
    await addStepInUi(page, "From", "Start");
    await addStepInUi(page, "To", "Outcome");
    await saveStudio(page);
    const draft = await draftOf(page, projectId);
    const nodes = Object.values(draft.document.nodes);
    await command(page, projectId, draft.id, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId: nodes[0]!.flowId, fromId: nodes[0]!.id, toId: nodes[1]!.id, condition: "" } });
    await page.reload();
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.locator("#projects-nav").getByRole("button", { name: "History project", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "History project" })).toBeVisible();
    await page.locator("#projects-nav").getByRole("button", { name: "Studio project", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Studio project" })).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requests: { key: string; body: string }[] = [];
    if (failedRead) await page.route(`**/drafts/${draft.id}`, (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } }));
    await page.route("**/drafts/*/changes", async (route) => {
      requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (requests.length !== 1) return route.continue();
      await held;
      const response = await route.fetch();
      if (uncertain) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: /^Delete connection/ }).click();
      await headerSave(page).click();
      await expect.poll(() => requests.length).toBe(1);
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: "History project" })).toBeVisible();
      await page.goForward();
      await expect(page.getByRole("heading", { level: 1, name: "Studio project" })).toBeVisible();
      await expect(page.locator(".studio-status")).toContainText("Saving");
      await expect(headerSave(page)).toBeDisabled();
      // Editing is never locked by a save: new changes queue behind it.
      await expect(toolbar(page).getByRole("button", { name: "Add step", exact: true })).toBeEnabled();
      await expect(note(page)).toHaveCount(0);
      expect(requests).toHaveLength(1);
      release();
      if (uncertain) {
        await expect(note(page).getByRole("button", { name: "Retry" })).toBeEnabled();
        await note(page).getByRole("button", { name: "Retry" }).click();
      }
      if (failedRead) {
        await expect(page.locator(".studio-status")).toContainText("Changes saved. The latest draft could not load.");
        await expect(page.locator(".studio-status")).not.toContainText("All changes saved");
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "History project" })).toBeVisible();
        await page.goForward();
        await expect(page.getByRole("heading", { level: 1, name: "Studio project" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Retry read", exact: true })).toHaveCount(0);
      }
      await expect(page.locator(".studio-status")).toContainText("0 connections");
      await expect(page.locator(".studio-status")).toContainText("All changes saved");
      await expect(page.locator(".studio-status")).not.toContainText("couldn’t confirm");
      await expect(note(page)).toHaveCount(0);
      expect(requests).toHaveLength(uncertain ? 2 : 1);
      if (uncertain) expect(requests[1]).toEqual(requests[0]);
      const saved = await draftOf(page, projectId);
      expect(saved.documentRevision).toBe(draft.documentRevision + 2);
      expect(Object.keys(saved.document.edges)).toHaveLength(0);
      expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
    } finally { release(); }
  });

  test("a pre-command bootstrap and stale draft read cannot clear acknowledged refresh failure", async ({ page }) => {
    await createFlowInUi(page, "Read ordering");
    await addStepInUi(page, "Before", "Start");
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await panel(page).getByRole("button", { name: /Project$/ }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let captured = false;
    let staleDraft!: DraftView;
    await page.route(`**/projects/${projectId}/bootstrap`, async (route) => {
      const response = await route.fetch();
      staleDraft = (await response.json() as { draft: DraftView }).draft;
      captured = true;
      await held;
      await route.fulfill({ response });
    });
    let mode: "failed" | "stale" | "fresh" = "failed";
    let writes = 0;
    await page.route("**/drafts/*/changes", async (route) => { writes += 1; await route.continue(); });
    try {
      await panel(page).getByLabel("Project name").fill("Metadata reread");
      await saveButton(page).click();
      await expect.poll(() => captured).toBe(true);
      await page.route(`**/drafts/${staleDraft.id}`, async (route) => {
        if (mode === "failed") await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } });
        else if (mode === "stale") await route.fulfill({ json: staleDraft });
        else await route.continue();
      });
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Before/ }).click();
      await panel(page).getByLabel("Name", { exact: true }).fill("After");
      await saveButton(page).click();
      await expect(page.locator(".studio-status")).toContainText("Changes saved. The latest draft could not load.");
      release();
      await expect(page.getByRole("heading", { level: 1, name: "Metadata reread" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry read", exact: true })).toBeVisible();
      await expect(page.locator(".studio-status")).not.toContainText("All changes saved");
      mode = "stale";
      const staleRead = page.waitForResponse((response) => response.url().endsWith(`/drafts/${staleDraft.id}`));
      await page.getByRole("button", { name: "Retry read", exact: true }).click();
      await staleRead;
      await expect(page.getByRole("button", { name: "Retry read", exact: true })).toBeVisible();
      await expect(page.locator(".studio-status")).not.toContainText("All changes saved");
      mode = "fresh";
      await page.getByRole("button", { name: "Retry read", exact: true }).click();
      await expect(page.getByRole("list", { name: "Steps" })).toContainText("After");
      await expect(page.getByRole("button", { name: "Retry read", exact: true })).toHaveCount(0);
      await expect(page.locator(".studio-status")).toContainText("All changes saved");
      expect(writes).toBe(1);
    } finally { release(); }
  });

  test("a canvas connection is local at once; a refused save of it reports failure in Studio status", async ({ page }) => {
    await createFlowInUi(page, "Canvas connection");
    await addStepInUi(page, "Start", "Start");
    await addStepInUi(page, "End", "Outcome");
    await saveStudio(page);
    const draft = await draftOf(page, projectId);
    const nodes = Object.fromEntries(Object.values(draft.document.nodes).map((node) => [node.label, node.id]));
    await page.route("**/drafts/*/changes", (route) => route.fulfill({ status: 400, json: { error: { code: "INVALID_INPUT", message: "Connection refused" } } }));
    // Four sides per step (UI02) are all connectable; the bottom/top pair is the default TB routing. Each side is
    // two stacked handle elements (source- and target-typed, Task 13 fix round 1); `.first()` picks one of the pair.
    await page.locator(`.react-flow__node[data-id="${nodes.Start}"] .react-flow__handle[data-handleid="bottom"]`).first().dragTo(
      page.locator(`.react-flow__node[data-id="${nodes.End}"] .react-flow__handle[data-handleid="top"]`).first(),
    );
    await expect(page.locator(".studio-status")).toContainText("1 connection");
    await headerSave(page).click();
    await expect(page.locator(".studio-status")).toContainText("Your changes weren’t saved.");
    await expect(note(page)).toContainText("Connection refused");
    expect(Object.values((await draftOf(page, projectId)).document.edges)).toHaveLength(0);
  });

  test("a stale canvas reconnect stays on screen and is applied again only when the person chooses", async ({ page }) => {
    await createFlowInUi(page, "Canvas recovery");
    await addStepInUi(page, "Start", "Start");
    await addStepInUi(page, "Original");
    await addStepInUi(page, "Mine");
    await addStepInUi(page, "Remote");
    await saveStudio(page);
    let draft = await draftOf(page, projectId);
    const nodes = Object.fromEntries(Object.values(draft.document.nodes).map((node) => [node.label, node.id]));
    await command(page, projectId, draft.id, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId: Object.keys(draft.document.flows)[0]!, fromId: nodes.Start, toId: nodes.Original, condition: "" } });
    await page.reload();
    await expect(page.locator(".react-flow__edgeupdater-target")).toHaveCount(1);
    draft = await draftOf(page, projectId);
    const edge = Object.values(draft.document.edges)[0]!;
    await command(page, projectId, draft.id, { command: "RECONNECT_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { edgeId: edge.id, fromId: nodes.Remote, toId: nodes.Original } });
    const requests: { commands: Record<string, unknown>[] }[] = [];
    await page.route("**/drafts/*/changes", async (route) => { requests.push(route.request().postDataJSON()); await route.continue(); });
    await page.locator(".react-flow__edgeupdater-target").dragTo(page.locator(`.react-flow__node[data-id="${nodes.Mine}"] .react-flow__handle[data-handleid="top"]`).first());
    await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toBeVisible();
    expect(requests).toHaveLength(0);
    await headerSave(page).click();
    await expect(note(page)).toContainText("Someone else changed this draft first");
    expect(requests[0]!.commands[0]).toMatchObject({ command: "RECONNECT_EDGE", expectedDocumentRevision: draft.documentRevision,
      payload: { edgeId: edge.id, fromId: nodes.Start, toId: nodes.Mine } });
    expect(Object.values((await draftOf(page, projectId)).document.edges)[0]!.fromId).toBe(nodes.Remote);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await expect(page.getByRole("list", { name: "Connections" })).toContainText(/Start.*Mine/); // mine stays on screen
    await note(page).getByRole("button", { name: "Apply my changes again" }).click();
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.commands[0]).toMatchObject({ expectedDocumentRevision: draft.documentRevision + 1 });
    expect(Object.values((await draftOf(page, projectId)).document.edges)[0]).toMatchObject({ fromId: nodes.Start, toId: nodes.Mine });
  });

  test("local Archive preserves typed Studio text for copying and explicit discard", async ({ page }) => {
    await createFlowInUi(page, "Review");
    await addStepInUi(page, "Keep", "Start");
    await saveStudio(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Description").fill("Archive local text");
    await panel(page).getByRole("button", { name: /Project$/ }).click();
    await panel(page).getByLabel("Project name").fill("Unsaved metadata");
    await panel(page).getByRole("button", { name: /Archive project/ }).click();
    const archive = modal(page, "Archive Studio project?");
    await archive.getByLabel("Reason").fill("Review later");
    await archive.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(archive).toBeHidden();
    await expect(page.locator(".editor-banner")).toContainText("Archived");
    await expect(page.getByRole("heading", { level: 1, name: "Studio project" })).toBeVisible();
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Keep/ }).click();
    await expect(panel(page).getByLabel("Your unsaved text")).toHaveValue("Description: Archive local text");
    await expect(saveButton(page)).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await panel(page).getByRole("button", { name: "Discard", exact: true }).click();
    await expect(panel(page).getByLabel("Your unsaved text")).toHaveCount(0);
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
  });

  test("inspector text survives panel and selection changes, validates code points and respects composition", async ({ page }) => {
    await createFlowInUi(page, "Drafting");
    await addStepInUi(page, "First", "Start");
    await addStepInUi(page, "Second");
    await toolbar(page).getByRole("button", { name: "List" }).click();
    const steps = page.getByRole("list", { name: "Steps" });
    await steps.getByRole("button", { name: /First/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    const name = panel(page).getByLabel("Name");
    const long = "\u{1f642}".repeat(161);
    await name.fill(long);
    await expect(name).toHaveValue(long);
    await saveButton(page).click();
    await expect(name).toBeFocused();
    await expect(panel(page).getByText("Name can be up to 160 characters (now 161).")).toBeVisible();
    await panel(page).getByRole("button", { name: "Close panel" }).click();
    await steps.getByRole("button", { name: /Second/ }).click();
    await expect(panel(page)).toBeHidden();
    await steps.getByRole("button", { name: /First/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(name).toHaveValue(long);
    await name.fill("\u{1f642}".repeat(160));
    let writes = 0;
    page.on("request", (request) => { if (/\/(commands|changes)$/.test(request.url()) && request.method() === "POST") writes++; });
    await name.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    expect(writes).toBe(0);
    await panel(page).getByLabel("Description").fill("Complete description");
    await panel(page).getByLabel("Description").press("Control+Enter");
    await expect(panel(page).getByText("Saved.", { exact: true })).toBeVisible();
    const draft = await draftOf(page, projectId);
    const saved = Object.values(draft.document.nodes).find((node) => node.kind === "START")!;
    expect([...saved.label]).toHaveLength(160);
    expect(saved.description).toBe("Complete description");
    expect(writes).toBe(1);
  });

  test("a save that finds the session ended returns to sign-in without keeping the typed text", async ({ page }) => {
    await createFlowInUi(page, "Access");
    await addStepInUi(page, "Check", "Start");
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Name").fill("Check badge");
    await page.evaluate(() => { (window as Window & { studioSessionMarker?: boolean }).studioSessionMarker = true; });
    await page.context().clearCookies();
    await saveButton(page).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByText("Check badge")).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { studioSessionMarker?: boolean }).studioSessionMarker)).toBeUndefined();
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
      layout: { schemaVersion: 1, positions: { [start]: { x: 0, y: 0, version: 1 }, [long]: { x: 260, y: 80, version: 1 }, [end]: { x: 0, y: 160, version: 1 } }, directions: Object.fromEntries([flowId, ...extra].map((id) => [id, "TB"])), edgeSides: {} },
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
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(panel(page).getByText("Full description text", { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
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
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const add = modal(page, "Add step");
    await expect(add.getByLabel("Shape")).toBeVisible();
    await expect(add.getByLabel("Name")).toBeVisible();
    expect(await pageFits(page)).toBe(true);
    await add.getByRole("button", { name: "Cancel" }).click();
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
  test("keyboard List selection survives filtering, Canvas pan and zoom never write, and a drag writes only one batch, on Save", async ({ page }) => {
    await mock(page, "OWNER");
    let writes = 0;
    let saves = 0;
    await page.route(/\/(commands|positions)$/, async (route) => { writes++; await route.abort(); });
    // Task 14b: an editor's drag stays unsaved until Save (or autosave), then saves in one batch.
    await page.route("**/changes", async (route) => { saves++; await route.abort(); });
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
    await node.dragTo(node, { sourcePosition: { x: 30, y: 30 }, targetPosition: { x: 90, y: 90 }, steps: 5 });
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    expect(saves).toBe(0);
    await headerSave(page).click();
    // The lost acknowledgement keeps the moved step on screen with a same-key Retry.
    await expect(note(page)).toContainText("We couldn’t confirm your changes.");
    await expect(node).not.toHaveAttribute("style", before!);
    await page.getByRole("button", { name: "Zoom In", exact: true }).click();
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    expect(writes).toBe(0);
    expect(saves).toBe(1);
    await page.screenshot({ path: test.info().outputPath("studio-canvas.png") });
  });

  for (const [role, status] of [["VIEWER", "ACTIVE"], ["OWNER", "ARCHIVED"]]) test(`a read-only canvas (${role}, ${status}) never moves, queues or saves a dragged step`, async ({ page }) => {
    await mock(page, role!, status);
    let writes = 0;
    await page.route(/\/(commands|positions|changes)$/, async (route) => { writes++; await route.abort(); });
    await page.goto(`/app/projects/${projectId}`);
    const node = page.locator(`.react-flow__node[data-id="${start}"]`);
    await expect(node).toBeVisible();
    const before = await node.getAttribute("style");
    await node.dragTo(node, { sourcePosition: { x: 30, y: 30 }, targetPosition: { x: 90, y: 90 }, steps: 5 });
    await expect(node).toHaveAttribute("style", before!);
    // Readers never get an outbox: no Save, nothing unsaved.
    await expect(headerSave(page)).toHaveCount(0);
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
    expect(writes).toBe(0);
  });

  test("an unconfirmed List deletion retries its exact batch after switching views", async ({ page }) => {
    await mock(page, "OWNER");
    const attempts: { key: string; body: string }[] = [];
    const initial = draft();
    await page.route("**/drafts/" + initial.id, async (route) => route.fulfill({ json: { ...initial, documentRevision: 2, document: { ...initial.document, edges: {} } } }));
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Response lost" } } });
      else await route.fulfill({ json: { draftId: initial.id, documentRevision: 2, layoutRevision: 1, eventSequence: 1, createdIds: [], versions: {}, positions: {}, replayed: true } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: /^Delete connection Receive form/ }).click();
    await headerSave(page).click();
    await expect(note(page).getByRole("button", { name: "Retry" })).toBeVisible();
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".studio-status")).toContainText("0 connections");
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(note(page)).toHaveCount(0);
  });

  test("Delete on a selected connection removes it at once and Undo brings it back; on a step Delete still asks first", async ({ page }) => {
    await mock(page, "OWNER");
    let writes = 0;
    await page.route(/\/(commands|positions|changes)$/, async (route) => { writes++; await route.abort(); });
    await page.goto(`/app/projects/${projectId}`);
    const path = page.locator(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`);
    await expect(path).toHaveCount(1);
    const point = await path.evaluate((element: SVGPathElement) => {
      const at = element.getPointAtLength(element.getTotalLength() / 2).matrixTransform(element.getScreenCTM()!);
      return { x: at.x, y: at.y };
    });
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toHaveClass(/selected/);
    await page.keyboard.press("Delete");
    await expect(openModals(page)).toHaveCount(0);
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toHaveCount(0);
    await expect(page.locator(".studio-status")).toContainText("0 connections");
    await expect(page.locator(".studio-status")).toContainText("Unsaved changes");
    await page.locator(".studio-status").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".studio-status")).toContainText("1 connection");
    await page.locator(`.react-flow__node[data-id="${start}"]`).click();
    await page.keyboard.press("Delete");
    const confirm = modal(page, "Delete step");
    await expect(confirm.getByText("Receive form", { exact: true })).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(writes).toBe(0);
  });

  test("a narrow editor uses 44 px controls even on a wider screen", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 844 });
    await mock(page, "OWNER");
    await page.goto(`/app/projects/${projectId}`);
    const list = toolbar(page).getByRole("button", { name: "List", exact: true });
    await expect(list).toHaveAttribute("aria-pressed", "true");
    expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await toolbar(page).getByRole("button", { name: "Flow details" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    for (const name of ["Zoom In", "Zoom Out", "Fit View"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const add = modal(page, "Add step");
    for (const label of ["Shape", "Name", "Actor", "Description"]) {
      expect((await add.getByLabel(label).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await add.getByRole("button", { name: "Cancel" }).click();
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = modal(page, "Connect steps");
    for (const label of ["From", "To", "Condition"]) {
      expect((await connect.getByLabel(label).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await connect.getByRole("button", { name: "Cancel" }).click();
    expect(await pageFits(page)).toBe(true);
  });

  test("an acknowledged save reports and recovers a failed draft refresh without sending another request", async ({ page }) => {
    await mock(page, "OWNER");
    const initial = draft();
    let reads = 0;
    let writes = 0;
    await page.route("**/drafts/" + initial.id, async (route) => {
      reads++;
      if (reads === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read unavailable" } } });
      else await route.fulfill({ json: { ...initial, documentRevision: 2, document: { ...initial.document, edges: {} } } });
    });
    await page.route("**/changes", async (route) => {
      writes++;
      await route.fulfill({ json: { draftId: initial.id, documentRevision: 2, layoutRevision: 1, eventSequence: 1, createdIds: [], versions: {}, positions: {}, replayed: false } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: /^Delete connection Receive form/ }).click();
    await headerSave(page).click();
    await expect(page.locator(".studio-status")).toContainText("Changes saved. The latest draft could not load.");
    await expect(page.locator(".studio-status")).not.toContainText("All changes saved");
    await expect(page.locator(".studio-status")).toContainText("0 connections"); // what was saved stays shown
    await page.getByRole("button", { name: "Retry read", exact: true }).click();
    await expect(page.locator(".studio-status")).toContainText("0 connections");
    await expect(page.locator(".studio-status")).toContainText("All changes saved");
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });

  for (const change of ["role", "archive", "empty"]) test(`an exact unconfirmed batch retries after ${change} change without a new write`, async ({ page }) => {
    await mock(page, "OWNER");
    let role = "OWNER", status = "ACTIVE";
    const initial = draft();
    const attempts: { key: string; body: string }[] = [];
    const committed = { ...initial, documentRevision: 2, document: { ...initial.document, nodes: { ...initial.document.nodes, [start]: { ...initial.document.nodes[start]!, label: "Saved before change", version: 2 } } } };
    const currentDraft = () => change === "empty" && status === "ARCHIVED" ? { ...emptyDraftView(initial.id), documentRevision: 3 } : committed;
    await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status, role, ownerId: projectId }, draft: attempts.length ? currentDraft() : initial } }));
    await page.route(`**/api/projects/${projectId}/status`, async (route) => route.fulfill({ json: { settingsVersion: 1, approvalPolicyVersion: 1, status } }));
    await page.route(`**/api/projects/${projectId}/members`, async (route) => route.fulfill({ json: { members: [] } }));
    await page.route(`**/api/projects/${projectId}/settings`, async (route) => {
      if (change === "role") role = "VIEWER";
      else status = "ARCHIVED";
      await route.fulfill({ json: {} });
    });
    await page.route("**/drafts/" + initial.id, async (route) => route.fulfill({ json: currentDraft() }));
    await page.route("**/changes", async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Acknowledgement lost" } } });
      else await route.fulfill({ json: { draftId: initial.id, documentRevision: 2, layoutRevision: 1, eventSequence: 1, createdIds: [], versions: { [start]: 2 }, positions: {}, replayed: true } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Receive form/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Name").fill("Saved before change");
    await saveButton(page).click();
    await expect(note(page).getByRole("button", { name: "Retry" })).toBeVisible();
    await panel(page).getByLabel("Name").fill("My later text");
    await panel(page).getByRole("button", { name: /Project$/ }).click();
    await panel(page).getByLabel("Project name").fill("Refresh access");
    await saveButton(page).click();
    await expect(page.locator(change === "role" ? ".editor-header" : ".editor-banner")).toContainText(change === "role" ? "Viewer" : "Archived");
    await note(page).getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(note(page)).toHaveCount(0);
    if (change === "empty") await page.getByRole("button", { name: "Unsaved text for a removed item" }).click();
    else await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Saved before change/ }).click();
    await expect(panel(page).getByLabel("Your unsaved text")).toHaveValue("Name: My later text");
    await expect(saveButton(page)).toHaveCount(0);
    await expect(toolbar(page).getByRole("button", { name: "Add step" })).toHaveCount(0);
    await panel(page).getByRole("button", { name: "Discard", exact: true }).click();
    expect(attempts).toHaveLength(2);
  });

  for (const change of ["role", "archive"]) test(`a ${change} change keeps unsaved changes readable for copying, with discard only`, async ({ page }) => {
    await mock(page, "OWNER");
    let role = "OWNER";
    let status = "ACTIVE";
    let writes = 0;
    await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status, role, ownerId: projectId }, draft: draft() } }));
    await page.route("**/changes", async (route) => {
      writes++;
      if (change === "role") role = "VIEWER";
      else status = "ARCHIVED";
      await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "Access changed" } } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Receive form/ }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel(page).getByLabel("Name").fill("Denied change");
    await saveButton(page).click();
    await expect(page.locator(change === "role" ? ".editor-header" : ".editor-banner")).toContainText(change === "role" ? "Viewer" : "Archived");
    await expect(saveButton(page)).toHaveCount(0);
    await expect(headerSave(page)).toHaveCount(0);
    await expect(panel(page).getByLabel("Name")).toHaveCount(0);
    await expect(panel(page).getByText("Full description text", { exact: true })).toBeVisible();
    // The typed name now lives in the unsaved change, listed for copying since it can no longer be saved.
    await expect(note(page)).toContainText("This draft is read-only now");
    await expect(note(page)).toContainText("name “Denied change”");
    await note(page).getByRole("button", { name: "Discard my changes" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(page.locator(".studio-status")).not.toContainText("Unsaved changes");
    expect(writes).toBe(1);
  });

  test("a role downgrade removes an already-open Add step form", async ({ page }) => {
    await mock(page, "OWNER");
    let role = "OWNER";
    await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role, ownerId: projectId }, draft: draft() } }));
    await page.route("**/changes", async (route) => {
      role = "VIEWER";
      await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "Access changed" } } });
    });
    await page.clock.install();
    await page.goto(`/app/projects/${projectId}`);
    // A queued change is autosaved while the form is open; that save finds the narrower access.
    await toolbar(page).getByRole("button", { name: "List" }).click();
    await page.getByRole("button", { name: /^Delete connection Receive form/ }).click();
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const add = modal(page, "Add step");
    await add.getByLabel("Name").fill("No longer permitted");
    await page.clock.fastForward(10_500);
    await expect(page.locator(".editor-header")).toContainText("Viewer");
    await expect(add).toHaveCount(0);
    await expect(toolbar(page).getByRole("button", { name: "Add step" })).toHaveCount(0);
  });

  test("a role downgrade removes an already-open flow creation form", async ({ page }) => {
    await mock(page, "OWNER");
    let role = "OWNER";
    await page.route(`**/api/projects/${projectId}/bootstrap`, async (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role, ownerId: projectId }, draft: draft() } }));
    await page.route("**/changes", async (route) => {
      role = "VIEWER";
      await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "Access changed" } } });
    });
    await page.goto(`/app/projects/${projectId}`);
    await page.locator(".flow-switch").click();
    await modal(page, "Flows").getByRole("button", { name: "New flow" }).click();
    await modal(page, "New flow").getByLabel("Title").fill("No longer permitted");
    await modal(page, "New flow").getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator(".editor-header")).toContainText("Viewer");
    // The local flow's form closed (it can never create a second one); the unsaved flow is listed, and a reader's
    // Flows dialog offers no creation.
    await expect(page.getByRole("button", { name: "Create flow", exact: true })).toHaveCount(0);
    await expect(note(page)).toContainText("New flow “No longer permitted”");
    await page.locator(".flow-switch").click();
    await expect(modal(page, "Flows")).toBeVisible();
    await expect(modal(page, "Flows").getByRole("button", { name: "New flow" })).toHaveCount(0);
  });

});
