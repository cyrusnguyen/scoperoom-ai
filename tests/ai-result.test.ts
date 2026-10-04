import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultError, validateResult } from "../src/features/proposals/domain/validate-result.ts";
import { goodGenerate, resultFixture } from "./support/ai-results.ts";
const f = resultFixture();

test("exact citations refuse a corrupted captured source hash and extra source authority", () => {
  const capture = f.generate();
  capture.sources[0]!.contentHash = "0".repeat(64);
  assert.throws(() => validateResult(capture, goodGenerate(f.sourceVersionId)), ResultError);
  const result = goodGenerate(f.sourceVersionId);
  const citation = (result.citations as Record<string, unknown>[])[0]!;
  citation.title = "Model chosen title";
  assert.throws(() => validateResult(f.generate(), result), ResultError);
});

test("URL, tool, origin, confirmation and geometry fields fail closed", () => {
  for (const field of ["url", "tool", "origin", "confirmation", "position", "version"]) {
    const result = goodGenerate(f.sourceVersionId);
    Object.assign((result.operations[1] as { edit: { payload: object } }).edit.payload, { [field]: "untrusted" });
    assert.throws(() => validateResult(f.generate(), result), ResultError);
  }
});
