import test from "node:test";
import assert from "node:assert/strict";
import { resolveDock } from "../src/features/shell/ui/dock.ts";

const widths = [1440, 1200, 1024, 900, 768, 390];

test("left panel only: docks down to 900, overlays below", () => {
  const expect: Record<number, ["docked" | "overlay", number?]> = { 1440: ["docked", 1140], 1200: ["docked", 900], 1024: ["docked", 724], 900: ["docked", 600], 768: ["overlay"], 390: ["overlay"] };
  for (const W of widths) {
    const r = resolveDock(W, { leftOpen: true, rightOpen: false, lastOpened: "left" });
    assert.equal(r.right, "closed", `W=${W} right stays closed`);
    assert.equal(r.left, expect[W][0], `W=${W} left mode`);
    if (expect[W][1] !== undefined) assert.equal(r.editor, expect[W][1], `W=${W} editor width`);
  }
});

test("right panel only: docks down to 1024, overlays below", () => {
  const expect: Record<number, ["docked" | "overlay", number?]> = { 1440: ["docked", 1080], 1200: ["docked", 840], 1024: ["docked", 664], 900: ["overlay", 900], 768: ["overlay"], 390: ["overlay"] };
  for (const W of widths) {
    const r = resolveDock(W, { leftOpen: false, rightOpen: true, lastOpened: "right" });
    assert.equal(r.left, "closed", `W=${W} left stays closed`);
    assert.equal(r.right, expect[W][0], `W=${W} right mode`);
    if (expect[W][1] !== undefined) assert.equal(r.editor, expect[W][1], `W=${W} editor width`);
  }
});

test("both open at 1440: both dock, editor 780", () => {
  assert.deepEqual(resolveDock(1440, { leftOpen: true, rightOpen: true, lastOpened: "left" }), { left: "docked", right: "docked", editor: 780 });
});

test("both open at 1200 and 1024: right docks, left overlays (lastOpened left)", () => {
  for (const [W, editor] of [[1200, 840], [1024, 664]] as const) {
    assert.deepEqual(resolveDock(W, { leftOpen: true, rightOpen: true, lastOpened: "left" }), { left: "overlay", right: "docked", editor });
  }
});

test("both open at 900: left docks, right overlays (lastOpened right)", () => {
  assert.deepEqual(resolveDock(900, { leftOpen: true, rightOpen: true, lastOpened: "right" }), { left: "docked", right: "overlay", editor: 600 });
});

test("both open below 900: only lastOpened stays as an overlay, the other closes", () => {
  for (const W of [768, 390]) {
    assert.deepEqual(resolveDock(W, { leftOpen: true, rightOpen: true, lastOpened: "left" }), { left: "overlay", right: "closed", editor: W });
    assert.deepEqual(resolveDock(W, { leftOpen: true, rightOpen: true, lastOpened: "right" }), { left: "closed", right: "overlay", editor: W });
  }
});

test("both closed panels reserve zero width regardless of window size", () => {
  for (const W of widths) assert.deepEqual(resolveDock(W, { leftOpen: false, rightOpen: false, lastOpened: null }), { left: "closed", right: "closed", editor: W });
});

test("first load with no lastOpened yet never overlays: an unresolved panel closes", () => {
  for (const W of [768, 390]) assert.deepEqual(resolveDock(W, { leftOpen: true, rightOpen: true, lastOpened: null }), { left: "closed", right: "closed", editor: W });
});

test("invariant: editor never falls below min(W, 560), closed panels reserve 0, for every open combination and width", () => {
  for (const W of [320, 390, 480, 560, 639, 640, 768, 900, 1024, 1200, 1280, 1440, 1920]) {
    for (const leftOpen of [false, true]) for (const rightOpen of [false, true]) for (const lastOpened of ["left", "right", null] as const) {
      const r = resolveDock(W, { leftOpen, rightOpen, lastOpened });
      assert(r.editor >= Math.min(W, 560), `W=${W} left=${leftOpen} right=${rightOpen} last=${lastOpened} editor=${r.editor}`);
      if (!leftOpen) assert.equal(r.left, "closed");
      if (!rightOpen) assert.equal(r.right, "closed");
      assert.equal(r.editor, W - (r.left === "docked" ? 300 : 0) - (r.right === "docked" ? 360 : 0), "only docked panels reserve width");
      assert(!(r.left === "overlay" && r.right === "overlay"), "at most one overlay");
      if (r.left === "overlay") assert.equal(lastOpened, "left");
      if (r.right === "overlay") assert.equal(lastOpened, "right");
    }
  }
});

test("nothing docks below 560, and both dock only from 1220 upward", () => {
  assert.notEqual(resolveDock(559, { leftOpen: true, rightOpen: false, lastOpened: "left" }).left, "docked");
  const both1219 = resolveDock(1219, { leftOpen: true, rightOpen: true, lastOpened: "left" });
  assert(both1219.left !== "docked" || both1219.right !== "docked");
  const both1220 = resolveDock(1220, { leftOpen: true, rightOpen: true, lastOpened: "left" });
  assert.deepEqual({ left: both1220.left, right: both1220.right }, { left: "docked", right: "docked" });
});
