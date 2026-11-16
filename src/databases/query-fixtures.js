// @ts-check
import { createPrng } from "../lib/prng.js";
import { operatorsFor, runQuery, takesValue } from "./query.js";

/**
 * Random databases and queries with the answers this implementation gives,
 * for checking that the backend's SQL agrees (leaf-backend's
 * testdata/query-fixtures.json, written by query.test.js with
 * `LEAF_QUERY_FIXTURES=<path>`). Text is ASCII only: how Postgres lowercases
 * other letters depends on the database's locale.
 */

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").Filter} Filter */
/** @typedef {import("../api/types.js").FilterGroup} FilterGroup */
/** @typedef {import("../api/types.js").Sort} Sort */

const WORDS = [
  "Apple",
  "apple pie",
  "Banana",
  "band",
  "Cherry",
  "",
  "launch plan",
  "Launch",
  "zeta",
  "Alpha beta",
  "a",
];
const URLS = ["https://leaf.test/a", "https://Leaf.test/B", "http://example.com", ""];
const DATES = ["2026-01-01", "2026-02-28", "2026-10-13", "2025-12-31", "2026-10-14"];
const NUMBERS = [0, 1, -1, 2.5, 10, 100, -0.25, 3];
export const FIXTURE_MEMBERS = ["user_a", "user_b", "user_c"];

/** @type {Property[]} */
export const FIXTURE_SCHEMA = [
  { id: "title", name: "Name", type: "title" },
  { id: "text", name: "Notes", type: "text" },
  { id: "num", name: "Points", type: "number" },
  {
    id: "sel",
    name: "Priority",
    type: "select",
    options: [
      { id: "high", name: "High", color: "red" },
      { id: "low", name: "Low", color: "green" },
      { id: "mid", name: "Mid", color: "yellow" },
    ],
  },
  {
    id: "tags",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "t1", name: "One", color: "blue" },
      { id: "t2", name: "Two", color: "gray" },
      { id: "t3", name: "Three", color: "pink" },
    ],
  },
  {
    id: "status",
    name: "Status",
    type: "status",
    options: [
      { id: "s1", name: "Not started", color: "default", group: "to_do" },
      { id: "s2", name: "Doing", color: "blue", group: "in_progress" },
      { id: "s3", name: "Done", color: "green", group: "complete" },
    ],
  },
  { id: "due", name: "Due", type: "date" },
  { id: "who", name: "Assignee", type: "person" },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "link", name: "Link", type: "url" },
];

/**
 * @param {number} seed
 * @param {{ rows?: number, queries?: number }} [sizes]
 */
export function makeQueryFixture(seed, { rows: rowCount = 60, queries: queryCount = 150 } = {}) {
  const rng = createPrng(seed);
  /** @template T @param {readonly T[]} items @returns {T[]} */
  const subset = (items) => items.filter(() => rng.next() < 0.4);

  /** @param {Property} p */
  const randomValue = (p) => {
    if (rng.next() < 0.25) return undefined;
    switch (p.type) {
      case "text":
        return rng.pick(WORDS) || undefined;
      case "url":
        return rng.pick(URLS) || undefined;
      case "number":
        return rng.pick(NUMBERS);
      case "select":
      case "status":
        return rng.pick(p.options ?? []).id;
      case "multi_select": {
        const ids = subset((p.options ?? []).map((o) => o.id));
        return ids.length ? ids : undefined;
      }
      case "person": {
        const ids = subset(FIXTURE_MEMBERS);
        return ids.length ? ids : undefined;
      }
      case "date":
        return rng.pick(DATES);
      case "checkbox":
        return rng.next() < 0.5 ? true : undefined;
    }
    return undefined;
  };

  /** @type {Row[]} */
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    /** @type {Record<string, any>} */
    const properties = {};
    for (const p of FIXTURE_SCHEMA.slice(1)) {
      const value = randomValue(p);
      if (value !== undefined) properties[p.id] = value;
    }
    rows.push({
      id: `row_${String(i).padStart(3, "0")}`,
      database_id: "db",
      title: rng.next() < 0.15 ? "" : rng.pick(WORDS),
      icon: null,
      properties,
      // Increasing, as the server makes them when rows are added in order.
      position: `a${String(i).padStart(4, "0")}`,
      created_at: "2026-10-13T00:00:00.000Z",
      updated_at: "2026-10-13T00:00:00.000Z",
    });
  }

  /** @param {Property} p @returns {any} */
  const filterValue = (p) => {
    if (rng.next() < 0.08) return rng.next() < 0.5 && p.type !== "checkbox" ? "" : undefined;
    switch (p.type) {
      case "title":
      case "text":
        return rng.pick(["app", "AN", "launch", "a", "Banana", "zeta", "pie", "x"]);
      case "url":
        return rng.pick(["leaf", "HTTPS", "/b", "example.com"]);
      case "number":
        return rng.pick(NUMBERS);
      case "select":
      case "status":
      case "multi_select":
        return rng.pick([...(p.options ?? []).map((o) => o.id), "gone"]);
      case "person":
        return rng.pick(FIXTURE_MEMBERS);
      case "date":
        return rng.pick(DATES);
      case "checkbox":
        return rng.next() < 0.5;
    }
  };

  /** @param {number} depth @returns {Filter} */
  const randomFilter = (depth) => {
    if (depth > 0 && (depth >= 2 || rng.next() < 0.7)) {
      const p = rng.pick([
        ...FIXTURE_SCHEMA,
        /** @type {Property} */ ({ id: "deleted", name: "Gone", type: "text" }),
      ]);
      const operator = rng.pick(operatorsFor(/** @type {any} */ (p.type)));
      /** @type {any} */
      const condition = { property_id: p.id, operator };
      const value = takesValue(operator)
        ? filterValue(p.id === "deleted" ? FIXTURE_SCHEMA[1] : p)
        : undefined;
      if (value !== undefined) condition.value = value;
      return condition;
    }
    const items = Array.from({ length: 1 + rng.int(3) }, () => randomFilter(depth + 1));
    return rng.next() < 0.5 ? { and: items } : { or: items };
  };

  /** @returns {Sort[]} */
  const randomSorts = () => {
    const ids = subset(FIXTURE_SCHEMA.map((p) => p.id)).slice(0, 3);
    return ids.map((id) => ({
      property_id: id,
      direction: rng.next() < 0.5 ? "ascending" : "descending",
    }));
  };

  const queries = [];
  for (let i = 0; i < queryCount; i++) {
    const filter = rng.next() < 0.1 ? null : /** @type {FilterGroup} */ (randomFilter(0));
    const sorts = randomSorts();
    // A board column, now and then.
    /** @type {import("../api/types.js").RowGroup | null} */
    let group = null;
    if (rng.next() < 0.3) {
      const p = rng.pick(FIXTURE_SCHEMA.filter((x) => x.type === "select" || x.type === "status"));
      group = { property_id: p.id, value: rng.next() < 0.25 ? null : rng.pick(p.options ?? []).id };
    }
    const result = runQuery(rows, FIXTURE_SCHEMA, { filter, sorts, group, offset: 0, limit: 500 });
    queries.push({ filter, sorts, group, ids: result.rows.map((row) => row.id) });
  }
  return {
    seed,
    properties: FIXTURE_SCHEMA,
    members: FIXTURE_MEMBERS,
    rows: rows.map(({ id, title, properties }) => ({ id, title, properties })),
    queries,
  };
}
