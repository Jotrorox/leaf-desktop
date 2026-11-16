// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrng } from "../../lib/prng.js";
import { Item, newRegister, SEQ_TEXT, Sequence, writeRegister } from "./sequence.js";

/**
 * Build items for one replica's view of a sequence. Inserting the same items
 * in any causal order must give the same list.
 *
 * @param {[client: number, clock: number, origin: [number, number] | null, ch: string][]} specs
 */
function build(specs) {
  const seq = new Sequence(SEQ_TEXT, null);
  /** @type {Map<string, Item>} */
  const byId = new Map();
  for (const [client, clock, origin, ch] of specs) {
    const o = origin ? /** @type {Item} */ (byId.get(origin.join(":"))) : null;
    const item = new Item(client, clock, seq, o, ch);
    seq.integrate(item);
    byId.set(`${client}:${clock}`, item);
  }
  return seq;
}

test("concurrent inserts at the same spot order newest first, the same everywhere", () => {
  // Both insert after "a" (1:1). Client 2's op has the same clock but a
  // larger client id, so it's newer and goes first.
  /** @typedef {[client: number, clock: number, origin: [number, number] | null, ch: string]} Spec */
  /** @type {Spec} */
  const base = [1, 1, null, "a"];
  /** @type {Spec} */
  const x = [1, 2, [1, 1], "x"];
  /** @type {Spec} */
  const y = [2, 2, [1, 1], "y"];
  assert.equal(build([base, x, y]).toString(), "ayx");
  assert.equal(build([base, y, x]).toString(), "ayx");
});

test("runs typed concurrently at the same spot don't interleave", () => {
  const base = /** @type {[number, number, [number, number] | null, string]} */ ([1, 1, null, "_"]);
  /** @param {number} client @param {number} start @param {string} s */
  const run = (client, start, s) =>
    [...s].map(
      (ch, i) =>
        /** @type {[number, number, [number, number] | null, string]} */ ([
          client,
          start + i,
          i === 0 ? [1, 1] : [client, start + i - 1],
          ch,
        ]),
    );
  const a = run(2, 2, "hello");
  const b = run(3, 2, "WORLD");
  const rng = createPrng(1);
  /** @type {Set<string>} */
  const results = new Set();
  for (let trial = 0; trial < 50; trial++) {
    // Random interleaving of the two runs, each kept in its own order (causal).
    const ia = [...a];
    const ib = [...b];
    const order = [base];
    while (ia.length || ib.length) {
      if (ib.length === 0 || (ia.length && rng.next() < 0.5))
        order.push(/** @type {any} */ (ia.shift()));
      else order.push(/** @type {any} */ (ib.shift()));
    }
    results.add(build(order).toString());
  }
  assert.deepEqual([...results], ["_WORLDhello"]);
});

test("an item lands after its origin's newer descendants", () => {
  // a; b and c both typed after a (c newer); d typed after c; then e (older
  // than c, newer than b) after a. e must go after c's subtree, before b.
  const seq = build([
    [1, 1, null, "a"],
    [1, 2, [1, 1], "b"],
    [2, 5, [1, 1], "c"],
    [2, 6, [2, 5], "d"],
    [3, 3, [1, 1], "e"],
  ]);
  assert.equal(seq.toString(), "acdeb");
});

test("tombstones keep their place; length counts visible items", () => {
  const seq = build([
    [1, 1, null, "a"],
    [1, 2, [1, 1], "b"],
    [1, 3, [1, 2], "c"],
  ]);
  const b = /** @type {Item} */ (seq.itemAt(1));
  assert.equal(b.content, "b");
  assert.equal(seq.delete(b), true);
  assert.equal(seq.delete(b), false);
  assert.equal(seq.length, 2);
  assert.equal(seq.toString(), "ac");
  // Inserting after the tombstone puts the item where "b" was.
  const x = new Item(2, 4, seq, b, "x");
  seq.integrate(x);
  assert.equal(seq.toString(), "axc");
  assert.equal(seq.indexOf(x), 1);
  assert.equal(seq.indexOf(b), 1);
});

test("itemAt walks from a cached position in both directions", () => {
  const seq = new Sequence(SEQ_TEXT, null);
  /** @type {Item | null} */
  let prev = null;
  for (let i = 0; i < 100; i++) {
    /** @type {Item} */
    const it = new Item(1, i + 1, seq, prev, String(i % 10));
    seq.integrate(it);
    prev = it;
  }
  for (const i of [50, 51, 49, 99, 0, 98, 1, 75])
    assert.equal(/** @type {Item} */ (seq.itemAt(i)).clock, i + 1);
  assert.equal(seq.itemAt(100), null);
  assert.equal(seq.itemAt(-1), null);
  for (let i = 0; i < 100; i += 7)
    assert.equal(seq.indexOf(/** @type {Item} */ (seq.itemAt(i))), i);
});

test("registers: newest write wins, ties broken by client", () => {
  const r = newRegister();
  assert.equal(writeRegister(r, "a", 1, 5), true);
  assert.equal(writeRegister(r, "b", 1, 4), false);
  assert.equal(writeRegister(r, "c", 2, 5), true);
  assert.equal(writeRegister(r, "d", 1, 5), false);
  assert.equal(writeRegister(r, "e", 2, 5), false, "same id is idempotent");
  assert.equal(r.value, "c");
});
