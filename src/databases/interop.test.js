// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "../api/mock/db.js";
import { createMockServer } from "../api/mock/server.js";
import { api, backendDir, databaseUrl, server, USER } from "../api/test-backend.js";

/**
 * Boards against the real Go server and Postgres (M8): the same requests
 * go to the server and to the mock backend (which the UI is developed
 * against), and their answers must be the same: views and their board
 * settings, board columns' rows and totals, card moves and their errors.
 *
 * Skipped unless LEAF_BACKEND_DIR and LEAF_INTEROP_DATABASE_URL are set
 * (`src/api/test-backend.js`):
 *
 *   LEAF_BACKEND_DIR=../leaf-backend \
 *   LEAF_INTEROP_DATABASE_URL="postgres:///leaf_interop?host=/tmp" \
 *   node --test src/databases/interop.test.js
 */

/** Drops what can't match: timestamps, and ids either side makes up. @param {unknown} value @returns {unknown} */
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (["created_at", "updated_at", "archived_at", "role"].includes(key)) continue;
      out[key] = comparable(v);
    }
    return out;
  }
  return value;
}

test("boards: the server answers like the mock", {
  skip: !backendDir || !databaseUrl,
  timeout: 120_000,
}, async () => {
  const backend = server();
  await backend.start();
  try {
    const [workspace] = await api("GET", "/v1/workspaces");
    // Page and view ids are global on the server: new ones each run.
    const run = Date.now().toString(36);
    const db = `board-${run}`;
    const board = `b-${run}`;
    const row = (/** @type {number} */ n) => `r${n}-${run}`;

    /** @type {import("../api/roles.js").Role} */
    let role = "owner";
    const mockDb = createDb(
      { workspaces: [{ id: workspace.id, name: workspace.name }], pages: [] },
      { role: () => role },
    );
    const mock = createMockServer({
      db: () => mockDb,
      config: () => ({ latency: 0, failEvery: 0, offline: false }),
    });

    /**
     * Sends a request to both and checks they agree.
     * @param {string} what @param {"GET" | "POST" | "PATCH" | "DELETE"} method @param {string} path @param {unknown} [body]
     * @param {{ user?: string, pick?: (answer: any) => unknown }} [options] `pick`: the part to compare.
     */
    async function both(what, method, path, body, { user = USER, pick = (x) => x } = {}) {
      /** @param {() => Promise<unknown>} send */
      const settle = (send) =>
        send().then(
          (answer) => ({ answer: comparable(pick(answer)) }),
          (error) => ({ error: { status: error.status, code: error.code } }),
        );
      role = user === "user_viewer" ? "view" : "owner";
      const real = await settle(() => api(method, path, body, { user }));
      const fake = await settle(() => mock.request(method, path, { body }));
      assert.deepEqual(real, fake, what);
      return /** @type {any} */ (real).answer;
    }
    const view = (/** @type {any} */ d) => d.views.find((/** @type {any} */ v) => v.id === board);
    const ids = (/** @type {any} */ page) => ({
      ids: page.rows.map((/** @type {any} */ r) => r.id),
      total: page.total,
    });
    /** @param {string} what @param {string | null} value @param {object} [extra] */
    const column = (what, value, extra = {}) =>
      both(
        what,
        "POST",
        `/v1/databases/${db}/query`,
        { group: { property_id: "status", value }, ...extra },
        { pick: ids },
      );

    await both(
      "create the database",
      "POST",
      "/v1/pages",
      {
        id: db,
        workspace_id: workspace.id,
        parent_id: null,
        title: "Board interop",
        kind: "database",
      },
      { pick: (p) => p.kind },
    );
    await both(
      "add a select",
      "POST",
      `/v1/databases/${db}/properties`,
      {
        id: "prio",
        name: "Priority",
        type: "select",
        options: [
          { id: "hi", name: "High", color: "red" },
          { id: "lo", name: "Low", color: "gray" },
        ],
      },
      { pick: (d) => d.properties },
    );
    await both(
      "add a status",
      "POST",
      `/v1/databases/${db}/properties`,
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
      { pick: (d) => d.properties },
    );
    const values = [
      { status: "todo" },
      { status: "doing", prio: "hi" },
      { status: "todo", prio: "lo" },
      {},
      { status: "done" },
    ];
    for (const [i, properties] of values.entries()) {
      await both(`add row ${i + 1}`, "POST", `/v1/databases/${db}/rows`, {
        id: row(i + 1),
        title: `Row ${i + 1}`,
        properties,
      });
    }

    // A board picks the status; card properties drop unknown ids and the title.
    await both("add a board", "POST", `/v1/databases/${db}/views`, {
      id: board,
      name: "Board",
      type: "board",
      card_properties: ["prio", "gone", "title"],
    });
    await both("hide groups", "PATCH", `/v1/databases/${db}/views/${board}`, {
      hidden_groups: ["", "nope", "done"],
    });
    await both("bad group_by", "PATCH", `/v1/databases/${db}/views/${board}`, {
      group_by: "title",
    });
    await both("bad type", "PATCH", `/v1/databases/${db}/views/${board}`, { type: "calendar" });

    // Columns.
    for (const value of [null, "todo", "doing", "done"]) await column(`column ${value}`, value);
    await column("a sorted column", "todo", {
      sorts: [{ property_id: "title", direction: "descending" }],
    });
    await column("a filtered column", "todo", {
      filter: { and: [{ property_id: "prio", operator: "is_not_empty" }] },
    });
    await both(
      "group on a select",
      "POST",
      `/v1/databases/${db}/query`,
      { group: { property_id: "prio", value: null } },
      { pick: ids },
    );
    await both("group on the title", "POST", `/v1/databases/${db}/query`, {
      group: { property_id: "title", value: null },
    });
    await both("group without a property", "POST", `/v1/databases/${db}/query`, {
      group: { value: "todo" },
    });

    // Moves: column and place together, place only, column only.
    await both("move to the top of To do", "POST", `/v1/databases/${db}/rows/${row(5)}/move`, {
      after_id: null,
      properties: { status: "todo" },
    });
    await both("reorder within To do", "POST", `/v1/databases/${db}/rows/${row(1)}/move`, {
      after_id: row(3),
    });
    await both("to No Status", "POST", `/v1/databases/${db}/rows/${row(3)}/move`, {
      properties: { status: null },
    });
    await column("To do after the moves", "todo");
    await column("No Status after the moves", null);
    await both("the manual order", "POST", `/v1/databases/${db}/query`, {}, { pick: ids });
    await both("after itself", "POST", `/v1/databases/${db}/rows/${row(1)}/move`, {
      after_id: row(1),
    });
    await both("after a stranger", "POST", `/v1/databases/${db}/rows/${row(1)}/move`, {
      after_id: "nope",
    });
    await both("an unknown option", "POST", `/v1/databases/${db}/rows/${row(1)}/move`, {
      properties: { status: "nope" },
    });
    await both("an unknown row", "POST", `/v1/databases/${db}/rows/nope-${run}/move`, {});

    // Schema changes keep the board valid.
    await both(
      "remove an option",
      "PATCH",
      `/v1/databases/${db}/properties/status`,
      {
        options: [
          { id: "todo", name: "To do", color: "default", group: "to_do" },
          { id: "doing", name: "Doing", color: "blue", group: "in_progress" },
        ],
      },
      { pick: view },
    );
    await both(
      "delete a card property",
      "DELETE",
      `/v1/databases/${db}/properties/prio`,
      undefined,
      { pick: view },
    );
    await both(
      "status to text",
      "PATCH",
      `/v1/databases/${db}/properties/status`,
      { type: "text" },
      { pick: view },
    );
  } finally {
    await backend.stop("SIGTERM");
  }
});
