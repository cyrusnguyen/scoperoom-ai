import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, type Download, type Request } from "@playwright/test";
import { test } from "./studio-fixtures";
import { test as collaborationTest } from "./collaboration-fixtures";
import { appUrl, createProjectViaApi, seedStudioChanges } from "./support";
import { parseFlowFile } from "../../src/features/exchange/domain/flow-file.ts";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";

const dialog = (page: Page) => page.getByRole("dialog", { name: "Export flow", exact: true });
async function draftOf(page: Page, id: string): Promise<DraftView> { return (await (await page.request.get(`/api/projects/${id}/bootstrap`)).json()).draft; }
async function setup(page: Page, empty = false) {
  const id = await createProjectViaApi(page, "Export project"), flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(page, id, [
    { command: "CREATE_FLOW", payload: { title: "Saved journey", purpose: "Export test", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    ...(empty ? [] : [{ command: "ADD_NODE" as const, payload: { flowId, kind: "ACTION" as const, label: "Saved step", actorLabel: "Customer", description: "Private label text" }, proposedIds: [nodeId] }]),
  ]);
  await page.goto(`/app/projects/${id}`); await expect(page.locator(".flow-switch")).toBeVisible();
  return { id, flowId, nodeId };
}
async function openExport(page: Page) {
  await page.locator(".flow-switch").click();
  await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Export flow", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}
async function bytesOf(download: Download) { const path = await download.path(); expect(path).not.toBeNull(); return readFile(path!); }
async function download(page: Page) {
  const pending = page.waitForEvent("download"); await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click();
  const result = await pending; return { download: result, file: parseFlowFile(await bytesOf(result)) };
}
function exportsSent(page: Page) { const list: Request[] = []; page.on("request", req => { if (req.method() === "POST" && req.url().endsWith("/export")) list.push(req); }); return list; }

test("clean saved native download uses its disclosed pair and server filename", async ({ page }) => {
  const { id } = await setup(page), before = await draftOf(page, id), sent = exportsSent(page);
  await openExport(page); await expect(dialog(page)).toContainText(`Document revision ${before.documentRevision}, layout revision ${before.layoutRevision}`);
  await expect(dialog(page)).toContainText("confidential");
  const result = await download(page);
  expect(result.download.suggestedFilename()).toBe("Saved journey.scoperoom-flow.json");
  expect(result.file.nodes).toMatchObject([{ label: "Saved step", actorLabel: "Customer", description: "Private label text" }]);
  expect(result.file.origin).toEqual({ kind: "DRAFT", documentRevision: before.documentRevision, layoutRevision: before.layoutRevision });
  expect(sent).toHaveLength(1); expect(sent[0]!.headers()["idempotency-key"]).toBeUndefined();
  expect(sent[0]!.postDataJSON()).toEqual({ format: "native", includeLinkHints: false, expectedDocumentRevision: before.documentRevision, expectedLayoutRevision: before.layoutRevision });
  expect(await draftOf(page, id)).toEqual(before);
});

test("unsubmitted inspector text is excluded and Save cannot claim it saved", async ({ page }) => {
  const { id, nodeId } = await setup(page), before = await draftOf(page, id), sent = exportsSent(page);
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click(); await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.locator("#inspect-label").fill("Unsubmitted private text"); await openExport(page);
  await expect(dialog(page)).toContainText("unsaved"); await dialog(page).getByRole("button", { name: "Save and inspect saved state", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Submit or discard"); expect(sent).toHaveLength(0);
  const result = await download(page); expect(result.file.nodes[0]!.label).toBe("Saved step"); expect(await draftOf(page, id)).toEqual(before);
  await page.keyboard.press("Escape"); await expect(page.locator("#inspect-label")).toHaveValue("Unsubmitted private text");
});

test("Save and inspect drains completed local edits then requires an explicit download", async ({ page }) => {
  const { id, nodeId } = await setup(page), before = await draftOf(page, id), sent = exportsSent(page);
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).dblclick(); const input = page.getByRole("textbox", { name: "Step name" });
  await input.fill("Completed new label"); await input.press("Enter"); await openExport(page);
  await dialog(page).getByRole("button", { name: "Save and inspect saved state", exact: true }).click();
  await expect(dialog(page)).toContainText(`Document revision ${before.documentRevision + 1}`); expect(sent).toHaveLength(0);
  const result = await download(page); expect(result.file.nodes[0]!.label).toBe("Completed new label");
});

test("empty saved flow exports an explicit empty graph", async ({ page }) => {
  await setup(page, true); await openExport(page); const { file } = await download(page);
  expect(file.nodes).toEqual([]); expect(file.edges).toEqual([]); expect(file.positions).toEqual([]);
});

test("post-preparation status outage gives an actionable refusal and exact retry", async ({ page }) => {
  const { id } = await setup(page); let failed = false, downloaded = 0;
  page.on("download", () => downloaded++);
  await page.route("**/export", async route => { const result = await route.fetch(); failed = true; await route.fulfill({ response: result }); });
  await page.route(`**/api/projects/${id}/status`, route => failed ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Status temporarily unavailable" } } }) : route.continue());
  await openExport(page); await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("confirm your current access"); expect(downloaded).toBe(0);
  await page.unroute("**/export"); failed = false; const { file } = await download(page); expect(file.nodes[0]!.label).toBe("Saved step");
});

test("stale saved pair refreshes disclosure and requires an explicit second request", async ({ page }) => {
  const { id, flowId, nodeId } = await setup(page), before = await draftOf(page, id), sent = exportsSent(page);
  await openExport(page);
  await page.route("**/export", async route => {
    const moved = await page.request.post(`/api/projects/${id}/drafts/${before.id}/positions`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { mode: "MOVE_NODES", flowId, items: [{ nodeId, expectedPositionVersion: before.layout.positions[nodeId]!.version, x: 742, y: 351 }] } });
    expect(moved.status()).toBe(200); await route.continue();
  }, { times: 1 });
  await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("explicitly retry"); expect(sent).toHaveLength(1);
  await expect(dialog(page)).toContainText(`layout revision ${before.layoutRevision + 1}`);
  const { file } = await download(page); expect(sent).toHaveLength(2); expect(file.positions).toEqual([{ nodeId: "n1", x: 742, y: 351 }]);
});

test("a pending local move is excluded until Save and inspect acknowledges it", async ({ page }) => {
  const { id, nodeId } = await setup(page), before = await draftOf(page, id);
  const box = (await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 65, { steps: 8 }); await page.mouse.up();
  await openExport(page); await expect(dialog(page)).toContainText("pending movement");
  const first = await download(page); expect(first.file.positions).toEqual([{ nodeId: "n1", x: before.layout.positions[nodeId]!.x, y: before.layout.positions[nodeId]!.y }]);
  await dialog(page).getByRole("button", { name: "Save and inspect saved state", exact: true }).click();
  await expect(dialog(page)).toContainText(`layout revision ${before.layoutRevision + 1}`);
  const second = await download(page); expect(second.file.positions).not.toEqual(first.file.positions);
});

for (const status of [200, 401]) test(`late export ${status} after project replacement cannot download or navigate`, async ({ page }) => {
  const { id } = await setup(page); const destination = await createProjectViaApi(page, "Destination"); await page.reload(); await expect(page.getByRole("button", { name: "Destination", exact: true })).toBeVisible();
  let release!: () => void, downloaded = 0; const held = new Promise<void>(resolve => release = resolve); let started = false;
  page.on("download", () => downloaded++);
  await page.route("**/export", async route => { const response = await route.fetch(); started = true; await held; if (status === 200) await route.fulfill({ response }); else await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Session ended" } } }); });
  await openExport(page); await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Destination", exact: true, includeHidden: true }).dispatchEvent("click");
  await expect(page).toHaveURL(new RegExp(`/app/projects/${destination}$`));
  await expect(page.getByRole("heading", { name: "Destination", exact: true })).toBeVisible();
  const settled = page.waitForResponse(response => response.url().includes(`/api/projects/${id}/`) && response.url().endsWith("/export")); release(); await (await settled).finished(); await page.evaluate(() => Promise.resolve());
  await expect(page).toHaveURL(new RegExp(`/app/projects/${destination}$`)); expect(downloaded).toBe(0);
});

test("narrow keyboard export keeps Cancel focus and restores the flow opener", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  await page.locator(".flow-switch").focus(); await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Export flow", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Tab"); await expect(dialog(page).getByRole("button", { name: "Save and inspect saved state" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog(page)).toBeHidden(); await expect(page.locator(".flow-switch")).toBeFocused();
});

test("real downloaded export imports and reexports with graph geometry and fresh trust", async ({ page }) => {
  const { id, flowId } = await setup(page, true);
  const initial = await draftOf(page, id), bytes = await readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
  const previewId = randomUUID(); const preview = await page.request.post(`/api/projects/${id}/flow-imports/preview?draftId=${initial.id}&previewId=${previewId}`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID(), "Content-Type": "application/json" }, data: bytes });
  expect(preview.status()).toBe(200); const inspected = await preview.json();
  const applied = await page.request.post(`/api/projects/${id}/flow-imports/${previewId}/apply`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { draftId: initial.id, previewHash: inspected.previewHash } });
  expect(applied.status()).toBe(200); const originalFlow = (await applied.json()).flowId;
  await page.reload(); await page.locator(".flow-switch").click(); await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: /^Checkout/ }).click();
  await openExport(page); const first = await download(page); const source = await draftOf(page, id); await page.keyboard.press("Escape");
  await page.locator(".flow-switch").click(); await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: "Import flow", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "Import flow", exact: true });
  await importer.getByLabel("Native flow file").setInputFiles({ name: first.download.suggestedFilename(), mimeType: "application/json", buffer: await bytesOf(first.download) });
  await importer.getByRole("button", { name: "Inspect file", exact: true }).click(); await expect(importer.getByText("Ready", { exact: true })).toBeVisible();
  await importer.getByRole("button", { name: "Create unapproved copy", exact: true }).click(); await expect(importer).toBeHidden();
  const after = await draftOf(page, id); const importedFlow = Object.keys(after.document.flows).find(key => !source.document.flows[key])!;
  expect(importedFlow).not.toBe(originalFlow); expect(after.document.flows[importedFlow]).toMatchObject({ inclusion: "UNDECIDED", confirmation: null, verificationMethod: null });
  for (const [key, value] of Object.entries(source.document.flows)) expect(after.document.flows[key]).toEqual(value);
  for (const [key, value] of Object.entries(source.document.nodes)) { expect(after.document.nodes[key]).toEqual(value); expect(after.layout.positions[key]).toEqual(source.layout.positions[key]); }
  for (const [key, value] of Object.entries(source.document.edges)) { expect(after.document.edges[key]).toEqual(value); expect(after.layout.edgeSides[key]).toEqual(source.layout.edgeSides[key]); }
  expect(after.layout.directions[originalFlow]).toBe(source.layout.directions[originalFlow]); expect(after.document.flows[flowId]).toEqual(source.document.flows[flowId]);
  const newNodes = Object.values(after.document.nodes).filter(node => node.flowId === importedFlow); expect(newNodes).toHaveLength(first.file.nodes.length);
  for (const node of newNodes) { expect(source.document.nodes[node.id]).toBeUndefined(); expect(node).toMatchObject({ origin: "IMPORTED", sourceRefs: [] }); }
  await openExport(page); const second = await download(page);
  const normalize = (file: typeof first.file) => {
    const labels = new Map(file.nodes.map(node => [node.id, node.label])); expect(new Set(labels.values()).size).toBe(file.nodes.length);
    const edges = new Map(file.edges.map(edge => [edge.id, edge]));
    return { flow: file.flow, nodes: file.nodes.map(({ id: _id, ...node }) => { void _id; return node; }).sort((a, b) => a.label.localeCompare(b.label)),
      edges: file.edges.map(edge => ({ from: labels.get(edge.fromId), to: labels.get(edge.toId), condition: edge.condition })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      positions: file.positions!.map(position => ({ label: labels.get(position.nodeId), x: position.x, y: position.y })).sort((a, b) => a.label!.localeCompare(b.label!)),
      sides: file.edgeSides!.map(side => ({ fromNode: labels.get(edges.get(side.edgeId)!.fromId), toNode: labels.get(edges.get(side.edgeId)!.toId), from: side.from, to: side.to })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  };
  expect(normalize(second.file)).toEqual(normalize(first.file));
});

test("peer deleting the selected flow never retargets export to a fallback flow", async ({ page }) => {
  const { id, flowId } = await setup(page, true), before = await draftOf(page, id), fallback = randomUUID();
  await seedStudioChanges(page, id, [{ command: "CREATE_FLOW", payload: { title: "Fallback flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [fallback] }]);
  await page.reload(); await page.locator(".flow-switch").click(); await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: /Saved journey/ }).click(); await openExport(page);
  await expect(dialog(page)).toContainText("Saved journey");
  const current = await draftOf(page, id);
  const removed = await page.request.post(`/api/projects/${id}/drafts/${before.id}/changes`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { commands: [{ commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: current.documentRevision, payload: { flowId, removeNodeIds: [], removeEdgeIds: [] } }], moves: [] } });
  expect(removed.status()).toBe(200);
  await dialog(page).getByRole("button", { name: "Inspect current saved state", exact: true }).click();
  await expect(dialog(page)).toContainText("unavailable"); await expect(dialog(page)).not.toContainText("Fallback flow");
  await expect(dialog(page).getByRole("button", { name: "Export saved state", exact: true })).toBeDisabled();
});

test("live export HTTP is keyless no-store authenticated and refuses client replacement data", async ({ page, browser }) => {
  const { id, flowId } = await setup(page), before = await draftOf(page, id);
  const url = `/api/projects/${id}/drafts/${before.id}/flows/${flowId}/export`, data = { format: "native", includeLinkHints: false, expectedDocumentRevision: before.documentRevision, expectedLayoutRevision: before.layoutRevision };
  const post = (body: unknown, origin = appUrl) => page.request.post(url, { headers: { Origin: origin }, data: body });
  const success = await post(data); expect(success.status()).toBe(200); expect(success.headers()["cache-control"]).toContain("no-store"); expect(await success.json()).toMatchObject({ filename: "Saved journey.scoperoom-flow.json", file: { format: "scoperoom-flow" } });
  for (const extra of [{ document: before.document }, { layout: before.layout }, { positions: [] }, { includeLinkHints: true }, { format: "png" }]) {
    const refused = await post({ ...data, ...extra }); expect(refused.status()).toBe(400); expect(await refused.json()).toMatchObject({ error: { code: "INVALID_INPUT" } }); expect(refused.headers()["cache-control"]).toContain("no-store");
  }
  expect((await post(data, "https://evil.example")).status()).toBe(403); expect((await post(data, "")).status()).toBe(403);
  const anonymous = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  try { const denied = await anonymous.request.post(url, { headers: { Origin: appUrl }, data }); expect(denied.status()).toBe(401); expect(denied.headers()["cache-control"]).toContain("no-store"); }
  finally { await anonymous.close(); }
  expect(await draftOf(page, id)).toEqual(before);
});

test("Cancel during held preparation prevents a late private download", async ({ page }) => {
  await setup(page); let release!: () => void, started = false, downloaded = 0; const held = new Promise<void>(resolve => release = resolve);
  page.on("download", () => downloaded++);
  await page.route("**/export", async route => { const response = await route.fetch(); started = true; await held; await route.fulfill({ response }); });
  await openExport(page); await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click(); await expect.poll(() => started).toBe(true);
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  const finished = page.waitForResponse(response => response.url().endsWith("/export")); release(); await (await finished).finished();
  await expect(dialog(page)).toBeHidden(); expect(downloaded).toBe(0); await expect(page.locator(".flow-switch")).toBeFocused();
});

async function seedShared(ownerPage: Page, projectId: string) {
  const flowId = randomUUID(), nodeId = randomUUID();
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Shared saved flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Shared saved step", actorLabel: "", description: "" }, proposedIds: [nodeId] },
  ]); return { flowId, nodeId };
}
for (const role of ["VIEWER", "REVIEWER"] as const) collaborationTest(`${role} exports an archived saved flow with read authority`, async ({ collaboration: { ownerPage, editorPage, projectId, setEditorRole } }) => {
  await seedShared(ownerPage, projectId); await setEditorRole(role);
  const status = await (await ownerPage.request.get(`/api/projects/${projectId}/status`)).json();
  expect((await ownerPage.request.post(`/api/projects/${projectId}/archive`, { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { expectedProjectVersion: status.version, reason: "Export fixture" } })).status()).toBe(200);
  await editorPage.goto(`/app/projects/${projectId}`); await openExport(editorPage);
  const { file } = await download(editorPage); expect(file.nodes[0]!.label).toBe("Shared saved step");
});

for (const change of ["removed", "account"] as const) collaborationTest(`${change} during held preparation prevents private download`, async ({ collaboration: { ownerPage, editorPage, projectId, removeEditor } }) => {
  await seedShared(ownerPage, projectId); await editorPage.goto(`/app/projects/${projectId}`); let release!: () => void, started = false, downloaded = 0;
  const held = new Promise<void>(resolve => release = resolve); editorPage.on("download", () => downloaded++);
  await editorPage.route("**/export", async route => { const response = await route.fetch(); expect(response.status()).toBe(200); started = true; await held; await route.fulfill({ response }); });
  await openExport(editorPage); await dialog(editorPage).getByRole("button", { name: "Export saved state", exact: true }).click(); await expect.poll(() => started).toBe(true);
  if (change === "removed") await removeEditor();
  else { await editorPage.context().clearCookies(); await editorPage.context().addCookies(await ownerPage.context().cookies()); }
  const finished = editorPage.waitForResponse(response => response.url().endsWith("/export")); release(); await (await finished).finished();
  if (change === "account") await expect(editorPage).toHaveURL(/\/app$/);
  else await expect(editorPage.locator("#studio-flow-title")).toHaveCount(0);
  expect(downloaded).toBe(0);
});

collaborationTest("real peer drag ghost never enters a downloaded native file", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const { nodeId } = await seedShared(ownerPage, projectId); await Promise.all([ownerPage, editorPage].map(page => page.goto(`/app/projects/${projectId}`)));
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 });
  const before = await draftOf(ownerPage, projectId); await openExport(ownerPage);
  const box = (await editorPage.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox())!;
  await editorPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await editorPage.mouse.down();
  await editorPage.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 80, { steps: 8 });
  try {
    await expect(ownerPage.locator(`.live-ghost[data-node-id="${nodeId}"]`)).toBeAttached();
    const { file } = await download(ownerPage); expect(file.positions).toEqual([{ nodeId: "n1", x: before.layout.positions[nodeId]!.x, y: before.layout.positions[nodeId]!.y }]);
    expect(await draftOf(ownerPage, projectId)).toEqual(before);
  } finally { await editorPage.mouse.up(); }
});

test("replacement draft generation fences a held native preparation", async ({ page }) => {
  const { id } = await setup(page); const replacement = randomUUID(); let replacementRead = false; let release!: () => void, started = false, downloaded = 0; const held = new Promise<void>(resolve => release = resolve);
  page.on("download", () => downloaded++);
  await page.route("**/export", async route => { const response = await route.fetch(); started = true; await held; await route.fulfill({ response }); });
  await openExport(page); await dialog(page).getByRole("button", { name: "Export saved state", exact: true }).click(); await expect.poll(() => started).toBe(true);
  await page.route(`**/api/projects/${id}/status`, async route => { const response = await route.fetch(), body = await response.json(); body.currentDraftId = replacement; await route.fulfill({ response, json: body }); });
  await page.route(`**/api/projects/${id}/bootstrap`, async route => { const response = await route.fetch(), body = await response.json(); body.status.currentDraftId = replacement; body.draft.id = replacement; replacementRead = true; await route.fulfill({ response, json: body }); });
  const status = page.waitForResponse(response => response.url().endsWith("/status")); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await status; await expect.poll(() => replacementRead).toBe(true);
  const finished = page.waitForResponse(response => response.url().endsWith("/export")); release(); await (await finished).finished();
  await expect(dialog(page).getByRole("button", { name: "Export saved state", exact: true })).toBeEnabled(); expect(downloaded).toBe(0);
});

test("acknowledged save with under-floor saved reads blocks export until a covering inspection", async ({ page }) => {
  const { id, nodeId } = await setup(page), before = await draftOf(page, id), sent = exportsSent(page); let stale = true;
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).dblclick(); const input = page.getByRole("textbox", { name: "Step name" }); await input.fill("Receipt acknowledged label"); await input.press("Enter");
  await page.route(`**/api/projects/${id}/drafts/${before.id}`, route => stale ? route.fulfill({ json: before }) : route.continue());
  await openExport(page); await dialog(page).getByRole("button", { name: "Save and inspect saved state", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("acknowledged revisions");
  await expect(dialog(page).getByRole("button", { name: "Export saved state", exact: true })).toBeDisabled(); expect(sent).toHaveLength(0);
  stale = false; await dialog(page).getByRole("button", { name: "Inspect current saved state", exact: true }).click();
  await expect(dialog(page)).toContainText(`Document revision ${before.documentRevision + 1}`);
  const { file } = await download(page); expect(file.nodes[0]!.label).toBe("Receipt acknowledged label");
});
