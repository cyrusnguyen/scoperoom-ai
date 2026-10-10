import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-fixtures";
import { test as collaborationTest } from "./collaboration-fixtures";
import { appUrl, createProjectViaApi, e2eReady, openDatabase, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

async function prepare(page: Page, projectId: string) {
  const flowId = randomUUID(), nodeId = randomUUID();
  const draftId = await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Checkout", purpose: "Complete an order", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" }, proposedIds: [nodeId] },
  ]);
  return { flowId, nodeId, draftId, path: `/api/projects/${projectId}/drafts/${draftId}` };
}
async function inspect(page: Page, projectId: string) {
  await page.goto(`/app/projects/${projectId}`);
  await expect(page.locator("#studio-flow-title")).toHaveText("Checkout");
  const button = page.getByRole("button", { name: "Inspect", exact: true });
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await expect(page.getByText("Unconfirmed.", { exact: true })).toBeVisible();
}
const headers = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });

test("flow confirmation preserves unapplied text, confirms saved wording and becomes stale after a step edit", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Flow confirmation");
  const { flowId, nodeId, path } = await prepare(page, projectId);
  await inspect(page, projectId);
  const panel = page.locator("#right-panel"), before = await (await page.request.get(path)).json();
  const confirms: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`${path}/commands`)) confirms.push(request.postData() ?? ""); });
  await panel.getByLabel("Purpose", { exact: true }).fill("My unsaved wording");
  await panel.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(panel.getByText(/Submit or discard your typed text/)).toBeVisible();
  await expect(panel.getByLabel("Purpose", { exact: true })).toHaveValue("My unsaved wording");
  expect(confirms).toHaveLength(0);
  expect(await (await page.request.get(path)).json()).toEqual(before);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".studio-status")).toContainText("All changes saved");
  await panel.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(panel.getByText("Confirmed: current wording.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Confirm flow", exact: true })).toBeDisabled();
  const confirmed = await (await page.request.get(path)).json();
  expect(confirmed.document.flows[flowId].purpose).toBe("My unsaved wording");
  expect(confirmed.document.flows[flowId].confirmation.behaviourVersion).toBe(confirmed.document.flows[flowId].behaviourVersion);
  const changed = await page.request.post(`${path}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, label: "Pay by wallet" } } });
  expect(changed.status()).toBe(200);
  await page.reload();
  const inspectButton = page.getByRole("button", { name: "Inspect", exact: true });
  if (await inspectButton.getAttribute("aria-pressed") !== "true") await inspectButton.click();
  await expect(panel.getByText("Needs confirmation: flow meaning changed.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Confirm flow", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(panel.getByText("Confirmed: current wording.", { exact: true })).toBeVisible();
});

test("confirmation requires reinspection when save-first refreshes a changed flow", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Inspected flow guard");
  const { nodeId, path } = await prepare(page, projectId);
  await inspect(page, projectId);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route(`**/api/projects/${projectId}/status`, async (route) => {
    entered(); await held; await route.continue();
  });
  let confirms = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`${path}/commands`)) confirms++; });
  try {
    await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await started;
    await page.getByRole("button", { name: "Confirm flow", exact: true }).click();
    const changed = await page.request.post(`${path}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, label: "New meaning" } } });
    expect(changed.status()).toBe(200);
  } finally { release(); }
  await expect(page.getByText("Saved changes affected this action. Review it again before saving.", { exact: true })).toBeVisible();
  expect(confirms).toBe(0);
  expect(Object.values((await (await page.request.get(path)).json()).document.flows).every((flow: unknown) => (flow as { confirmation: unknown }).confirmation === null)).toBe(true);
  await page.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(page.getByText("Confirmed: current wording.", { exact: true })).toBeVisible();
});

for (const acknowledged of [false, true]) {
  test(acknowledged
    ? "acknowledged flow confirmation refresh stays with its flow through selection and remount"
    : "lost flow confirmation acknowledgement retries the exact body and key after selection and remount", async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Confirmation recovery");
    const { flowId, path } = await prepare(page, projectId);
    const otherFlowId = randomUUID();
    await seedStudioChanges(page, projectId, [
      { command: "CREATE_FLOW", payload: { title: "Shipping", purpose: "Deliver an order", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [otherFlowId] },
    ]);
    await inspect(page, projectId);
    const panel = page.locator("#right-panel");
    const before = await (await page.request.get(path)).json();
    const sent: Array<{ body: string; key: string | undefined }> = [];
    let committed: unknown, stale = acknowledged;
    await page.route(`**${path}`, route => stale && sent.length > 0 ? route.fulfill({ json: before }) : route.continue());
    await page.route(`**${path}/commands`, async (route) => {
      const request = route.request();
      sent.push({ body: request.postData()!, key: request.headers()["idempotency-key"] });
      if (sent.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committed = await (await page.request.get(path)).json();
        if (acknowledged) await route.fulfill({ response });
        else await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Confirm flow", exact: true }).click();
    const recovery = acknowledged ? "Refresh" : "Retry";
    const pendingMessage = acknowledged ? /Confirm flow was acknowledged/ : /We couldn’t confirm “Confirm flow”/;
    await expect(panel.getByRole("button", { name: recovery, exact: true })).toBeVisible();
    await expect(panel.getByText(pendingMessage)).toBeVisible();
    const switchTo = async (title: string) => {
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.locator(".flow-switch").click();
      await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
      await expect(page.locator("#studio-flow-title")).toHaveText(title);
      await page.getByRole("button", { name: "Inspect", exact: true }).click();
    };
    await switchTo("Shipping");
    await expect(panel.getByText("Unconfirmed.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: recovery, exact: true })).toHaveCount(0);
    await expect(panel.getByText(pendingMessage)).toHaveCount(0);
    // The pending request still blocks a second confirmation, even where its recovery controls are hidden.
    await expect(panel.getByRole("button", { name: "Confirm flow", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Specs", exact: true }).click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(panel.getByRole("button", { name: recovery, exact: true })).toHaveCount(0);
    await expect(panel.getByText(pendingMessage)).toHaveCount(0);
    await switchTo("Checkout");
    await page.getByRole("tab", { name: "Specs", exact: true }).click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(panel.getByRole("button", { name: recovery, exact: true })).toBeVisible();
    await expect(panel.getByText(pendingMessage)).toBeVisible();
    expect(sent).toHaveLength(1);
    stale = false;
    await panel.getByRole("button", { name: recovery, exact: true }).click();
    await expect(panel.getByText("Confirm flow: saved.", { exact: true })).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]!.key).toBeTruthy();
    expect(JSON.parse(sent[0]!.body).payload).toEqual({ flowId });
    const saved = await (await page.request.get(path)).json();
    expect(saved).toEqual(committed);
    expect(saved.document.flows[otherFlowId].confirmation).toBeNull();
  });
}
for (const outcome of ["saved", "refused", "unsent"] as const) {
  test(`settled flow confirmation ${outcome} stays with its flow through selection and remount`, async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Settled confirmation");
    const { flowId, path } = await prepare(page, projectId);
    const otherFlowId = randomUUID();
    await seedStudioChanges(page, projectId, [
      { command: "CREATE_FLOW", payload: { title: "Shipping", purpose: "Deliver an order", classification: "USER_JOURNEY", inclusion: "INCLUDED" }, proposedIds: [otherFlowId] },
    ]);
    await inspect(page, projectId);
    const panel = page.locator("#right-panel");
    const before = await (await page.request.get(path)).json();
    const sent: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`${path}/commands`)) sent.push(request.postData()!); });
    if (outcome === "refused") await page.route(`**${path}/commands`, route => route.fulfill({ status: 409, json: { error: { code: "STALE_ENTITY_VERSION", message: "Inspected flow changed." } } }));
    if (outcome === "unsent") await panel.getByLabel("Purpose", { exact: true }).fill("Unapplied wording");
    await panel.getByRole("button", { name: "Confirm flow", exact: true }).click();
    const message = outcome === "saved" ? "Confirm flow: saved." : outcome === "refused" ? /changed|stale/i : /Submit or discard your typed text/;
    const confirmation = panel.getByRole("region", { name: "Confirmation", exact: true });
    await expect(confirmation.getByText(message)).toBeVisible();
    if (outcome === "unsent") {
      await panel.getByRole("button", { name: "Discard local changes", exact: true }).click();
      await expect(panel.getByLabel("Purpose", { exact: true })).toHaveValue("Complete an order");
    }
    const switchTo = async (title: string) => {
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.locator(".flow-switch").click();
      await page.getByRole("dialog", { name: "Flows", exact: true }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
      await expect(page.locator("#studio-flow-title")).toHaveText(title);
      await page.getByRole("button", { name: "Inspect", exact: true }).click();
    };
    await switchTo("Shipping");
    await expect(panel.getByText("Unconfirmed.", { exact: true })).toBeVisible();
    await expect(confirmation.getByText(message)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Confirm flow", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: "Specs", exact: true }).click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(confirmation.getByText(message)).toHaveCount(0);
    await switchTo("Checkout");
    await page.getByRole("tab", { name: "Specs", exact: true }).click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(confirmation.getByText(message)).toBeVisible();
    await expect(confirmation.getByRole("button", { name: /^(Retry|Refresh)$/ })).toHaveCount(0);
    expect(sent).toHaveLength(outcome === "unsent" ? 0 : 1);
    if (sent.length) expect(JSON.parse(sent[0]!).payload).toEqual({ flowId });
    const after = await (await page.request.get(path)).json();
    expect(after.document.flows[otherFlowId].confirmation).toBeNull();
    if (outcome === "saved") expect(after.document.flows[flowId].confirmation.behaviourVersion).toBe(after.document.flows[flowId].behaviourVersion);
    else expect(after).toEqual(before);
  });
}

collaborationTest("editors can confirm flows; viewers and reviewers have no authoring control and are refused", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, setEditorRole } = collaboration;
  const { flowId, path } = await prepare(ownerPage, projectId);
  await editorPage.clock.resume();
  await inspect(editorPage, projectId);
  await editorPage.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(editorPage.getByText("Confirmed: current wording.", { exact: true })).toBeVisible();
  for (const role of ["VIEWER", "REVIEWER"] as const) {
    await setEditorRole(role);
    await editorPage.reload();
    const inspectButton = editorPage.getByRole("button", { name: "Inspect", exact: true });
    if (await inspectButton.getAttribute("aria-pressed") !== "true") await inspectButton.click();
    await expect(editorPage.getByText("Confirmed: current wording.", { exact: true })).toBeVisible();
    await expect(editorPage.getByRole("button", { name: "Confirm flow", exact: true })).toHaveCount(0);
    const draft = await (await editorPage.request.get(path)).json();
    const refused = await editorPage.request.post(`${path}/commands`, { headers: headers(), data: { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: draft.document.flows[flowId].version, payload: { flowId } } });
    expect(refused.status()).toBe(403);
    expect(await (await editorPage.request.get(path)).json()).toEqual(draft);
  }
});

// Stage 9.1 candidate UI acceptance; the four flow confirmation cases above remain intact.
import { readyCandidate, openReview, freezeInUi, freezeViaApi, reviewHeaders } from "./review-support";

test("narrow keyboard preview freezes exact saved scope, reads captured evidence and withdraws before freezing again", async ({ page }, testInfo) => {
  const projectId=await createProjectViaApi(page,"Candidate reader");
  const prepared=await readyCandidate(page,projectId,true);
  await page.setViewportSize({width:320,height:844});
  await openReview(page,projectId);
  await page.getByRole("tab",{name:"Review",exact:true}).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab",{name:"Details",exact:true})).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab",{name:"Review",exact:true})).toBeFocused();
  await page.getByRole("tab",{name:"Current",exact:true}).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab",{name:"History",exact:true})).toBeFocused();
  await expect(page.getByRole("tab",{name:"Review",exact:true})).toHaveAttribute("aria-selected","true");
  await page.keyboard.press("ArrowLeft");
  const previews:string[]=[], freezes:string[]=[];
  page.on("request",r=>{if(r.method()==="POST"&&r.url().endsWith("/review-preview")) previews.push(r.postData()!);if(r.method()==="POST"&&r.url().endsWith("/reviews")) freezes.push(r.postData()!);});
  await freezeInUi(page);
  expect(JSON.parse(freezes[0]!)).toEqual(JSON.parse(previews[0]!));
  await expect(page.locator(".candidate-reader").getByText("Saved checkout",{exact:true})).toBeVisible();
  const capturedName = page.locator(".candidate-reader dt").filter({ hasText: /^Captured project name$/ }).locator("+ dd");
  await expect(capturedName).toHaveText("Candidate reader");
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Back to project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Renamed candidate project");
  await page.locator("#right-panel").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Project name updated.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Renamed candidate project");
  expect((await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json()).project.name).toBe("Renamed candidate project");
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(capturedName).toHaveText("Candidate reader");
  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  await page.getByRole("button", { name: /Candidate Open/ }).click();
  await expect(capturedName).toHaveText("Candidate reader");
  await expect(page.locator(".candidate-reader")).not.toContainText("Renamed candidate project");
  await expect(page.locator(".source-lines li")).toHaveCount(100);
  await page.getByRole("button",{name:"Captured brief, lines 105-105",exact:true}).click();
  await expect(page.locator(".source-lines")).toHaveAttribute("start","101");
  await expect(page.locator('.source-lines li[data-cited="true"]')).toHaveText("Evidence line 105");
  await page.getByRole("button",{name:"Last lines",exact:true}).click();
  await expect(page.locator(".source-lines")).toHaveAttribute("start","201");
  await expect(page.locator(".source-lines li")).toHaveCount(6);
  await expect(page.locator(".source-lines li").last()).toHaveText("");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("candidate-reader-320.png"),fullPage:true});
  let currentSourceReads=0;
  page.on("request",r=>{if(r.url().includes(`/api/projects/${projectId}/sources/`)) currentSourceReads++;});
  await page.request.post(`/api/projects/${projectId}/sources/${prepared.source!.sourceId}/versions`,{headers:reviewHeaders(),data:{expectedSourceRecordVersion:prepared.source!.version,expectedCurrentVersionId:prepared.source!.sourceVersionId,title:"Latest brief",text:"Latest unrelated evidence"}});
  await expect(page.locator(".candidate-reader")).not.toContainText("Latest unrelated evidence");
  expect(currentSourceReads).toBe(0);
  await page.getByLabel("Reason", { exact: true }).fill("Revisit saved scope");
  await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();
  await expect(page.getByText("Closed reason: Revisit saved scope",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Back to history",exact:true}).click();
  await expect(page.getByRole("button",{name:/Candidate Withdrawn/})).toBeFocused();
  await page.getByRole("tab",{name:"Current",exact:true}).click();
  await freezeInUi(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#right-panel")).toBeHidden();
  await expect(page.getByRole("button",{name:"Inspect",exact:true})).toBeFocused();
});

test("dirty Details fields block preview and survive candidate error navigation",async({page})=>{
  const projectId=await createProjectViaApi(page,"Dirty candidate"), {flowId,path}=await readyCandidate(page,projectId);
  await openReview(page,projectId);
  await page.getByRole("tab",{name:"Details",exact:true}).click();
  await page.getByRole("button",{name:"Back to project",exact:true}).click();
  await page.getByLabel("Project name",{exact:true}).fill("Unsent project name");
  await page.getByRole("tab",{name:"Review",exact:true}).click();
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByText(/Submit or discard your unsaved form fields/)).toBeVisible();
  await page.getByRole("tab",{name:"Details",exact:true}).click();
  await expect(page.getByLabel("Project name",{exact:true})).toHaveValue("Unsent project name");
  await page.getByLabel("Project name",{exact:true}).fill("Dirty candidate");
  const flow=(await(await page.request.get(path)).json()).document.flows[flowId];
  await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"UPDATE_FLOW",expectedEntityVersion:flow.version,payload:{flowId,purpose:"New purpose"}}});
  await page.getByRole("tab",{name:"Review",exact:true}).click();
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByText("Confirm the current wording of this included item.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Inspect item",exact:true}).click();
  await expect(page.getByLabel("Purpose",{exact:true})).toHaveValue("New purpose");
});

test("stale layout or policy blocks freeze of an inspected preview and missing approver is actionable",async({page})=>{
  const projectId=await createProjectViaApi(page,"Preview drift"), {path,startId}=await readyCandidate(page,projectId);
  await openReview(page,projectId);
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByText("Saved scope is ready to freeze.",{exact:true})).toBeVisible();
  const draft=await(await page.request.get(path)).json();
  const position=draft.layout.positions[startId];
  expect((await page.request.post(`${path}/positions`,{headers:reviewHeaders(),data:{mode:"MOVE_NODES",flowId:draft.document.nodes[startId].flowId,items:[{nodeId:startId,x:position.x+10,y:position.y,expectedPositionVersion:position.version}]}})).status()).toBe(200);
  await page.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});
  await expect(page.getByRole("button",{name:"Freeze candidate",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByRole("button",{name:"Freeze candidate",exact:true})).toBeEnabled();
  const status=await(await page.request.get(`/api/projects/${projectId}/status`)).json();
  await page.request.patch(`/api/projects/${projectId}/approval-policy`,{headers:reviewHeaders(),data:{designatedApproverId:null,expectedApprovalPolicyVersion:status.approvalPolicyVersion}});
  await page.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});
  await expect(page.getByRole("button",{name:"Freeze candidate",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByText("Choose an eligible designated approver in Sharing.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Project sharing and approver",exact:true}).click();
  await expect(page.getByRole("tab",{name:"Details",exact:true})).toHaveAttribute("aria-selected","true");
});

test("lost freeze acknowledgement retries same body and key after panel remount",async({page})=>{
  const projectId=await createProjectViaApi(page,"Freeze recovery");await readyCandidate(page,projectId);await openReview(page,projectId);
  const sent:Array<{body:string;key:string|undefined}>=[];
  await page.route(`**/api/projects/${projectId}/drafts/*/reviews`,async route=>{sent.push({body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});if(sent.length===1){expect((await route.fetch()).status()).toBe(201);await route.abort("failed");}else await route.continue();});
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await page.getByRole("button",{name:"Freeze candidate",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Specs",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
});

test("acknowledged freeze remains acknowledged when history refresh fails",async({page})=>{
  const projectId=await createProjectViaApi(page,"Acknowledged freeze");await readyCandidate(page,projectId);await openReview(page,projectId);
  let mutations=0,failed=false;
  await page.route(`**/api/projects/${projectId}/reviews`,route=>failed?route.fulfill({status:503,json:{error:{code:"UNAVAILABLE",message:"Review reads unavailable"}}}):route.continue());
  page.on("request",r=>{if(r.method()==="POST"&&r.url().endsWith("/reviews")){mutations++;if(mutations===1)failed=true;}});
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await page.getByRole("button",{name:"Freeze candidate",exact:true}).click();
  await expect(page.getByText(/Freeze candidate was acknowledged/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Refresh",exact:true})).toBeVisible();expect(mutations).toBe(1);
  failed=false;await page.getByRole("button",{name:"Refresh",exact:true}).click();await expect(page.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();expect(mutations).toBe(2);
});

collaborationTest("editor receipt recovery after downgrade preserves read access, and reviewer/viewer and archived candidates are read-only",async({collaboration})=>{
  const {ownerPage,editorPage,projectId,setEditorRole}=collaboration;
  await readyCandidate(ownerPage,projectId);await openReview(editorPage,projectId);
  const sent:Array<{body:string;key:string|undefined}>=[];
  await editorPage.route(`**/api/projects/${projectId}/drafts/*/reviews`,async route=>{sent.push({body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});if(sent.length===1){expect((await route.fetch()).status()).toBe(201);await route.abort("failed");}else await route.continue();});
  await editorPage.getByRole("button",{name:"Preview saved scope",exact:true}).click();await editorPage.getByRole("button",{name:"Freeze candidate",exact:true}).click();await expect(editorPage.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  await setEditorRole("VIEWER");
  await editorPage.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});
  await editorPage.getByRole("button",{name:"Retry",exact:true}).click();await expect(editorPage.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();expect(sent[1]).toEqual(sent[0]);
  await expect(editorPage.getByRole("button",{name:"Withdraw candidate",exact:true})).toHaveCount(0);
  await editorPage.getByRole("tab",{name:"Current",exact:true}).click();
  await editorPage.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(editorPage.getByText("Saved scope is ready to freeze.",{exact:true})).toBeVisible();
  await expect(editorPage.getByRole("button",{name:"Freeze candidate",exact:true})).toHaveCount(0);
  await setEditorRole("REVIEWER");await editorPage.reload();await editorPage.getByRole("button",{name:"Inspect",exact:true}).click();await editorPage.getByRole("tab",{name:"Review",exact:true}).click();await expect(editorPage.getByRole("button",{name:"Preview saved scope",exact:true})).toBeVisible();
  await editorPage.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(editorPage.getByText("Saved scope is ready to freeze.",{exact:true})).toBeVisible();
  await expect(editorPage.getByRole("button",{name:"Freeze candidate",exact:true})).toHaveCount(0);
  const status=await(await ownerPage.request.get(`/api/projects/${projectId}/status`)).json();expect((await ownerPage.request.post(`/api/projects/${projectId}/archive`,{headers:reviewHeaders(),data:{expectedProjectVersion:status.version,reason:"Archive candidate"}})).status()).toBe(200);
  await editorPage.reload();await editorPage.getByRole("button",{name:"Inspect",exact:true}).click();await editorPage.getByRole("tab",{name:"Review",exact:true}).click();await editorPage.getByRole("tab",{name:"History",exact:true}).click();await editorPage.getByRole("button",{name:/Candidate Superseded/}).click();await expect(editorPage.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();
});

test("acknowledged review cannot settle below its exact receipt floor", async ({page}) => {
  const projectId=await createProjectViaApi(page,"Review floor");await readyCandidate(page,projectId);await openReview(page,projectId);
  const before=await(await page.request.get(`/api/projects/${projectId}/reviews`)).json();
  let stale=true,committed=false;
  await page.route(`**/api/projects/${projectId}/drafts/*/reviews`,async route=>{const response=await route.fetch();expect(response.status()).toBe(committed?200:201);committed=true;await route.fulfill({response});});
  await page.route(`**/api/projects/${projectId}/reviews`,route=>committed&&stale?route.fulfill({json:before}):route.continue());
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await page.getByRole("button",{name:"Freeze candidate",exact:true}).click();
  await expect(page.getByText(/Freeze candidate was acknowledged/)).toBeVisible();await expect(page.getByRole("button",{name:"Refresh",exact:true})).toBeVisible();
  await expect(page.getByText("Freeze candidate: saved.",{exact:true})).toHaveCount(0);
  stale=false;await page.getByRole("button",{name:"Refresh",exact:true}).click();await expect(page.getByText("Freeze candidate: saved.",{exact:true})).toBeVisible();
});

test("explicit queued-save preview saves Studio edits and freeze refuses later local drift",async({page})=>{
  const projectId=await createProjectViaApi(page,"Saved preview"),{startId,path}=await readyCandidate(page,projectId);
  await openReview(page,projectId);await page.getByRole("button",{name:"Close panel",exact:true}).click();
  const node=page.locator(`.react-flow__node[data-id="${startId}"]`);
  await node.locator(".step-label").dblclick();await node.getByRole("textbox",{name:"Step name",exact:true}).fill("Saved beginning");await page.keyboard.press("Enter");
  await page.getByRole("button",{name:"Inspect",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save Studio changes and preview",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Save Studio changes and preview",exact:true}).click();
  await expect(page.getByText("Confirm the current wording of this included item.",{exact:false})).toBeVisible();
  expect((await(await page.request.get(path)).json()).document.nodes[startId].label).toBe("Saved beginning");
  await page.getByRole("button",{name:"Inspect item",exact:true}).click();await page.getByRole("button",{name:"Confirm flow",exact:true}).click();
  await expect(page.getByText("Confirm flow: saved.",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Review",exact:true}).click();await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await expect(page.getByRole("button",{name:"Freeze candidate",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Close panel",exact:true}).click();await node.locator(".step-label").dblclick();await node.getByRole("textbox",{name:"Step name",exact:true}).fill("Unsent newer beginning");await page.keyboard.press("Enter");await page.getByRole("button",{name:"Inspect",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  // The preview is deliberately lost on panel remount; a new unsaved-only preview cannot freeze those newer local edits.
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await expect(page.getByRole("button",{name:"Freeze candidate",exact:true})).toBeDisabled();
  expect((await(await page.request.get(path)).json()).document.nodes[startId].label).toBe("Saved beginning");
});

test("late withdrawal acknowledgement preserves newer reason through remount and the next candidate",async({page})=>{
  const projectId=await createProjectViaApi(page,"Withdrawal input");await readyCandidate(page,projectId);await openReview(page,projectId);await freezeInUi(page);
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route(`**/api/projects/${projectId}/reviews/*/withdraw`,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);entered();await held;await route.fulfill({response});});
  await page.getByLabel("Reason", { exact: true }).fill("Submitted reason");await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();await started;
  try{await page.getByLabel("Reason", { exact: true }).fill("Newer local reason");await page.getByRole("tab",{name:"Specs",exact:true}).click();}finally{release();}
  await page.getByRole("tab",{name:"Review",exact:true}).click();await expect(page.getByText("Closed reason: Submitted reason",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Current",exact:true}).click();await freezeInUi(page);await expect(page.getByLabel("Reason", { exact: true })).toHaveValue("Newer local reason");
});

test("freeze receipt retry reaches original path after a replaced visible draft without save-first",async({page})=>{
  const projectId=await createProjectViaApi(page,"Replaced visible draft"),{draftId}=await readyCandidate(page,projectId);await openReview(page,projectId);
  const initial=await(await page.request.get(`/api/projects/${projectId}/bootstrap`)).json();const replacementId=randomUUID();
  const replacement={...initial,draft:{...initial.draft,id:replacementId},status:{...initial.status,currentDraftId:replacementId}};
  let replaced=false;const sent:Array<{body:string;key:string|undefined}>=[];
  await page.route(`**/api/projects/${projectId}/status`,route=>replaced?route.fulfill({json:replacement.status}):route.continue());
  await page.route(`**/api/projects/${projectId}/bootstrap`,route=>replaced?route.fulfill({json:replacement}):route.continue());
  await page.route(`**/api/projects/${projectId}/drafts/${draftId}/reviews`,async route=>{sent.push({body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});if(sent.length===1){expect((await route.fetch()).status()).toBe(201);await route.abort("failed");}else await route.continue();});
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();await page.getByRole("button",{name:"Freeze candidate",exact:true}).click();await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  replaced=true;const bootstrap=page.waitForResponse(response=>response.url().endsWith(`/api/projects/${projectId}/bootstrap`));await page.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});await bootstrap;
  await page.getByRole("button",{name:"Retry",exact:true}).click();await expect(page.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
});

test("late withdrawal 401 after project switch cannot sign out the next project and recovers exact attempt",async({page})=>{
  const projectId=await createProjectViaApi(page,"Old candidate project"),other=await createProjectViaApi(page,"Next project");await readyCandidate(page,projectId);await openReview(page,projectId);await freezeInUi(page);
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});const sent:Array<{body:string;key:string|undefined;url:string}>=[];
  await page.route(`**/api/projects/${projectId}/reviews/*/withdraw`,async route=>{sent.push({body:route.request().postData()!,key:route.request().headers()["idempotency-key"],url:route.request().url()});if(sent.length===1){expect((await route.fetch()).status()).toBe(200);entered();await held;await route.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED",message:"Late session response"}}});}else await route.continue();});
  await page.getByLabel("Reason", { exact: true }).fill("Submitted closure");await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();await started;
  try{await page.getByRole("button",{name:"Next project",exact:true}).click();await page.getByRole("button",{name:"Discard changes",exact:true}).click();await expect(page.getByRole("heading",{level:1,name:"Next project",exact:true})).toBeVisible();}finally{release();}
  await expect(page).toHaveURL(new RegExp(`/app/projects/${other}$`));await page.getByRole("button",{name:"Old candidate project",exact:true}).click();await expect(page.getByRole("heading",{level:1,name:"Old candidate project",exact:true})).toBeVisible();await page.getByRole("button",{name:"Inspect",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  await expect(page.getByText("Closed reason: Submitted closure", { exact: true })).toBeVisible();
  let releaseAuthority!: () => void, enteredAuthority!: () => void;
  const authorityHeld = new Promise<void>(resolve => { releaseAuthority = resolve; });
  const authorityStarted = new Promise<void>(resolve => { enteredAuthority = resolve; });
  await page.route(`**/api/projects/${projectId}/status`, async route => { enteredAuthority(); await authorityHeld; await route.continue(); });
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await authorityStarted;
  // The reader can already show closure while Retry still awaits its current-access check.
  const replay = page.waitForResponse(response => response.url() === sent[0]!.url
    && response.request().method() === "POST" && response.request().headers()["idempotency-key"] === sent[0]!.key);
  try {
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Closed reason: Submitted closure", { exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
  } finally { releaseAuthority(); }
  const response = await replay;
  expect(response.status()).toBe(200);
  expect((await response.json()).replayed).toBe(true);
  await expect(page.getByText("Withdraw candidate: saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

collaborationTest("loss of membership removes protected candidate and evidence before late reads can repopulate them",async({collaboration})=>{
  const {ownerPage,editorPage,projectId,removeEditor}=collaboration;const {draftId}=await readyCandidate(ownerPage,projectId,true);const frozen=await freezeViaApi(ownerPage,projectId,draftId);await openReview(editorPage,projectId);await editorPage.getByRole("tab",{name:"History",exact:true}).click();await editorPage.getByRole("button",{name:/Candidate Open/}).click();await expect(editorPage.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();
  await removeEditor();await editorPage.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});await expect(editorPage.locator(".candidate-reader")).toHaveCount(0);await expect(editorPage.locator(".source-lines")).toHaveCount(0);await expect(editorPage.locator("#right-panel")).toHaveCount(0);
  expect((await editorPage.request.get(`/api/projects/${projectId}/reviews/${frozen.reviewId}`)).status()).toBe(404);
});

test("held candidate detail cannot overwrite a newer identity, and saved-draft sync refreshes change notices",async({page})=>{
  const projectId=await createProjectViaApi(page,"Detail fences"),{draftId,path,startId}=await readyCandidate(page,projectId);
  const first=await freezeViaApi(page,projectId,draftId);expect((await page.request.post(`/api/projects/${projectId}/reviews/${first.reviewId}/withdraw`,{headers:reviewHeaders(),data:{expectedReviewVersion:1,reason:"Next candidate"}})).status()).toBe(200);const second=await freezeViaApi(page,projectId,draftId);
  await openReview(page,projectId);await page.getByRole("tab",{name:"History",exact:true}).click();
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route(`**/api/projects/${projectId}/reviews/${first.reviewId}`,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response});});
  await page.locator(`#review-row-${first.reviewId}`).click();await started;
  try{await page.getByRole("button",{name:"Back to history",exact:true}).click();await page.locator(`#review-row-${second.reviewId}`).click();await expect(page.locator(".candidate-reader").getByText(second.snapshotId,{exact:true})).toBeVisible();}finally{release();}
  await expect(page.locator(".candidate-reader").getByText(first.snapshotId,{exact:true})).toHaveCount(0);
  const draft=await(await page.request.get(path)).json();expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"UPDATE_NODE",expectedEntityVersion:draft.document.nodes[startId].version,payload:{nodeId:startId,label:"New saved beginning"}}})).status()).toBe(200);
  await page.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});await expect(page.getByText("The current draft has newer saved changes. This captured candidate is unchanged.",{exact:true})).toBeVisible();await expect(page.locator(".candidate-reader")).not.toContainText("New saved beginning");
});

test("account identity change clears the candidate reader and its protected evidence",async({page})=>{
  const projectId=await createProjectViaApi(page,"Account-bound candidate");await readyCandidate(page,projectId,true);await openReview(page,projectId);await freezeInUi(page);
  let changed=true;
  await page.route(`**/api/projects/${projectId}/status`,async route=>{const response=await route.fetch();const status=await response.json();if(changed){changed=false;await route.fulfill({json:{...status,viewerId:randomUUID()}});}else await route.fulfill({response});});
  await page.evaluate(()=>{window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));});await expect(page).toHaveURL(/\/app$/);await expect(page.locator(".candidate-reader")).toHaveCount(0);await expect(page.locator(".source-lines")).toHaveCount(0);
});

test("shared reconciliation retries a failed detail after a review-only change", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Review detail recovery");
  const { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  await openReview(page, projectId);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page.locator(`#review-row-${frozen.reviewId}`).click();
  await expect(page.getByRole("heading", { name: "Candidate - not approved", exact: true })).toBeVisible();

  let failDetail = true;
  await page.route(`**/api/projects/${projectId}/reviews/${frozen.reviewId}`, route => failDetail
    ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Candidate detail temporarily unavailable" } } })
    : route.continue());
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/withdraw`, {
    headers: reviewHeaders(), data: { expectedReviewVersion: 1, reason: "Recover this closed state" },
  })).status()).toBe(200);
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("Candidate detail temporarily unavailable", { exact: false })).toBeVisible();

  // No draft counter changes and no manual Retry: the next shared status cycle must recover the failed resource.
  failDetail = false;
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("Closed reason: Recover this closed state", { exact: true })).toBeVisible();
});

for (const [action, state, heading] of [
  ["Approve candidate", "APPROVED", "Approved candidate"],
  ["Request changes", "CHANGES_REQUESTED", "Candidate - changes requested"],
  ["Reject candidate", "REJECTED", "Candidate - rejected"],
] as const) {
  test(`decision persists ${state} with exact human attribution after refresh`, async ({ page }) => {
    const projectId = await createProjectViaApi(page, "Human decision");
    await readyCandidate(page, projectId);
    await openReview(page, projectId);
    const approver = page.locator(".review-panel dt").filter({ hasText: /^Designated approver$/ }).locator("+ dd");
    await expect(approver).toHaveText("Studio test owner · Owner");
    await freezeInUi(page);
    const candidate = await (await page.request.get(`/api/projects/${projectId}/reviews`)).json();
    const review = candidate.items[0];
    const before = await (await page.request.get(`/api/projects/${projectId}/reviews/${review.reviewId}`)).json();
    await page.getByLabel("Reason", { exact: true }).fill("Human inspected this exact scope");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    const saved = await (await page.request.get(`/api/projects/${projectId}/reviews/${review.reviewId}`)).json();
    expect(saved.review.state).toBe(state);
    expect(saved.decision.actorId).toBe(before.snapshot.policySnapshot.designatedApproverId);
    expect(saved.decision.actorDisplayName).toBe("Studio test owner");
    expect(saved.decision.actorRole).toBe("OWNER");
    expect(saved.decision.reviewedHash).toBe(before.snapshot.reviewHash);
    expect(saved.decision.comment).toBe("Human inspected this exact scope");
    expect(saved.snapshot).toEqual(before.snapshot);
    const attribution = page.getByRole("region", { name: "Human decision", exact: true });
    await expect(attribution.getByText("Studio test owner", { exact: true })).toBeVisible();
    await expect(attribution.getByText("Owner", { exact: true })).toBeVisible();
    await expect(attribution.getByText("Self/internal approval", { exact: true })).toHaveCount(state === "APPROVED" ? 1 : 0);
    await expect(page.locator(".candidate-reader")).toContainText(saved.decision.actorId);
    await expect(attribution.locator(`time[datetime="${saved.decision.createdAt}"]`)).toHaveCount(state === "APPROVED" ? 2 : 1);
    await page.reload();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await page.locator(`#review-row-${review.reviewId}`).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.locator(".candidate-reader")).toContainText("Human inspected this exact scope");
    await expect(page.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  });
}

test("decision lost response retries exact bytes and key after remount", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Decision retry");
  await readyCandidate(page, projectId); await openReview(page, projectId); await freezeInUi(page);
  const sent: Array<{ url: string; body: string; key: string | undefined }> = [];
  await page.route(`**/api/projects/${projectId}/reviews/*/decision`, async route => {
    sent.push({ url: route.request().url(), body: route.request().postData()!, key: route.request().headers()["idempotency-key"] });
    if (sent.length === 1) { expect((await route.fetch()).status()).toBe(200); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByLabel("Reason", { exact: true }).fill("Original decision reason");
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  // The committed terminal reader can arrive first; the request still needs its exact receipt.
  await page.getByRole("tab", { name: "Specs", exact: true }).click();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  const replay = page.waitForResponse(response => response.url() === sent[0]!.url && response.request().method() === "POST");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const recovered = await replay; expect(recovered.status()).toBe(200); expect((await recovered.json()).replayed).toBe(true);
  await expect(page.getByText("Request changes: saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidate - changes requested", exact: true })).toBeVisible();
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  const detail = await (await page.request.get(sent[0]!.url.replace(/\/decision$/, ""))).json();
  expect(detail.decision.comment).toBe("Original decision reason");
  expect(detail.decision.decision).toBe("REQUEST_CHANGES");
});

test("acknowledged decision refresh failure retries its receipt and late acknowledgement keeps newer input", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Decision acknowledged");
  await readyCandidate(page, projectId); await openReview(page, projectId); await freezeInUi(page);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let failed = false;
  const sent: Array<{ body: string; key: string | undefined }> = [];
  await page.route(`**/api/projects/${projectId}/reviews/*/decision`, async route => {
    sent.push({ body: route.request().postData()!, key: route.request().headers()["idempotency-key"] });
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (sent.length === 1) { failed = true; entered(); await held; }
    await route.fulfill({ response });
  });
  await page.route(`**/api/projects/${projectId}/reviews`, route => failed ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Decision refresh unavailable" } } }) : route.continue());
  await page.getByLabel("Reason", { exact: true }).fill("Submitted rejection");
  await page.getByRole("button", { name: "Reject candidate", exact: true }).click(); await started;
  try { await page.getByLabel("Reason", { exact: true }).fill("Newer local reason"); await page.getByRole("tab", { name: "Specs", exact: true }).click(); } finally { release(); }
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByText(/Reject candidate was acknowledged/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible(); expect(sent).toHaveLength(1);
  failed = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Reject candidate: saved.", { exact: true })).toBeVisible(); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  await page.getByRole("tab", { name: "Current", exact: true }).click(); await freezeInUi(page);
  await expect(page.getByLabel("Reason", { exact: true })).toHaveValue("Newer local reason");
});

collaborationTest("nonapprover controls are absent and a designated reviewer can decide an exact candidate", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, setEditorRole } = collaboration;
  const { draftId } = await readyCandidate(ownerPage, projectId);
  const first = await freezeViaApi(ownerPage, projectId, draftId);
  await openReview(editorPage, projectId); await editorPage.getByRole("tab", { name: "History", exact: true }).click(); await editorPage.locator(`#review-row-${first.reviewId}`).click();
  await expect(editorPage.getByRole("heading", { name: "Candidate - not approved", exact: true })).toBeVisible();
  for (const name of ["Approve candidate", "Request changes", "Reject candidate"]) await expect(editorPage.getByRole("button", { name, exact: true })).toHaveCount(0);
  await setEditorRole("REVIEWER");
  const actor = await (await editorPage.request.get(`/api/projects/${projectId}/status`)).json();
  const status = await (await ownerPage.request.get(`/api/projects/${projectId}/status`)).json();
  expect((await ownerPage.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: reviewHeaders(), data: { designatedApproverId: actor.viewerId, expectedApprovalPolicyVersion: status.approvalPolicyVersion } })).status()).toBe(200);
  const next = await freezeViaApi(ownerPage, projectId, draftId);
  await openReview(editorPage, projectId); await editorPage.getByRole("tab", { name: "History", exact: true }).click(); await editorPage.locator(`#review-row-${next.reviewId}`).click();
  await expect(editorPage.getByRole("button", { name: "Withdraw candidate", exact: true })).toHaveCount(0);
  await editorPage.getByLabel("Reason", { exact: true }).fill("Reviewer asks for a clearer scope");
  await editorPage.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(editorPage.getByRole("heading", { name: "Candidate - changes requested", exact: true })).toBeVisible();
  expect((await (await ownerPage.request.get(`/api/projects/${projectId}/reviews/${next.reviewId}`)).json()).decision.actorId).toBe(actor.viewerId);
});

test("decision publication keeps exact saved newer work and unsent canvas, inspector and Scope input", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Publication keeps local work");
  const { path, startId } = await readyCandidate(page, projectId); await openReview(page, projectId); await freezeInUi(page);
  const review = (await (await page.request.get(`/api/projects/${projectId}/reviews`)).json()).items[0];
  const initial = await (await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: initial.document.nodes[startId].version, payload: { nodeId: startId, label: "Saved newer beginning" } } })).status()).toBe(200);
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("The current draft has newer saved changes. This captured candidate is unchanged.", { exact: true })).toBeVisible();
  const beforeMove = await (await page.request.get(path)).json(), position = beforeMove.layout.positions[startId];
  expect((await page.request.post(`${path}/positions`, { headers: reviewHeaders(), data: { mode: "MOVE_NODES", flowId: beforeMove.document.nodes[startId].flowId, items: [{ nodeId: startId, x: position.x + 20, y: position.y, expectedPositionVersion: position.version }] } })).status()).toBe(200);
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  const saved = await (await page.request.get(path)).json();
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000));
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/(changes|commands|positions)$/.test(request.url())) writes.push(request.url()); });
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  const node = page.locator(`.react-flow__node[data-id="${startId}"]`);
  await node.locator(".step-label").dblclick(); await node.getByRole("textbox", { name: "Step name", exact: true }).fill("Unsent canvas beginning"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Inspect", exact: true }).click(); await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("Unsent inspector description");
  await page.getByRole("tab", { name: "Specs", exact: true }).click(); await page.getByRole("tab", { name: "Scope", exact: true }).click(); await page.getByRole("button", { name: "New requirement", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Unsent Scope requirement"); await page.getByLabel("Statement", { exact: true }).fill("Unsent Scope statement");
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve candidate", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve candidate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved candidate", exact: true })).toBeVisible();
  const pending = page.getByRole("region", { name: "Saved work against current baseline", exact: true });
  await expect(pending).toContainText("Saved included scope has changes pending approval.");
  await expect(pending).toContainText("Saved layout has unapproved presentation changes.");
  await expect(pending).toContainText("Unsent edits and typed fields are separate");
  expect(writes).toEqual([]);
  const after = await (await page.request.get(path)).json();
  for (const key of ["id", "document", "layout", "documentRevision", "layoutRevision"]) expect(after[key], key).toEqual(saved[key]);
  expect((await (await page.request.get(`/api/projects/${projectId}/status`)).json()).approvedSnapshotId).toBe(review.snapshotId);
  // The opened panel makes the editor use its existing responsive List view.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start Unsent canvas beginning", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Unsent canvas beginning", exact: true })).toBeChecked();
  await expect(page.locator(".candidate-reader")).not.toContainText("Unsent canvas beginning");
  await page.getByRole("tab", { name: "Details", exact: true }).click(); await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Unsent inspector description");
  await page.getByRole("tab", { name: "Specs", exact: true }).click(); await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsent Scope requirement"); await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Unsent Scope statement");
});

test("decision controls and terminal attribution support keyboard at desktop and 320px", async ({ page }, testInfo) => {
  const projectId = await createProjectViaApi(page, "Decision accessibility"); await readyCandidate(page, projectId); await openReview(page, projectId); await freezeInUi(page);
  await expect(page.locator("#right-panel textarea")).toHaveCount(1);
  await expect(page.getByText("Required for request changes, rejection and withdrawal. Optional for approval. 0/4,000 characters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve candidate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("decision-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator("#right-panel")).toHaveAttribute("data-dock", "overlay");
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toBeFocused();
  await page.getByLabel("Reason", { exact: true }).focus();
  await expect(page.getByRole("button", { name: "Request changes", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "Reject candidate", exact: true })).toBeDisabled();
  await page.keyboard.type("Keyboard reviewed exact scope"); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Approve candidate", exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Request changes", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("decision-controls-320.png"), fullPage: true });
  await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: "Candidate - changes requested", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Human decision", exact: true }).getByText("Changes requested", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const readerOverflow = await page.locator(".review-panel").evaluate(panel => panel.scrollWidth - panel.clientWidth);
  expect(readerOverflow).toBeLessThanOrEqual(0);
  await page.getByRole("heading", { name: "Candidate - changes requested", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("decision-terminal-320.png"), fullPage: true });
  await page.getByRole("region", { name: "Human decision", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("decision-attribution-320.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("heading", { name: "Candidate - changes requested", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("decision-terminal-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to history", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Candidate Changes requested/ })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 844 });
  const overflow = await page.locator(".review-panel").evaluate(panel => panel.scrollWidth - panel.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a decision refused after an approver policy change retains submitted and newer reason", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Decision authority refusal");
  await readyCandidate(page, projectId); await openReview(page, projectId); await freezeInUi(page);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const attempts: Array<{ body: string; key: string | undefined }> = [];
  await page.route(`**/api/projects/${projectId}/reviews/*/decision`, async route => {
    attempts.push({ body: route.request().postData()!, key: route.request().headers()["idempotency-key"] });
    entered(); await held; await route.continue();
  });
  await page.getByLabel("Reason", { exact: true }).fill("Retain my refused request");
  const response = page.waitForResponse(result => result.url().endsWith("/decision") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Request changes", exact: true }).click(); await started;
  try {
    await page.getByLabel("Reason", { exact: true }).fill("Newer text after sending");
    const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json();
    expect((await page.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: reviewHeaders(), data: { designatedApproverId: null, expectedApprovalPolicyVersion: status.approvalPolicyVersion } })).status()).toBe(200);
  } finally { release(); }
  expect((await response).status()).toBe(403);
  await expect(page.getByText("This action isn't available for your account.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(attempts).toHaveLength(1); expect(JSON.parse(attempts[0]!.body).reason).toBe("Retain my refused request");
  const status = await (await page.request.get(`/api/projects/${projectId}/status`)).json();
  expect((await page.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: reviewHeaders(), data: { designatedApproverId: status.viewerId, expectedApprovalPolicyVersion: status.approvalPolicyVersion } })).status()).toBe(200);
  await page.getByRole("tab", { name: "Current", exact: true }).click(); await freezeInUi(page);
  await expect(page.getByLabel("Reason", { exact: true })).toHaveValue("Newer text after sending");
});


test("approved history preserves the exact selected baseline through later publication and panel remount", async ({page},testInfo)=>{
  const {readyCandidate,freezeViaApi,openReview,reviewHeaders}=await import("./review-support");
  const projectId=await createProjectViaApi(page,"Original agreed project");
  const {draftId,path,flowId,source}=await readyCandidate(page,projectId,true);
  const publish=async(frozen:{reviewId:string;reviewHash:string},reason:string)=>{
    const response=await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`,{headers:reviewHeaders(),data:{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:frozen.reviewHash,reason}});
    expect(response.status()).toBe(200);return response.json();
  };
  const first=await freezeViaApi(page,projectId,draftId);const publication=await publish(first,"First exact agreement");
  const original=await (await page.request.get(`/api/projects/${projectId}/snapshots/${first.snapshotId}`)).json();
  await openReview(page,projectId);await page.getByRole("tab",{name:"History",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Approved baselines",exact:true})).toBeVisible();
  await page.locator(`#snapshot-row-${first.snapshotId}`).click();
  const reader=page.getByRole("article",{name:"Published baseline",exact:true});
  await expect(reader.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();
  await expect(reader.getByText("First exact agreement",{exact:false})).toBeVisible();
  await expect(reader.locator(`time[datetime="${publication.publishedAt}"]`)).toHaveCount(2);
  await expect(reader.getByText(original.decision.actorId,{exact:true})).toHaveCount(2);
  await expect(reader.getByText("Captured checkout",{exact:true})).toBeVisible();
  await expect(reader.getByText("Original agreed project",{exact:true})).toBeVisible();
  await reader.getByRole("button",{name:"Captured brief, lines 105-105",exact:true}).click();
  await expect(reader.locator('.source-lines')).toContainText("Evidence line 105");
  expect((await page.request.post(`/api/projects/${projectId}/sources/${source!.sourceId}/versions`,{headers:reviewHeaders(),data:{title:"Corrected current brief",text:"New source text",expectedSourceRecordVersion:1,expectedCurrentVersionId:source!.sourceVersionId}})).status()).toBe(201);
  const settings=await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json();
  expect((await page.request.patch(`/api/projects/${projectId}/settings`,{headers:reviewHeaders(),data:{name:"Renamed current project",expectedSettingsVersion:settings.status.settingsVersion}})).status()).toBe(200);
  let draft=await (await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"UPDATE_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId,purpose:"Second approved checkout"}}})).status()).toBe(200);
  draft=await (await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"CONFIRM_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId}}})).status()).toBe(200);
  const second=await freezeViaApi(page,projectId,draftId);await publish(second,"Second agreement");
  const statusSeen=page.waitForResponse(r=>r.url().endsWith(`/api/projects/${projectId}/status`)&&r.status()===200);
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await statusSeen;
  await expect(reader.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();
  await expect(reader.getByText("Captured checkout",{exact:true})).toBeVisible();
  await expect(reader.getByText("Second approved checkout",{exact:true})).toHaveCount(0);
  await expect(reader.getByText("Original agreed project",{exact:true})).toBeVisible();
  expect(await (await page.request.get(`/api/projects/${projectId}/snapshots/${first.snapshotId}`)).json()).toEqual(original);
  await page.getByRole("tab",{name:"Details",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  await expect(reader.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();
  await reader.getByRole("heading",{name:"Approved baseline 1",exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("baseline-history-desktop.png")});
  await page.setViewportSize({width:320,height:800});
  await expect(reader.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("baseline-history-320.png")});
  await reader.getByRole("heading",{name:"Human decision",exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath("baseline-attribution-320.png")});
  await page.getByRole("button",{name:"Back to history",exact:true}).click();
  await expect(page.locator(`#snapshot-row-${first.snapshotId}`)).toBeFocused();
  await expect(page.locator(`#snapshot-row-${second.snapshotId}`)).toBeVisible();
  await page.locator(`#snapshot-row-${second.snapshotId}`).click();
  await expect(reader.getByRole("heading",{name:"Approved baseline 2",exact:true})).toBeVisible();
  await expect(reader.getByText("Second approved checkout",{exact:true})).toBeVisible();
});


test("late decision receipt settles exact retry while an older baseline stays selected",async({page})=>{
  const projectId=await createProjectViaApi(page,"Pinned recovery baseline");
  const {draftId,path,flowId}=await readyCandidate(page,projectId);
  const first=await freezeViaApi(page,projectId,draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${first.reviewId}/decision`,{headers:reviewHeaders(),data:{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:first.reviewHash}})).status()).toBe(200);
  let draft=await(await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"UPDATE_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId,purpose:"Newer scope for decision"}}})).status()).toBe(200);
  draft=await(await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"CONFIRM_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId}}})).status()).toBe(200);
  const second=await freezeViaApi(page,projectId,draftId);
  await openReview(page,projectId);await page.getByRole("tab",{name:"History",exact:true}).click();await page.locator(`#review-row-${second.reviewId}`).click();
  await expect(page.getByRole("button",{name:"Approve candidate",exact:true})).toBeVisible();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  const sent:Array<{url:string;body:string;key:string|undefined}>=[];
  await page.route(`**/api/projects/${projectId}/reviews/${second.reviewId}/decision`,async route=>{
    sent.push({url:route.request().url(),body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});
    if(sent.length===1){expect((await route.fetch()).status()).toBe(200);entered();await held;await route.abort("failed");}else await route.continue();
  });
  await page.getByRole("button",{name:"Approve candidate",exact:true}).click();await started;
  try{await page.getByRole("button",{name:"Back to history",exact:true}).click();await page.locator(`#snapshot-row-${first.snapshotId}`).click();await expect(page.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();}finally{release();}
  await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  const replay=page.waitForResponse(r=>r.url()===sent[0].url&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Retry",exact:true}).click();const response=await replay;expect(response.status()).toBe(200);expect((await response.json()).replayed).toBe(true);
  await expect(page.getByText("Approve candidate: saved.",{exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();
  await expect(page.getByRole("article",{name:"Published baseline",exact:true})).toContainText("Captured checkout");
  await expect(page.getByRole("article",{name:"Published baseline",exact:true})).not.toContainText("Newer scope for decision");
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
  const detail=await(await page.request.get(`/api/projects/${projectId}/snapshots/${second.snapshotId}`)).json();expect(detail.publicationSequence).toBe(2);
});


for (const candidateRead of ["loaded", "in flight"] as const) test(`receipt reconciliation preserves a newly selected candidate with its read ${candidateRead}`,async({page})=>{
  const projectId=await createProjectViaApi(page,"Pinned recovery baseline");
  const {draftId,path,flowId}=await readyCandidate(page,projectId);
  const first=await freezeViaApi(page,projectId,draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${first.reviewId}/decision`,{headers:reviewHeaders(),data:{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:first.reviewHash}})).status()).toBe(200);
  let draft=await(await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"UPDATE_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId,purpose:"Newer scope for decision"}}})).status()).toBe(200);
  draft=await(await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`,{headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"CONFIRM_FLOW",expectedEntityVersion:draft.document.flows[flowId].version,payload:{flowId}}})).status()).toBe(200);
  const second=await freezeViaApi(page,projectId,draftId);
  await openReview(page,projectId);await page.getByRole("tab",{name:"History",exact:true}).click();await page.locator(`#review-row-${second.reviewId}`).click();
  await expect(page.getByRole("button",{name:"Approve candidate",exact:true})).toBeVisible();
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  const sent:Array<{url:string;body:string;key:string|undefined}>=[];
  await page.route(`**/api/projects/${projectId}/reviews/${second.reviewId}/decision`,async route=>{
    sent.push({url:route.request().url(),body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});
    if(sent.length===1){expect((await route.fetch()).status()).toBe(200);entered();await held;await route.abort("failed");}else await route.continue();
  });
  await page.getByRole("button",{name:"Approve candidate",exact:true}).click();await started;
  try{await page.getByRole("button",{name:"Back to history",exact:true}).click();await page.locator(`#snapshot-row-${first.snapshotId}`).click();await expect(page.getByRole("heading",{name:"Approved baseline 1",exact:true})).toBeVisible();}finally{release();}
  await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  let listEntered!:()=>void,listRelease!:()=>void;
  const listStarted=new Promise<void>(r=>listEntered=r),listHeld=new Promise<void>(r=>listRelease=r);
  await page.route(`**/api/projects/${projectId}/snapshots`,async route=>{
    const response=await route.fetch();listEntered();await listHeld;await route.fulfill({response});
  });
  let candidateEntered!:()=>void,candidateRelease!:()=>void;
  const candidateStarted=new Promise<void>(r=>candidateEntered=r),candidateHeld=new Promise<void>(r=>candidateRelease=r);
  if(candidateRead==="in flight") await page.route(`**/api/projects/${projectId}/reviews/${first.reviewId}`,async route=>{
    const response=await route.fetch();candidateEntered();await candidateHeld;await route.fulfill({response});
  });
  const replay=page.waitForResponse(r=>r.url()===sent[0].url&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Retry",exact:true}).click();const response=await replay;expect(response.status()).toBe(200);expect((await response.json()).replayed).toBe(true);
  await listStarted;
  const reader=page.getByRole("article",{name:"Frozen candidate",exact:true});
  try {
    await page.getByRole("button",{name:"Back to history",exact:true}).click();
    await page.locator(`#review-row-${first.reviewId}`).click();
    if(candidateRead==="in flight") await candidateStarted;
    else await expect(reader).toContainText("Captured checkout");
  } finally {listRelease();}
  try {await expect(page.getByText("Approve candidate: saved.",{exact:true})).toBeVisible();}
  finally {candidateRelease();}
  await expect(reader).toContainText("Captured checkout");
  await expect(reader).not.toContainText("Newer scope for decision");
  await expect(reader.getByText(first.reviewId,{exact:true})).toBeVisible();
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
  const detail=await(await page.request.get(`/api/projects/${projectId}/snapshots/${second.snapshotId}`)).json();expect(detail.publicationSequence).toBe(2);
});

test("approved Markdown downloads and copy use the exact selected older baseline after source correction and newer approval", async ({ page }, testInfo) => {
  const projectId = await createProjectViaApi(page, "Markdown agreed scope"), { draftId, path, flowId, source } = await readyCandidate(page, projectId, true);
  const publish = async (frozen: { reviewId: string; reviewHash: string }) => expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  const first = await freezeViaApi(page, projectId, draftId); await publish(first);
  await openReview(page, projectId); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#snapshot-row-${first.snapshotId}`).click();
  const download = page.getByRole("button", { name: "Download Markdown", exact: true }); await expect(download).toBeVisible();
  const original = await (await page.request.get(`/api/projects/${projectId}/snapshots/${first.snapshotId}/export?format=markdown`)).text();
  expect((await page.request.post(`/api/projects/${projectId}/sources/${source!.sourceId}/versions`, { headers: reviewHeaders(), data: { title: "New brief", text: "Corrected source", expectedSourceRecordVersion: 1, expectedCurrentVersionId: source!.sourceVersionId } })).status()).toBe(201);
  let saved = await (await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: saved.document.flows[flowId].version, payload: { flowId, purpose: "Second approved scope" } } })).status()).toBe(200);
  saved = await (await page.request.get(path)).json();
  expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: saved.document.flows[flowId].version, payload: { flowId } } })).status()).toBe(200);
  const second = await freezeViaApi(page, projectId, draftId); await publish(second);
  const sent: string[] = []; page.on("request", request => { if (request.url().includes("/export?format=markdown")) sent.push(request.url()); });
  await download.focus(); const downloaded = page.waitForEvent("download"); await page.keyboard.press("Enter"); const file = await downloaded;
  expect(file.suggestedFilename()).toBe("Markdown agreed scope.md");
  const stream = await file.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(original);
  const copied = page.waitForResponse(response => response.url().endsWith(`/snapshots/${first.snapshotId}/export?format=markdown`) && response.status() === 200);
  await page.getByRole("button", { name: "Show Markdown for copy", exact: true }).click(); await copied;
  await expect(page.getByRole("button", { name: "Show Markdown for copy", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Approved Markdown", { exact: true })).toHaveValue(original);
  expect(sent.every(url => url.endsWith(`/snapshots/${first.snapshotId}/export?format=markdown`))).toBe(true); expect(sent).toHaveLength(2);
  await page.setViewportSize({ width: 320, height: 800 }); await page.getByLabel("Approved Markdown", { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("approved-markdown-320.png") });
  await page.getByRole("button", { name: "Back to history", exact: true }).click(); await page.locator(`#snapshot-row-${second.snapshotId}`).click();
  await expect(page.getByLabel("Approved Markdown", { exact: true })).toHaveCount(0);
});

collaborationTest("approved Markdown clears cached output and fences a late authorized response after membership revocation", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, removeEditor } = collaboration, { draftId } = await readyCandidate(ownerPage, projectId, true);
  const frozen = await freezeViaApi(ownerPage, projectId, draftId);
  expect((await ownerPage.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  await openReview(editorPage, projectId); await editorPage.getByRole("tab", { name: "History", exact: true }).click(); await editorPage.locator(`#snapshot-row-${frozen.snapshotId}`).click();
  const show = editorPage.getByRole("button", { name: "Show Markdown for copy", exact: true }); await show.click();
  await expect(editorPage.getByLabel("Approved Markdown", { exact: true })).toContainText("Captured checkout");
  let release!: () => void, entered!: () => void; const held = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  await editorPage.route(`**/snapshots/${frozen.snapshotId}/export?format=markdown`, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); entered(); await held; await route.fulfill({ response }); });
  const downloads: string[] = []; editorPage.on("download", file => downloads.push(file.suggestedFilename()));
  await editorPage.getByRole("button", { name: "Download Markdown", exact: true }).click(); await started;
  try {
    await removeEditor(); await editorPage.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await expect(editorPage.getByLabel("Approved Markdown", { exact: true })).toHaveCount(0); await expect(editorPage.locator("#right-panel")).toHaveCount(0);
  } finally { release(); }
  expect((await editorPage.request.get(`/api/projects/${projectId}/snapshots/${frozen.snapshotId}/export?format=markdown`)).status()).toBe(404);
  expect(downloads).toEqual([]);
});

test("approved Markdown Retry keeps the selected snapshot after temporary export failure and a late project-switch response discloses nothing", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Retry exact Markdown"), { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  const other = await createProjectViaApi(page, "Other Markdown project");
  await openReview(page, projectId); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#snapshot-row-${frozen.snapshotId}`).click();
  const endpoint = `**/snapshots/${frozen.snapshotId}/export?format=markdown`, sent: string[] = [];
  let fail = true, release!: () => void, entered!: () => void; const held = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  await page.route(endpoint, async route => {
    sent.push(route.request().url());
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Export temporarily unavailable" } } }); }
    else { const response = await route.fetch(); expect(response.status()).toBe(200); entered(); await held; await route.fulfill({ response }); }
  });
  await page.getByRole("button", { name: "Show Markdown for copy", exact: true }).click(); await expect(page.getByText("Export temporarily unavailable", { exact: false })).toBeVisible();
  const downloads: string[] = []; page.on("download", file => downloads.push(file.suggestedFilename()));
  await page.getByRole("button", { name: "Retry Markdown", exact: true }).click(); await started;
  try { await page.goto(`/app/projects/${other}`); await expect(page.getByRole("heading", { name: "Other Markdown project", exact: true })).toBeVisible(); } finally { release(); }
  expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]); expect(downloads).toEqual([]); await expect(page.getByLabel("Approved Markdown", { exact: true })).toHaveCount(0);
});

for (const change of ["sign-out", "account switch"] as const) collaborationTest(`approved Markdown clears prepared text and fences late output on ${change}`, async ({ collaboration }) => {
  const { ownerPage: page, projectId } = collaboration, { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  await openReview(page, projectId); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#snapshot-row-${frozen.snapshotId}`).click();
  await page.getByRole("button", { name: "Show Markdown for copy", exact: true }).click(); await expect(page.getByLabel("Approved Markdown", { exact: true })).toContainText("Captured checkout");
  let release!: () => void, entered!: () => void; const held = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  await page.route(`**/snapshots/${frozen.snapshotId}/export?format=markdown`, async route => { const response = await route.fetch(); entered(); await held; await route.fulfill({ response }); });
  const downloads: string[] = []; page.on("download", file => downloads.push(file.suggestedFilename()));
  await page.getByRole("button", { name: "Download Markdown", exact: true }).click(); await started;
  if (change === "account switch") await page.route(`**/projects/${projectId}/status`, async route => {
    const response = await route.fetch(); await route.fulfill({ json: { ...await response.json(), viewerId: randomUUID() } });
  });
  try {
    if (change === "sign-out") await page.getByRole("button", { name: "Sign out", exact: true }).click();
    else await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await expect(page).toHaveURL(change === "sign-out" ? /\/login$/ : /\/app$/);
  } finally { release(); }
  await expect(page.getByLabel("Approved Markdown", { exact: true })).toHaveCount(0); expect(downloads).toEqual([]);
});


test("saved pending meaning compares current baseline through A to B to A while historical selection remains pinned", async ({ page }, testInfo) => {
  const projectId = await createProjectViaApi(page, "Semantic pending baseline"), { draftId, path, flowId, startId } = await readyCandidate(page, projectId);
  const publish = async (candidate: { reviewId: string; reviewHash: string }) => {
    const response = await page.request.post(`/api/projects/${projectId}/reviews/${candidate.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: candidate.reviewHash } });
    expect(response.status()).toBe(200);
  };
  const purpose = async (text: string, confirm = false) => {
    let saved = await (await page.request.get(path)).json();
    expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: saved.document.flows[flowId].version, payload: { flowId, purpose: text } } })).status()).toBe(200);
    if (confirm) { saved = await (await page.request.get(path)).json(); expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: saved.document.flows[flowId].version, payload: { flowId } } })).status()).toBe(200); }
  };
  const first = await freezeViaApi(page, projectId, draftId); await publish(first);
  await openReview(page, projectId);
  const pending = page.getByRole("region", { name: "Saved work against current baseline", exact: true });
  await expect(pending).toContainText("Saved included scope matches the current approved baseline.");
  await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#snapshot-row-${first.snapshotId}`).click();
  const reader = page.getByRole("article", { name: "Published baseline", exact: true });
  await expect(reader).toContainText("Captured checkout");
  await purpose("B checkout", true); const second = await freezeViaApi(page, projectId, draftId);
  await purpose("Captured checkout");
  const before = await (await page.request.get(path)).json(); await publish(second);
  const seen = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/status`) && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await seen;
  await expect(pending).toContainText("Saved included scope has changes pending approval.");
  await expect(pending).toContainText("Baseline 2"); await expect(reader).toContainText("Approved baseline 1"); await expect(reader).toContainText("Captured checkout");
  expect(await (await page.request.get(path)).json()).toEqual(before);
  await purpose("B checkout"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pending).toContainText("Saved included scope matches the current approved baseline.");
  const saved = await (await page.request.get(path)).json(), position = saved.layout.positions[startId];
  expect((await page.request.post(`${path}/positions`, { headers: reviewHeaders(), data: { mode: "MOVE_NODES", flowId, items: [{ nodeId: startId, x: position.x + 70, y: position.y, expectedPositionVersion: position.version }] } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pending).toContainText("Saved included scope matches the current approved baseline."); await expect(pending).toContainText("Saved layout has unapproved presentation changes.");
  await expect(reader).toContainText("Approved baseline 1");
  await page.setViewportSize({ width: 320, height: 800 }); await pending.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("saved-pending-320.png") });
});


test("saved pending comparison never labels a below-status saved view clean and recovers through the existing reader", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Saved comparison stale read"), { draftId, path, flowId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  await openReview(page, projectId);
  const pending = page.getByRole("region", { name: "Saved work against current baseline", exact: true });
  await expect(pending).toContainText("Saved included scope matches the current approved baseline.");
  const before = await (await page.request.get(path)).json(); let stale = true;
  await page.route(`**${path}`, route => stale ? route.fulfill({ json: before }) : route.continue());
  expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: before.document.flows[flowId].version, payload: { flowId, purpose: "New saved pending wording" } } })).status()).toBe(200);
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(pending).toContainText("Saved comparison is unavailable or still refreshing.");
  await expect(pending.getByText("Saved included scope matches the current approved baseline.", { exact: true })).toHaveCount(0);
  stale = false; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pending).toContainText("Saved included scope has changes pending approval.");
  await page.unroute(`**${path}`);
});

test("saved pending comparison exposes unavailable current baseline reads and retries that exact baseline", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Saved comparison unavailable baseline"), { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  const endpoint = `**/api/projects/${projectId}/snapshots/${frozen.snapshotId}`;
  await page.route(endpoint, route => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Baseline temporarily unavailable" } } }));
  await openReview(page, projectId);
  const pending = page.getByRole("region", { name: "Saved work against current baseline", exact: true });
  await expect(pending).toContainText("Baseline temporarily unavailable");
  await expect(pending.getByText("Saved included scope matches the current approved baseline.", { exact: true })).toHaveCount(0);
  await page.unroute(endpoint); const recovered = page.waitForResponse(r => r.url().endsWith(`/snapshots/${frozen.snapshotId}`) && r.status() === 200);
  await pending.getByRole("button", { name: "Retry saved comparison", exact: true }).click(); await recovered;
  await expect(pending).toContainText("Saved included scope matches the current approved baseline.");
});

test("late decision acknowledgement preserves a different candidate selected before the response", async ({ page, workerAccount }) => {
  const projectId = await createProjectViaApi(page, "Late acknowledgement selection"), { draftId } = await readyCandidate(page, projectId);
  const first = await freezeViaApi(page, projectId, draftId);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${first.reviewId}/withdraw`, { headers: reviewHeaders(), data: { expectedReviewVersion: 1, reason: "Older inspected candidate" } })).status()).toBe(200);
  const second = await freezeViaApi(page, projectId, draftId);
  await openReview(page, projectId); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#review-row-${second.reviewId}`).click();
  await expect(page.getByRole("button", { name: "Approve candidate", exact: true })).toBeVisible();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const endpoint = `**/api/projects/${projectId}/reviews/${second.reviewId}/decision`;
  await page.route(endpoint, async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200); entered(); await held; await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Approve candidate", exact: true }).click(); await started;
  const reader = page.getByRole("article", { name: "Frozen candidate", exact: true });
  try {
    await page.getByRole("button", { name: "Back to history", exact: true }).click(); await page.locator(`#review-row-${first.reviewId}`).click();
    await expect(reader.getByText(first.reviewId, { exact: true })).toBeVisible();
    await expect(reader).toContainText("Older inspected candidate");
  } finally { release(); }
  await expect(page.getByText("Approve candidate: saved.", { exact: true })).toBeVisible();
  await expect(reader.getByText(first.reviewId, { exact: true })).toBeVisible();
  await expect(reader).toContainText("Older inspected candidate");
  await page.getByRole("tab", { name: "Details", exact: true }).click(); await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(reader.getByText(first.reviewId, { exact: true })).toBeVisible();
  expect((await workerAccount.database.query("select count(*)::int n from app.review_decision where project_id=$1", [projectId])).rows[0].n).toBe(1);
  await page.unroute(endpoint);
});


test("captured reader distinguishes included scope from excluded and undecided background before and after approval", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Mixed captured scope"), { draftId, path, startId } = await readyCandidate(page, projectId, true);
  const excludedFlow = randomUUID(), undecidedFlow = randomUUID(), backgroundNode = randomUUID();
  await seedStudioChanges(page, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Excluded flow", purpose: "Captured excluded purpose", classification: "BUSINESS_PROCESS", inclusion: "EXCLUDED" }, proposedIds: [excludedFlow] },
    { command: "ADD_NODE", payload: { flowId: excludedFlow, kind: "ACTION", label: "Excluded step", description: "Captured background step", actorLabel: "" }, proposedIds: [backgroundNode] },
    { command: "CREATE_FLOW", payload: { title: "Undecided flow", purpose: "Captured exploratory purpose", classification: "BUSINESS_PROCESS", inclusion: "UNDECIDED" }, proposedIds: [undecidedFlow] },
  ]);
  const command = async (body: object) => expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, ...body } })).status()).toBe(200);
  for (const inclusion of ["EXCLUDED", "UNDECIDED"] as const) {
    const saved = await (await page.request.get(path)).json();
    await command({ command: "CREATE_REQUIREMENT", expectedDocumentRevision: saved.documentRevision, payload: { title: `${inclusion} requirement`, statement: `Captured ${inclusion} statement`, category: "FUNCTIONAL", inclusion, sourceRefs: [], ownerId: null, verification: null } });
  }
  let saved = await (await page.request.get(path)).json();
  const includedReq = Object.values(saved.document.requirements).find((req: unknown) => (req as { inclusion: string }).inclusion === "INCLUDED") as { id: string };
  const excludedReq = Object.values(saved.document.requirements).find((req: unknown) => (req as { inclusion: string }).inclusion === "EXCLUDED") as { id: string };
  for (const [requirementId, nodeId, explanation] of [
    [includedReq.id, startId, "Reviewed included connection"],
    [includedReq.id, backgroundNode, "Unreviewed excluded-flow connection"],
    [excludedReq.id, startId, "Unreviewed excluded-requirement connection"],
  ]) {
    saved = await (await page.request.get(path)).json();
    await command({ command: "ADD_TRACE_LINK", expectedDocumentRevision: saved.documentRevision, payload: { requirementId, nodeId, explanation } });
  }
  saved = await (await page.request.get(path)).json();
  const link = Object.values(saved.document.traceLinks).find((link: unknown) => (link as { explanation: string }).explanation === "Reviewed included connection") as { id: string; version: number };
  await command({ command: "CONFIRM_TRACE_LINK", expectedEntityVersion: link.version, payload: { linkId: link.id, expectedRequirementBehaviourVersion: saved.document.requirements[includedReq.id].behaviourVersion, expectedNodeBehaviourVersion: saved.document.nodes[startId].behaviourVersion } });
  const frozen = await freezeViaApi(page, projectId, draftId);
  await openReview(page, projectId); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(`#review-row-${frozen.reviewId}`).click();
  const reader = page.getByRole("article", { name: "Frozen candidate", exact: true });
  const disclosures = async (approved: boolean) => {
    for (const [title, marker, content] of [
      ["Excluded flow", "Excluded background. Not approved behavior.", "Captured excluded purpose"],
      ["Undecided flow", "Undecided / exploratory background. Not approved.", "Captured exploratory purpose"],
      ["REQ-002: EXCLUDED requirement", "Excluded background. Not approved behavior.", "Captured EXCLUDED statement"],
      ["REQ-003: UNDECIDED requirement", "Undecided / exploratory background. Not approved.", "Captured UNDECIDED statement"],
    ]) {
      const item = reader.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).last();
      await expect(item.getByText(marker, { exact: true })).toBeVisible(); await expect(item.getByText(content, { exact: true })).toBeVisible();
    }
    await expect(reader.getByText(approved ? "Included in approved scope." : "Included candidate scope. Not approved.", { exact: true })).toHaveCount(2);
    await expect(reader.getByText("Background trace link. Not approved.", { exact: true })).toHaveCount(2);
    await expect(reader.getByText("Link review: Not reviewed", { exact: true })).toHaveCount(2);
    await expect(reader.getByText(approved ? "Reviewed included link. Approved scope." : "Reviewed included candidate link. Not approved.", { exact: true })).toBeVisible();
    await expect(reader.getByText("Captured background step", { exact: true })).toBeVisible();
    await expect(reader.getByText("Unreviewed excluded-flow connection", { exact: true })).toBeVisible();
    await expect(reader.getByText("Unreviewed excluded-requirement connection", { exact: true })).toBeVisible();
  };
  await disclosures(false);
  await page.getByRole("button", { name: "Approve candidate", exact: true }).click();
  await expect(reader.getByRole("heading", { name: "Approved candidate", exact: true })).toBeVisible();
  await disclosures(true);
});

collaborationTest("historical approval keeps captured actor name and role after profile and membership changes", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, setEditorRole } = collaboration, { draftId } = await readyCandidate(ownerPage, projectId);
  const actor = await (await editorPage.request.get(`/api/projects/${projectId}/status`)).json();
  const status = await (await ownerPage.request.get(`/api/projects/${projectId}/status`)).json();
  expect((await ownerPage.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: reviewHeaders(), data: { designatedApproverId: actor.viewerId, expectedApprovalPolicyVersion: status.approvalPolicyVersion } })).status()).toBe(200);
  const frozen = await freezeViaApi(ownerPage, projectId, draftId);
  expect((await editorPage.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  const endpoint = `/api/projects/${projectId}/snapshots/${frozen.snapshotId}/export?format=markdown`;
  const original = await (await ownerPage.request.get(endpoint)).text();
  expect(original).toContain("Approved actor name:\n\n> Collab editor"); expect(original).toContain("Approved actor role: EDITOR");
  const database = await openDatabase();
  try { expect((await database.query("update app.user_profile set display_name=$2 where id=$1", [actor.viewerId, "Renamed participant"])).rowCount).toBe(1); } finally { await database.end(); }
  await setEditorRole("VIEWER");
  const members = await (await ownerPage.request.get(`/api/projects/${projectId}/members`)).json();
  expect(members.members.find((member: { profileId: string }) => member.profileId === actor.viewerId)).toMatchObject({ displayName: "Renamed participant", role: "VIEWER" });
  expect(await (await ownerPage.request.get(endpoint)).text()).toBe(original);
  await openReview(ownerPage, projectId); await ownerPage.getByRole("tab", { name: "History", exact: true }).click(); await ownerPage.locator(`#snapshot-row-${frozen.snapshotId}`).click();
  const decision = ownerPage.getByRole("region", { name: "Human decision", exact: true });
  await expect(decision.getByText("Collab editor", { exact: true })).toBeVisible(); await expect(decision.getByText("Editor", { exact: true })).toBeVisible();
  await expect(decision.getByText(actor.viewerId, { exact: true })).toBeVisible();
  await expect(decision).not.toContainText("Renamed participant"); await expect(decision).not.toContainText("Self/internal approval");
  await ownerPage.getByRole("button", { name: "Show Markdown for copy", exact: true }).click();
  await expect(ownerPage.getByLabel("Approved Markdown", { exact: true })).toHaveValue(original);
});
