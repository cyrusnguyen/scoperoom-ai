import assert from "node:assert/strict";
import test from "node:test";
import { historyProblem } from "../scripts/db/history.mjs";

const local = ["20260926000000_project_baseline"];

test("a fresh or baseline-only history is accepted", () => {
  assert.equal(historyProblem(null, [], local), null);
  assert.equal(historyProblem("app", ["20260926000000_project_baseline"], local), null);
});

test("pre-baseline histories fail closed with a reset instruction", () => {
  assert.match(historyProblem("public", ["20260923092305_foundation"], local) ?? "", /reset/i);
  assert.match(historyProblem("app", ["20260923092305_foundation", "20260924190000_workspace_admission"], local) ?? "", /20260924190000_workspace_admission/);
});
