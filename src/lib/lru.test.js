import assert from "node:assert/strict";
import test from "node:test";
import { LruCache } from "./lru.js";

test("drops the least recently used entry past the entry limit", () => {
  const cache = new LruCache({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // "a" is now the most recent
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("keeps the total size within the budget", () => {
  const cache = new LruCache({ maxSize: 10, sizeOf: (/** @type {string} */ v) => v.length });
  cache.set("a", "aaaa");
  cache.set("b", "bbbb");
  cache.set("c", "cccc");
  assert.equal(cache.has("a"), false);
  assert.equal(cache.size, 8);
  cache.set("b", "bb"); // replacing an entry updates the total
  assert.equal(cache.size, 6);
  assert.equal(cache.count, 2);
});

test("doesn't keep an entry larger than the whole budget", () => {
  const cache = new LruCache({ maxSize: 3, sizeOf: (/** @type {string} */ v) => v.length });
  cache.set("a", "aa");
  cache.set("b", "bbbb");
  assert.equal(cache.has("b"), false);
  assert.equal(cache.get("a"), "aa");
});

test("peek doesn't count as a use", () => {
  const cache = new LruCache({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.peek("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("a"), false);
});

test("delete and clear", () => {
  const cache = new LruCache({ sizeOf: () => 5 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.delete("a"), true);
  assert.equal(cache.delete("a"), false);
  assert.equal(cache.size, 5);
  cache.clear();
  assert.equal(cache.count, 0);
  assert.equal(cache.size, 0);
});
