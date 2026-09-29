import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-fixtures";
import type { DraftView, NodeKind } from "../../src/features/drafts/contracts/scope-document.ts";
import { STEP_SIZE } from "../../src/features/drafts/contracts/draft-layout.ts";
import { createProjectViaApi, e2eReady, emptyDraftView, saveStudio, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

/** The edge path's own drawn start point in screen coordinates: proof it actually renders from its saved side,
 * not just that a `.react-flow__edge` element with that id exists (which error 008 can still leave behind empty). */
async function edgeStartPoint(page: Page, edgeId: string) {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`).evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
    return { x: at.x, y: at.y };
  });
}

async function createFlowInUi(page: Page, title: string) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = dialog(page, "New flow");
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText(title);
  await expect(page.locator("dialog[open]")).toHaveCount(0); // its save-first has finished
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
  let projectId: string;

  test.beforeEach(async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    projectId = await createProjectViaApi(page, "Canvas project");
    if (!testInfo.title.startsWith("every kind renders")) {
      const flowId = randomUUID();
      const labels = testInfo.title.startsWith("reconnecting an end") || testInfo.title.startsWith("click-to-connect saves")
        ? [["Cart", "START"], ["Done", "OUTCOME"], ["Other", "ACTION"]]
        : [["Cart", "START"], ["Done", "OUTCOME"]];
      const nodeIds = labels.map(() => randomUUID());
      await seedStudioChanges(page, projectId, [
        { command: "CREATE_FLOW", payload: { title: "Shapes", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
        ...labels.map(([label, kind], index) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [nodeIds[index]!] })),
      ], [{ flowId, items: nodeIds.map((nodeId, index) => ({ nodeId, expectedPositionVersion: 1, x: index * 320, y: 0 })) }]);
    }
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Canvas project" })).toBeVisible();
    if (testInfo.title.startsWith("every kind renders")) await createFlowInUi(page, "Shapes");
    else await expect(page.locator("#studio-flow-title")).toHaveText("Shapes");
  });

  test("every kind renders at its fixed STEP_SIZE, and a DATA_STORE step draws as a cylinder that survives reload", async ({ page }) => {
    const shapes: [string, "Start" | "Step" | "Decision" | "Outcome" | "Data store", NodeKind][] = [
      ["Cart", "Start", "START"], ["Pay", "Step", "ACTION"], ["Paid?", "Decision", "DECISION"],
      ["Orders", "Data store", "DATA_STORE"], ["Done", "Outcome", "OUTCOME"],
    ];
    for (const [label, shape] of shapes) await addStepInUi(page, label, shape);
    await saveStudio(page);
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

  test("an editor sees four connectable handle sides per step (each a source and a target element), and a condition on a new edge shows as a label pill", async ({ page }) => {
    const draft = await draftOf(page, projectId);
    const cartId = Object.values(draft.document.nodes).find((node) => node.label === "Cart")!.id;
    const cartNode = nodeAt(page, cartId);
    // Every side draws as one source-typed and one target-typed handle stacked together (so a saved connection can
    // start from any side: React Flow's edge-drawing lookup only finds a start handle among source-typed ones).
    await expect(cartNode.locator(".react-flow__handle")).toHaveCount(8);
    await expect(cartNode.locator(".react-flow__handle.connectable")).toHaveCount(8);

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

  test("dragging right→left handles saves those sides and they survive reload; dragging the edge's end to another handle saves new sides; a plain connection still renders", async ({ page }) => {
    let draft = await draftOf(page, projectId);
    const cartId = Object.values(draft.document.nodes).find((node) => node.label === "Cart")!.id;
    const doneId = Object.values(draft.document.nodes).find((node) => node.label === "Done")!.id;

    // Connecting by dragging Cart's right handle to Done's left handle records those sides (UI02 Task 13). Each side
    // is two stacked elements (source- and target-typed); `.first()` just picks one of the pair.
    await nodeAt(page, cartId).locator('.react-flow__handle[data-handleid="right"]').first().dragTo(nodeAt(page, doneId).locator('.react-flow__handle[data-handleid="left"]').first());
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await saveStudio(page);
    draft = await draftOf(page, projectId);
    const edgeId = Object.keys(draft.document.edges)[0]!;
    expect(draft.layout.edgeSides[edgeId]).toEqual({ from: "right", to: "left" });

    // The saved sides survive a reload: the edge draws from the exact saved side, not just an element with its id.
    await page.reload();
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toHaveCount(1);
    const cartBox = (await nodeAt(page, cartId).boundingBox())!;
    const start = await edgeStartPoint(page, edgeId);
    expect(start.x).toBeGreaterThan(cartBox.x + cartBox.width - 5); // drawn from Cart's *right* edge, as saved

    // Dragging the connected end to another handle on the same two steps is a side-only save: no request until Save.
    const requests: unknown[] = [];
    await page.route("**/drafts/*/changes", async (route) => { requests.push(route.request().postDataJSON()); await route.continue(); });
    await page.locator(".react-flow__edgeupdater-target").dragTo(nodeAt(page, doneId).locator('.react-flow__handle[data-handleid="top"]').first());
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"]`)).toBeVisible();
    expect(requests).toHaveLength(0);
    await saveStudio(page);
    expect(requests).toHaveLength(1);
    draft = await draftOf(page, projectId);
    expect(draft.layout.edgeSides[edgeId]).toEqual({ from: "right", to: "top" });
    // The endpoints and the document itself never moved: a pure geometry change.
    expect([draft.document.edges[edgeId]!.fromId, draft.document.edges[edgeId]!.toId]).toEqual([cartId, doneId]);

    // A plain connection made through the dialog (no specific handles) still renders, with no saved sides.
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = dialog(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Done" });
    await connect.getByLabel("To").selectOption({ label: "Cart" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await saveStudio(page);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    draft = await draftOf(page, projectId);
    const plainEdgeId = Object.keys(draft.document.edges).find((id) => id !== edgeId)!;
    expect(draft.layout.edgeSides[plainEdgeId]).toBeUndefined();
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  });

  test("a connection saves from the step and handle the drag started on to the drop, whichever side it starts from", async ({ page }) => {
    const draft = await draftOf(page, projectId);
    const cartId = Object.values(draft.document.nodes).find((node) => node.label === "Cart")!.id;
    const doneId = Object.values(draft.document.nodes).find((node) => node.label === "Done")!.id;
    const handle = (nodeId: string, side: string) => nodeAt(page, nodeId).locator(`.react-flow__handle[data-handleid="${side}"]`).first();
    // Drags starting on top and left (target-typed) and on right and bottom (source-typed), and one starting on Done.
    const drags: [string, string, string, string][] = [
      [cartId, "top", doneId, "left"], [cartId, "left", doneId, "top"], [cartId, "right", doneId, "left"], [cartId, "bottom", doneId, "top"],
      [doneId, "top", cartId, "bottom"], [doneId, "left", cartId, "right"],
    ];
    for (const [fromId, from, toId, to] of drags) await handle(fromId, from).dragTo(handle(toId, to));
    await expect(page.locator(".react-flow__edge")).toHaveCount(drags.length);
    await saveStudio(page);
    const saved = await draftOf(page, projectId);
    const edges = Object.values(saved.document.edges).map((edge) => `${edge.fromId}:${saved.layout.edgeSides[edge.id]?.from}>${edge.toId}:${saved.layout.edgeSides[edge.id]?.to}`);
    expect(edges.sort()).toEqual(drags.map(([fromId, from, toId, to]) => `${fromId}:${from}>${toId}:${to}`).sort());
    await page.reload();
    await expect(page.locator(".react-flow__edge path.react-flow__edge-path")).toHaveCount(drags.length);
  });

  test("dragging a visible handle beside a selected loop creates an outgoing connection", async ({ page }) => {
    const draft = await draftOf(page, projectId);
    const cartId = Object.values(draft.document.nodes).find((node) => node.label === "Cart")!.id;
    const doneId = Object.values(draft.document.nodes).find((node) => node.label === "Done")!.id;
    const handle = (id: string, side: string) => nodeAt(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`).first();
    await handle(cartId, "right").dragTo(handle(cartId, "left"));
    await saveStudio(page);
    const loopId = Object.keys((await draftOf(page, projectId)).document.edges)[0]!;
    // Select by keyboard so this test does not depend on the loop path's routing.
    await page.locator(`.react-flow__edge[data-id="${loopId}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`.react-flow__edge[data-id="${loopId}"]`)).toHaveClass(/selected/);
    const source = (await handle(cartId, "right").boundingBox())!;
    const target = (await handle(doneId, "top").boundingBox())!;
    // Handles straddle the shape border. Its old overflow clipping sent an outer-half press to the underlying edge.
    await page.mouse.move(source.x + source.width / 2 + 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await saveStudio(page);
    const saved = await draftOf(page, projectId);
    expect(saved.document.edges[loopId]).toMatchObject({ fromId: cartId, toId: cartId });
    const added = Object.values(saved.document.edges).find((edge) => edge.id !== loopId)!;
    expect(added).toMatchObject({ fromId: cartId, toId: doneId });
    expect(saved.layout.edgeSides[added.id]).toEqual({ from: "right", to: "top" });
    await page.reload();
    const path = page.locator(`.react-flow__edge[data-id="${added.id}"] path.react-flow__edge-path`);
    await expect(path).toBeVisible();
    await expect(path).toHaveAttribute("marker-end", /url\(/);
    const tip = await path.evaluate((element: SVGPathElement) => {
      const point = element.getPointAtLength(element.getTotalLength()).matrixTransform(element.getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
    const end = (await handle(doneId, "top").boundingBox())!;
    expect(Math.abs(tip.x - (end.x + end.width / 2))).toBeLessThan(1);
    expect(Math.abs(tip.y - end.y)).toBeLessThan(1);
  });

  test("reconnecting an end moves only that end: the other keeps its step and side", async ({ page }) => {
    let draft = await draftOf(page, projectId);
    const id = (label: string) => Object.values(draft.document.nodes).find((node) => node.label === label)!.id;
    const [cartId, doneId, otherId] = [id("Cart"), id("Done"), id("Other")];
    const handle = (nodeId: string, side: string) => nodeAt(page, nodeId).locator(`.react-flow__handle[data-handleid="${side}"]`).first();
    await handle(cartId, "right").dragTo(handle(doneId, "left")); // Cart right → Done left
    await saveStudio(page);
    draft = await draftOf(page, projectId);
    const edgeId = Object.keys(draft.document.edges)[0]!;
    const edgeNow = async () => {
      await saveStudio(page);
      const saved = await draftOf(page, projectId);
      return { fromId: saved.document.edges[edgeId]!.fromId, toId: saved.document.edges[edgeId]!.toId, ...saved.layout.edgeSides[edgeId] };
    };
    // Move the to end onto Other's top: from stays Cart/right.
    await page.locator(".react-flow__edgeupdater-target").dragTo(handle(otherId, "top"));
    expect(await edgeNow()).toEqual({ fromId: cartId, toId: otherId, from: "right", to: "top" });
    // Move the from end onto Done's left (a target-typed handle, so React Flow calls the other step "source"): to stays Other/top.
    await page.locator(".react-flow__edgeupdater-source").dragTo(handle(doneId, "left"));
    expect(await edgeNow()).toEqual({ fromId: doneId, toId: otherId, from: "left", to: "top" });
    // Move the from end onto another handle of the same step: only that side changes.
    await page.locator(".react-flow__edgeupdater-source").dragTo(handle(doneId, "bottom"));
    expect(await edgeNow()).toEqual({ fromId: doneId, toId: otherId, from: "bottom", to: "top" });
  });

  test("click-to-connect saves from the first handle clicked to the second, and a reconnect leaves nothing behind to misdirect it", async ({ page }) => {
    const draft = await draftOf(page, projectId);
    const id = (label: string) => Object.values(draft.document.nodes).find((node) => node.label === label)!.id;
    const [cartId, doneId, otherId] = [id("Cart"), id("Done"), id("Other")];
    const handle = (nodeId: string, side: string) => nodeAt(page, nodeId).locator(`.react-flow__handle[data-handleid="${side}"]`).first();
    // A reconnect of Cart -> Done's to end onto Other leaves the kept end's start (Cart, right) with React Flow's
    // reconnect callbacks; a later click-connect must not be oriented by it.
    await handle(cartId, "right").dragTo(handle(doneId, "left"));
    await page.locator(".react-flow__edgeupdater-target").dragTo(handle(otherId, "top"));
    await saveStudio(page);
    // Click Other's right (source-typed) then Cart's top: Other -> Cart.
    await handle(otherId, "right").click();
    await handle(cartId, "top").click();
    // Click Cart's left (target-typed) then Done's right: Cart -> Done.
    await handle(cartId, "left").click();
    await handle(doneId, "right").click();
    await saveStudio(page);
    const saved = await draftOf(page, projectId);
    const edges = Object.values(saved.document.edges).map((edge) => `${edge.fromId}:${saved.layout.edgeSides[edge.id]?.from}>${edge.toId}:${saved.layout.edgeSides[edge.id]?.to}`);
    expect(edges.sort()).toEqual([`${cartId}:right>${otherId}:top`, `${otherId}:right>${cartId}:top`, `${cartId}:left>${doneId}:right`].sort());
  });

  test("a pending click-to-connect keeps its first handle when a jittery press (a small drag) happens before the completing click", async ({ page }) => {
    const draft = await draftOf(page, projectId);
    const id = (label: string) => Object.values(draft.document.nodes).find((node) => node.label === label)!.id;
    const [cartId, doneId] = [id("Cart"), id("Done")];
    const handle = (nodeId: string, side: string) => nodeAt(page, nodeId).locator(`.react-flow__handle[data-handleid="${side}"]`).first();
    // Cart's left is target-typed: a start cleared by the second click's drag would save this connection reversed (Done -> Cart).
    await handle(cartId, "left").click();
    // A press on Done right, 3 px of movement and a release is a drag gesture (it ends with onConnectEnd), not a click, so the click-connect stays pending.
    const box = (await handle(doneId, "right").boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await handle(doneId, "right").hover();
    await page.mouse.down();
    await page.mouse.move(x + 3, y, { steps: 3 });
    await page.mouse.up();
    await handle(doneId, "right").click();
    await saveStudio(page);
    const saved = await draftOf(page, projectId);
    const edges = Object.values(saved.document.edges).map((edge) => ({ fromId: edge.fromId, toId: edge.toId, ...saved.layout.edgeSides[edge.id] }));
    expect(edges).toEqual([{ fromId: cartId, toId: doneId, from: "left", to: "right" }]);
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
      layout: { schemaVersion: 1, positions: { [start]: { x: 0, y: 0, version: 1 }, [end]: { x: 0, y: 160, version: 1 } }, directions: { [flowId]: "TB" }, edgeSides: {} },
    };
  };


  test.beforeEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [], truncated: false }, shared: { items: [{ id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerName: "Owner", updatedAt: "2026-09-27T00:00:00.000Z" }], truncated: false }, archived: { items: [], truncated: false }, capacity: { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: { items: [], truncated: false } }));
    await page.route(`**/api/projects/${projectId}/bootstrap`, (route) => route.fulfill({ json: { project: { id: projectId, name: "Intake project", status: "ACTIVE", role: "VIEWER", ownerId: projectId }, draft: draft() } }));
    await page.goto(`/app/projects/${projectId}`);
  });

  test("a reader's steps keep their eight handle elements in the DOM, but none are connectable", async ({ page }) => {
    const startNode = nodeAt(page, start);
    await expect(startNode).toBeVisible();
    await expect(startNode.locator(".react-flow__handle")).toHaveCount(8);
    await expect(startNode.locator(".react-flow__handle.connectable")).toHaveCount(0);
  });
});
