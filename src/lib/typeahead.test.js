// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTypeaheadBuffer, findTypeaheadMatch } from "./typeahead.js";

const labels = ["Copy link", "Keyboard shortcuts", "Settings", "Share", "Sign out"];

test("a letter jumps to the next item starting with it", () => {
  assert.equal(findTypeaheadMatch(labels, 0, "s"), 2);
  assert.equal(findTypeaheadMatch(labels, -1, "k"), 1);
});

test("matching is case-insensitive and ignores surrounding whitespace", () => {
  assert.equal(findTypeaheadMatch(["  Alpha", "beta"], -1, "B"), 1);
});

test("repeating a letter cycles through matches and wraps", () => {
  assert.equal(findTypeaheadMatch(labels, 2, "ss"), 3);
  assert.equal(findTypeaheadMatch(labels, 3, "sss"), 4);
  assert.equal(findTypeaheadMatch(labels, 4, "ssss"), 2);
});

test("a longer prefix keeps the current item while it matches", () => {
  assert.equal(findTypeaheadMatch(labels, 2, "se"), 2);
  assert.equal(findTypeaheadMatch(labels, 2, "sh"), 3);
  assert.equal(findTypeaheadMatch(labels, 3, "sig"), 4);
});

test("no match returns -1", () => {
  assert.equal(findTypeaheadMatch(labels, 0, "z"), -1);
  assert.equal(findTypeaheadMatch([], -1, "a"), -1);
  assert.equal(findTypeaheadMatch(labels, 0, ""), -1);
});

test("the buffer accumulates and resets", () => {
  const buffer = createTypeaheadBuffer(10_000);
  assert.equal(buffer.active, false);
  assert.equal(buffer.push("s"), "s");
  assert.equal(buffer.push("e"), "se");
  assert.equal(buffer.active, true);
  buffer.reset();
  assert.equal(buffer.active, false);
  assert.equal(buffer.push("k"), "k");
  buffer.reset();
});
