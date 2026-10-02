import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, type Page, type Request, type Route } from "@playwright/test";
import { test } from "./studio-fixtures";
import { test as collaborationTest, interceptRealtime, poll } from "./collaboration-fixtures";
import { appUrl, createProjectViaApi, e2eReady, headerSave, seedStudioChanges, saveStudio } from "./support";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import type { ImportPreviewView } from "../../src/features/exchange/contracts/import.ts";
import type { FlowFileV1 } from "../../src/features/exchange/contracts/flow-file.ts";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");
const nativeFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import flow", exact: true });
async function draftOf(page: Page, id: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${id}/bootstrap`)).json()).draft;
}
async function openImport(page: Page) {
  await page.locator(".flow-switch").click();
  await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Import flow", exact: true }).click();
}
async function inspect(page: Page, bytes = nativeFile()) {
  await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "journey.scoperoom-flow.json", mimeType: "application/json", buffer: await bytes });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click();
  await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
}
const applyButton = (page: Page) => dialog(page).getByRole("button", { name: "Create unapproved copy", exact: true });
const records = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("scoperoom:flow-import:")).map((key) => JSON.parse(sessionStorage.getItem(key)!)));
const nodeAt = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const writes = (page: Page, suffix = "/apply") => {
  const list: Request[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith(suffix)) list.push(request); });
  return list;
};
async function setup(page: Page, populated = false) {
  const id = await createProjectViaApi(page, "Import project");
  const flowId = randomUUID(), first = randomUUID(), second = randomUUID(), edge = randomUUID();
  if (populated) await seedStudioChanges(page, id, [
    { command: "CREATE_FLOW", payload: { title: "Existing", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Existing start", actorLabel: "", description: "" }, proposedIds: [first] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Existing end", actorLabel: "", description: "" }, proposedIds: [second] },
    { command: "ADD_EDGE", payload: { flowId, fromId: first, toId: second, condition: "Existing connection" }, proposedIds: [edge] },
  ]);
  await page.goto(`/app/projects/${id}`);
  await expect(page.locator(".flow-switch")).toBeVisible();
  return { id, flowId, first, second, edge };
}
async function drag(page: Page, id: string, dx: number, dy: number) {
  const box = (await nodeAt(page, id).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
}
async function typeWhileModal(page: Page, selector: string, text: string) {
  await page.locator(selector).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

test("inspection leaves an empty draft unchanged; Apply creates an unapproved independent copy", async ({ page }) => {
  test.setTimeout(90_000);
  const id = await createProjectViaApi(page, "Import project");
  await page.goto(`/app/projects/${id}`);
  await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();
  const before = await draftOf(page, id);
  await openImport(page);
  await inspect(page);
  await expect(dialog(page)).toContainText("5 steps");
  await expect(dialog(page)).toContainText("Supplied geometry is preserved");
  await expect(dialog(page)).toContainText(`Target draft: ${before.id}`);
  await expect(dialog(page).locator("time")).toHaveAttribute("dateTime", /.+/);
  await expect(dialog(page)).toContainText("1 link hints ignored");
  await expect(dialog(page).getByLabel("Read-only import graph")).toBeVisible();
  expect(await draftOf(page, id)).toEqual(before);
  await dialog(page).getByRole("button", { name: "Create unapproved copy", exact: true }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText("Checkout {flow}");
  const after = await draftOf(page, id);
  expect(Object.values(after.document.flows)).toHaveLength(1);
  expect(Object.values(after.document.flows)[0]).toMatchObject({ inclusion: "UNDECIDED", confirmation: null });
  expect(Object.values(after.document.nodes).every((node) => node.origin === "IMPORTED")).toBe(true);
  const file: FlowFileV1 = JSON.parse((await nativeFile()).toString());
  const imported = Object.values(after.document.flows)[0]!;
  expect(after.layout.directions[imported.id]).toBe(file.flow.direction);
  const ids = new Map(file.nodes.map((node) => [node.id, Object.values(after.document.nodes).find((saved) => saved.label === node.label)!.id]));
  for (const position of file.positions!) expect(after.layout.positions[ids.get(position.nodeId)!]).toMatchObject({ x: position.x, y: position.y });
  for (const sides of file.edgeSides!) {
    const edge = file.edges.find((edge) => edge.id === sides.edgeId)!;
    const saved = Object.values(after.document.edges).find((saved) => saved.fromId === ids.get(edge.fromId) && saved.toId === ids.get(edge.toId))!;
    expect(after.layout.edgeSides[saved.id]).toEqual({ from: sides.from, to: sides.to });
  }
});

test("populated inspection, HTML-looking labels, automatic geometry, hints, discard and narrow keyboard semantics", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await setup(page, true);
  const before = await draftOf(page, id);
  const file = JSON.parse((await nativeFile()).toString());
  file.nodes[1].label = '<img src="https://invalid.example/x" onerror="alert(1)">';
  delete file.positions; delete file.edgeSides; delete file.linkHints;
  const requests: string[] = []; page.on("request", (request) => { if (request.url().includes("invalid.example")) requests.push(request.url()); });
  await page.locator(".flow-switch").focus(); await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Import flow", exact: true }).focus(); await page.keyboard.press("Enter");
  await inspect(page, Promise.resolve(Buffer.from(JSON.stringify(file))));
  await expect(dialog(page).getByRole("button", { name: "List alternative" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog(page)).toContainText(file.nodes[1].label);
  await expect(dialog(page)).toContainText("deterministic automatic layout");
  await expect(dialog(page)).toContainText("inclusion UNDECIDED");
  await expect(dialog(page)).toContainText("Snapshot provenance");
  await expect(dialog(page).getByText(/link hints ignored/)).toHaveCount(0);
  expect(requests).toHaveLength(0); expect(await draftOf(page, id)).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = (await dialog(page).boundingBox())!; expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape"); await expect(dialog(page)).toBeHidden(); await expect(page.locator(".flow-switch")).toBeFocused();
  await openImport(page); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Graph preview" }).click();
  await expect(dialog(page).getByLabel("Read-only import graph")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Discard preview" }).click();
  await expect(dialog(page)).toBeHidden(); await expect(page.locator(".flow-switch")).toBeFocused();
  expect(await draftOf(page, id)).toEqual(before); expect(await records(page)).toHaveLength(0);
});

for (const [name, bytes, expected] of [
  ["malformed", Buffer.from("{not valid JSON"), "Check the details"],
  ["unsupported", Buffer.from('{"format":"foreign","formatVersion":1}'), "Unsupported format"],
] as const) test(`${name} file is Invalid without changing the saved draft`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const before = await draftOf(page, id);
  await openImport(page); await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "bad.scoperoom-flow.json", mimeType: "application/json", buffer: bytes });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click();
  await expect(dialog(page).getByText("Invalid", { exact: true })).toBeVisible(); await expect(dialog(page).getByRole("alert")).toContainText(expected);
  expect(await draftOf(page, id)).toEqual(before); await expect(applyButton(page)).toHaveCount(0);
});

test("lost upload acknowledgement and READY reload recover the same opaque preview, without file content in storage", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const observations: { url: string; key: string | null; digest: string }[] = [];
    Object.assign(window, { importUploadObservations: observations });
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/flow-imports/preview?") && init?.body instanceof Blob) {
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await init.body.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        observations.push({ url, key: new Headers(init.headers).get("Idempotency-Key"), digest });
      }
      return original(input, init);
    };
  });
  const { id } = await setup(page); const uploads = writes(page, "/preview");
  const before = await draftOf(page, id);
  await page.route("**/flow-imports/preview?**", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await openImport(page); await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "journey.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Upload not confirmed");
  const [record] = await records(page); expect(JSON.stringify(record)).not.toContain("Checkout"); expect(Object.keys(record).sort()).toEqual(["actorId", "createKey", "discardKey", "draftId", "fingerprint", "previewId", "projectId"].sort());
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click();
  await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
  expect(uploads).toHaveLength(2); expect(uploads[1]!.url()).toBe(uploads[0]!.url()); expect(uploads[1]!.headers()["idempotency-key"]).toBe(uploads[0]!.headers()["idempotency-key"]);
  const observed = await page.evaluate(() => (window as unknown as { importUploadObservations: { digest: string }[] }).importUploadObservations);
  expect(observed).toHaveLength(2); expect(observed[1]).toEqual(observed[0]); expect(observed[0]!.digest).toBe(record.fingerprint);
  const original = (await records(page))[0]; await page.reload(); await openImport(page);
  await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible(); expect((await records(page))[0]).toEqual(original);
  expect(uploads).toHaveLength(2); expect(await draftOf(page, id)).toEqual(before);
  await expect(dialog(page)).toContainText("1 link hints ignored");
});

test("uncommitted lost upload reload asks for the same file and retries original ID/key", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const uploads = writes(page, "/preview");
  await page.route("**/flow-imports/preview?**", (route) => route.abort("failed"), { times: 1 });
  await openImport(page); await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "journey.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click(); await expect(dialog(page).getByText("Validating", { exact: true })).toBeVisible();
  const original = (await records(page))[0]; await page.reload(); await openImport(page);
  await expect(dialog(page).getByRole("alert")).toContainText("select the same file");
  await dialog(page).getByRole("button", { name: "Recover import status" }).click(); await expect(dialog(page).getByRole("alert")).toContainText("Upload not confirmed");
  await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "same.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click(); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
  expect(uploads).toHaveLength(2); expect((await records(page))[0].previewId).toBe(original.previewId); expect(uploads[1]!.headers()["idempotency-key"]).toBe(original.createKey);
  expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(0);
});

test("real Apply commit with lost acknowledgement pins exact retry and blocks repeated Escape", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page, true); const before = await draftOf(page, id); const applies = writes(page);
  await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("couldn’t confirm");
  await expect(dialog(page).getByRole("button", { name: "Cancel", exact: true })).toBeDisabled(); await expect(dialog(page).getByRole("button", { name: "Discard preview" })).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Inspect again" })).toBeDisabled(); await expect(dialog(page).getByLabel("Native flow file")).toBeDisabled();
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await expect(dialog(page)).toBeVisible();
  const committed = await draftOf(page, id); expect(Object.values(committed.document.flows)).toHaveLength(2);
  const [record] = await records(page); expect(record.attempt).toEqual({ key: applies[0]!.headers()["idempotency-key"], ...applies[0]!.postDataJSON() });
  await dialog(page).getByRole("button", { name: "Retry import" }).click(); await expect(dialog(page)).toBeHidden();
  expect(applies).toHaveLength(2); expect(applies[1]!.postData()).toBe(applies[0]!.postData()); expect(applies[1]!.headers()["idempotency-key"]).toBe(applies[0]!.headers()["idempotency-key"]);
  const after = await draftOf(page, id); expect(after.documentRevision).toBe(committed.documentRevision); expect(after.layoutRevision).toBe(committed.layoutRevision);
  for (const [nodeId, position] of Object.entries(before.layout.positions)) expect(after.layout.positions[nodeId]).toEqual(position);
});

test("lost Apply reload recovers APPLIED using GET and opens only its existing saved copy", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const applies = writes(page);
  await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("couldn’t confirm");
  const original = (await records(page))[0]; expect(original.attempt).toBeTruthy(); expect(JSON.stringify(original)).not.toContain("Choose");
  await page.reload(); await openImport(page); await expect(dialog(page)).toBeHidden(); await expect(page.locator("#studio-flow-title")).toHaveText("Checkout {flow}");
  expect(applies).toHaveLength(1); expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(1);
});

test("lost committed Apply stays pinned when Retry status barrier fails before its POST", async ({ page }) => {
  const { id } = await setup(page, true); const applies = writes(page);
  await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("button", { name: "Retry import" })).toBeEnabled();
  const original = (await records(page))[0]; const committed = await draftOf(page, id);
  const failStatus = (route: Route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Barrier unavailable" } } });
  await page.route(`**/api/projects/${id}/status`, failStatus);
  // A real-time status read can have refreshed authority after the lost acknowledgement. Invalidate it explicitly.
  const failedRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${id}/status` && response.status() === 503);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await failedRead;
  await dialog(page).getByRole("button", { name: "Retry import" }).click();
  await expect(dialog(page).getByRole("button", { name: "Retry import" })).toBeEnabled();
  expect(applies).toHaveLength(1); expect((await records(page))[0].attempt).toEqual(original.attempt);
  for (const name of ["Cancel", "Discard preview", "Inspect again"]) await expect(dialog(page).getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(dialog(page).getByLabel("Native flow file")).toBeDisabled();
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await expect(dialog(page)).toBeVisible();
  await page.unroute(`**/api/projects/${id}/status`, failStatus);
  await dialog(page).getByRole("button", { name: "Retry import" }).click(); await expect(dialog(page)).toBeHidden();
  expect(applies).toHaveLength(2); expect(applies[1]!.postData()).toBe(applies[0]!.postData()); expect(applies[1]!.headers()["idempotency-key"]).toBe(original.attempt.key);
  const after = await draftOf(page, id); expect(after.documentRevision).toBe(committed.documentRevision); expect(after.layoutRevision).toBe(committed.layoutRevision);
});

for (const operation of ["upload", "Apply"] as const) test(`same-mount replacement releases held ${operation} latch without adopting the old response`, async ({ page }) => {
  const { id } = await setup(page, true); await openImport(page);
  await dialog(page).evaluate((element) => element.setAttribute("data-retained-modal", "true"));
  let held: Route | undefined;
  if (operation === "Apply") await inspect(page);
  await page.route(operation === "upload" ? "**/flow-imports/preview?**" : "**/flow-imports/*/apply", (route) => { held = route; }, { times: 1 });
  if (operation === "upload") {
    await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "journey.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() });
    await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click();
  } else await applyButton(page).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const original = (await records(page))[0]; const response = await held!.fetch(); expect(response.status()).toBe(200);
  const replacementId = randomUUID(); let bootstrapped = false;
  await page.route(`**/api/projects/${id}/bootstrap`, async (route) => { const real = await route.fetch(); const body = await real.json(); body.draft.id = replacementId; body.status.currentDraftId = replacementId; await route.fulfill({ response: real, json: body }); bootstrapped = true; });
  await page.route(`**/api/projects/${id}/status`, async (route) => { const real = await route.fetch(); const body = await real.json(); body.currentDraftId = replacementId; await route.fulfill({ response: real, json: body }); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => bootstrapped).toBe(true);
  await expect(dialog(page)).toHaveAttribute("data-retained-modal", "true");
  await held!.fulfill({ response });
  await expect(dialog(page).getByRole("button", { name: "Recover import status" })).toBeEnabled();
  expect((await records(page))[0]).toEqual(original);
  if (operation === "Apply") {
    await expect(dialog(page).getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(dialog(page)).toBeVisible();
  } else await expect(dialog(page).getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Recover import status" }).click();
  await expect(dialog(page).getByText(operation === "Apply" ? "Applied" : "Stale", { exact: true })).toBeVisible();
  expect((await records(page))[0].draftId).toBe(original.draftId);
  if (operation === "Apply") await expect(dialog(page)).toContainText("historical flow is unavailable");
});

for (const mode of ["stale", "failed"] as const) test(`${mode} covering read after acknowledgement keeps Import saved until refresh without another Apply`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const before = await draftOf(page, id); const applies = writes(page);
  await openImport(page); await inspect(page);
  let fail = true;
  await page.route(`**/drafts/${before.id}`, (route) => fail ? mode === "stale" ? route.fulfill({ status: 200, json: before }) : route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Read delayed" } } }) : route.continue());
  await applyButton(page).click(); await expect(dialog(page)).toContainText("Import saved. Refreshing saved changes…");
  await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible(); await expect(dialog(page).getByRole("button", { name: "Create unapproved copy" })).toHaveCount(0);
  fail = false; await dialog(page).getByRole("button", { name: "Refresh saved changes" }).click(); await expect(dialog(page)).toBeHidden();
  await expect(page.locator("#studio-flow-title")).toHaveText("Checkout {flow}"); expect(applies).toHaveLength(1);
});

for (const [code, state] of [["IMPORT_EXPIRED", "Expired"], ["IMPORT_STALE", "Stale"], ["DRAFT_REPLACED", "Stale"], ["LIMIT_EXCEEDED", "Ready"]] as const) test(`${code} refusal retains safe file for explicit reinspection and creates no flow`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const before = await draftOf(page, id);
  await openImport(page); await inspect(page); const original = (await records(page))[0];
  await page.route("**/flow-imports/*/apply", (route) => route.fulfill({ status: 409, json: { error: { code, message: "Review target and capacity before inspecting again." } } }), { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByText(state, { exact: true })).toBeVisible(); await expect(dialog(page).getByRole("alert")).toContainText("Review target");
  expect(await draftOf(page, id)).toEqual(before); expect((await records(page))[0].attempt).toBeUndefined();
  await dialog(page).getByRole("button", { name: "Inspect again" }).click(); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible(); expect((await records(page))[0].previewId).not.toBe(original.previewId);
});

for (const lane of ["text", "coordinate", "endpoint", "redo"] as const) test(`${lane} unresolved local input cannot be silently saved or discarded by import`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id, first } = await setup(page, true); const before = await draftOf(page, id); const applies = writes(page), saves = writes(page, "/changes");
  if (lane === "redo") {
    await page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true }).click(); const add = page.getByRole("dialog", { name: "Add step", exact: true });
    await add.getByLabel("Name").fill("Redo me"); await add.getByRole("button", { name: "Add step", exact: true }).click(); await page.locator(".studio-status").getByRole("button", { name: "Undo", exact: true }).click();
  } else {
    if (lane === "endpoint") await page.locator(".react-flow__edge").first().click(); else await nodeAt(page, first).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    if (lane === "text") await page.locator("#inspect-label").fill("Typed unsaved text");
    if (lane === "coordinate") await page.getByLabel("X", { exact: true }).fill("420");
    if (lane === "endpoint") await page.getByLabel("From", { exact: true }).selectOption({ label: "Existing end" });
  }
  await openImport(page); await inspect(page); await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("Studio");
  expect(applies).toHaveLength(0); expect(saves).toHaveLength(0); expect(await draftOf(page, id)).toEqual(before);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  if (lane === "text") await expect(page.locator("#inspect-label")).toHaveValue("Typed unsaved text");
  if (lane === "coordinate") await expect(page.getByLabel("X", { exact: true })).toHaveValue("420");
  if (lane === "redo") await expect(page.locator(".studio-status").getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
});

for (const mode of ["refused", "uncertain"] as const) test(`${mode} queued save is explicitly resolved before importing`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page, true); const applies = writes(page), saves = writes(page, "/changes"); const before = await draftOf(page, id);
  await page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true }).click(); const add = page.getByRole("dialog", { name: "Add step", exact: true });
  await add.getByLabel("Name").fill("Waiting local edit"); await add.getByRole("button", { name: "Add step", exact: true }).click();
  await page.route("**/changes", (route) => mode === "uncertain" ? route.abort("failed") : route.fulfill({ status: 409, json: { error: { code: "STALE_DOCUMENT_REVISION", message: "Peer saved first" } } }), { times: 1 });
  await headerSave(page).click(); await expect(page.locator(".save-note")).toBeVisible();
  await openImport(page); await inspect(page); await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("Resolve the unconfirmed or refused save");
  expect(applies).toHaveLength(0); expect(saves).toHaveLength(1); expect(await draftOf(page, id)).toEqual(before);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click(); await expect(page.locator(".studio-stage")).toContainText("Waiting local edit");
  const resolution = page.locator(".save-note").getByRole("button", { name: mode === "uncertain" ? "Retry" : "Discard my changes", exact: true }); await resolution.click();
  if (mode === "uncertain") { await expect(page.locator(".studio-status")).toContainText("All changes saved"); expect(saves).toHaveLength(2); expect(saves[1]!.headers()["idempotency-key"]).toBe(saves[0]!.headers()["idempotency-key"]); expect(saves[1]!.postData()).toBe(saves[0]!.postData()); }
  else await expect(page.locator(".studio-stage")).not.toContainText("Waiting local edit");
  await openImport(page); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible(); await applyButton(page).click(); await expect(dialog(page)).toBeHidden(); expect(applies).toHaveLength(1);
});

test("completed queued edits save and import succeeds with both effects preserved", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page, true); const saves = writes(page, "/changes"), applies = writes(page);
  await page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true }).click(); const add = page.getByRole("dialog", { name: "Add step", exact: true });
  await add.getByLabel("Name").fill("Queued before import"); await add.getByRole("button", { name: "Add step", exact: true }).click();
  await openImport(page); await inspect(page); await applyButton(page).click(); await expect(dialog(page)).toBeHidden();
  expect(saves).toHaveLength(1); expect(applies).toHaveLength(1); expect(Object.values((await draftOf(page, id)).document.nodes).some((node) => node.label === "Queued before import")).toBe(true);
});

test("active pointer drag refuses import until the gesture is explicitly finished", async ({ page }) => {
  test.setTimeout(90_000);
  const { id, first } = await setup(page, true); const applies = writes(page);
  const box = (await nodeAt(page, first).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2, { steps: 4 });
  try {
    await page.locator(".flow-switch").evaluate((element) => (element as HTMLButtonElement).click());
    await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Import flow", exact: true }).evaluate((element) => (element as HTMLButtonElement).click());
    await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "journey.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() });
    await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).evaluate((element) => (element as HTMLButtonElement).click());
    await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
    await applyButton(page).evaluate((element) => (element as HTMLButtonElement).click());
    await expect(dialog(page).getByRole("alert")).toContainText("active drag"); expect(applies).toHaveLength(0); expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(1);
  } finally { await page.mouse.up(); }
});

test("late Apply and fenced late reload responses cannot navigate a reopened project", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page, true); const other = await createProjectViaApi(page, "Other project");
  await page.reload(); await openImport(page); await inspect(page);
  let held: Route | undefined; await page.route("**/flow-imports/*/apply", (route) => { held = route; }, { times: 1 });
  await applyButton(page).click(); await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('.project-row[title="Other project"]').evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
  const committed = await held!.fetch(); expect(committed.status()).toBe(200); await held!.fulfill({ response: committed });
  await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible(); await expect(page.getByText("Checkout {flow}", { exact: true })).toHaveCount(0);
  await page.locator('.project-row[title="Import project"]').click(); await openImport(page); await expect(dialog(page)).toBeHidden();
  expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(2);
  // A read started by an acknowledged import is fenced before its 401 can tear down the next project.
  await openImport(page); await inspect(page);
  const draft = await draftOf(page, id); let read: Route | undefined;
  await page.route(`**/drafts/${draft.id}`, (route) => { read = route; }, { times: 1 });
  await applyButton(page).click(); await expect.poll(() => Boolean(read)).toBe(true);
  await page.locator('.project-row[title="Other project"]').evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
  await read!.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Old session" } } });
  await expect(page).toHaveURL(`/app/projects/${other}`); await expect(page.getByRole("heading", { level: 1, name: "Other project" })).toBeVisible();
});

test("account change clears only import records and protected preview, including an in-flight late Apply", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page); await page.evaluate(() => sessionStorage.setItem("unrelated-preference", "keep")); await openImport(page); await inspect(page);
  let held: Route | undefined; await page.route("**/flow-imports/*/apply", (route) => { held = route; }, { times: 1 });
  await applyButton(page).click(); await expect.poll(() => Boolean(held)).toBe(true);
  // The existing controller's account-change callback dispatches this exact teardown event before replacing the page.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("scoperoom:session-ended", { detail: "account" })));
  await expect(page.getByText("Your account changed. Reloading…")).toBeVisible(); expect(await records(page)).toHaveLength(0);
  await held!.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Previous session" } } });
  await expect(dialog(page)).toHaveCount(0); expect(await page.evaluate(() => sessionStorage.getItem("unrelated-preference"))).toBe("keep");
});

test("READY original target becomes Stale on replacement; APPLIED never opens a cloned UUID in the replacement draft", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); await openImport(page); await inspect(page);
  const original = (await records(page))[0]; const replacementId = randomUUID();
  // The bootstrap/status are real responses except for the replacement identity: exercise the actual shared read admission.
  await page.route(`**/api/projects/${id}/bootstrap`, async (route) => {
    const response = await route.fetch(); const body = await response.json(); body.draft.id = replacementId; body.status.currentDraftId = replacementId; await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/projects/${id}/status`, async (route) => { const response = await route.fetch(); const body = await response.json(); body.currentDraftId = replacementId; await route.fulfill({ response, json: body }); });
  await page.reload(); await openImport(page); await expect(dialog(page).getByText("Stale", { exact: true })).toBeVisible(); await expect(applyButton(page)).toBeDisabled(); expect((await records(page))[0].draftId).toBe(original.draftId);
  const applied = await page.request.post(`/api/projects/${id}/flow-imports/${original.previewId}/apply`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { draftId: original.draftId, previewHash: original.previewHash } }); expect(applied.status()).toBe(200);
  const result = await applied.json();
  await page.reload(); await openImport(page); await expect(dialog(page).getByText("Applied", { exact: true })).toBeVisible(); await expect(dialog(page)).toContainText("historical flow is unavailable");
  // The shown replacement has the identical imported flow UUID and a covering revision pair; draft identity still forbids opening it.
  const replacementResponse = await page.request.get(`/api/projects/${id}/bootstrap`); const originalSaved = (await replacementResponse.json()).draft;
  expect(originalSaved.document.flows[result.flowId]).toBeTruthy(); await expect(dialog(page)).toBeVisible(); await expect(dialog(page).getByRole("button", { name: "Create unapproved copy" })).toHaveCount(0);
  expect((await records(page))[0].draftId).toBe(original.draftId);
});

collaborationTest.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");
collaborationTest("real peer edits and moves survive import; imported nodes drag, reload, and remain independent from a deliberate second copy", async ({ collaboration }) => {
  test.setTimeout(120_000);
  const { ownerPage, editorPage, projectId } = collaboration;
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Peer flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Peer original", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  (await interceptRealtime(editorPage)).dropEvents = true;
  await ownerPage.goto(`/app/projects/${projectId}`); await editorPage.goto(`/app/projects/${projectId}`); await expect(nodeAt(ownerPage, nodeId)).toBeVisible(); await expect(nodeAt(editorPage, nodeId)).toBeVisible();
  await openImport(editorPage); await inspect(editorPage);
  await nodeAt(ownerPage, nodeId).locator(".step-label").dblclick(); await ownerPage.locator(".inline-edit textarea").fill("Peer saved edit"); await ownerPage.locator(".inline-edit textarea").press("Enter");
  await drag(ownerPage, nodeId, 80, 30); await saveStudio(ownerPage); const peer = await draftOf(ownerPage, projectId);
  await applyButton(editorPage).click(); await expect(dialog(editorPage)).toBeHidden(); const imported = await draftOf(editorPage, projectId);
  expect(imported.document.nodes[nodeId]!.label).toBe("Peer saved edit"); expect(imported.layout.positions[nodeId]).toEqual(peer.layout.positions[nodeId]);
  const firstFlow = Object.values(imported.document.flows).find((flow) => flow.id !== flowId)!; const start = Object.values(imported.document.nodes).find((node) => node.flowId === firstFlow.id && node.label === "Begin")!;
  expect(imported.layout.positions[start.id]).toMatchObject({ x: 0, y: 0 });
  await drag(editorPage, start.id, 100, 30); await saveStudio(editorPage); const moved = (await draftOf(editorPage, projectId)).layout.positions[start.id]; expect(moved).not.toEqual(imported.layout.positions[start.id]);
  await editorPage.reload(); await editorPage.locator(".flow-switch").click(); await editorPage.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: /^Checkout/ }).click(); await expect(nodeAt(editorPage, start.id)).toBeVisible(); expect((await draftOf(editorPage, projectId)).layout.positions[start.id]).toEqual(moved);
  await openImport(editorPage); await inspect(editorPage); await applyButton(editorPage).click(); await expect(dialog(editorPage)).toBeHidden();
  const final = await draftOf(editorPage, projectId); const secondFlow = Object.values(final.document.flows).find((flow) => flow.id !== flowId && flow.id !== firstFlow.id)!;
  const secondStart = Object.values(final.document.nodes).find((node) => node.flowId === secondFlow.id && node.label === "Begin")!;
  expect(secondStart.id).not.toBe(start.id); expect(final.layout.positions[secondStart.id]).toMatchObject({ x: 0, y: 0 }); expect(final.layout.positions[start.id]).toEqual(moved);
});

test("oversize file is Invalid before reading or uploading its bytes", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const uploads = writes(page, "/preview"); const before = await draftOf(page, id);
  await openImport(page); await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "large.scoperoom-flow.json", mimeType: "application/json", buffer: Buffer.alloc(1_048_577) });
  await dialog(page).getByRole("button", { name: "Inspect file", exact: true }).click(); await expect(dialog(page).getByText("Invalid", { exact: true })).toBeVisible(); await expect(dialog(page).getByRole("alert")).toContainText("1 MiB"); expect(uploads).toHaveLength(0); expect(await draftOf(page, id)).toEqual(before);
});

test("discard lost acknowledgement repeats its stable key and never changes the saved draft", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const before = await draftOf(page, id); const discards = writes(page, "/discard");
  await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/discard", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await dialog(page).getByRole("button", { name: "Discard preview" }).click(); await expect(dialog(page).getByRole("alert")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Discard preview" }).click(); await expect(dialog(page)).toBeHidden();
  expect(discards).toHaveLength(2); expect(discards[1]!.headers()["idempotency-key"]).toBe(discards[0]!.headers()["idempotency-key"]); expect(await draftOf(page, id)).toEqual(before);
});

for (const pending of [false, true]) test(`expired retained identity after reload ${pending ? "releases unknown Apply and " : ""}asks for the same file before explicit fresh inspection`, async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const uploads = writes(page, "/preview"); await openImport(page); await inspect(page);
  if (pending) {
    await page.route("**/flow-imports/*/apply", (route) => route.abort("failed"), { times: 1 });
    await applyButton(page).click(); await expect(dialog(page).getByRole("button", { name: "Retry import" })).toBeEnabled();
    expect((await records(page))[0].attempt).toBeTruthy();
  }
  const original = (await records(page))[0];
  await page.route(`**/flow-imports/${original.previewId}`, async (route) => { const response = await route.fetch(); const preview: ImportPreviewView = await response.json(); await route.fulfill({ response, json: { ...preview, state: "EXPIRED", file: null, positions: null, fidelityReport: null } }); });
  await page.reload(); await openImport(page); await expect(dialog(page).getByText("Expired", { exact: true })).toBeVisible(); await expect(dialog(page)).toContainText("Select the same file again"); await expect(dialog(page).getByRole("button", { name: "Inspect again" })).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Cancel", exact: true })).toBeEnabled(); expect((await records(page))[0].attempt).toBeUndefined();
  await dialog(page).getByLabel("Native flow file").setInputFiles({ name: "same.scoperoom-flow.json", mimeType: "application/json", buffer: await nativeFile() }); await dialog(page).getByRole("button", { name: "Inspect again" }).click(); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible();
  expect(uploads).toHaveLength(2); expect((await records(page))[0].previewId).not.toBe(original.previewId); expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(0);
});

test("denied preview read clears protected record, labels and selected file", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page); await openImport(page); await inspect(page); const original = (await records(page))[0];
  await page.route(`**/flow-imports/${original.previewId}`, (route) => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unavailable" } } }));
  await dialog(page).getByRole("button", { name: "Recover import status" }).click(); await expect(dialog(page).getByText("Access lost", { exact: true })).toBeVisible(); expect(await records(page)).toHaveLength(0); await expect(dialog(page)).not.toContainText("Checkout {flow}"); await expect(dialog(page).getByLabel("Native flow file")).toHaveValue("");
});

test("APPLIED flow deleted later is explained as unavailable and never recreated on recovery", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const applies = writes(page); await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("couldn’t confirm");
  const committed = await draftOf(page, id); const flow = Object.values(committed.document.flows)[0]!;
  await seedStudioChanges(page, id, [{ command: "DELETE_FLOW", payload: { flowId: flow.id, removeNodeIds: Object.keys(committed.document.nodes), removeEdgeIds: Object.keys(committed.document.edges) }, proposedIds: [] }]);
  await page.reload(); await openImport(page); await expect(dialog(page).getByText("Applied", { exact: true })).toBeVisible(); await expect(dialog(page)).toContainText("created flow has since been deleted"); await expect(dialog(page).getByRole("button", { name: "Create unapproved copy" })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Refresh saved changes" }).click(); expect(applies).toHaveLength(1); expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(0);
  await dialog(page).getByRole("button", { name: "Start another import" }).click(); await expect(dialog(page).getByText("Select a file", { exact: true })).toBeVisible(); expect(await records(page)).toHaveLength(0);
});

test("unknown Apply reload retains READY original attempt and retries exact key/body", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const applies = writes(page); await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", (route) => route.abort("failed"), { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("couldn’t confirm"); const original = (await records(page))[0];
  expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(0); await page.reload(); await openImport(page);
  await expect(dialog(page).getByRole("button", { name: "Retry import" })).toBeEnabled(); expect((await records(page))[0]).toEqual(original); await expect(dialog(page).getByRole("button", { name: "Inspect again" })).toBeDisabled(); await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Retry import" }).click(); await expect(dialog(page)).toBeHidden(); expect(applies).toHaveLength(2); expect(applies[1]!.postData()).toBe(applies[0]!.postData()); expect(applies[1]!.headers()["idempotency-key"]).toBe(applies[0]!.headers()["idempotency-key"]); expect(Object.values((await draftOf(page, id)).document.flows)).toHaveLength(1);
});

test("uppercase project URL uses the same canonical opaque scope for inspection and reload", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); await page.goto(`/app/projects/${id.toUpperCase()}`); await openImport(page); await inspect(page);
  const original = (await records(page))[0]; expect(original.projectId).toBe(id); await page.reload(); await openImport(page); await expect(dialog(page).getByText("Ready", { exact: true })).toBeVisible(); expect((await records(page))[0]).toEqual(original);
});

test("archived owner recovers own APPLIED result but cannot inspect or create a new copy", async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await setup(page); const applies = writes(page); await openImport(page); await inspect(page);
  await page.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(page).click(); await expect(dialog(page).getByRole("alert")).toContainText("couldn’t confirm");
  const status = await (await page.request.get(`/api/projects/${id}/status`)).json(); const archive = await page.request.post(`/api/projects/${id}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: status.version, reason: "UI recovery fixture" } }); expect(archive.status()).toBe(200);
  await page.reload(); await openImport(page); await expect(dialog(page)).toBeHidden(); await expect(page.locator("#studio-flow-title")).toHaveText("Checkout {flow}");
  await openImport(page); await expect(dialog(page)).toContainText("read-only"); await expect(dialog(page).getByLabel("Native flow file")).toBeDisabled(); await expect(dialog(page).getByRole("button", { name: "Inspect file" })).toBeDisabled(); expect(applies).toHaveLength(1);
});

collaborationTest("downgraded reader recovers own APPLIED acknowledgement without issuing another write", async ({ collaboration }) => {
  test.setTimeout(120_000);
  const { editorPage, projectId, setEditorRole } = collaboration;
  await editorPage.goto(`/app/projects/${projectId}`); await openImport(editorPage); await inspect(editorPage); const applies = writes(editorPage);
  await editorPage.route("**/flow-imports/*/apply", async (route) => { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }, { times: 1 });
  await applyButton(editorPage).click(); await expect(dialog(editorPage).getByRole("alert")).toContainText("couldn’t confirm"); await setEditorRole("VIEWER");
  await editorPage.reload(); await openImport(editorPage); await expect(dialog(editorPage)).toBeHidden(); await expect(editorPage.locator("#studio-flow-title")).toHaveText("Checkout {flow}");
  await openImport(editorPage); await expect(dialog(editorPage)).toContainText("read-only"); await expect(dialog(editorPage).getByLabel("Native flow file")).toBeDisabled(); expect(applies).toHaveLength(1);
});

collaborationTest("real downgrade retains safe Studio input, disables new Apply, and removal clears protected import recovery", async ({ collaboration }) => {
  test.setTimeout(120_000);
  const { ownerPage, editorPage, projectId, setEditorRole, removeEditor } = collaboration;
  const flowId = randomUUID(), nodeId = randomUUID(); await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Peer flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Original", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  await editorPage.clock.install(); await editorPage.addInitScript(() => { Math.random = () => 0; }); await editorPage.goto(`/app/projects/${projectId}`); await expect(nodeAt(editorPage, nodeId)).toBeVisible();
  await nodeAt(editorPage, nodeId).click(); await editorPage.getByRole("button", { name: "Inspect", exact: true }).click(); await editorPage.locator("#inspect-label").fill("Safe local text"); await editorPage.getByLabel("X", { exact: true }).fill("420");
  await openImport(editorPage); await inspect(editorPage); const applies = writes(editorPage);
  await setEditorRole("VIEWER"); await poll(editorPage); await expect(applyButton(editorPage)).toBeDisabled(); await expect(dialog(editorPage)).toContainText("read-only");
  await dialog(editorPage).getByRole("button", { name: "Cancel", exact: true }).click(); await expect(editorPage.getByLabel("Your unsaved position")).toHaveValue(/420/); await expect(editorPage.getByLabel("Your unsaved text")).toHaveValue(/Safe local text/); expect(applies).toHaveLength(0);
  await openImport(editorPage); await expect(dialog(editorPage).getByText("Ready", { exact: true })).toBeVisible(); await removeEditor(); await poll(editorPage);
  await expect(editorPage.getByRole("heading", { level: 1, name: "Project unavailable" })).toBeVisible(); expect(await records(editorPage)).toHaveLength(0); await expect(editorPage.getByText("Safe local text")).toHaveCount(0);
});

test("completed queued edit is saved before Apply and buffers introduced during that Save are rechecked", async ({ page }) => {
  test.setTimeout(90_000);
  const { id, first } = await setup(page, true); const applies = writes(page), saves = writes(page, "/changes");
  await nodeAt(page, first).click(); await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.locator(".studio-toolbar").getByRole("button", { name: "Add step", exact: true }).click(); const add = page.getByRole("dialog", { name: "Add step", exact: true });
  await add.getByLabel("Name").fill("Queued completed edit"); await add.getByRole("button", { name: "Add step", exact: true }).click();
  await page.locator(".studio-toolbar").getByRole("button", { name: "Canvas", exact: true }).click();
  await nodeAt(page, first).click();
  await openImport(page); await inspect(page);
  let held: Route | undefined; await page.route("**/changes", (route) => { held = route; }, { times: 1 });
  await applyButton(page).click(); await expect.poll(() => Boolean(held)).toBe(true);
  await typeWhileModal(page, "#inspect-label", "Arrived during save"); await held!.continue();
  await expect(dialog(page).getByRole("alert")).toContainText("typed text"); expect(applies).toHaveLength(0); expect(saves).toHaveLength(1);
  expect(Object.values((await draftOf(page, id)).document.nodes).some((node) => node.label === "Queued completed edit")).toBe(true);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click(); await expect(page.locator("#inspect-label")).toHaveValue("Arrived during save");
});

test("status barrier rechecks typed coordinates immediately before sending Apply", async ({ page }) => {
  test.setTimeout(90_000);
  const { first } = await setup(page, true); const applies = writes(page);
  await nodeAt(page, first).click(); await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await openImport(page); await inspect(page);
  let held: Route | undefined; await page.route("**/status", (route) => { held = route; }, { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => Boolean(held)).toBe(true);
  await applyButton(page).click(); await typeWhileModal(page, ".position-form input#position-x", "640"); await held!.continue();
  await expect(dialog(page).getByRole("alert")).toContainText("coordinates"); expect(applies).toHaveLength(0);
});
