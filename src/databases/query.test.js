// @ts-check

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkFilter,
  compareCodePoints,
  matchesFilter,
  parseFilter,
  pruneFilter,
  runQuery,
} from "./query.js";
import { makeQueryFixture } from "./query-fixtures.js";

// Structure cases are the backend's dbschema_test.go ones.

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Row} Row */

test("parseFilter checks the structure and returns it canonical", () => {
  const good = {
    and: [
      { property_id: "a", operator: "equals", value: 1 },
      { or: [{ property_id: "b", operator: "is_empty", value: null }, { and: [] }] },
    ],
  };
  assert.deepEqual(parseFilter(good), {
    and: [
      { property_id: "a", operator: "equals", value: 1 },
      { or: [{ property_id: "b", operator: "is_empty" }, { and: [] }] },
    ],
  });
  assert.equal(parseFilter(null), null);
  for (const bad of [
    [],
    { property_id: "a", operator: "equals" },
    { and: [], or: [] },
    { and: [{ and: [{ and: [{ and: [] }] }] }] },
    { and: [{ property_id: "a" }] },
    { and: [{ property_id: "a", operator: "equals", extra: 1 }] },
  ]) {
    assert.throws(() => parseFilter(bad), { code: "invalid_filter" }, JSON.stringify(bad));
  }
});

test("checkFilter validates against the schema and drops unknown properties", () => {
  /** @type {Property[]} */
  const schema = [
    { id: "title", name: "Name", type: "title" },
    { id: "n", name: "N", type: "number" },
    { id: "c", name: "C", type: "checkbox" },
  ];
  const check = (/** @type {unknown} */ raw) => checkFilter(parseFilter(raw), schema);
  assert.deepEqual(
    check({
      and: [
        { property_id: "gone", operator: "equals", value: "x" },
        { property_id: "n", operator: "greater_than", value: "" },
      ],
    }),
    { and: [{ property_id: "n", operator: "greater_than", value: "" }] },
  );
  for (const bad of [
    { and: [{ property_id: "n", operator: "contains", value: 1 }] },
    { and: [{ property_id: "n", operator: "equals", value: "x" }] },
    { and: [{ property_id: "c", operator: "is_empty" }] },
    { and: [{ property_id: "c", operator: "equals", value: "yes" }] },
  ]) {
    assert.throws(() => check(bad), { code: "invalid_filter" }, JSON.stringify(bad));
  }
});

test("pruneFilter drops a property's conditions and the groups left empty", () => {
  const filter = /** @type {any} */ ({
    or: [
      { property_id: "a", operator: "is_empty" },
      { and: [{ property_id: "a", operator: "is_empty" }] },
      { property_id: "b", operator: "is_empty" },
    ],
  });
  assert.deepEqual(pruneFilter(filter, "a"), { or: [{ property_id: "b", operator: "is_empty" }] });
});

/** @type {Property[]} */
const SCHEMA = [
  { id: "title", name: "Name", type: "title" },
  { id: "n", name: "N", type: "number" },
  {
    id: "s",
    name: "S",
    type: "select",
    options: [
      { id: "b", name: "B", color: "red" },
      { id: "a", name: "A", color: "red" },
    ],
  },
  { id: "c", name: "C", type: "checkbox" },
  { id: "t", name: "T", type: "text" },
];

/** @param {string} id @param {string} title @param {Record<string, any>} properties @returns {Row} */
const row = (id, title, properties) => ({
  id,
  database_id: "db",
  title,
  icon: null,
  properties,
  position: id,
  created_at: "",
  updated_at: "",
});

const ROWS = [
  row("r1", "Launch", { n: 3, s: "a", t: "Hello" }),
  row("r2", "", { n: -1, c: true }),
  row("r3", "lunch", { s: "b" }),
];

/** @param {unknown} filter */
const ids = (filter, sorts = /** @type {any[]} */ ([])) =>
  runQuery(ROWS, SCHEMA, { filter: parseFilter(filter), sorts }).rows.map((r) => r.id);

test("empty cells match only is_empty and the negative operators", () => {
  assert.deepEqual(ids({ and: [{ property_id: "t", operator: "does_not_contain", value: "x" }] }), [
    "r1",
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "t", operator: "contains", value: "ELL" }] }), [
    "r1",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "n", operator: "does_not_equal", value: 3 }] }), [
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "n", operator: "less_than", value: 5 }] }), [
    "r1",
    "r2",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "title", operator: "is_empty" }] }), ["r2"]);
  assert.deepEqual(ids({ and: [{ property_id: "s", operator: "does_not_equal", value: "a" }] }), [
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "c", operator: "equals", value: false }] }), [
    "r1",
    "r3",
  ]);
});

test("a condition without a value, or on a deleted property, matches everything", () => {
  assert.deepEqual(ids({ and: [{ property_id: "t", operator: "contains", value: "" }] }), [
    "r1",
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "n", operator: "greater_than" }] }), [
    "r1",
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ and: [{ property_id: "gone", operator: "contains", value: "x" }] }), [
    "r1",
    "r2",
    "r3",
  ]);
  assert.deepEqual(ids({ or: [] }), ["r1", "r2", "r3"]);
});

test("and and or nest", () => {
  const filter = {
    or: [
      { property_id: "title", operator: "starts_with", value: "la" },
      {
        and: [
          { property_id: "c", operator: "equals", value: true },
          { property_id: "n", operator: "less_than", value: 0 },
        ],
      },
    ],
  };
  assert.deepEqual(ids(filter), ["r1", "r2"]);
  assert.equal(matchesFilter(ROWS[2], parseFilter(filter), SCHEMA), false);
});

test("sorts put empty values last both ways, select by option order, then position", () => {
  assert.deepEqual(ids(null, [{ property_id: "n", direction: "ascending" }]), ["r2", "r1", "r3"]);
  assert.deepEqual(ids(null, [{ property_id: "n", direction: "descending" }]), ["r1", "r2", "r3"]);
  // Option order: b before a.
  assert.deepEqual(ids(null, [{ property_id: "s", direction: "ascending" }]), ["r3", "r1", "r2"]);
  assert.deepEqual(ids(null, [{ property_id: "title", direction: "descending" }]), [
    "r3",
    "r1",
    "r2",
  ]);
  assert.deepEqual(ids(null, [{ property_id: "c", direction: "descending" }]), ["r2", "r1", "r3"]);
  assert.deepEqual(ids(null, [{ property_id: "gone", direction: "descending" }]), [
    "r1",
    "r2",
    "r3",
  ]);
});

test("runQuery pages through the matches and counts them all", () => {
  const page = runQuery(ROWS, SCHEMA, { filter: null, sorts: [], offset: 1, limit: 1 });
  assert.deepEqual(
    page.rows.map((r) => r.id),
    ["r2"],
  );
  assert.equal(page.total, 3);
});

test("compareCodePoints orders like UTF-8 bytes", () => {
  assert.equal(compareCodePoints("a", "b"), -1);
  assert.equal(compareCodePoints("ab", "a"), 1);
  assert.equal(compareCodePoints("", ""), 0);
  // U+FF5E sorts before U+1F600, though its UTF-16 unit is larger than the surrogate's.
  assert.equal(compareCodePoints("～", "😀"), -1);
  assert.equal("～" < "😀", false);
});

test("random queries are self-consistent, and can be written for the backend", () => {
  for (const seed of [1, 2, 3]) {
    const fixture = makeQueryFixture(seed);
    for (const query of fixture.queries) {
      assert.ok(query.ids.length <= fixture.rows.length);
      assert.equal(new Set(query.ids).size, query.ids.length);
    }
  }
  const path = process.env.LEAF_QUERY_FIXTURES;
  if (path)
    writeFileSync(path, `${JSON.stringify([1, 2, 3].map((seed) => makeQueryFixture(seed)))}\n`);
});
