import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name).replaceAll("\\", "/");
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

// React only reports duplicate sibling keys in development, and the browser suite runs a production build.
test("no JSX line gives two elements the same key expression", () => {
  for (const file of tsxFiles("src")) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const keys = [...line.matchAll(/\bkey=\{([^}]*)\}/g)].map((match) => match[1].trim());
      const repeated = keys.find((key, position) => keys.indexOf(key) !== position);
      assert.equal(repeated, undefined, `${file}:${index + 1} repeats key={${repeated}}; key the shared parent once instead`);
    });
  }
});
