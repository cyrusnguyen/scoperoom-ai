import assert from "node:assert/strict";
import test from "node:test";
import { requireEnv } from "./support/env.ts";

test("missing test environment skips locally but fails under CI", () => {
  const saved = process.env.CI;
  try {
    delete process.env.CI;
    assert.equal(requireEnv(["SCOPEROOM_TEST_ENV_THAT_DOES_NOT_EXIST"]), false);
    process.env.CI = "true";
    assert.throws(() => requireEnv(["SCOPEROOM_TEST_ENV_THAT_DOES_NOT_EXIST"]), /SCOPEROOM_TEST_ENV_THAT_DOES_NOT_EXIST/);
    process.env.PATH_FOR_TEST = "x";
    assert.equal(requireEnv(["PATH_FOR_TEST"]), true);
  } finally {
    if (saved === undefined) delete process.env.CI; else process.env.CI = saved;
    delete process.env.PATH_FOR_TEST;
  }
});
