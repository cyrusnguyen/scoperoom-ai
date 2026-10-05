import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL, loadCorpus, selectCases, budgetGateway, assess, outcomeCounts } from "./evaluation/run.mts";
import { resultFixture } from "./support/ai-results.ts";
import { buildModelRequest } from "../src/features/proposals/domain/model-request.ts";
import { canonicalJson, sha256 } from "../src/features/proposals/domain/capture.ts";
const request = () => { const capture = resultFixture().generate(); capture.versions.model = MODEL; return buildModelRequest({id: "00000000-0000-4000-8000-000000000001", model: MODEL, capture}, 1000); };
const state = () => ({model: MODEL, authorizedCalls: 26, reservedCalls: 0, records: []});
async function budgetTest(run: (journal: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "scoperoom-evaluation-")); const journal = join(dir, "budget.json");
  writeFileSync(journal, JSON.stringify(state())); try { await run(journal); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("frozen corpus has 24 executable canonical captures, balanced development and held-out partitions", () => { const corpus = loadCorpus(); assert.equal(corpus.length, 24); assert.equal(corpus.filter(item => item.partition === "development").length, 16); assert.equal(corpus.filter(item => item.partition === "held-out").length, 8); assert.equal(corpus.filter(item => item.capture.taskType === "PROPOSE_FLOW").length, 12); assert.equal(corpus.filter(item => item.capture.taskType === "REFINE_FLOW_SELECTION").length, 12); });
test("bounded case selection rejects duplicates, unknowns and implicit live authority", () => {
  assert.deepEqual(selectCases([], ["G01", "I01"]), ["G01", "I01"]);
  for (const args of [["--only=G01,G01"], ["--only=X"], ["--live"], ["--limit=0"], ["--unexpected"]]) assert.throws(() => selectCases(args, ["G01", "I01"]));
});
test("physical inference is fsynced before transport and cannot repeat after restart", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const transport: typeof fetch = async () => { calls++; const saved = JSON.parse(readFileSync(journal, "utf8")); assert.equal(saved.reservedCalls, 1); assert.equal(saved.records[0].id, "G01"); throw new Error("uncertain provider failure"); };
  const options = {journal, id: "G01", kind: "corpus" as const, apiKey: "synthetic-test-key", transport, onDenied: () => denied++};
  await budgetGateway(options).generate(request(), new AbortController().signal);
  await budgetGateway(options).generate(request(), new AbortController().signal);
  assert.equal(calls, 1); assert.equal(denied, 1); assert.equal(JSON.parse(readFileSync(journal, "utf8")).reservedCalls, 1);
}));
test("malformed, exhausted and mismatched journal authority never reaches transport", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  for (const value of ["{", JSON.stringify({...state(), model: "another-model"}), JSON.stringify({...state(), reservedCalls: 26}), JSON.stringify({...state(), authorizedCalls: 27}), JSON.stringify({...state(), records: [{slot: 1}]})]) {
    writeFileSync(journal, value);
    await budgetGateway({journal, id: "G01", kind: "corpus", apiKey: "synthetic-test-key", onDenied: () => denied++, transport: async () => {calls++; throw new Error("must not reach transport");}}).generate(request(), new AbortController().signal);
  }
  assert.equal(calls, 0); assert.equal(denied, 5);
}));
test("model mismatch and failed persistence deny before any inference", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const gateway = budgetGateway({journal, id: "G01", kind: "corpus", apiKey: "synthetic-test-key", transport: async () => {calls++; throw new Error("must not call");}, onDenied: () => denied++});
  await gateway.generate({...request(), model: "another-model"}, new AbortController().signal);
  writeFileSync(`${journal}.lock`, "other process");
  await gateway.generate(request(), new AbortController().signal);
  assert.equal(calls, 0); assert.equal(denied, 2);
}));

test("all validator probes preserve outside behavior and saved positions without treating derived flow versions as edits", () => {
  for (const item of loadCorpus()) {
    const observed = assess(item, item.validationProbe);
    assert.equal(observed.schemaFailure, null, item.id); assert.equal(observed.applicationFailure, null, item.id); assert.equal(observed.scopePreserved, true, item.id);
    assert.equal(observed.humanReview.status, "not_reviewed"); assert.equal(observed.humanReview.useful, null);
  }
});
test("a durable journey slot blocks a worker retry and transports cannot follow redirects", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const gateway = budgetGateway({journal,id:"journey:PROPOSE_FLOW",kind:"journey",apiKey:"synthetic-test-key",transport:async (_input, init) => {calls++; assert.equal(init?.redirect,"error"); return new Response("{}",{status:503});},onDenied:()=>denied++});
  assert.equal((await gateway.generate(request(),new AbortController().signal)).kind,"unavailable");
  assert.equal((await gateway.generate(request(),new AbortController().signal)).kind,"refused");
  assert.equal(calls,1); assert.equal(denied,1);
}));
test("hostile model authority, boundary edits, foreign citations and unresolved dependencies fail canonical assessment", () => {
  const improve = loadCorpus()[12];
  const proposal = (operations: unknown[], citations: unknown[] = []) => ({schemaVersion:1,kind:"proposal",operations,assumptions:[],citations});
  for (const output of [
    {...improve.validationProbe as object, approved:true},
    proposal([{id:"bad",dependsOn:[],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.graph.boundaryNodeIds[0],label:"Hostile boundary edit"}}}]),
    proposal([{id:"bad",dependsOn:["missing"],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.selection!.nodeIds[0],label:"Missing prerequisite"}}}]),
    proposal([{id:"bad",dependsOn:[],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.selection!.nodeIds[0],label:"Foreign citation"}}}],[{sourceVersionId:"00000000-0000-4000-8000-000000999999",startLine:1,endLine:1,excerpt:"Invented"}]),
    {schemaVersion:1,kind:"clarification",message:"Need context",operations:[]},
    "{truncated",
  ]) assert.notEqual(assess(improve,output).schemaFailure,null);
});


test("a failed fsync cannot start transport and its uncertain slot is never reclaimed", async () => budgetTest(async journal => {
  let calls=0, denied=0;
  const gateway=budgetGateway({journal,id:"G01",kind:"corpus",apiKey:"synthetic-test-key",transport:async()=>{calls++;throw new Error("must not start");},syncFile:()=>{throw new Error("injected storage failure");},onDenied:()=>denied++});
  await gateway.generate(request(),new AbortController().signal);
  assert.equal(calls,0);assert.equal(denied,1);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,1);
}));
test("a valid exhausted 26-slot journal denies without a physical call", async () => budgetTest(async journal => {
  const names=["G","I"].flatMap(p=>Array.from({length:12},(_,i)=>`${p}${String(i+1).padStart(2,"0")}`)).concat(["journey:PROPOSE_FLOW","journey:REFINE_FLOW_SELECTION"]);
  writeFileSync(journal,JSON.stringify({...state(),reservedCalls:26,records:names.map((name,i)=>({slot:i+1,id:name,kind:i<24?"corpus":"journey",runId:`00000000-0000-4000-8000-${String(i+100).padStart(12,"0")}`,model:MODEL,reservedAt:"2026-10-05T00:00:00.000Z"}))}));
  let calls=0,denied=0;
  await budgetGateway({journal,id:"G01",kind:"corpus",apiKey:"synthetic-test-key",transport:async()=>{calls++;throw new Error("must not call");},onDenied:()=>denied++}).generate(request(),new AbortController().signal);
  assert.equal(calls,0);assert.equal(denied,1);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,26);
}));

test("hash-consistent forged captures, foreign source ownership and stale identities fail before evaluation", async () => budgetTest(async journal => {
  const corpusFile=join(journal,"..","cases.json");
  const original=JSON.parse(readFileSync(new URL("./evaluation/cases.json",import.meta.url),"utf8"));
  for (const mutate of [
    (raw: typeof original) => {raw.cases[12].capture.graph.nodes[0].readOnly=false;raw.cases[12].capture.graphHash=sha256(canonicalJson(raw.cases[12].capture.graph));raw.cases[12].captureHash=sha256(canonicalJson(raw.cases[12].capture));},
    (raw: typeof original) => {raw.cases[6].saved.sources[0].projectId="00000000-0000-4000-8000-000000999999";},
    (raw: typeof original) => {raw.cases[0].input.expectedDocumentRevision++;},
    (raw: typeof original) => {raw.cases[0].capture.limits.maxInputTokens=1000000;raw.cases[0].captureHash=sha256(canonicalJson(raw.cases[0].capture));},
    (raw: typeof original) => {raw.cases[0].partition="held-out";},
  ]) { const raw=structuredClone(original);mutate(raw);writeFileSync(corpusFile,JSON.stringify(raw));assert.throws(()=>loadCorpus(corpusFile)); }
}));



test("unavailable output never becomes a validation or usefulness success in aggregate counts", () => {
  const item=loadCorpus()[0];
  const counts=outcomeCounts([{outcome:"unavailable",assessment:null},{outcome:"completed",assessment:assess(item,{schemaVersion:1,kind:"clarification",message:"Which authorizer?"})},{outcome:"completed",assessment:assess(item,{schemaVersion:1,kind:"proposal",operations:[]})}]);
  assert.deepEqual(counts,{providerNoncompletion:1,schemaFailures:1,applicationFailures:0,scopePreservationFailures:0,validatedProposals:0,validatedClarifications:1});
});
