// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "./db.js";
import { MOCK_WORKSPACE_ID, seedState } from "./seed.js";

const WS = MOCK_WORKSPACE_ID;

function freshDb() {
  let clock = 0;
  let ids = 0;
  return createDb(seedState(new Date("2026-10-12T12:00:00Z")), {
    now: () => new Date(Date.UTC(2026, 9, 12, 12, 0, clock++)).toISOString(),
    newId: () => `gen_${++ids}`,
  });
}

/** @param {ReturnType<typeof freshDb>} db @param {string | null} parent */
const titles = (db, parent) => db.tree(WS, parent).map((node) => node.title);

/**
 * @param {() => unknown} fn
 * @param {number} status
 * @param {string} code
 */
function assertApiError(fn, status, code) {
  assert.throws(fn, (/** @type {any} */ err) => {
    assert.equal(err.name, "ApiError");
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

test("tree returns one level, in position order, without archived pages", () => {
  const db = freshDb();
  assert.deepEqual(titles(db, null), [
    "Getting started",
    "Project Kickoff",
    "Journal",
    "Reading list",
    "",
  ]);
  assert.deepEqual(titles(db, "pg_kickoff"), ["Meeting notes", "Tasks", "Research links"]);
  const kickoff = db.tree(WS, null)[1];
  assert.equal(kickoff.has_children, true);
  assert.equal(db.tree(WS, null)[4].has_children, false);
});

test("tree rejects unknown workspaces and parents", () => {
  const db = freshDb();
  assertApiError(() => db.tree("nope", null), 404, "workspace_not_found");
  assertApiError(() => db.tree(WS, "nope"), 404, "page_not_found");
});

test("create appends by default, honours after_id, and is idempotent by id", () => {
  const db = freshDb();
  const last = db.createPage({
    id: "n1",
    workspace_id: WS,
    parent_id: "pg_kickoff",
    title: "Last",
  });
  assert.deepEqual(titles(db, "pg_kickoff").at(-1), "Last");
  assert.equal(last.parent_id, "pg_kickoff");
  assert.equal(last.has_children, false);

  db.createPage({
    id: "n2",
    workspace_id: WS,
    parent_id: "pg_kickoff",
    after_id: null,
    title: "First",
  });
  db.createPage({
    id: "n3",
    workspace_id: WS,
    parent_id: "pg_kickoff",
    after_id: "pg_tasks",
    title: "After tasks",
  });
  assert.deepEqual(titles(db, "pg_kickoff"), [
    "First",
    "Meeting notes",
    "Tasks",
    "After tasks",
    "Research links",
    "Last",
  ]);

  const again = db.createPage({
    id: "n1",
    workspace_id: WS,
    parent_id: "pg_kickoff",
    title: "Last",
  });
  assert.equal(again.id, "n1");
  assert.equal(titles(db, "pg_kickoff").length, 6);
  assertApiError(
    () => db.createPage({ id: "n1", workspace_id: WS, parent_id: null }),
    409,
    "id_conflict",
  );
});

test("create validates its input", () => {
  const db = freshDb();
  assertApiError(
    () => db.createPage({ workspace_id: "nope", parent_id: null }),
    404,
    "workspace_not_found",
  );
  assertApiError(
    () => db.createPage({ workspace_id: WS, parent_id: "pg_old_roadmap" }),
    409,
    "page_archived",
  );
  assertApiError(
    () => db.createPage({ workspace_id: WS, parent_id: null, after_id: "pg_tasks" }),
    400,
    "invalid_after",
  );
  assertApiError(
    () => db.createPage({ workspace_id: WS, parent_id: null, title: 5 }),
    400,
    "invalid_title",
  );
  assertApiError(
    () => db.createPage({ workspace_id: WS, parent_id: null, icon: "" }),
    400,
    "invalid_icon",
  );
  const generated = db.createPage({ workspace_id: WS, parent_id: null });
  assert.equal(generated.id, "gen_1");
  assert.equal(generated.title, "");
});

test("update changes only the given fields and bumps updated_at", () => {
  const db = freshDb();
  const before = db.getPage("pg_tasks");
  const after = db.updatePage("pg_tasks", { title: "To-dos" });
  assert.equal(after.title, "To-dos");
  assert.equal(after.icon, before.icon);
  assert.notEqual(after.updated_at, before.updated_at);
  assert.equal(db.updatePage("pg_tasks", { icon: null }).icon, null);
  assert.equal(db.updatePage("pg_tasks", { cover: "gradient:dusk" }).cover, "gradient:dusk");
  assertApiError(() => db.updatePage("pg_q3_ideas", { title: "x" }), 409, "page_archived");
  assertApiError(() => db.updatePage("nope", { title: "x" }), 404, "page_not_found");
});

test("move reorders within a parent and between parents", () => {
  const db = freshDb();
  db.movePage("pg_research", { parent_id: "pg_kickoff", after_id: null });
  assert.deepEqual(titles(db, "pg_kickoff"), ["Research links", "Meeting notes", "Tasks"]);

  db.movePage("pg_tasks", { parent_id: null, after_id: "pg_getting_started" });
  assert.deepEqual(titles(db, null), [
    "Getting started",
    "Tasks",
    "Project Kickoff",
    "Journal",
    "Reading list",
    "",
  ]);
  assert.deepEqual(titles(db, "pg_kickoff"), ["Research links", "Meeting notes"]);
  assert.equal(db.getPage("pg_tasks").parent_id, null);

  // Into a page without children.
  const moved = db.movePage("pg_ddia", { parent_id: "pg_empty", after_id: null });
  assert.equal(moved.parent_id, "pg_empty");
  assert.equal(db.getPage("pg_empty").has_children, true);
});

test("move refuses cycles, archived pages and bad after_ids", () => {
  const db = freshDb();
  assertApiError(
    () => db.movePage("pg_kickoff", { parent_id: "pg_kickoff", after_id: null }),
    400,
    "invalid_move",
  );
  assertApiError(
    () => db.movePage("pg_kickoff", { parent_id: "pg_notes_review", after_id: null }),
    400,
    "invalid_move",
  );
  assertApiError(
    () => db.movePage("pg_tasks", { parent_id: "pg_old_roadmap", after_id: null }),
    409,
    "page_archived",
  );
  assertApiError(
    () => db.movePage("pg_q3_ideas", { parent_id: null, after_id: null }),
    409,
    "page_archived",
  );
  assertApiError(
    () => db.movePage("pg_tasks", { parent_id: null, after_id: "pg_research" }),
    400,
    "invalid_after",
  );
  assertApiError(
    () => db.movePage("pg_tasks", { parent_id: "pg_kickoff", after_id: "pg_tasks" }),
    400,
    "invalid_after",
  );
  assertApiError(() => db.movePage("pg_tasks", { parent_id: null }), 400, "invalid_move");
});

test("moving after the page right before it is a no-op that keeps the order", () => {
  const db = freshDb();
  db.movePage("pg_tasks", { parent_id: "pg_kickoff", after_id: "pg_meeting_notes" });
  assert.deepEqual(titles(db, "pg_kickoff"), ["Meeting notes", "Tasks", "Research links"]);
});

test("trash archives the subtree; the trash lists only what was trashed directly", () => {
  const db = freshDb();
  db.trashPage("pg_kickoff");
  assert.deepEqual(titles(db, null), ["Getting started", "Journal", "Reading list", ""]);
  assert.ok(db.getPage("pg_notes_review").archived_at, "descendants are archived too");
  assert.deepEqual(
    db.trash(WS).map((page) => page.id),
    ["pg_kickoff", "pg_old_roadmap"],
    "newest first",
  );
  assertApiError(() => db.trashPage("pg_kickoff"), 409, "page_archived");
});

test("restore brings back the subtree under its parent", () => {
  const db = freshDb();
  db.trashPage("pg_meeting_notes");
  const restored = db.restorePage("pg_meeting_notes");
  assert.equal(restored.archived_at, null);
  assert.equal(restored.parent_id, "pg_kickoff");
  assert.deepEqual(titles(db, "pg_kickoff"), ["Meeting notes", "Tasks", "Research links"]);
  assert.deepEqual(titles(db, "pg_meeting_notes"), ["Oct 6 · Kickoff", "Oct 9 · Design review"]);
});

test("restore doesn't bring back pages that were trashed separately before", () => {
  const db = freshDb();
  db.trashPage("pg_notes_kickoff");
  db.trashPage("pg_meeting_notes");
  db.restorePage("pg_meeting_notes");
  assert.deepEqual(titles(db, "pg_meeting_notes"), ["Oct 9 · Design review"]);
  assert.deepEqual(
    db.trash(WS).map((page) => page.id),
    ["pg_notes_kickoff", "pg_old_roadmap"],
  );
});

test("a page whose parent is still in the trash is restored to the top level", () => {
  const db = freshDb();
  const restored = db.restorePage("pg_q3_ideas");
  assert.equal(restored.parent_id, null);
  assert.equal(titles(db, null).at(-1), "Q3 ideas");
  assert.ok(db.getPage("pg_old_roadmap").archived_at, "the parent stays in the trash");
});

test("delete forever removes the archived subtree, and only archived pages", () => {
  const db = freshDb();
  assertApiError(() => db.deleteForever("pg_kickoff"), 409, "not_archived");
  db.deleteForever("pg_old_roadmap");
  assertApiError(() => db.getPage("pg_old_roadmap"), 404, "page_not_found");
  assertApiError(() => db.getPage("pg_q3_ideas"), 404, "page_not_found");
  assert.deepEqual(db.trash(WS), []);
});

test("duplicate deep-copies the live subtree right after the original", () => {
  const db = freshDb();
  db.trashPage("pg_notes_kickoff");
  const copy = db.duplicatePage("pg_meeting_notes", { id: "copy_1" });
  assert.equal(copy.id, "copy_1");
  assert.equal(copy.title, "Meeting notes (copy)");
  assert.equal(copy.has_children, true);
  assert.deepEqual(titles(db, "pg_kickoff"), [
    "Meeting notes",
    "Meeting notes (copy)",
    "Tasks",
    "Research links",
  ]);
  assert.deepEqual(
    titles(db, "copy_1"),
    ["Oct 9 · Design review"],
    "archived descendants aren't copied",
  );
  assert.notEqual(db.tree(WS, "copy_1")[0].id, "pg_notes_review");

  assert.equal(db.duplicatePage("pg_empty", { id: "copy_2" }).title, "Untitled (copy)");
  assertApiError(() => db.duplicatePage("pg_tasks", { id: "copy_1" }), 409, "id_conflict");
});

test("snapshot round-trips through createDb", () => {
  const db = freshDb();
  db.createPage({ id: "n1", workspace_id: WS, parent_id: null, title: "Saved" });
  const reloaded = createDb(db.snapshot());
  assert.equal(reloaded.getPage("n1").title, "Saved");
});

test("documents: save merges updates, gaps are refused, duplicates copy them", async () => {
  const { Doc } = await import("../../editor/model/doc.js");
  const { base64ToBytes, bytesToBase64 } = await import("../../lib/base64.js");
  const db = freshDb();
  assert.deepEqual(db.getDoc("pg_basics"), { snapshot: null });
  const doc = new Doc({ clientId: 300 });
  /** @type {Uint8Array[]} */
  const updates = [];
  doc.observe((e) => e.update && updates.push(e.update));
  const id = doc.insertBlock({ type: "p", text: "Hi" });
  doc.insertText(id, 2, "!");
  assertApiError(
    () => db.saveDoc("pg_basics", { update: bytesToBase64(updates[1]) }),
    409,
    "doc_gap",
  );
  db.saveDoc("pg_basics", { update: bytesToBase64(updates[0]) });
  const { state_vector } = db.saveDoc("pg_basics", { update: bytesToBase64(updates[1]) });
  assert.deepEqual(base64ToBytes(state_vector), doc.encodeStateVector());
  const stored = /** @type {string} */ (db.getDoc("pg_basics").snapshot);
  assert.deepEqual(Doc.fromSnapshot(base64ToBytes(stored)).toJSON(), doc.toJSON());
  assertApiError(() => db.saveDoc("pg_basics", { update: "AQEA" }), 400, "invalid_update");
  db.duplicatePage("pg_basics", { id: "pg_copy" });
  assert.equal(db.getDoc("pg_copy").snapshot, stored);
});

test("searchPages matches titles like the server: prefix first, with the path, no archived pages", () => {
  const db = freshDb();
  const found = (/** @type {string} */ q) => db.searchPages(WS, q).map((m) => m.title);
  assert.deepEqual(
    db.searchPages(WS, "NOTES").map((m) => [m.id, m.path]),
    [["pg_meeting_notes", ["Project Kickoff"]]],
  );
  assert.deepEqual(db.searchPages(WS, "design review")[0].path, [
    "Project Kickoff",
    "Meeting notes",
  ]);
  assert.equal(
    found("re")
      .slice(0, 2)
      .every((t) => t.toLowerCase().startsWith("re")),
    true,
  );
  assert.equal(found("re").length, 3);
  db.trashPage("pg_kickoff");
  assert.deepEqual(found("research"), []);
  assert.equal(db.searchPages(WS, "", 3).length, 3);
});
