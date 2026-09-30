import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Guard scripts must never become silent no-ops: reached through a linked path they still run their CLI and fail
// closed on missing configuration, while importing them for helpers runs nothing.
const env = { ...process.env, SCOPEROOM_BOOTSTRAP_DATABASE_URL: "", SCOPEROOM_ENVIRONMENT_ID: "" };

test("guarded database CLIs run through a linked checkout path and stay inert when imported", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoperoom-db-"));
  try {
    const linked = join(dir, "db");
    symlinkSync(resolve("scripts/db"), linked, process.platform === "win32" ? "junction" : "dir");
    for (const [script, args] of [["guard.mjs", []], ["realtime.mjs", ["verify"]]] as const) {
      const result = spawnSync(process.execPath, [join(linked, script), ...args], { env, encoding: "utf8" });
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /needs SCOPEROOM_BOOTSTRAP_DATABASE_URL/, script);
      const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL(`../scripts/db/${script}`, import.meta.url).href)})`], { env, encoding: "utf8" });
      assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, "", ""], `${script} import`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
