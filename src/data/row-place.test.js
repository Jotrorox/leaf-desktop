// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { hashKey } from "../lib/query/key.js";
import { planPlacement } from "./row-place.js";

/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").RowPage} RowPage */

/** @param {string} id @param {string | undefined} status @returns {Row} */
const row = (id, status) => ({
  id,
  database_id: "db",
  title: id,
  icon: null,
  properties: status ? { status } : {},
  position: id,
  created_at: "",
  updated_at: "",
});

const table = { filter: null, sorts: [] };
/** @param {string | null} value */
const col = (value) => ({ filter: null, sorts: [], group: { property_id: "status", value } });

/**
 * A cache of row pages, and a way to apply a plan to it.
 * @param {[unknown, number, RowPage][]} entries
 */
function cache(entries) {
  const map = new Map(
    entries.map(([q, chunk, page]) => [
      hashKey(["rows", "db", q, chunk]),
      { key: ["rows", "db", q, chunk], page },
    ]),
  );
  return {
    keys: [...map.values()].map((e) => e.key),
    /** @param {readonly unknown[]} key */
    get: (key) => map.get(hashKey(key))?.page,
    /** @param {ReturnType<typeof planPlacement>} plan */
    apply(plan) {
      for (const { key, update } of plan) {
        const entry = /** @type {{ page: RowPage | undefined }} */ (map.get(hashKey(key)));
        entry.page = update(entry.page);
      }
    },
    /** @param {unknown} q @param {number} [chunk] */
    ids: (q, chunk = 0) => map.get(hashKey(["rows", "db", q, chunk]))?.page?.rows.map((r) => r.id),
    /** @param {unknown} q */
    total: (q) => map.get(hashKey(["rows", "db", q, 0]))?.page?.total,
  };
}

/** @param {string} status */
const setStatus = (status) => (/** @type {Row} */ r) => ({
  ...r,
  properties: { ...r.properties, status },
});

test("a card moved to another column leaves one and joins the other at its place", () => {
  const c = cache([
    [table, 0, { rows: [row("a", "todo"), row("b", "todo"), row("c", "done")], total: 3 }],
    [col("todo"), 0, { rows: [row("a", "todo"), row("b", "todo")], total: 2 }],
    [col("done"), 0, { rows: [row("c", "done")], total: 1 }],
    [col(null), 0, { rows: [], total: 0 }],
  ]);
  const plan = planPlacement({
    keys: c.keys,
    get: c.get,
    before: row("b", "todo"),
    change: setStatus("done"),
    target: { query: col("done"), index: 0 },
    chunkSize: 100,
  });
  c.apply(plan);
  assert.deepEqual(c.ids(col("todo")), ["a"]);
  assert.equal(c.total(col("todo")), 1);
  assert.deepEqual(c.ids(col("done")), ["b", "c"]);
  assert.equal(c.total(col("done")), 2);
  assert.deepEqual(c.ids(col(null)), []);
  // The table changes the row in place.
  assert.deepEqual(c.ids(table), ["a", "b", "c"]);
  assert.equal(c.get(["rows", "db", table, 0])?.rows[1].properties.status, "done");
  // Re-applied over data that already has it (the server's answer), nothing doubles.
  c.apply(plan);
  assert.deepEqual(c.ids(col("done")), ["b", "c"]);
});

test("reordering within a column", () => {
  const c = cache([
    [col("todo"), 0, { rows: [row("a", "todo"), row("b", "todo"), row("c", "todo")], total: 3 }],
  ]);
  c.apply(
    planPlacement({
      keys: c.keys,
      get: c.get,
      before: row("a", "todo"),
      change: (r) => r,
      target: { query: col("todo"), index: 2 },
      chunkSize: 100,
    }),
  );
  assert.deepEqual(c.ids(col("todo")), ["b", "c", "a"]);
  assert.equal(c.total(col("todo")), 3);
});

test("a value change without a target: leaves its column, joins the end of another if it's loaded", () => {
  const c = cache([
    [col("todo"), 0, { rows: [row("a", "todo"), row("b", "todo")], total: 2 }],
    [col("done"), 0, { rows: [row("c", "done")], total: 1 }],
    // Two chunks, the last not loaded: the row can't be placed, but counts.
    [col(null), 0, { rows: [row("x", undefined), row("y", undefined)], total: 3 }],
  ]);
  c.apply(
    planPlacement({
      keys: c.keys,
      get: c.get,
      before: row("a", "todo"),
      change: setStatus("done"),
      chunkSize: 2,
    }),
  );
  assert.deepEqual(c.ids(col("todo")), ["b"]);
  assert.deepEqual(c.ids(col("done")), ["c", "a"]);
  assert.equal(c.total(col("done")), 2);
  c.apply(
    planPlacement({
      keys: c.keys,
      get: c.get,
      before: row("b", "todo"),
      change: (r) => ({ ...r, properties: {} }),
      chunkSize: 2,
    }),
  );
  assert.deepEqual(c.ids(col(null)), ["x", "y"]);
  assert.equal(c.total(col(null)), 4);
});

test("a target past the first chunk lands in the right one", () => {
  const c = cache([
    [col("todo"), 0, { rows: [row("a", "todo"), row("b", "todo")], total: 4 }],
    [col("todo"), 1, { rows: [row("c", "todo"), row("d", "todo")], total: 4 }],
    [col("done"), 0, { rows: [row("z", "done")], total: 1 }],
  ]);
  c.apply(
    planPlacement({
      keys: c.keys,
      get: c.get,
      before: row("z", "done"),
      change: setStatus("todo"),
      target: { query: col("todo"), index: 3 },
      chunkSize: 2,
    }),
  );
  assert.deepEqual(c.ids(col("todo"), 1), ["c", "z", "d"]);
  assert.equal(c.total(col("todo")), 5);
  assert.deepEqual(c.ids(col("done")), []);
  assert.equal(c.total(col("done")), 0);
});
