// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { PALETTE, paletteName } from "./palette.js";

test("every palette symbol draws, and no group repeats one", () => {
  for (const group of PALETTE) {
    assert.ok(group.items.length > 0, group.id);
    assert.equal(new Set(group.items).size, group.items.length, group.id);
    for (const item of group.items)
      assert.doesNotThrow(
        () => katex.renderToString(item.preview, { throwOnError: true }),
        item.label,
      );
  }
});

test("palette names read as commands", () => {
  const structures = PALETTE[0].items;
  assert.equal(paletteName(structures[0]), "Superscript");
  assert.equal(paletteName(structures[1]), "Subscript");
  assert.equal(paletteName(structures[2]), "\\frac");
  assert.ok(structures.some((s) => paletteName(s) === "\\sqrt"));
});

test("each symbol is in one group only", () => {
  const all = PALETTE.flatMap((g) => g.items);
  assert.equal(new Set(all).size, all.length);
});
