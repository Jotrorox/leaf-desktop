// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardColumns,
  cardProperties,
  columnName,
  columnOf,
  dropCard,
  NO_VALUE,
  placeId,
  withCardProperty,
  withHiddenGroup,
} from "./board.js";
import { matchesGroup, parseGroup, runQuery } from "./query.js";
import {
  defaultGroupBy,
  fitSchema,
  newView,
  parseCardProperties,
  parseGroupBy,
  parseHiddenGroups,
  withDefaults,
} from "./views.js";

// Board rules; the backend's boards_test.go checks the same ones.

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Row} Row */

/** @type {Property[]} */
const SCHEMA = [
  { id: "title", name: "Name", type: "title" },
  {
    id: "prio",
    name: "Priority",
    type: "select",
    options: [
      { id: "hi", name: "High", color: "red" },
      { id: "lo", name: "Low", color: "gray" },
    ],
  },
  {
    id: "status",
    name: "Status",
    type: "status",
    options: [
      { id: "todo", name: "To do", color: "default", group: "to_do" },
      { id: "doing", name: "Doing", color: "blue", group: "in_progress" },
      { id: "done", name: "Done", color: "green", group: "complete" },
    ],
  },
  { id: "tags", name: "Tags", type: "multi_select", options: [] },
  { id: "due", name: "Due", type: "date" },
];

/** @param {string} id @param {Record<string, any>} properties @returns {Row} */
const row = (id, properties) => ({
  id,
  database_id: "db",
  title: id,
  icon: null,
  properties,
  position: id,
  created_at: "",
  updated_at: "",
});

test("a board groups by the first status, else the first select", () => {
  assert.equal(defaultGroupBy(SCHEMA), "status");
  assert.equal(defaultGroupBy(SCHEMA.filter((p) => p.type !== "status")), "prio");
  assert.equal(defaultGroupBy([SCHEMA[0], SCHEMA[3]]), null);
});

test("board settings are checked like the server checks them", () => {
  assert.equal(parseGroupBy("prio", SCHEMA), "prio");
  assert.equal(parseGroupBy(null, SCHEMA), null);
  assert.equal(parseGroupBy("gone", SCHEMA), null);
  assert.throws(() => parseGroupBy("tags", SCHEMA), { code: "invalid_view" });
  assert.throws(() => parseGroupBy(5, SCHEMA), { code: "invalid_view" });
  assert.deepEqual(parseCardProperties(["status", "title", "gone", "status", "prio"], SCHEMA), [
    "status",
    "prio",
  ]);
  assert.throws(() => parseCardProperties("status", SCHEMA), { code: "invalid_view" });
  assert.deepEqual(parseHiddenGroups(["lo", "", "nope", "lo"], SCHEMA[1]), ["lo", ""]);
  assert.deepEqual(parseHiddenGroups(["lo"], undefined), []);
});

test("views saved before boards get empty board settings", () => {
  const old = /** @type {any} */ ({
    id: "v",
    name: "Old",
    type: "table",
    position: "a0",
    filter: null,
    sorts: [],
    columns: [],
  });
  assert.deepEqual(withDefaults(old), {
    ...old,
    group_by: null,
    card_properties: [],
    hidden_groups: [],
  });
});

test("schema changes keep a board's settings valid", () => {
  const view = {
    ...newView("b", "Board", "board", "a0"),
    group_by: "status",
    card_properties: ["prio", "tags"],
    hidden_groups: ["todo", "gone", ""],
  };
  const fit = fitSchema(view, SCHEMA);
  assert.deepEqual(fit.hidden_groups, ["todo", ""]);
  const noTags = fitSchema(
    view,
    SCHEMA.filter((p) => p.id !== "tags"),
  );
  assert.deepEqual(noTags.card_properties, ["prio"]);
  const statusAsText = SCHEMA.map((p) =>
    p.id === "status" ? { id: "status", name: "Status", type: /** @type {const} */ ("text") } : p,
  );
  const lost = fitSchema(view, statusAsText);
  assert.equal(lost.group_by, null);
  assert.deepEqual(lost.hidden_groups, []);
});

test("columns: no value first, then the options, some hidden", () => {
  const view = {
    ...newView("b", "Board", "board", "a0"),
    group_by: "status",
    hidden_groups: ["done"],
  };
  const columns = boardColumns(view, SCHEMA);
  assert.deepEqual(
    columns.map((c) => [c.id, c.hidden]),
    [
      [NO_VALUE, false],
      ["todo", false],
      ["doing", false],
      ["done", true],
    ],
  );
  assert.equal(columnName(SCHEMA[2], columns[0]), "No Status");
  assert.equal(columnName(SCHEMA[2], columns[1]), "To do");
  assert.deepEqual(boardColumns({ ...view, group_by: "tags" }, SCHEMA), []);
  assert.deepEqual(boardColumns({ ...view, group_by: null }, SCHEMA), []);
  assert.equal(columnOf(row("a", { status: "doing" }), SCHEMA[2]), "doing");
  assert.equal(columnOf(row("a", { status: "gone" }), SCHEMA[2]), NO_VALUE);
  assert.equal(columnOf(row("a", {}), SCHEMA[2]), NO_VALUE);
});

test("card properties and hidden groups toggle", () => {
  const view = {
    ...newView("b", "Board", "board", "a0"),
    group_by: "status",
    card_properties: ["due", "gone"],
  };
  assert.deepEqual(
    cardProperties(view, SCHEMA).map((p) => p.id),
    ["due"],
  );
  assert.deepEqual(withCardProperty(view, "prio", true), ["due", "gone", "prio"]);
  assert.deepEqual(withCardProperty(view, "due", false), ["gone"]);
  assert.deepEqual(withHiddenGroup(view, "", true), [""]);
  assert.deepEqual(withHiddenGroup({ ...view, hidden_groups: ["", "x"] }, "", false), ["x"]);
});

test("dropping a card: where it goes in the manual order and which column", () => {
  const ids = ["a", "b", "c", "d"];
  const same = { ids, cardId: "b", from: "x", to: "x", sorted: false };
  // The gaps next to itself change nothing.
  assert.equal(dropCard({ ...same, index: 1 }), null);
  assert.equal(dropCard({ ...same, index: 2 }), null);
  assert.deepEqual(dropCard({ ...same, index: 0 }), { after: null, index: 0 });
  assert.deepEqual(dropCard({ ...same, index: 3 }), { after: "c", index: 2 });
  assert.deepEqual(dropCard({ ...same, index: 4 }), { after: "d", index: 3 });
  // Into another column.
  const other = { ids, cardId: "z", from: "y", to: "x", sorted: false };
  assert.deepEqual(dropCard({ ...other, index: 0 }), { after: null, index: 0, to: "x" });
  assert.deepEqual(dropCard({ ...other, index: 2 }), { after: "b", index: 2, to: "x" });
  assert.deepEqual(dropCard({ ...other, ids: [], index: 0 }), { after: null, index: 0, to: "x" });
  // Sorted: only the column changes.
  assert.equal(dropCard({ ...same, index: 0, sorted: true }), null);
  assert.deepEqual(dropCard({ ...other, index: 2, sorted: true }), { to: "x", index: 2 });
  assert.deepEqual(placeId(ids, "b", 2), ["a", "c", "b", "d"]);
  assert.deepEqual(placeId(ids, "z", 0), ["z", "a", "b", "c", "d"]);
  assert.deepEqual(placeId(ids, "a", 9), ["b", "c", "d", "a"]);
});

test("a query's group narrows rows to one column", () => {
  const rows = [
    row("r1", { status: "todo" }),
    row("r2", { status: "doing" }),
    row("r3", { status: "todo", prio: "lo" }),
    row("r4", {}),
  ];
  const ids = (/** @type {any} */ group) => runQuery(rows, SCHEMA, { group }).rows.map((r) => r.id);
  assert.deepEqual(ids({ property_id: "status", value: "todo" }), ["r1", "r3"]);
  assert.deepEqual(ids({ property_id: "status", value: null }), ["r4"]);
  assert.deepEqual(ids({ property_id: "prio", value: null }), ["r1", "r2", "r4"]);
  assert.equal(
    matchesGroup(row("x", { status: "" }), { property_id: "status", value: null }),
    true,
  );
  assert.deepEqual(parseGroup({ property_id: "status", value: "todo" }, SCHEMA), {
    property_id: "status",
    value: "todo",
  });
  assert.deepEqual(parseGroup({ property_id: "status" }, SCHEMA), {
    property_id: "status",
    value: null,
  });
  assert.equal(parseGroup(null, SCHEMA), null);
  for (const bad of [
    [],
    { value: "x" },
    { property_id: "status", value: 3 },
    { property_id: "status", value: "" },
    { property_id: "tags", value: null },
    { property_id: "gone" },
  ]) {
    assert.throws(() => parseGroup(bad, SCHEMA), { code: "invalid_query" }, JSON.stringify(bad));
  }
});
