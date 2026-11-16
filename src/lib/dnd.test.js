// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { autoScrollDelta, dropZone, pastThreshold } from "./dnd.js";

test("dropZone with inside: quarters for before/after, middle for inside", () => {
  assert.equal(dropZone(0, 32), "before");
  assert.equal(dropZone(7, 32), "before");
  assert.equal(dropZone(8, 32), "inside");
  assert.equal(dropZone(16, 32), "inside");
  assert.equal(dropZone(23, 32), "inside");
  assert.equal(dropZone(24, 32), "after");
  assert.equal(dropZone(31, 32), "after");
});

test("dropZone without inside splits the row in half", () => {
  assert.equal(dropZone(15, 32, { inside: false }), "before");
  assert.equal(dropZone(16, 32, { inside: false }), "after");
});

test("dropZone clamps out-of-row offsets and survives a zero height", () => {
  assert.equal(dropZone(-5, 32), "before");
  assert.equal(dropZone(50, 32), "after");
  assert.equal(dropZone(0, 0), "inside");
  assert.equal(dropZone(0, 0, { inside: false }), "after");
});

test("dropZone edge size is configurable", () => {
  assert.equal(dropZone(10, 32, { edge: 0.4 }), "before");
  assert.equal(dropZone(16, 32, { edge: 0.4 }), "inside");
});

test("autoScrollDelta: 0 in the middle, up near the top, down near the bottom", () => {
  assert.equal(autoScrollDelta(300, 0, 600), 0);
  assert.ok(autoScrollDelta(10, 0, 600) < 0);
  assert.ok(autoScrollDelta(590, 0, 600) > 0);
});

test("autoScrollDelta ramps up toward the edge and caps at maxSpeed", () => {
  const options = { edge: 40, maxSpeed: 20 };
  const slow = autoScrollDelta(560 + 5, 0, 600, options);
  const fast = autoScrollDelta(600 - 2, 0, 600, options);
  assert.ok(slow > 0 && slow < fast, `${slow} < ${fast}`);
  assert.equal(autoScrollDelta(700, 0, 600, options), 20, "past the edge: max speed");
  assert.equal(autoScrollDelta(-100, 0, 600, options), -20);
});

test("autoScrollDelta shrinks the hot zone in short containers", () => {
  // 60px tall: the zone is 20px, so the middle stays still.
  assert.equal(autoScrollDelta(130, 100, 160), 0);
  assert.ok(autoScrollDelta(105, 100, 160) < 0);
  assert.equal(autoScrollDelta(100, 100, 100), 0);
});

test("pastThreshold uses the distance, not each axis", () => {
  assert.equal(pastThreshold(3, 0, 4), false);
  assert.equal(pastThreshold(3, 3, 4), true);
  assert.equal(pastThreshold(0, -4, 4), true);
});
