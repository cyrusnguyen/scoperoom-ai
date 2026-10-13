import assert from "node:assert/strict";
import test from "node:test";
import { runScheduled } from "../src/worker/maintenance.ts";

test("a scheduled sweep logs the task, outcome and counts, and resolves ok", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const error = t.mock.method(console, "error", () => undefined);
  assert.deepEqual(await runScheduled("cleanup", async () => ({ expiredPreviews: 1 })), { ok: true });
  assert.deepEqual(info.mock.calls.map((call) => call.arguments), [['{"maintenance":"cleanup","ok":true,"counts":{"expiredPreviews":1}}']]);
  assert.equal(error.mock.callCount(), 0);
});

test("a failed sweep is a result, never a throw, and the log carries no error text", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const error = t.mock.method(console, "error", () => undefined);
  assert.deepEqual(await runScheduled("repair", async () => { throw new Error("password=x host=y"); }), { ok: false });
  assert.deepEqual(error.mock.calls.map((call) => call.arguments), [['{"maintenance":"repair","ok":false}']]);
  assert.equal(info.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(error.mock.calls), /password/);
});
