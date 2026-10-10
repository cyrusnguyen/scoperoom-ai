import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-fixtures";
import { test as collaborationTest } from "./collaboration-fixtures";
import { appUrl, createProjectViaApi, e2eReady, seedStudioChanges } from "./support";

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

test("lost flow confirmation acknowledgement retries the exact body and key after remount", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Confirmation recovery");
  const { path } = await prepare(page, projectId);
  await inspect(page, projectId);
  const sent: Array<{ body: string; key: string | undefined }> = [];
  let committed: unknown;
  await page.route(`**${path}/commands`, async (route) => {
    const request = route.request();
    sent.push({ body: request.postData()!, key: request.headers()["idempotency-key"] });
    if (sent.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = await (await page.request.get(path)).json();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Confirm flow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Specs", exact: true }).click();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Confirm flow: saved.", { exact: true })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]!.key).toBeTruthy();
  expect(await (await page.request.get(path)).json()).toEqual(committed);
});

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
  await page.getByLabel("Withdrawal reason").fill("Revisit saved scope");
  await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();
  await expect(page.getByText("Closed reason: Revisit saved scope",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Back to history",exact:true}).click();
  await expect(page.getByRole("button",{name:/WITHDRAWN/})).toBeFocused();
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
  await editorPage.reload();await editorPage.getByRole("button",{name:"Inspect",exact:true}).click();await editorPage.getByRole("tab",{name:"Review",exact:true}).click();await editorPage.getByRole("tab",{name:"History",exact:true}).click();await editorPage.getByRole("button",{name:/SUPERSEDED/}).click();await expect(editorPage.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();
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
  await page.getByLabel("Withdrawal reason").fill("Submitted reason");await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();await started;
  try{await page.getByLabel("Withdrawal reason").fill("Newer local reason");await page.getByRole("tab",{name:"Specs",exact:true}).click();}finally{release();}
  await page.getByRole("tab",{name:"Review",exact:true}).click();await expect(page.getByText("Closed reason: Submitted reason",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Current",exact:true}).click();await freezeInUi(page);await expect(page.getByLabel("Withdrawal reason")).toHaveValue("Newer local reason");
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
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});const sent:Array<{body:string;key:string|undefined}>=[];
  await page.route(`**/api/projects/${projectId}/reviews/*/withdraw`,async route=>{sent.push({body:route.request().postData()!,key:route.request().headers()["idempotency-key"]});if(sent.length===1){expect((await route.fetch()).status()).toBe(200);entered();await held;await route.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED",message:"Late session response"}}});}else await route.continue();});
  await page.getByLabel("Withdrawal reason").fill("Submitted closure");await page.getByRole("button",{name:"Withdraw candidate",exact:true}).click();await started;
  try{await page.getByRole("button",{name:"Next project",exact:true}).click();await page.getByRole("button",{name:"Discard changes",exact:true}).click();await expect(page.getByRole("heading",{level:1,name:"Next project",exact:true})).toBeVisible();}finally{release();}
  await expect(page).toHaveURL(new RegExp(`/app/projects/${other}$`));await page.getByRole("button",{name:"Old candidate project",exact:true}).click();await expect(page.getByRole("heading",{level:1,name:"Old candidate project",exact:true})).toBeVisible();await page.getByRole("button",{name:"Inspect",exact:true}).click();await page.getByRole("tab",{name:"Review",exact:true}).click();
  await page.getByRole("button",{name:"Retry",exact:true}).click();await expect(page.getByText("Closed reason: Submitted closure",{exact:true})).toBeVisible();expect(sent[1]).toEqual(sent[0]);
});

collaborationTest("loss of membership removes protected candidate and evidence before late reads can repopulate them",async({collaboration})=>{
  const {ownerPage,editorPage,projectId,removeEditor}=collaboration;const {draftId}=await readyCandidate(ownerPage,projectId,true);const frozen=await freezeViaApi(ownerPage,projectId,draftId);await openReview(editorPage,projectId);await editorPage.getByRole("tab",{name:"History",exact:true}).click();await editorPage.getByRole("button",{name:/OPEN/}).click();await expect(editorPage.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();
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
