// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { computePosition } from "./position.js";

const viewport = { width: 1000, height: 800 };
const menu = { width: 200, height: 150 };

/** @param {number} x @param {number} y @param {number} [width] @param {number} [height] */
const rect = (x, y, width = 100, height = 30) => ({ x, y, width, height });

test("bottom-start sits below the anchor, left edges aligned", () => {
  const pos = computePosition(rect(100, 100), menu, viewport, {
    placement: "bottom-start",
    offset: 4,
  });
  assert.deepEqual(pos, {
    x: 100,
    y: 134,
    placement: "bottom-start",
    maxHeight: 800 - 8 - 130 - 4,
  });
});

test("bottom centers on the anchor; bottom-end aligns right edges", () => {
  assert.equal(computePosition(rect(400, 100), menu, viewport, { placement: "bottom" }).x, 350);
  assert.equal(computePosition(rect(400, 100), menu, viewport, { placement: "bottom-end" }).x, 300);
});

test("flips to the top when there's no room below", () => {
  const pos = computePosition(rect(100, 700), menu, viewport, {
    placement: "bottom-start",
    offset: 4,
  });
  assert.equal(pos.placement, "top-start");
  assert.equal(pos.y, 700 - 4 - 150);
});

test("flips to the bottom when there's no room above", () => {
  const pos = computePosition(rect(100, 20), menu, viewport, { placement: "top" });
  assert.equal(pos.placement, "bottom");
  assert.equal(pos.y, 20 + 30 + 4);
});

test("keeps the larger side when neither fits, and caps the height", () => {
  const short = { width: 1000, height: 300 };
  // 156px of room below, 98px above: stays below and gets maxHeight 152 (156 minus the offset).
  const pos = computePosition(rect(100, 106), { width: 200, height: 400 }, short, {
    placement: "bottom",
    offset: 4,
  });
  assert.equal(pos.placement, "bottom");
  assert.equal(pos.maxHeight, 300 - 8 - 136 - 4);
  assert.equal(pos.y, 140);
});

test("a capped top placement still ends just above the anchor", () => {
  const short = { width: 1000, height: 300 };
  const pos = computePosition(rect(100, 200), { width: 200, height: 400 }, short, {
    placement: "top",
    offset: 4,
  });
  assert.equal(pos.placement, "top");
  assert.equal(pos.maxHeight, 200 - 8 - 4);
  assert.equal(pos.y, 8);
});

test("shifts left to stay inside the right edge", () => {
  const pos = computePosition(rect(950, 100, 40), menu, viewport, {
    placement: "bottom-start",
    padding: 8,
  });
  assert.equal(pos.x, 1000 - 8 - 200);
});

test("shifts right to stay inside the left edge", () => {
  const pos = computePosition(rect(10, 100, 40), menu, viewport, {
    placement: "bottom-end",
    padding: 8,
  });
  assert.equal(pos.x, 8);
});

test("boxes wider than the viewport pin to the left padding", () => {
  const pos = computePosition(rect(10, 100), { width: 1200, height: 100 }, viewport, {
    padding: 8,
  });
  assert.equal(pos.x, 8);
});

test("right flips to left near the right edge", () => {
  const pos = computePosition(rect(900, 100, 60), menu, viewport, {
    placement: "right-start",
    offset: 4,
  });
  assert.equal(pos.placement, "left-start");
  assert.equal(pos.x, 900 - 4 - 200);
  assert.equal(pos.y, 100);
});

test("side placements shift vertically into the viewport", () => {
  const pos = computePosition(rect(100, 780, 60, 20), menu, viewport, {
    placement: "right-start",
    padding: 8,
  });
  assert.equal(pos.y, 800 - 8 - 150);
});

test("returns whole pixels", () => {
  const pos = computePosition(rect(100.4, 100.6, 33, 30), { width: 51, height: 20 }, viewport, {
    placement: "bottom",
  });
  assert.equal(Number.isInteger(pos.x), true);
  assert.equal(Number.isInteger(pos.y), true);
});
