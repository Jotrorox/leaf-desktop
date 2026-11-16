// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "./db.js";
import { createMockServer } from "./server.js";

// Board views in the mock backend: the same cases as the backend's
// boards_test.go (docs/databases.md, Section 3.1).

const WS = "ws";
const STATUS_OPTIONS = [
  { id: "todo", name: "To do", color: "default", group: "to_do" },
  { id: "doing", name: "Doing", color: "blue", group: "in_progress" },
  { id: "done", name: "Done", color: "green", group: "complete" },
];

/**
 * A database with a select ("prio"), a status ("status") and five rows:
 * r1 todo, r2 doing, r3 todo, r4 none, r5 done.
 * @param {{ role?: () => import("../roles.js").Role }} [options]
 */
function boardDb(options = {}) {
  let ids = 0;
  const db = createDb(
    { workspaces: [{ id: WS, name: "Mock" }], pages: [] },
    { newId: () => `gen_${++ids}`, ...options },
  );
  db.createPage({ id: "db", workspace_id: WS, title: "Tasks", kind: "database" });
  db.addProperty("db", {
    id: "prio",
    name: "Priority",
    type: "select",
    options: [
      { id: "hi", name: "High", color: "red" },
      { id: "lo", name: "Low", color: "gray" },
    ],
  });
  db.addProperty("db", { id: "status", name: "Status", type: "status", options: STATUS_OPTIONS });
  db.createRow("db", { id: "r1", title: "One", properties: { status: "todo" } });
  db.createRow("db", { id: "r2", title: "Two", properties: { status: "doing", prio: "hi" } });
  db.createRow("db", { id: "r3", title: "Three", properties: { status: "todo", prio: "lo" } });
  db.createRow("db", { id: "r4", title: "Four" });
  db.createRow("db", { id: "r5", title: "Five", properties: { status: "done" } });
  return db;
}

/** @param {ReturnType<typeof boardDb>} db @param {string} property @param {string | null} value @param {any[]} [sorts] */
function column(db, property, value, sorts = []) {
  const page = db.queryRows("db", { group: { property_id: property, value }, sorts, limit: 500 });
  assert.equal(page.total, page.rows.length);
  return page.rows.map((r) => r.id);
}

/** @param {() => unknown} fn @param {number} status @param {string} code */
function assertApiError(fn, status, code) {
  assert.throws(fn, (/** @type {any} */ err) => err.status === status && err.code === code);
}

test("board views group by a select or status", () => {
  const db = boardDb();
  const board = db.createView("db", { id: "b", type: "board" });
  assert.equal(board.type, "board");
  assert.equal(board.name, "Board");
  assert.equal(board.group_by, "status");
  assert.deepEqual([board.card_properties, board.hidden_groups], [[], []]);
  const table = db.createView("db", { id: "t" });
  assert.equal(table.type, "table");
  assert.equal(table.group_by, null);
  const switched = db.updateView("db", "t", { type: "board" });
  assert.deepEqual([switched.type, switched.group_by], ["board", "status"]);
  assertApiError(() => db.updateView("db", "t", { type: "calendar" }), 400, "invalid_view");

  const v = db.updateView("db", "b", {
    group_by: "prio",
    card_properties: ["status", "title", "gone", "status", "prio"],
    hidden_groups: ["lo", "", "nope", "lo"],
  });
  assert.equal(v.group_by, "prio");
  assert.deepEqual(v.card_properties, ["status", "prio"]);
  assert.deepEqual(v.hidden_groups, ["lo", ""]);
  assertApiError(() => db.updateView("db", "b", { group_by: "tags" }), 400, "invalid_view");
  assertApiError(() => db.updateView("db", "b", { group_by: 5 }), 400, "invalid_view");
  assert.deepEqual(db.updateView("db", "b", { group_by: "status" }).hidden_groups, []);
  assert.equal(db.updateView("db", "b", { group_by: "gone" }).group_by, null);
});

test("schema changes keep boards valid", () => {
  const db = boardDb();
  db.createView("db", {
    id: "b",
    type: "board",
    card_properties: ["prio", "tags"],
    hidden_groups: ["todo", "done", ""],
  });
  const board = () =>
    /** @type {import("../types.js").View} */ (
      db.getDatabase("db").views.find((v) => v.id === "b")
    );
  db.updateProperty("db", "status", { options: STATUS_OPTIONS.slice(0, 2) });
  assert.deepEqual(board().hidden_groups, ["todo", ""]);
  db.updateProperty("db", "status", { type: "select" });
  assert.equal(board().group_by, "status");
  assert.equal(board().hidden_groups.length, 2);
  db.updateProperty("db", "status", { type: "text" });
  assert.equal(board().group_by, null);
  assert.deepEqual(board().hidden_groups, []);
  db.deleteProperty("db", "tags");
  assert.deepEqual(board().card_properties, ["prio"]);
  db.updateView("db", "b", { group_by: "prio" });
  db.deleteProperty("db", "prio");
  assert.equal(board().group_by, null);
  assert.deepEqual(board().card_properties, []);
});

test("views stored before boards read with empty board settings", () => {
  const db = createDb({
    workspaces: [{ id: WS, name: "Mock" }],
    pages: [
      {
        id: "db",
        workspace_id: WS,
        parent_id: null,
        title: "",
        icon: null,
        cover: null,
        position: "a0",
        archived_at: null,
        trash_root: null,
        created_at: "",
        updated_at: "",
        kind: "database",
      },
    ],
    databases: {
      db: {
        properties: [{ id: "title", name: "Name", type: "title" }],
        views: [
          /** @type {any} */ ({
            id: "v",
            name: "Old",
            type: "table",
            position: "a0",
            filter: null,
            sorts: [],
            columns: [],
          }),
        ],
      },
    },
  });
  const [view] = db.getDatabase("db").views;
  assert.deepEqual([view.group_by, view.card_properties, view.hidden_groups], [null, [], []]);
  assert.equal(db.updateView("db", "v", { type: "board" }).group_by, null);
});

test("group queries are board columns", () => {
  const db = boardDb();
  assert.deepEqual(column(db, "status", "todo"), ["r1", "r3"]);
  assert.deepEqual(column(db, "status", null), ["r4"]);
  assert.deepEqual(column(db, "prio", null, [{ property_id: "title", direction: "ascending" }]), [
    "r5",
    "r4",
    "r1",
  ]);
  const filtered = db.queryRows("db", {
    filter: { or: [{ property_id: "title", operator: "contains", value: "t" }] },
    group: { property_id: "status", value: "todo" },
  });
  assert.deepEqual(
    filtered.rows.map((r) => r.id),
    ["r3"],
  );
  for (const id of ["tags", "title", "gone"])
    assertApiError(
      () => db.queryRows("db", { group: { property_id: id, value: null } }),
      400,
      "invalid_query",
    );
});

test("moving cards changes the column and the manual order together", () => {
  const db = boardDb();
  const moved = db.moveRow("db", "r5", { after_id: null, properties: { status: "todo" } });
  assert.equal(moved.properties.status, "todo");
  assert.deepEqual(column(db, "status", "todo"), ["r5", "r1", "r3"]);
  db.moveRow("db", "r1", { after_id: "r3" });
  assert.deepEqual(column(db, "status", "todo"), ["r5", "r3", "r1"]);
  db.moveRow("db", "r3", { properties: { status: null } });
  assert.deepEqual(column(db, "status", null), ["r3", "r4"]);
  assert.deepEqual(
    db.queryRows("db", {}).rows.map((r) => r.id),
    ["r5", "r2", "r3", "r1", "r4"],
  );

  assertApiError(() => db.moveRow("db", "r1", { after_id: "r1" }), 400, "invalid_after");
  assertApiError(() => db.moveRow("db", "r1", { after_id: "nope" }), 400, "invalid_after");
  assertApiError(
    () => db.moveRow("db", "r1", { properties: { status: "nope" } }),
    400,
    "invalid_value",
  );
  assertApiError(() => db.moveRow("db", "nope", {}), 404, "row_not_found");
  db.createPage({ id: "plain", workspace_id: WS, title: "Plain" });
  assertApiError(() => db.moveRow("db", "plain", {}), 404, "row_not_found");
  db.trashPage("r2");
  assertApiError(
    () => db.moveRow("db", "r2", { properties: { status: "todo" } }),
    409,
    "page_archived",
  );
});

test("viewers can't move cards", () => {
  const db = boardDb();
  /** @type {import("../roles.js").Role} */
  let role = "owner";
  const viewerDb = createDb(db.snapshot(), { role: () => role });
  role = "view";
  assertApiError(() => viewerDb.moveRow("db", "r1", { after_id: null }), 403, "read_only");
});

test("the move route", async () => {
  const db = boardDb();
  const server = createMockServer({
    db: () => db,
    config: () => ({ latency: 0, failEvery: 0, offline: false }),
  });
  const moved = /** @type {any} */ (
    await server.request("POST", "/v1/databases/db/rows/r4/move", {
      body: { after_id: null, properties: { status: "done" } },
    })
  );
  assert.equal(moved.properties.status, "done");
  assert.deepEqual(column(db, "status", "done"), ["r4", "r5"]);
});
