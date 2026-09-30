import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import type { Client } from "pg";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { interceptRealtime, poll, test } from "./collaboration-fixtures";
import { appUrl, e2eReady, headerSave, openDatabase, saveStudio, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const ghostAt = (page: Page, nodeId: string) => page.locator(`.live-ghost[data-node-id="${nodeId}"]`);
const transformOf = (page: Page, nodeId: string) => nodeAt(page, nodeId).evaluate((element) => (element as HTMLElement).style.transform);
const status = (page: Page) => page.locator(".studio-status");
/** The header note while Realtime is delayed; nothing matches while it is healthy. Saving never depends on it. */
const delayed = (page: Page) => page.getByRole("status").filter({ hasText: "Live updates delayed" });
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
const envelope = (code: string, message: string) => ({ error: { code, message, requestId: "00000000-0000-4000-8000-000000000000", retryable: true } });

// Stage 04.3 Task 5: a peer's drag is an advisory, labelled outline in flow space; it never moves a canonical node, and the
// only saved result is the peer's own Save.
test("a peer's drag shows as a labelled ghost at any pan and zoom, the canonical step stays put until the save, and the ghost ends with the drag", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const [flowId, startId, nextId] = [randomUUID(), randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Live", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Next", description: "", actorLabel: "" }, proposedIds: [nextId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  await expect(nodeAt(ownerPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 }); // both are subscribed and in the roster
  // The owner views the flow at a different zoom than the editor drags at.
  await ownerPage.getByRole("button", { name: "Zoom Out" }).click();
  await ownerPage.waitForTimeout(400);
  const savedTransform = await transformOf(ownerPage, startId);

  const box = (await nodeAt(editorPage, startId).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await editorPage.mouse.move(x, y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(x + 60, y + 30, { steps: 4 });
  await editorPage.mouse.move(x + 160, y + 80, { steps: 8 });

  const ghost = ghostAt(ownerPage, startId);
  await expect(ghost).toBeVisible({ timeout: 10_000 });
  await expect(ghost).toContainText("Collab editor");
  await expect(ownerPage.locator(".live-overlay")).toHaveAttribute("aria-hidden", "true");
  await expect(ownerPage.locator("[aria-live] .live-overlay, .live-overlay [aria-live]")).toHaveCount(0);
  // The ghost is a pointer-events-none outline; the canonical step has not moved (only a save moves it).
  await expect(ghost).toHaveCSS("pointer-events", "none");
  expect(await transformOf(ownerPage, startId)).toBe(savedTransform);
  const [ghostBox, nodeBox] = [(await ghost.boundingBox())!, (await nodeAt(ownerPage, startId).boundingBox())!];
  expect(Math.abs(ghostBox.x - nodeBox.x) + Math.abs(ghostBox.y - nodeBox.y)).toBeGreaterThan(10);
  // The ghost is drawn in flow space under the owner's zoom: it is as wide as the owner's own (zoomed-out) copy of the step.
  expect(Math.abs(ghostBox.width - nodeBox.width)).toBeLessThan(4);
  expect(nodeBox.width).toBeLessThan(box.width); // the owner really is zoomed out relative to the editor

  // A fresh update right before the drop, so only DRAG_END (not the 2 s expiry) can remove the ghost within the next second.
  await editorPage.mouse.move(x + 162, y + 81);
  await editorPage.waitForTimeout(200); // longer than the 125 ms movement interval: the nudge is on the wire before the drop
  await expect(ghost).toBeVisible();
  await editorPage.mouse.up();
  await expect(ghost).toHaveCount(0, { timeout: 1_000 });
  expect(await transformOf(ownerPage, startId)).toBe(savedTransform); // unsaved: nothing changed for the owner

  await saveStudio(editorPage);
  await ownerPage.reload();
  await expect(nodeAt(ownerPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => transformOf(ownerPage, startId)).not.toBe(savedTransform);
  const placed = await transformOf(ownerPage, startId);
  await editorPage.reload();
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => transformOf(editorPage, startId)).toBe(placed);
});

test("a peer's cursor over the canvas is labelled; over a panel it is not published", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const [flowId, startId] = [randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Cursors", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 });
  const pane = (await editorPage.locator(".react-flow__pane").boundingBox())!;
  await editorPage.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 40);
  await editorPage.mouse.move(pane.x + pane.width / 2 + 20, pane.y + pane.height - 30, { steps: 4 });
  const cursor = ownerPage.locator(".live-cursor");
  await expect(cursor).toBeVisible({ timeout: 10_000 });
  await expect(cursor).toContainText("Collab editor");
  await expect(cursor).toHaveCSS("pointer-events", "none");
  // Nothing is published from the controls: keep moving over them longer than the 2 s preview TTL. A published position would
  // keep the cursor alive there; instead the last one from the canvas expires.
  const controls = (await editorPage.locator(".canvas-controls").boundingBox())!;
  const [cx, cy] = [controls.x + controls.width / 2, controls.y + controls.height / 2];
  await editorPage.mouse.move(cx, cy, { steps: 6 });
  for (let step = 0; step < 14; step++) { await editorPage.mouse.move(cx + (step % 2 ? 4 : -4), cy); await editorPage.waitForTimeout(200); }
  await expect(cursor).toHaveCount(0, { timeout: 500 });
});

// Stage 04.3 Task 6: recovery, refresh and hostile input against the real provider. Every Realtime fault is a WebSocket-level interception of
// one page's own sockets (`interceptRealtime`); HTTP is never touched, and each fault is paired with evidence that the provider really did its part.
const centerOf = async (page: Page, nodeId: string) => {
  const box = (await nodeAt(page, nodeId).boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2] as const;
};
async function dragNode(page: Page, nodeId: string, dx: number, dy: number) {
  const [x, y] = await centerOf(page, nodeId);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}
async function renameLocally(page: Page, nodeId: string, label: string) {
  await nodeAt(page, nodeId).locator(".step-label").dblclick();
  await nodeAt(page, nodeId).getByRole("textbox", { name: "Step name" }).fill(label);
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Unsaved changes");
}
const draftOf = async (page: Page, projectId: string) => (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;

/** Start -> Pay -> Ship, saved by the owner in one real batch. */
async function seedChain(page: Page, projectId: string) {
  const [flowId, startId, payId, shipId] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  const node = (id: string, kind: string, label: string) => ({ command: "ADD_NODE", payload: { flowId, kind, label, description: "", actorLabel: "" }, proposedIds: [id] });
  const edge = (fromId: string, toId: string) => ({ command: "ADD_EDGE", payload: { flowId, fromId, toId, condition: "" }, proposedIds: [randomUUID()] });
  const draftId = await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Recovery", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    node(startId, "START", "Start"), node(payId, "ACTION", "Pay"), node(shipId, "ACTION", "Ship"), edge(startId, payId), edge(payId, shipId),
  ]);
  return { flowId, draftId, startId, payId, shipId };
}
type Chain = Awaited<ReturnType<typeof seedChain>>;

/** A saved rename as the given account, through the real API. */
async function saveLabel(page: Page, projectId: string, nodeId: string, label: string) {
  const draft = await draftOf(page, projectId);
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
    headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: draft.document.nodes[nodeId]!.version, payload: { nodeId, label } },
  });
  expect(response.status()).toBe(200);
}
async function savePosition(page: Page, projectId: string, ids: Chain, nodeId: string, x: number, y: number) {
  const { positions } = (await draftOf(page, projectId)).layout;
  const response = await page.request.post(`/api/projects/${projectId}/drafts/${ids.draftId}/positions`, {
    headers: headers(), data: { mode: "MOVE_NODES", flowId: ids.flowId, items: [{ nodeId, expectedPositionVersion: positions[nodeId]!.version, x, y }] },
  });
  expect(response.status()).toBe(200);
}
/** Both pages on the project with their nodes drawn, and the editor's channels joined (the owner counts them in the roster). */
async function openBoth({ ownerPage, editorPage, projectId }: { ownerPage: Page; editorPage: Page; projectId: string }, ids: Chain) {
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  for (const page of [ownerPage, editorPage]) await expect(nodeAt(page, ids.shipId)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 });
}

// RT-016, Review Focus 5: the provider delivers every hint to a healthy socket, the page never sees one, and 04.2's status timer alone converges.
// The page clock is frozen (as in the 04.2 polling specs), so no hint could be acted on before the poll deadline either way: the proof that the
// hint path was really lost is the wire counter (hints delivered by the provider and withheld), not the absence of an early update.
test("every hint lost on a healthy socket: the status timer alone converges, and a reload shows the saved values", async ({ collaboration }) => {
  test.setTimeout(120_000);
  const { ownerPage, editorPage, projectId } = collaboration;
  const ids = await seedChain(ownerPage, projectId);
  const wire = await interceptRealtime(editorPage);
  wire.dropEvents = true;
  await editorPage.addInitScript(() => { Math.random = () => 0; }); // jitter 0: the poll is due exactly 9 s after the last read
  await editorPage.clock.install();
  await openBoth(collaboration, ids);
  await editorPage.clock.pauseAt(new Date(Date.now() + 2_000)); // from here only `poll` moves the editor's time
  const startBefore = await transformOf(editorPage, ids.startId);

  await saveLabel(ownerPage, projectId, ids.payId, "Pay (theirs)");
  await savePosition(ownerPage, projectId, ids, ids.startId, 640, 480);
  await expect.poll(() => wire.dropped, { timeout: 15_000 }).toBeGreaterThan(0); // the provider delivered a hint to the reader's socket; the page never saw it
  expect(wire.connections).toBe(1);
  await expect(delayed(editorPage)).toHaveCount(0); // the socket is healthy: this is not the outage case
  await expect(nodeAt(editorPage, ids.payId)).not.toContainText("Pay (theirs)");

  await poll(editorPage);
  await expect(nodeAt(editorPage, ids.payId)).toContainText("Pay (theirs)");
  await expect.poll(() => transformOf(editorPage, ids.startId)).not.toBe(startBefore);

  // Values are asserted from the saved draft after a reload, not from the live view that converged.
  await editorPage.clock.resume();
  await Promise.all([editorPage.reload(), ownerPage.reload()]);
  await expect(nodeAt(editorPage, ids.payId)).toContainText("Pay (theirs)", { timeout: 20_000 });
  await expect(nodeAt(ownerPage, ids.startId)).toBeVisible({ timeout: 20_000 });
  const saved = await draftOf(editorPage, projectId);
  expect(saved.document.nodes[ids.payId]!.label).toBe("Pay (theirs)");
  expect(saved.layout.positions[ids.startId]).toMatchObject({ x: 640, y: 480 });
  await expect.poll(async () => transformOf(editorPage, ids.startId)).toBe(await transformOf(ownerPage, ids.startId));
});

// RT-018, RT-009: only the WebSockets go down. A real content and position Save still succeeds; the peer's saved position arrives by polling;
// on reconnect the delayed note goes, no ghost is left, and the first write after the rejoin waits for a status read.
test("a Realtime outage never blocks saving: Save succeeds while Live updates delayed shows, and after reconnect peers converge", async ({ collaboration }) => {
  test.setTimeout(180_000);
  const { ownerPage, editorPage, projectId } = collaboration;
  const ids = await seedChain(ownerPage, projectId);
  const wire = await interceptRealtime(editorPage);
  await openBoth(collaboration, ids);
  const startBefore = await transformOf(editorPage, ids.startId);

  // The owner holds a drag on Start, moving continuously: the editor sees its ghost.
  const [x, y] = await centerOf(ownerPage, ids.startId);
  await ownerPage.mouse.move(x, y);
  await ownerPage.mouse.down();
  await ownerPage.mouse.move(x + 60, y + 30, { steps: 4 });
  await ownerPage.mouse.move(x + 160, y + 80, { steps: 8 });
  await expect(ghostAt(editorPage, ids.startId)).toBeVisible({ timeout: 10_000 });
  let dragging = true;
  const wiggle = (async () => { for (let step = 0; dragging; step++) { await ownerPage.mouse.move(x + 160 + (step % 2) * 4, y + 80); await ownerPage.waitForTimeout(140); } })();

  await wire.cut(); // the editor's sockets only; every HTTP request still works
  await expect(delayed(editorPage)).toBeVisible({ timeout: 20_000 });
  await expect(ghostAt(editorPage, ids.startId)).toHaveCount(0, { timeout: 1_000 }); // the overlay ends with the connection, although the drag is still fresh
  dragging = false;
  await wiggle;
  await ownerPage.mouse.up();
  await saveStudio(ownerPage); // the owner's position is saved; the editor cannot hear about it

  // Polling (5 s base while delayed) carries the saved position to the editor with no socket at all.
  await expect.poll(() => transformOf(editorPage, ids.startId), { timeout: 30_000 }).not.toBe(startBefore);
  await expect(delayed(editorPage)).toBeVisible();

  // A real content and position Save from the editor with Realtime down.
  const shipBefore = (await draftOf(ownerPage, projectId)).layout.positions[ids.shipId]!.version;
  await renameLocally(editorPage, ids.payId, "Pay (editor)");
  await dragNode(editorPage, ids.shipId, 150, 0);
  await headerSave(editorPage).click();
  await expect(status(editorPage)).toContainText("All changes saved");
  await expect(delayed(editorPage)).toBeVisible(); // the Save neither needed nor cured the outage
  const during = await draftOf(ownerPage, projectId);
  expect(during.document.nodes[ids.payId]!.label).toBe("Pay (editor)");
  expect(during.layout.positions[ids.shipId]!.version).toBeGreaterThan(shipBefore);

  // Reconnect: the note clears, and a write made right after the rejoin is preceded by a status read.
  const order: string[] = [];
  editorPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/status$/.test(path)) order.push("status");
    else if (request.method() === "POST" && /\/drafts\/[^/]+\/(changes|positions|commands)$/.test(path)) order.push("write");
  });
  wire.restore();
  await expect(delayed(editorPage)).toHaveCount(0, { timeout: 40_000 });
  expect(wire.connections).toBeGreaterThan(1);
  await renameLocally(editorPage, ids.startId, "Start (after)");
  await headerSave(editorPage).click();
  await expect(status(editorPage)).toContainText("All changes saved");
  expect(order.indexOf("status")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("status")).toBeLessThan(order.indexOf("write"));

  // Peers converge, no stale ghost remains, and the saved draft holds both people's work after a reload.
  await expect(nodeAt(ownerPage, ids.payId)).toContainText("Pay (editor)", { timeout: 20_000 });
  await expect(nodeAt(ownerPage, ids.startId)).toContainText("Start (after)", { timeout: 20_000 });
  for (const page of [ownerPage, editorPage]) await expect(page.locator(".live-ghost")).toHaveCount(0);
  await Promise.all([ownerPage.reload(), editorPage.reload()]);
  for (const page of [ownerPage, editorPage]) {
    await expect(nodeAt(page, ids.payId)).toContainText("Pay (editor)", { timeout: 20_000 });
    await expect(nodeAt(page, ids.startId)).toContainText("Start (after)");
  }
  const saved = await draftOf(ownerPage, projectId);
  expect([saved.document.nodes[ids.payId]!.label, saved.document.nodes[ids.startId]!.label]).toEqual(["Pay (editor)", "Start (after)"]);
});

// The credential lasts 300 s and is renewed from 60 s before its end by realtime-js's heartbeat callback. The editor's page clock is advanced one
// heartbeat at a time (each reply is awaited, or the client would declare the socket dead), so the renewal is real: a real token request, a real
// access_token push on each joined channel, and a real rejoin that the provider accepts with the renewed credential.
test("a renewed credential reaches the open socket through the heartbeat, with no reconnect and no duplicate channel, and a rejoin uses it", async ({ collaboration }) => {
  test.setTimeout(240_000);
  const { ownerPage, editorPage, projectId } = collaboration;
  const ids = await seedChain(ownerPage, projectId);
  const wire = await interceptRealtime(editorPage);
  const tokenRequests: string[] = [];
  const statusReads: string[] = [];
  editorPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/realtime-token$/.test(path)) tokenRequests.push(path);
    if (/\/status$/.test(path)) statusReads.push(path);
  });
  await editorPage.addInitScript(() => { Math.random = () => 0; });
  await editorPage.clock.install();
  await openBoth(collaboration, ids);
  await expect.poll(() => wire.joins.length).toBe(2); // events and collab, once each
  const firstJoins = [...wire.joins];
  expect(new Set(firstJoins).size).toBe(2);
  const issuedAtLoad = tokenRequests.length;
  expect(issuedAtLoad).toBeGreaterThan(0);
  await editorPage.clock.pauseAt(new Date(Date.now() + 2_000));

  for (let beat = 0; beat < 14 && tokenRequests.length === issuedAtLoad; beat++) { // the source renews at the first heartbeat within 60 s of expiry
    const replies = wire.heartbeatReplies;
    await editorPage.clock.runFor(25_000);
    await expect.poll(() => wire.heartbeatReplies, { timeout: 10_000 }).toBeGreaterThan(replies);
  }
  expect(tokenRequests.length).toBeGreaterThan(issuedAtLoad);
  await expect.poll(() => wire.accessTokens, { timeout: 10_000 }).toBe(2); // the renewed JWT reached the socket, once per joined channel
  expect(wire.connections).toBe(1);
  expect(wire.joins).toEqual(firstJoins); // no rejoin and no extra channel
  await expect(delayed(editorPage)).toHaveCount(0);

  // A rejoin now presents the renewed credential: the provider accepts both joins, the status is read again, and no channel is duplicated.
  const readsBefore = statusReads.length;
  await wire.cut();
  wire.restore();
  for (let step = 0; step < 40 && wire.joined < 4; step++) {
    await editorPage.clock.runFor(1_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await expect.poll(() => wire.joined).toBe(4);
  expect(wire.joins).toHaveLength(4);
  expect(new Set(wire.joins).size).toBe(2);
  await expect(delayed(editorPage)).toHaveCount(0);
  await expect.poll(() => statusReads.length).toBeGreaterThan(readsBefore); // the rejoin refetches status

  await saveLabel(ownerPage, projectId, ids.payId, "Pay (after refresh)");
  await poll(editorPage);
  await expect(nodeAt(editorPage, ids.payId)).toContainText("Pay (after refresh)");
});

type SavedState = { draft: string; receipts: number; audit: number };
/** Everything saved that a preview must never touch: the draft (both revisions and both documents), receipts and audit for the project's people. */
async function savedState(database: Client, projectId: string): Promise<SavedState> {
  const { rows: [row] } = await database.query<SavedState>(
    `select (select concat(document_revision, ':', layout_revision, ':', document_json::text, ':', layout_json::text) from app.scope_draft where id = (select current_draft_id from app.project where id = $1)) as draft,
            (select count(*)::int from app.mutation_receipt where scope_id = $1 or actor_id in (select owner_id from app.project where id = $1 union select profile_id from app.project_membership where project_id = $1)) as receipts,
            (select count(*)::int from app.audit_event where project_id = $1) as audit`,
    [projectId],
  );
  return row!;
}

// RT-007, RT-008, RT-010, RT-011, RT-022: a real editor credential (from the real route) on a real collab channel sends hostile packets. The
// provider acknowledges every one; the owner's page draws none of them, and nothing saved, receipted or audited moves.
test("adversarial packets on a real editor channel reach nothing saved, and only the valid control shows", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  test.setTimeout(120_000);
  const ids = await seedChain(ownerPage, projectId);
  const database = await openDatabase();
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    await ownerPage.goto(`/app/projects/${projectId}`);
    await expect(nodeAt(ownerPage, ids.shipId)).toBeVisible({ timeout: 20_000 });
    const boot = await (await ownerPage.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { status: { realtimeEpoch: string; currentDraftId: string }; realtime: { collab: string } };
    const { members } = await (await ownerPage.request.get(`/api/projects/${projectId}/members`)).json() as { members: { profileId: string; displayName: string }[] };
    const editorProfileId = members.find((member) => member.displayName === "Collab editor")!.profileId;
    const context = { projectId, epoch: boot.status.realtimeEpoch, draftId: boot.status.currentDraftId, flowId: ids.flowId };

    // The editor's own credential from the real route, on the real private collab channel, as a tracked participant.
    const issued = await editorPage.request.post(`/api/projects/${projectId}/realtime-token`, { headers: { Origin: appUrl } });
    expect(issued.status()).toBe(200);
    await client.realtime.setAuth((await issued.json() as { accessToken: string }).accessToken);
    const channel = client.channel(boot.realtime.collab, { config: { private: true, broadcast: { ack: true, self: false }, presence: { key: randomUUID() } } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the editor channel did not join")), 10_000);
      channel.subscribe((state) => {
        if (state === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") { clearTimeout(timer); reject(new Error(`channel ${state}`)); }
      });
    });
    const sessionId = randomUUID();
    expect(await channel.track({ ...context, sessionId, profileId: editorProfileId, selection: null })).toBe("ok");
    await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 });

    const before = await savedState(database, projectId);
    const packet = (nodeId: string, sequence: number, over: Record<string, unknown> = {}) => ({
      type: "DRAG_PREVIEW", ...context, sessionId, sequence, gestureId: `g-${sequence}`, items: [{ nodeId, x: 200, y: 120, basePositionVersion: 1 }], ...over,
    });
    const send = async (payload: unknown) => expect(await channel.send({ type: "broadcast", event: "peer", payload }, { timeout: 5_000 })).toBe("ok"); // the provider acknowledges: an ACK is not a save

    await send(packet(ids.startId, 1));
    await expect(ghostAt(ownerPage, ids.startId)).toBeVisible({ timeout: 10_000 }); // control: this channel and this packet shape do draw
    for (const payload of [
      packet(randomUUID(), 2), // unknown node
      packet(ids.payId, 3, { items: [{ nodeId: ids.payId, x: 200, y: 120, basePositionVersion: 0 }] }), // old base version
      packet(ids.payId, 4, { flowId: randomUUID() }), // wrong flow
      packet(ids.payId, 5, { epoch: randomUUID() }), // wrong epoch
      packet(ids.payId, 6, { draftId: randomUUID() }), // wrong draft
      packet(ids.payId, 7, { projectId: randomUUID() }), // wrong project
      packet(ids.payId, 8, { userId: editorProfileId }), // spoofed identity key
    ]) await send(payload);
    await send(packet(ids.startId, 50)); // valid: raises the watermark
    await send(packet(ids.payId, 40)); // out of order: below it
    await send({ type: "CURSOR", ...context, sessionId, sequence: 55, x: 300, y: 200 });
    await expect(ownerPage.locator(".live-cursor")).toBeVisible({ timeout: 10_000 }); // everything sent before the cursor has been delivered and judged
    await expect(ownerPage.locator(`.live-ghost:not([data-node-id="${ids.startId}"])`)).toHaveCount(0);

    await send(packet(ids.payId, 60)); // the same target, valid: accepted, so the silence above was the rejection and not an ineligible node
    await expect(ghostAt(ownerPage, ids.payId)).toBeVisible({ timeout: 10_000 });
    expect(await savedState(database, projectId)).toEqual(before); // nothing saved, receipted or audited
  } finally {
    await client.removeAllChannels();
    await client.realtime.disconnect();
    await database.end();
  }
});

// RT-027: a delivered preview is not a save. The peer sees the editor's drag, the editor's write then fails, and the editor stays unsaved, the
// owner's node does not move and nothing was written; the same Save succeeds once the API answers.
test("a delivered preview followed by a failed API save stays not saved", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  test.setTimeout(120_000);
  const ids = await seedChain(ownerPage, projectId);
  await openBoth({ ownerPage, editorPage, projectId }, ids);
  const ownerStart = await transformOf(ownerPage, ids.startId);
  const write = /\/drafts\/[^/]+\/(changes|positions)$/;
  let refused = 0;
  await editorPage.route(write, (route) => { refused++; return route.fulfill({ status: 503, json: envelope("UNAVAILABLE", "Try again.") }); });

  const [x, y] = await centerOf(editorPage, ids.startId);
  await editorPage.mouse.move(x, y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(x + 60, y + 30, { steps: 4 });
  await editorPage.mouse.move(x + 160, y + 80, { steps: 8 });
  await expect(ghostAt(ownerPage, ids.startId)).toBeVisible({ timeout: 10_000 }); // the provider delivered the preview
  await editorPage.mouse.up();
  await expect(ghostAt(ownerPage, ids.startId)).toHaveCount(0, { timeout: 2_500 });

  await headerSave(editorPage).click();
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect(status(editorPage)).toContainText(/couldn.t confirm your changes|weren.t saved|Not saved/);
  await expect(status(editorPage)).not.toContainText("All changes saved");
  expect((await draftOf(ownerPage, projectId)).layout.positions[ids.startId]!.version).toBe(1); // nothing was written
  expect(await transformOf(ownerPage, ids.startId)).toBe(ownerStart);

  await editorPage.unroute(write);
  await headerSave(editorPage).click();
  await expect(status(editorPage)).toContainText("All changes saved");
  expect((await draftOf(ownerPage, projectId)).layout.positions[ids.startId]!.version).toBe(2);
  await expect.poll(() => transformOf(ownerPage, ids.startId)).not.toBe(ownerStart);
});
