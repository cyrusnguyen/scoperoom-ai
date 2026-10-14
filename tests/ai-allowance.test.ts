import assert from "node:assert/strict";
import test from "node:test";
import { aiAllowance, allowanceText } from "../src/features/proposals/domain/allowance.ts";

test("the allowance counts what is left of each limit, never below zero, and null limits are unlimited", () => {
  assert.deepEqual(aiAllowance({ allowed: true, total: 5, daily: 30 }, { total: 2, today: 1 }, true),
    { allowed: true, viewerIsOwner: true, total: { used: 2, limit: 5, left: 3 }, today: { used: 1, limit: 30, left: 29 } });
  assert.deepEqual(aiAllowance({ allowed: true, total: 5, daily: 30 }, { total: 7, today: 7 }, false).total, { used: 7, limit: 5, left: 0 });
  assert.deepEqual(aiAllowance({ allowed: true, total: null, daily: null }, { total: 40, today: 3 }, true).total, { used: 40, limit: null, left: null });
});

test("the text says what is left, today's count when a daily limit applies, and whose allowance it is", () => {
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: 5, daily: 30 }, { total: 2, today: 1 }, true)), "3 of 5 AI requests left · 29 of 30 left today");
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: 5, daily: null }, { total: 5, today: 0 }, true)), "0 of 5 AI requests left");
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: null, daily: 10 }, { total: 50, today: 10 }, true)), "Unlimited AI requests · 0 of 10 left today");
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: null, daily: null }, { total: 0, today: 0 }, true)), "Unlimited AI requests");
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: 5, daily: 30 }, { total: 2, today: 1 }, false)), "3 of 5 AI requests left · 29 of 30 left today (the project owner's allowance)");
  assert.equal(allowanceText(aiAllowance({ allowed: false, total: 5, daily: 30 }, { total: 0, today: 0 }, false)), "AI requests are not enabled for this project's owner.");
  assert.equal(allowanceText(aiAllowance({ allowed: true, total: 1, daily: null }, { total: 0, today: 0 }, true)), "1 of 1 AI request left");
});
