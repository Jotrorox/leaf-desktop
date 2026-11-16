// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidKey, keyBetween, nKeysBetween } from "./fractional-index.js";
import { createPrng } from "./prng.js";

/** @param {string[]} keys */
function assertAscending(keys) {
  for (let i = 1; i < keys.length; i++) {
    assert.ok(
      keys[i - 1] < keys[i],
      `keys[${i - 1}] "${keys[i - 1]}" should sort before keys[${i}] "${keys[i]}"`,
    );
  }
}

test("the first key, appends and prepends", () => {
  assert.equal(keyBetween(null, null), "a0");
  assert.equal(keyBetween("a0", null), "a1");
  assert.equal(keyBetween("a1", null), "a2");
  assert.equal(keyBetween(null, "a0"), "Zz");
  assert.equal(keyBetween(null, "Zz"), "Zy");
});

test("integer parts roll over to the next length", () => {
  assert.equal(keyBetween("az", null), "b00");
  assert.equal(keyBetween("b0z", null), "b10");
  assert.equal(keyBetween(null, "b00"), "az");
  assert.equal(keyBetween("Zz", null), "a0");
  assert.equal(keyBetween(null, "Z0"), "Yzz");
});

test("between two keys", () => {
  assert.equal(keyBetween("a0", "a1"), "a0V");
  assert.equal(keyBetween("a0", "a2"), "a1");
  assert.equal(keyBetween("a0V", "a1"), "a0l");
  assert.equal(keyBetween("a0", "a0V"), "a0G");
  assert.equal(keyBetween("a1", "a1V"), "a1G");
  assert.equal(keyBetween("Zz", "a01"), "a0");
  assert.equal(keyBetween("a0", "b00"), "a1");
});

test("prepending before a key with a fraction returns its bare integer part", () => {
  assert.equal(keyBetween(null, "a0V"), "a0");
  assert.ok("a0" < "a0V");
});

test("results are always strictly between and valid", () => {
  const cases = /** @type {[string | null, string | null][]} */ ([
    [null, null],
    ["a0", null],
    [null, "a0"],
    ["a0", "a1"],
    ["a0", "a01"],
    ["a0z", "a1"],
    ["Zz", "a0"],
    ["a0V", "a0W"],
    ["a0Vzzz", "a0W"],
    ["a0", "a00001"],
  ]);
  for (const [a, b] of cases) {
    const key = keyBetween(a, b);
    assert.ok(isValidKey(key), `"${key}" should be valid`);
    if (a !== null) assert.ok(a < key, `"${a}" < "${key}"`);
    if (b !== null) assert.ok(key < b, `"${key}" < "${b}"`);
  }
});

test("rejects bad input", () => {
  assert.throws(() => keyBetween("a1", "a0"), RangeError);
  assert.throws(() => keyBetween("a1", "a1"), RangeError);
  assert.throws(() => keyBetween("a10", null), TypeError, "trailing zero in the fraction");
  assert.throws(() => keyBetween("", null), TypeError);
  assert.throws(() => keyBetween("b0", null), TypeError, "integer part too short");
  assert.throws(() => keyBetween("a!", null), TypeError);
  assert.throws(
    () => keyBetween(`A${"0".repeat(26)}`, null),
    TypeError,
    "the smallest integer alone isn't a key",
  );
});

test("isValidKey", () => {
  assert.equal(isValidKey("a0"), true);
  assert.equal(isValidKey("a0V"), true);
  assert.equal(isValidKey("Zz"), true);
  assert.equal(isValidKey("b00"), true);
  assert.equal(isValidKey("a0V0"), false);
  assert.equal(isValidKey("a"), false);
  assert.equal(isValidKey("0a"), false);
  assert.equal(isValidKey(42), false);
  assert.equal(isValidKey(null), false);
});

test("10,000 appends stay short and ordered", () => {
  /** @type {string[]} */
  const keys = [];
  let last = /** @type {string | null} */ (null);
  for (let i = 0; i < 10_000; i++) keys.push((last = keyBetween(last, null)));
  assertAscending(keys);
  assert.ok(
    /** @type {string} */ (last).length <= 4,
    `last key "${last}" should be at most 4 characters`,
  );
});

test("10,000 prepends stay short and ordered", () => {
  /** @type {string[]} */
  const keys = [];
  let first = /** @type {string | null} */ (null);
  for (let i = 0; i < 10_000; i++) keys.unshift((first = keyBetween(null, first)));
  assertAscending(keys);
  assert.ok(/** @type {string} */ (first).length <= 4);
});

test("1,000 inserts in a row at the same spot keep order, uniqueness and modest length", () => {
  // Always insert right after "a0", i.e. between "a0" and the previous insert:
  // the worst case, since the gap halves every time.
  const lower = "a0";
  const upper = "a1";
  /** @type {string[]} */
  const inserted = [];
  let bound = upper;
  for (let i = 0; i < 1000; i++) {
    const key = keyBetween(lower, bound);
    assert.ok(lower < key && key < bound);
    inserted.push(key);
    bound = key;
  }
  assert.equal(new Set(inserted).size, inserted.length);
  assertAscending([lower, ...inserted.reverse(), upper]);
  // About one character per ~6 inserts (log2(62) ≈ 5.95 bits per character).
  const longest = Math.max(...inserted.map((key) => key.length));
  assert.ok(longest <= 2 + Math.ceil(1000 / 5), `longest key is ${longest} characters`);
});

test("1,000 inserts in a row just before the same item", () => {
  // Insert directly above "a1" every time: between the previous insert and "a1".
  let lower = "a0";
  /** @type {string[]} */
  const inserted = [];
  for (let i = 0; i < 1000; i++) {
    const key = keyBetween(lower, "a1");
    inserted.push(key);
    lower = key;
  }
  assertAscending(["a0", ...inserted, "a1"]);
  assert.equal(new Set(inserted).size, 1000);
});

test("alternating inserts at the same spot", () => {
  // Like typing "insert above, insert below" around one item.
  let low = "a0";
  let high = "a1";
  /** @type {string[]} */
  const all = [low, high];
  for (let i = 0; i < 500; i++) {
    const key = keyBetween(low, high);
    all.push(key);
    if (i % 2) low = key;
    else high = key;
  }
  all.sort();
  assert.equal(new Set(all).size, all.length);
  assertAscending(all);
});

test("random inserts into a list keep it sorted (seeded fuzz)", () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    const random = createPrng(seed);
    /** @type {string[]} */
    const list = [];
    for (let i = 0; i < 2000; i++) {
      const index = random.int(list.length + 1);
      const key = keyBetween(list[index - 1] ?? null, list[index] ?? null);
      list.splice(index, 0, key);
    }
    assertAscending(list);
    assert.ok(list.every(isValidKey), `seed ${seed}: every key is valid`);
  }
});

test("nKeysBetween returns n ascending keys inside the bounds", () => {
  assert.deepEqual(nKeysBetween(null, null, 0), []);
  assert.deepEqual(nKeysBetween(null, null, 1), ["a0"]);
  assert.deepEqual(nKeysBetween(null, null, 3), ["a0", "a1", "a2"]);
  assert.deepEqual(nKeysBetween(null, "a0", 3), ["Zx", "Zy", "Zz"]);

  for (const [a, b, n] of /** @type {[string | null, string | null, number][]} */ ([
    ["a0", "a1", 10],
    ["a0", "a1", 100],
    ["a0", null, 50],
    [null, "a0", 50],
    ["a0V", "a0W", 25],
  ])) {
    const keys = nKeysBetween(a, b, n);
    assert.equal(keys.length, n);
    assertAscending([...(a ? [a] : []), ...keys, ...(b ? [b] : [])]);
    assert.ok(keys.every(isValidKey));
  }
});

test("nKeysBetween spreads keys out instead of crowding one end", () => {
  const keys = nKeysBetween("a0", "a1", 100);
  // Bisection keeps every key short; inserting one after another would reach ~20 characters.
  assert.ok(Math.max(...keys.map((key) => key.length)) <= 5);
});

test("nKeysBetween rejects a bad count", () => {
  assert.throws(() => nKeysBetween(null, null, -1), RangeError);
  assert.throws(() => nKeysBetween(null, null, 1.5), RangeError);
});
