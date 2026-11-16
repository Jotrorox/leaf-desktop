// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "./db.js";
import { MOCK_WORKSPACE_ID, seedState } from "./seed.js";
import { createMockServer } from "./server.js";

// The mock's search, sharing and uploads: the same cases as the server's
// search_test.go, sharing_test.go and files_test.go, where they apply to
// the mock's single user.

const WS = MOCK_WORKSPACE_ID;

/** @param {{ role?: () => import("../roles.js").Role }} [options] */
function freshDb(options = {}) {
  let clock = 0;
  let ids = 0;
  return createDb(seedState(new Date("2026-10-12T12:00:00Z")), {
    now: () => new Date(Date.UTC(2026, 9, 12, 12, 0, clock++)).toISOString(),
    newId: () => `gen_${++ids}`,
    ...options,
  });
}

/** @param {() => unknown} fn @param {number} status @param {string} code */
function assertApiError(fn, status, code) {
  assert.throws(
    fn,
    (/** @type {any} */ err) =>
      err.name === "ApiError" && err.status === status && err.code === code,
  );
}

test("search ranks titles, then letters in order, then content, and skips the trash", () => {
  const db = freshDb();
  db.createPage({ id: "pg_roadmap", workspace_id: WS, parent_id: null, title: "Roadmap 2027" });
  db.savePageText("pg_journal_mon", {
    text: "Long day. Talked about the roadmap with Ada, then wrote notes.",
  });
  const found = db.search("Roadmap");
  assert.deepEqual(
    found.map((r) => r.id),
    ["pg_roadmap", "pg_journal_mon"],
  );
  assert.equal(found[0].snippet, null);
  assert.match(String(found[1].snippet), /the roadmap with Ada/);
  assert.deepEqual(found[1].path, ["Journal"]);
  assert.deepEqual(
    db.search("rdmp").map((r) => r.id),
    ["pg_roadmap"],
  );
  const pro = db.search("pro").map((r) => r.id);
  assert.deepEqual(pro.slice(0, 2), ["pg_kickoff", "pg_pragprog"]);
  assert.equal(db.search("", 3)[0].id, "pg_roadmap");
  // A copy keeps the text.
  db.savePageText("pg_tasks", { text: "unique words here" });
  db.duplicatePage("pg_tasks", { id: "pg_tasks_copy" });
  assert.equal(db.search("unique words").length, 2);
});

test("sharing: invites, roles, inherited roles and the public link", () => {
  const db = freshDb();
  // A known email shares at once; an unknown one waits.
  let sharing = db.invite("pg_kickoff", { email: "Linus@Example.com ", role: "view" });
  const linus = sharing.people.find((p) => p.user_id === "user_linus");
  assert.deepEqual([linus?.role, linus?.source, linus?.guest], ["view", "page", true]);
  sharing = db.invite("pg_kickoff", { email: "new@example.com", role: "comment" });
  assert.deepEqual(
    sharing.invites.map((i) => [i.email, i.role, i.source]),
    [["new@example.com", "comment", "page"]],
  );
  // Below, it's inherited.
  const below = db.getSharing("pg_tasks");
  const inherited = below.people.find((p) => p.user_id === "user_linus");
  assert.deepEqual([inherited?.source, inherited?.inherited_from?.id], ["ancestor", "pg_kickoff"]);
  assert.equal(below.invites[0].inherited_from?.id, "pg_kickoff");
  // A member restricted on a subtree.
  sharing = db.setPersonRole("pg_tasks", "user_ada", { role: "view" });
  assert.equal(sharing.people.find((p) => p.user_id === "user_ada")?.role, "view");
  assert.equal(sharing.people[0].role, "owner");
  assertApiError(
    () => db.setPersonRole("pg_tasks", "user_mock", { role: "view" }),
    400,
    "own_role",
  );
  assertApiError(
    () => db.setPersonRole("pg_tasks", "user_ada", { role: "owner" }),
    400,
    "invalid_role",
  );
  assertApiError(
    () => db.setPersonRole("pg_tasks", "user_nobody", { role: "view" }),
    404,
    "person_not_found",
  );
  sharing = db.removePerson("pg_tasks", "user_ada");
  assert.equal(sharing.people.find((p) => p.user_id === "user_ada")?.role, "edit");
  assertApiError(() => db.removePerson("pg_tasks", "user_ada"), 404, "share_not_found");
  db.cancelInvite("pg_kickoff", "new@example.com");
  assertApiError(() => db.cancelInvite("pg_kickoff", "new@example.com"), 404, "invite_not_found");
  // Public, here or above.
  assert.equal(db.setPublic("pg_kickoff", { enabled: true }).public, true);
  const child = db.setPublic("pg_tasks", { enabled: false });
  assert.deepEqual([child.public, child.public_inherited_from?.id], [true, "pg_kickoff"]);
  assertApiError(() => db.setPublic("pg_tasks", { enabled: "yes" }), 400, "invalid_public");
});

test("only full access can share, and only they see emails", () => {
  let role = /** @type {import("../roles.js").Role} */ ("edit");
  const db = freshDb({ role: () => role });
  const sharing = db.getSharing("pg_kickoff");
  assert.equal(sharing.can_share, false);
  assert.ok(sharing.people.every((p) => p.email === null));
  assertApiError(
    () => db.invite("pg_kickoff", { email: "x@example.com", role: "view" }),
    403,
    "cant_share",
  );
  role = "full_access";
  assert.equal(
    db.getSharing("pg_kickoff").people.find((p) => p.user_id === "user_ada")?.email,
    "ada@leaf.test",
  );
});

test("uploads: ask for a URL, PUT once with progress, then it's served", async () => {
  const db = freshDb();
  /** @type {string[]} */
  const stored = [];
  const server = createMockServer({
    db: () => db,
    config: () => ({ latency: 0, failEvery: 0 }),
    onFile: (id) => stored.push(id),
  });
  /** @type {import("../types.js").UploadTicket} */
  const ticket = await server.request("POST", "/v1/files/upload-url", {
    body: { page_id: "pg_tasks", name: "a.png", content_type: "image/png", size: 4 },
  });
  assert.deepEqual(
    [ticket.method, ticket.headers["Content-Type"], ticket.url],
    ["PUT", "image/png", `/v1/files/${ticket.id}`],
  );
  /** @type {number[]} */
  const progress = [];
  const file = new Blob([new Uint8Array(4)], { type: "image/png" });
  await server.putFile(ticket.upload_url, file, {
    headers: ticket.headers,
    onProgress: (loaded) => progress.push(loaded),
  });
  assert.equal(progress.at(-1), 4);
  assert.deepEqual(stored, [ticket.id]);
  await assert.rejects(server.putFile(ticket.upload_url, file, { headers: ticket.headers }), {
    code: "invalid_upload_token",
  });
  await assert.rejects(
    server.request("POST", "/v1/files/upload-url", {
      body: { page_id: "pg_tasks", name: "a.svg", content_type: "image/svg+xml", size: 4 },
    }),
    { status: 415 },
  );
  await assert.rejects(
    server.request("POST", "/v1/files/upload-url", {
      body: { page_id: "pg_q3_ideas", name: "a.png", content_type: "image/png", size: 4 },
    }),
    { code: "page_archived" },
  );
  // An uploaded icon is a fine icon.
  assert.equal(db.updatePage("pg_tasks", { icon: `file:${ticket.id}` }).icon, `file:${ticket.id}`);
});
