// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { spatialMove } from "./grid-nav.js";

/**
 * Lays out items in rows of 32px cells.
 * @param {number[]} rowLengths
 */
function layout(rowLengths) {
  /** @type {{ x: number, y: number, width: number }[]} */
  const rects = [];
  rowLengths.forEach((length, row) => {
    for (let col = 0; col < length; col++) rects.push({ x: col * 32, y: row * 40, width: 32 });
  });
  return rects;
}

// A uniform grid, 4 wide:
//  0 1 2 3
//  4 5 6 7
//  8 9
const grid = layout([4, 4, 2]);

test("left and right step in DOM order and stop at the ends", () => {
  assert.equal(spatialMove(grid, 3, "ArrowRight"), 4);
  assert.equal(spatialMove(grid, 4, "ArrowLeft"), 3);
  assert.equal(spatialMove(grid, 0, "ArrowLeft"), 0);
  assert.equal(spatialMove(grid, 9, "ArrowRight"), 9);
});

test("up and down go to the closest item in the next row", () => {
  assert.equal(spatialMove(grid, 1, "ArrowDown"), 5);
  assert.equal(spatialMove(grid, 5, "ArrowDown"), 9);
  assert.equal(spatialMove(grid, 7, "ArrowDown"), 9, "short row: the nearest item");
  assert.equal(spatialMove(grid, 9, "ArrowUp"), 5);
  assert.equal(spatialMove(grid, 8, "ArrowDown"), 8, "bottom row stays");
  assert.equal(spatialMove(grid, 2, "ArrowUp"), -1, "top row leaves the grid");
});

test("rows of different lengths (groups starting new rows)", () => {
  // Group A: 0 1 2 | Group B: 3 4 5 6 (each group starts a row)
  const grouped = layout([3, 4]).map((rect, i) => (i >= 3 ? { ...rect, y: rect.y + 24 } : rect));
  assert.equal(spatialMove(grouped, 2, "ArrowDown"), 5);
  assert.equal(spatialMove(grouped, 6, "ArrowUp"), 2);
  assert.equal(spatialMove(grouped, 0, "ArrowDown"), 3);
});

test("Home, End, other keys, an empty list and a bad index", () => {
  assert.equal(spatialMove(grid, 6, "Home"), 0);
  assert.equal(spatialMove(grid, 1, "End"), 9);
  assert.equal(spatialMove(grid, 1, "a"), null);
  assert.equal(spatialMove([], 0, "ArrowDown"), null);
  assert.equal(spatialMove(grid, -1, "ArrowDown"), null);
});
