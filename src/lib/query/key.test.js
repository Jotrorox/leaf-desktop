// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { hashKey, keyStartsWith } from "./key.js";

test("hashKey is structural: object key order doesn't matter", () => {
  assert.equal(
    hashKey(["a", { x: 1, y: { b: 2, a: 1 } }]),
    hashKey(["a", { y: { a: 1, b: 2 }, x: 1 }]),
  );
  assert.notEqual(hashKey(["a", 1]), hashKey(["a", "1"]));
  assert.notEqual(hashKey(["a", null]), hashKey(["a"]));
  assert.notEqual(hashKey(["a", ["b"]]), hashKey(["a", "b"]));
});

test("hashKey only accepts arrays", () => {
  assert.throws(() => hashKey(/** @type {any} */ ("page")), TypeError);
  assert.throws(() => hashKey(/** @type {any} */ ({ page: 1 })), TypeError);
});

test("keyStartsWith compares element by element", () => {
  assert.equal(keyStartsWith(["tree", "w1", "p1"], ["tree"]), true);
  assert.equal(keyStartsWith(["tree", "w1", "p1"], ["tree", "w1"]), true);
  assert.equal(keyStartsWith(["tree", "w1", "p1"], ["tree", "w1", "p1"]), true);
  assert.equal(keyStartsWith(["tree", "w1", "p1"], ["tree", "w2"]), false);
  assert.equal(keyStartsWith(["tree", "w1"], ["tree", "w1", "p1"]), false);
  assert.equal(keyStartsWith(["tree"], []), true);
  // Not a string prefix: "tree" doesn't start "trees".
  assert.equal(keyStartsWith(["trees"], ["tree"]), false);
  assert.equal(keyStartsWith(["a", { y: 1, x: 2 }, 3], ["a", { x: 2, y: 1 }]), true);
});
