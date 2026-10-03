import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { probeCaseVerified, selectProbeCases } from "../scripts/ai/probe.mts";
import type { ModelReply } from "../src/features/proposals/server/ports.ts";

// Guard paths run without loading an env file and never reach a provider. Canary secrets must stay out of diagnostics.
const guardedRun = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "scripts/ai/probe.mts", ...args], {
  encoding: "utf8", env: { ...process.env, GOOGLE_GENERATIVE_AI_API_KEY: "canary-key-never-send", AI_MODEL: "canary-model-never-print" },
});

test("provider probe refuses without explicit live intent before using configured credentials", () => {
  const result = guardedRun([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to call a provider/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /canary/);
});

test("provider probe validates every requested case before any call", () => {
  for (const args of [["--live", "--only="], ["--live", "--only=typo"], ["--live", "--only=generate,typo"], ["--live", "--only=generate,generate"], ["--live", "--only=generate", "--only=improve"], ["--live", "--only", "generate"]]) {
    const result = guardedRun(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /canary/);
  }
  assert.deepEqual(selectProbeCases(["--live", "--only=improve,generate"]), ["generate", "improve"]);
  assert.equal(selectProbeCases(["--live"]).length, 5);
});

test("provider probe succeeds only when the selected schema or calibration expectation is verified", () => {
  const completed: ModelReply = { kind: "completed", output: {}, usage: { inputTokens: 100, outputTokens: 50 } };
  assert.equal(probeCaseVerified("generate", completed, true), true);
  assert.equal(probeCaseVerified("improve", completed, false), false);
  assert.equal(probeCaseVerified("generate", { kind: "unavailable" }, null), false);
  assert.equal(probeCaseVerified("calibrate-ascii-40k", completed, null), true);
  assert.equal(probeCaseVerified("calibrate-cjk-10k", { ...completed, usage: { inputTokens: null, outputTokens: 50 } }, null), false);
  assert.equal(probeCaseVerified("unsupported-schema", { kind: "refused" }, null), true);
  for (const reply of [completed, { kind: "unavailable" }, { kind: "unknown" }] as ModelReply[]) assert.equal(probeCaseVerified("unsupported-schema", reply, null), false);
});
