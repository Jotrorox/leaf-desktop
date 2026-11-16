// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, backendDir, databaseUrl, port, server, sleep, USER } from "../../api/test-backend.js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { Doc } from "../model/doc.js";
import { UndoManager } from "../model/undo.js";
import { Awareness } from "./awareness.js";
import { localState, readPeer } from "./presence.js";
import { SyncProvider } from "./provider.js";

/**
 * The sync client against the real Go server and Postgres (M5's "kill the
 * server while typing" check): one client types while the server is
 * restarted gracefully (SIGTERM) and killed (SIGKILL); every keystroke must
 * reach the server and a second client.
 *
 * Skipped unless both are set:
 *
 *   LEAF_BACKEND_DIR=../leaf-backend \
 *   LEAF_INTEROP_DATABASE_URL="postgres:///leaf_interop?host=/tmp" \
 *   node --test src/editor/sync/interop.test.js
 *
 * It builds the backend's test binary and runs its TestInteropServer, which
 * serves the API with the tests' header auth (X-Test-User) instead of Clerk
 * (`src/api/test-backend.js`). LEAF_INTEROP_PORT picks the port (default 8099).
 */

const KEYSTROKES = 300;

/**
 * A document synced with the server, as the editor does it, over Node's
 * WebSocket, with presence. `user` is who's signed in (the server seeds
 * user_1 as the owner, user_2 as an editor and user_viewer as a viewer).
 * @param {string} pageId
 * @param {{ user?: string, readOnly?: boolean }} [options]
 */
function client(pageId, { user = USER, readOnly = false } = {}) {
  const doc = new Doc();
  const stats = { connects: 0 };
  const awareness = new Awareness(doc.clientId);
  const provider = new SyncProvider({
    doc,
    acked: new Map(),
    readOnly,
    awareness,
    connect: async () => {
      stats.connects++;
      const { ticket, read_only } = await api(
        "POST",
        "/v1/ws-ticket",
        { page_id: pageId },
        { user },
      );
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/v1/pages/${pageId}/ws?ticket=${encodeURIComponent(ticket)}`,
      );
      socket.binaryType = "arraybuffer";
      return { socket: /** @type {any} */ (socket), readOnly: read_only };
    },
    saveHttp: async (update, { keepalive }) => {
      const { state_vector } = await api(
        "POST",
        `/v1/pages/${pageId}/doc`,
        { update: bytesToBase64(update) },
        { keepalive, user },
      );
      return base64ToBytes(state_vector);
    },
  });
  const destroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    destroy();
    awareness.destroy();
  };
  return {
    doc,
    provider,
    awareness,
    stats,
    text: () =>
      doc
        .root()
        .map((id) => doc.getText(id))
        .join("\n"),
  };
}

/** @param {() => boolean} check @param {string} what @param {number} [ms] */
async function waitFor(check, what, ms = 30_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test("every keystroke survives a server restart and a crash mid-typing", {
  skip: !backendDir || !databaseUrl,
  timeout: 120_000,
}, async () => {
  const backend = server();
  /** @type {SyncProvider[]} */
  const providers = [];
  await backend.start();
  try {
    const [workspace] = await api("GET", "/v1/workspaces");
    const pageId = `interop-${Date.now().toString(36)}`;
    await api("POST", "/v1/pages", { id: pageId, workspace_id: workspace.id, title: "Interop" });

    const a = client(pageId);
    providers.push(a.provider);
    await waitFor(() => a.provider.connected, "the first connection");
    let block = "";
    a.doc.transact(() => {
      block = a.doc.insertBlock({ type: "p", parent: null });
    }, "local");
    let typed = "";
    for (let i = 0; i < KEYSTROKES; i++) {
      const ch = String.fromCharCode(97 + (i % 26));
      a.doc.transact(() => a.doc.insertText(block, typed.length, ch), "local");
      typed += ch;
      // Each outage hits a live connection (after a restart, the client
      // waits up to 1.5 s before reconnecting), with keystrokes in flight.
      if (i === 100 || i === 200) await waitFor(() => a.provider.connected, "a reconnect");
      if (i === 100) {
        // A deploy: the server commits what it has and closes sockets with 4000.
        await backend.stop("SIGTERM");
        await backend.start();
      } else if (i === 200) {
        // A crash: whatever wasn't committed is lost on the server side; the
        // client still has it as unacknowledged and sends it again.
        await backend.stop("SIGKILL");
        await sleep(300);
        await backend.start();
      }
      await sleep(5);
    }

    await waitFor(
      () => a.provider.connected && !a.provider.dirty,
      "the server to confirm everything",
    );
    assert.equal(a.text(), typed);
    // Both outages really cut the connection.
    assert.ok(a.stats.connects >= 3, `connected ${a.stats.connects} times`);

    const stored = await api("GET", `/v1/pages/${pageId}/doc`);
    const fromServer = Doc.fromSnapshot(base64ToBytes(stored.snapshot), { clientId: 1 });
    assert.equal(fromServer.getText(block), typed);

    const b = client(pageId);
    providers.push(b.provider);
    await waitFor(() => b.provider.connected, "the second connection");
    await waitFor(() => b.text() === typed, "the second client to see everything", 5000);

    // Live: what one types, the other sees.
    a.doc.transact(() => a.doc.insertText(block, typed.length, "!"), "local");
    await waitFor(() => b.text() === typed + "!", "a live update", 5000);
  } finally {
    for (const p of providers) p.destroy();
    await backend.stop("SIGTERM");
  }
});

test("three people on one page: typing converges, presence carries real user ids, undo is per person, viewers can't write", {
  skip: !backendDir || !databaseUrl,
  timeout: 120_000,
}, async () => {
  const backend = server();
  /** @type {SyncProvider[]} */
  const providers = [];
  await backend.start();
  try {
    const [workspace] = await api("GET", "/v1/workspaces");
    const pageId = `collab-${Date.now().toString(36)}`;
    await api("POST", "/v1/pages", { id: pageId, workspace_id: workspace.id, title: "Collab" });

    const owner = client(pageId, { user: "user_1" });
    const editor = client(pageId, { user: "user_2" });
    const viewer = client(pageId, { user: "user_viewer", readOnly: true });
    const people = [owner, editor, viewer];
    providers.push(...people.map((p) => p.provider));
    await waitFor(() => people.every((p) => p.provider.connected), "three connections");

    let block = "";
    owner.doc.transact(() => {
      block = owner.doc.insertBlock({ type: "p", text: "" });
    }, "local");
    await waitFor(() => editor.doc.hasBlock(block), "the paragraph to reach the editor");
    const undo = new UndoManager(editor.doc, { trackedOrigins: ["local"] });

    // Both type in the same paragraph at once.
    for (let i = 0; i < 100; i++) {
      for (const [p, ch] of /** @type {const} */ ([
        [owner, "o"],
        [editor, "e"],
      ])) {
        const at = (i * 7 + (ch === "o" ? 0 : 3)) % (p.doc.textLength(block) + 1);
        p.doc.transact(() => p.doc.insertText(block, at, ch), "local");
        if (p === editor) undo.stopCapturing();
      }
      if (i % 10 === 0) await sleep(5);
    }
    const settled = () =>
      people.every((p) => !p.provider.dirty && p.doc.getText(block) === owner.doc.getText(block));
    await waitFor(settled, "everyone to converge");
    assert.equal(owner.doc.getText(block).length, 200);

    // Presence: everyone sees the others, with the ids the server vouches for.
    for (const p of people) {
      const pos = p.doc.createRelativePosition(block, 10);
      p.awareness.setLocal(
        localState({ id: "", name: "name", image: null }, { anchor: pos, focus: pos }),
      );
    }
    await waitFor(() => people.every((p) => p.awareness.peers.size === 2), "presence");
    const ids = (/** @type {typeof owner} */ p) =>
      [...p.awareness.peers.values()].map((x) => x.user).sort();
    assert.deepEqual(ids(owner), ["user_2", "user_viewer"]);
    assert.deepEqual(ids(viewer), ["user_1", "user_2"]);
    for (const peer of owner.awareness.peers.values()) {
      const cursor = /** @type {NonNullable<ReturnType<typeof readPeer>["cursor"]>} */ (
        readPeer(peer).cursor
      );
      assert.deepEqual(
        owner.doc.resolveRelativePosition(cursor.focus),
        { blockId: block, offset: 10 },
        "cursors line up",
      );
    }

    // The editor's undo takes back only the editor's typing.
    while (undo.canUndo()) undo.undo();
    await waitFor(
      () => settled() && !owner.doc.getText(block).includes("e"),
      "the editor's undo to reach everyone",
    );
    assert.equal(owner.doc.getText(block), "o".repeat(100));

    // The viewer can't write: the socket ignores it, HTTP refuses it.
    viewer.doc.transact(() => viewer.doc.insertText(block, 0, "VIEWER"), "local");
    await assert.rejects(
      api(
        "POST",
        `/v1/pages/${pageId}/doc`,
        { update: bytesToBase64(viewer.doc.encodeDiff()) },
        { user: "user_viewer" },
      ),
      { status: 403, code: "read_only" },
    );
    await assert.rejects(
      api("PATCH", `/v1/pages/${pageId}`, { title: "nope" }, { user: "user_viewer" }),
      { status: 403 },
    );
    const page = await api("GET", `/v1/pages/${pageId}`, undefined, { user: "user_viewer" });
    assert.equal(page.role, "view");
    await sleep(300);
    assert.ok(!owner.doc.getText(block).includes("VIEWER"));

    // Leaving clears presence.
    editor.provider.destroy();
    await waitFor(() => owner.awareness.peers.size === 1, "the editor's presence to go");
    undo.destroy();
  } finally {
    for (const p of providers) p.destroy();
    await backend.stop("SIGTERM");
  }
});
