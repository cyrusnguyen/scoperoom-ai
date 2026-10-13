import assert from "node:assert/strict";
import test from "node:test";
import { StepError } from "inngest";
import { deliverRun, MAX_DELIVERY_ROUNDS } from "../src/features/proposals/server/deliver-run.ts";

const data = { runId: "00000000-0000-4000-8000-000000000001", dispatchId: "00000000-0000-4000-8000-000000000002", executionBinding: "sha-a", deadlineAt: new Date(Date.now() + 200_000).toISOString() };
function fakeStep() {
  const runs: string[] = [], sleeps: Array<[string, string]> = [];
  return { runs, sleeps, step: { run: async (id: string, fn: () => Promise<string | null>) => { runs.push(id); return fn(); }, sleepUntil: async (id: string, at: string) => { sleeps.push([id, at]); } } };
}

test("a worker built for another binding returns before any step, SQL claim or model call, without failing the run", async () => {
  const { step, runs } = fakeStep();
  let executed = 0;
  await deliverRun(data, step, { binding: "sha-b", execute: async () => { executed += 1; } });
  assert.deepEqual([executed, runs.length], [0, 0]);
  await deliverRun(data, step, { binding: "", execute: async () => { executed += 1; } }); // an unset binding (undefined would fall back to process.env)
  assert.deepEqual([executed, runs.length], [0, 0]);
});

test("a finished execution ends the delivery after one step", async () => {
  const { step, runs, sleeps } = fakeStep();
  await deliverRun(data, step, { binding: "sha-a", execute: async () => undefined });
  assert.deepEqual([runs, sleeps.length], [["attempt-1"], 0]);
});

test("a BUSY claim sleeps durably until the SQL window ends, then re-enters with a new step id", async () => {
  const { step, runs, sleeps } = fakeStep();
  const retryAt = new Date(Date.now() + 60_000);
  const answers: Array<Date | undefined> = [retryAt, undefined];
  await deliverRun(data, step, { binding: "sha-a", execute: async () => answers.shift() });
  assert.deepEqual(runs, ["attempt-1", "attempt-2"]);
  assert.deepEqual(sleeps, [["busy-1", retryAt.toISOString()]]);
});

test("the rounds are bounded: a run that stays BUSY is left to its SQL deadline", async () => {
  const { step, runs, sleeps } = fakeStep();
  await deliverRun(data, step, { binding: "sha-a", execute: async () => new Date(Date.now() + 1_000) });
  assert.equal(runs.length, MAX_DELIVERY_ROUNDS);
  assert.equal(sleeps.length, MAX_DELIVERY_ROUNDS - 1); // no sleep after the last round
});

function failingStep(error: unknown) {
  const sleeps: string[] = [];
  return { sleeps, step: { run: async (): Promise<string | null> => { throw error; }, sleepUntil: async (id: string) => { sleeps.push(id); } } };
}

test("a step that exhausts its retries ends the delivery as a result with one safe log line and no sleep", async (t) => {
  const { step, sleeps } = failingStep(new StepError("attempt-1", new Error("db down")));
  const logged = t.mock.method(console, "error", () => {});
  await deliverRun(data, step, { binding: "sha-a", execute: async () => undefined });
  assert.deepEqual(logged.mock.calls.map((call) => call.arguments), [[JSON.stringify({ delivery: "failed" })]]);
  assert.equal(sleeps.length, 0);
});

test("an error that is not a StepError still fails the run", async () => {
  const error = new Error("programming error");
  await assert.rejects(deliverRun(data, failingStep(error).step, { binding: "sha-a", execute: async () => undefined }), error);
});
