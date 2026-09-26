import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const tokensPath = "src/styles/tokens.css";

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name).replaceAll("\\", "/");
    return entry.isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
  });
}

const stylesheets = () => cssFiles("src").filter((path) => path !== tokensPath);

test("tokens.css holds the Atlas Projects layout tokens and palette anchors", () => {
  const tokens = readFileSync(tokensPath, "utf8");
  const expected: [string, string][] = [
    ["--sidebar-width", "300px"], ["--rpanel-width", "360px"], ["--bar-height", "44px"], ["--row-height", "36px"],
    ["--background", "#191c1a"], ["--accent", "#b49c65"], ["--accent-hover", "#c4ad77"], ["--radius-control", "6px"], ["--scrim", "#0c100db8"],
  ];
  for (const [name, value] of expected) assert.match(tokens, new RegExp(`${name}:\\s*${value};`), `${name} should be ${value}`);
  assert.doesNotMatch(tokens, /@theme|--color-|--primary:/, "Tailwind/shadcn aliases have no consumer in this app");
});

test("every custom property a stylesheet reads is defined in tokens.css, and only tokens.css defines them", () => {
  const defined = new Set([...readFileSync(tokensPath, "utf8").matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  for (const file of stylesheets()) {
    const css = readFileSync(file, "utf8");
    for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) assert(defined.has(name), `${file} reads undefined ${name}`);
    assert.doesNotMatch(css, /^\s*--[\w-]+\s*:/m, `${file} defines its own custom properties; move them to ${tokensPath}`);
  }
});
