// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { Doc } from "../editor/model/doc.js";
import { docReport } from "../editor/sync/text.js";
import { createDb } from "./mock/db.js";
import { createMockServer } from "./mock/server.js";
import { api, backendDir, base, databaseUrl, server } from "./test-backend.js";

/**
 * Search, sharing and files (M9) against the real Go server and Postgres:
 * what the frontend's `api/search.js`, `api/sharing.js` and `api/files.js`
 * send, and what the UI reads back, with the mock's answers alongside
 * where both can answer the same.
 *
 * Skipped unless LEAF_BACKEND_DIR and LEAF_INTEROP_DATABASE_URL are set
 * (`src/api/test-backend.js`):
 *
 *   LEAF_BACKEND_DIR=../leaf-backend \
 *   LEAF_INTEROP_DATABASE_URL="postgres:///leaf_interop?host=/tmp" \
 *   node --test src/api/m9-interop.test.js
 */

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

test("search, sharing, public links and uploads work against the server", {
  skip: !backendDir || !databaseUrl,
  timeout: 120_000,
}, async () => {
  const backend = server();
  await backend.start();
  try {
    const [workspace] = await api("GET", "/v1/workspaces");
    const run = Date.now().toString(36);
    const parent = `m9-${run}`;
    const child = `m9c-${run}`;
    await api("POST", "/v1/pages", {
      id: parent,
      workspace_id: workspace.id,
      parent_id: null,
      title: `Quarterly roadmap ${run}`,
    });
    await api("POST", "/v1/pages", {
      id: child,
      workspace_id: workspace.id,
      parent_id: parent,
      title: `Notes ${run}`,
    });

    // Search: titles by their letters, content with a snippet. The editor's
    // report (with the files the page shows) is what the server reads.
    const doc = new Doc();
    doc.insertBlock({ type: "paragraph", text: `We agreed on the zebra${run} launch plan.` });
    doc.insertBlock({ type: "image", after: doc.children(null)[0], attrs: { file: "f1" } });
    const report = docReport(doc);
    assert.deepEqual(report.files, ["f1"]);
    await api("PUT", `/v1/pages/${child}/text`, report);
    const byContent = await api("GET", `/v1/search?query=${encodeURIComponent(`zebra${run}`)}`);
    assert.deepEqual(
      byContent.map((/** @type {any} */ r) => [
        r.id,
        r.path,
        typeof r.snippet === "string" && r.snippet.includes(`zebra${run}`),
      ]),
      [[child, [`Quarterly roadmap ${run}`], true]],
    );
    const byLetters = await api(
      "GET",
      `/v1/search?query=${encodeURIComponent(`qrtrly rdmp ${run}`)}`,
    );
    assert.equal(byLetters[0]?.id, parent);
    // The mock answers the same way.
    const mockDb = createDb({
      workspaces: [{ id: workspace.id, name: workspace.name, icon: null, created_at: "" }],
      pages: [],
    });
    const mock = createMockServer({
      db: () => mockDb,
      config: () => ({ latency: 0, failEvery: 0 }),
    });
    await mock.request("POST", "/v1/pages", {
      body: {
        id: parent,
        workspace_id: workspace.id,
        parent_id: null,
        title: `Quarterly roadmap ${run}`,
      },
    });
    await mock.request("POST", "/v1/pages", {
      body: { id: child, workspace_id: workspace.id, parent_id: parent, title: `Notes ${run}` },
    });
    await mock.request("PUT", `/v1/pages/${child}/text`, {
      body: { text: `We agreed on the zebra${run} launch plan.` },
    });
    /** @type {any[]} */
    const mockFound = await mock.request(
      "GET",
      `/v1/search?query=${encodeURIComponent(`zebra${run}`)}`,
    );
    assert.deepEqual(
      mockFound.map((r) => [r.id, r.path, r.snippet]),
      byContent.map((/** @type {any} */ r) => [r.id, r.path, r.snippet]),
    );

    // Sharing: a guest whose email the server learned from their session.
    const guest = `user_guest_${run}`;
    const email = `guest-${run}@example.com`;
    const me = await api("GET", "/v1/me", undefined, { user: guest, email: email.toUpperCase() });
    assert.equal(me.email, email);
    await assert.rejects(api("GET", `/v1/pages/${child}`, undefined, { user: guest }), {
      status: 404,
    });
    let sharing = await api("POST", `/v1/pages/${parent}/sharing/invites`, { email, role: "view" });
    const shared = sharing.people.find((/** @type {any} */ p) => p.user_id === guest);
    assert.deepEqual(
      [shared.role, shared.source, shared.guest, shared.email],
      ["view", "page", true, email],
    );
    assert.equal((await api("GET", `/v1/pages/${child}`, undefined, { user: guest })).role, "view");
    assert.deepEqual(
      (await api("GET", "/v1/shared", undefined, { user: guest })).map(
        (/** @type {any} */ p) => p.id,
      ),
      [parent],
    );
    await assert.rejects(api("PATCH", `/v1/pages/${child}`, { title: "x" }, { user: guest }), {
      status: 403,
      code: "read_only",
    });
    // Inherited below, and the keys the panel reads are there.
    sharing = await api("GET", `/v1/pages/${child}/sharing`);
    assert.deepEqual(Object.keys(sharing).sort(), [
      "can_share",
      "invites",
      "page_id",
      "people",
      "public",
      "public_inherited_from",
      "role",
      "workspace",
    ]);
    const below = sharing.people.find((/** @type {any} */ p) => p.user_id === guest);
    assert.deepEqual([below.source, below.inherited_from.id], ["ancestor", parent]);
    // A pending invite, then canceled.
    sharing = await api("POST", `/v1/pages/${parent}/sharing/invites`, {
      email: `later-${run}@example.com`,
      role: "edit",
    });
    assert.deepEqual(
      sharing.invites.map((/** @type {any} */ i) => [i.email, i.role, i.source]),
      [[`later-${run}@example.com`, "edit", "page"]],
    );
    await api(
      "DELETE",
      `/v1/pages/${parent}/sharing/invites/${encodeURIComponent(`later-${run}@example.com`)}`,
    );
    await api("DELETE", `/v1/pages/${parent}/sharing/people/${guest}`);
    await assert.rejects(api("GET", `/v1/pages/${child}`, undefined, { user: guest }), {
      status: 404,
    });

    // The public link: anonymous readers, read-only.
    await assert.rejects(api("GET", `/v1/pages/${child}`, undefined, { user: null }), {
      status: 404,
    });
    sharing = await api("PUT", `/v1/pages/${parent}/sharing/public`, { enabled: true });
    assert.equal(sharing.public, true);
    assert.equal((await api("GET", `/v1/pages/${child}`, undefined, { user: null })).role, "view");
    assert.equal(
      (await api("POST", "/v1/ws-ticket", { page_id: child }, { user: null })).read_only,
      true,
    );
    await assert.rejects(api("GET", "/v1/workspaces", undefined, { user: null }), { status: 401 });

    // Uploads: ask, PUT (as the XMLHttpRequest does), read back without a token.
    const ticket = await api("POST", "/v1/files/upload-url", {
      page_id: child,
      name: "dot.png",
      content_type: "image/png",
      size: PNG.length,
    });
    assert.deepEqual(
      [ticket.method, ticket.headers["Content-Type"], ticket.url],
      ["PUT", "image/png", `/v1/files/${ticket.id}`],
    );
    const put = await fetch(base + ticket.upload_url, {
      method: "PUT",
      headers: ticket.headers,
      body: PNG,
    });
    assert.equal(put.status, 200);
    const file = await fetch(base + ticket.url);
    assert.equal(file.headers.get("Content-Type"), "image/png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);
    // An uploaded image can be the page's icon and cover.
    const page = await api("PATCH", `/v1/pages/${child}`, {
      icon: `file:${ticket.id}`,
      cover: `file:${ticket.id}`,
    });
    assert.deepEqual([page.icon, page.cover], [`file:${ticket.id}`, `file:${ticket.id}`]);
  } finally {
    await backend.stop("SIGTERM");
  }
});
