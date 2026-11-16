// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "./db.js";
import { MOCK_WORKSPACE_ID, seedState } from "./seed.js";
import { createMockServer } from "./server.js";

/** @param {Partial<import("./server.js").MockConfig>} [config] */
function setup(config = {}) {
  const db = createDb(seedState());
  let saves = 0;
  const server = createMockServer({
    db: () => db,
    config: () => ({ latency: 0, failEvery: 0, ...config }),
    onWrite: () => saves++,
  });
  return { db, server, saves: () => saves };
}

test("routes reads and writes like the API", async () => {
  const { server } = setup();
  const me = await server.request("GET", "/v1/me");
  assert.deepEqual(me, {
    id: "user_mock",
    name: "Mock User",
    email: "mock@leaf.test",
    avatar_url: null,
  });

  const workspaces = /** @type {any[]} */ (await server.request("GET", "/v1/workspaces"));
  assert.equal(workspaces[0].id, MOCK_WORKSPACE_ID);

  const children = /** @type {any[]} */ (
    await server.request("GET", `/v1/workspaces/${MOCK_WORKSPACE_ID}/tree?parent_id=pg_kickoff`)
  );
  assert.deepEqual(
    children.map((node) => node.id),
    ["pg_meeting_notes", "pg_tasks", "pg_research"],
  );

  const created = /** @type {any} */ (
    await server.request("POST", "/v1/pages", {
      body: { id: "new", workspace_id: MOCK_WORKSPACE_ID, parent_id: null, title: "Hi" },
    })
  );
  assert.equal(created.id, "new");
  assert.equal(
    /** @type {any} */ (
      await server.request("PATCH", "/v1/pages/new", { body: { title: "Hello" } })
    ).title,
    "Hello",
  );
  await server.request("POST", "/v1/pages/new/move", {
    body: { parent_id: "pg_kickoff", after_id: null },
  });
  assert.equal(
    /** @type {any} */ (await server.request("GET", "/v1/pages/new")).parent_id,
    "pg_kickoff",
  );
  assert.equal(await server.request("DELETE", "/v1/pages/new"), undefined);
  const trash = /** @type {any[]} */ (
    await server.request("GET", `/v1/workspaces/${MOCK_WORKSPACE_ID}/trash`)
  );
  assert.equal(trash[0].id, "new");
  await server.request("POST", "/v1/pages/new/restore");
  await server.request("DELETE", "/v1/pages/new");
  await server.request("DELETE", "/v1/pages/new?permanent=true");
  await assert.rejects(server.request("GET", "/v1/pages/new"), { name: "ApiError", status: 404 });
  const copy = /** @type {any} */ (
    await server.request("POST", "/v1/pages/pg_tasks/duplicate", { body: { id: "dup" } })
  );
  assert.equal(copy.title, "Tasks (copy)");
});

test("connected apps can be disconnected and allowed again", async () => {
  const { server } = setup();
  const list = /** @type {any[]} */ (await server.request("GET", "/v1/me/connections"));
  assert.equal(list.length, 2);
  const [first] = list;
  const off = /** @type {any} */ (
    await server.request("POST", "/v1/me/connections/disconnect", {
      body: { client_id: first.client_id },
    })
  );
  assert.ok(off.disconnected_at);
  const again = /** @type {any} */ (
    await server.request("POST", "/v1/me/connections/disconnect", {
      body: { client_id: first.client_id },
    })
  );
  assert.equal(again.disconnected_at, off.disconnected_at, "idempotent");
  const after = /** @type {any[]} */ (await server.request("GET", "/v1/me/connections"));
  assert.equal(after.at(-1).client_id, first.client_id, "disconnected apps go last");
  const on = /** @type {any} */ (
    await server.request("POST", "/v1/me/connections/allow", {
      body: { client_id: first.client_id },
    })
  );
  assert.equal(on.disconnected_at, null);
  await assert.rejects(
    server.request("POST", "/v1/me/connections/allow", { body: { client_id: "nope" } }),
    { status: 404, code: "connection_not_found" },
  );
  await assert.rejects(server.request("POST", "/v1/me/connections/allow", { body: {} }), {
    status: 400,
  });
  await assert.rejects(server.request("GET", "/v1/me/connections/allow"), { status: 405 });
});

test("unknown routes are 404 and wrong methods 405", async () => {
  const { server } = setup();
  await assert.rejects(server.request("GET", "/v1/nope"), { status: 404, code: "not_found" });
  await assert.rejects(server.request("PUT", "/v1/pages/pg_tasks"), {
    status: 405,
    code: "method_not_allowed",
  });
  await assert.rejects(server.request("GET", "/v1/pages/pg_tasks/move"), { status: 405 });
});

test("responses are copies: mutating them doesn't change the server", async () => {
  const { server } = setup();
  const page = /** @type {any} */ (await server.request("GET", "/v1/pages/pg_tasks"));
  page.title = "hacked";
  assert.equal(
    /** @type {any} */ (await server.request("GET", "/v1/pages/pg_tasks")).title,
    "Tasks",
  );
});

test("failEvery fails every Nth write before applying it; reads never fail", async () => {
  const { server, db, saves } = setup({ failEvery: 2 });
  /** @param {string} title */
  const rename = (title) => server.request("PATCH", "/v1/pages/pg_tasks", { body: { title } });

  await rename("one");
  await server.request("GET", "/v1/pages/pg_tasks");
  await assert.rejects(rename("two"), { name: "ApiError", status: 500, code: "mock_failure" });
  assert.equal(db.getPage("pg_tasks").title, "one", "the failed write changed nothing");
  await rename("three");
  await assert.rejects(rename("four"), { code: "mock_failure" });
  assert.equal(saves(), 2, "only successful writes persist");
});

test("resetWriteCount restarts the count", async () => {
  const { server } = setup({ failEvery: 2 });
  const rename = () => server.request("PATCH", "/v1/pages/pg_tasks", { body: { title: "x" } });
  await rename();
  server.resetWriteCount();
  await rename();
  await assert.rejects(rename());
});

test("latency delays responses and an abort rejects with AbortError", async () => {
  const { server } = setup({ latency: 40 });
  const started = Date.now();
  await server.request("GET", "/v1/workspaces");
  assert.ok(Date.now() - started >= 15, "at least half the latency");

  const controller = new AbortController();
  const pending = server.request("GET", "/v1/workspaces", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });

  await assert.rejects(server.request("GET", "/v1/workspaces", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});
