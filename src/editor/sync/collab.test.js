// @ts-check
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createDb } from "../../api/mock/db.js";
import { seedState } from "../../api/mock/seed.js";
import { createMockSync } from "../../api/mock/sync.js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { createPrng } from "../../lib/prng.js";
import { Doc } from "../model/doc.js";
import { UndoManager } from "../model/undo.js";
import { Awareness } from "./awareness.js";
import { localState, readPeer } from "./presence.js";
import { SyncProvider } from "./provider.js";

/**
 * M6's "done when", in Node: three clients typing in the same paragraph
 * through the mock server, with latency and messages overtaking each other,
 * converge; their cursors resolve to the same spots everywhere; and each
 * one's undo touches only its own edits.
 */

const PAGE = "pg_tasks";
const LOCAL = "local";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @type {(() => void)[]} */
const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** @param {{ latency?: number, jitter?: number, seed?: number }} [options] */
function backend({ latency = 20, jitter = 40, seed = 1 } = {}) {
  const db = createDb(seedState(new Date("2026-10-12T12:00:00Z")));
  const prng = createPrng(seed);
  const sync = createMockSync({
    db: () => db,
    latency: () => latency,
    jitter: () => jitter,
    random: prng.next,
  });
  return {
    db,
    sync,
    /** @param {Uint8Array} update */
    async saveHttp(update) {
      return base64ToBytes(db.saveDoc(PAGE, { update: bytesToBase64(update) }).state_vector);
    },
    stored() {
      const { snapshot } = db.getDoc(PAGE);
      return snapshot
        ? Doc.fromSnapshot(base64ToBytes(snapshot), { clientId: 1 })
        : new Doc({ clientId: 1 });
    },
  };
}

/**
 * One person's tab: a document, its provider, presence and undo.
 * @param {ReturnType<typeof backend>} server @param {string} userId
 */
function client(server, userId) {
  const doc = new Doc();
  const awareness = new Awareness(doc.clientId);
  const undo = new UndoManager(doc, { trackedOrigins: [LOCAL] });
  const provider = new SyncProvider({
    doc,
    acked: new Map(),
    awareness,
    connect: () => server.sync.connect(PAGE, { userId }),
    saveHttp: (update) => server.saveHttp(update),
    setTimer: /** @type {typeof setTimeout} */ ((fn, ms) => setTimeout(fn, (ms ?? 0) / 10)),
  });
  cleanups.push(() => {
    provider.destroy();
    awareness.destroy();
    undo.destroy();
  });
  return {
    userId,
    doc,
    awareness,
    undo,
    provider,
    /** @param {(doc: Doc) => void} fn */
    edit(fn) {
      doc.transact(() => fn(doc), LOCAL);
      undo.stopCapturing();
    },
  };
}

/** @type {(() => string) | null} */
let debugState = null;
/** @param {() => boolean} check @param {string} what */
async function until(check, what, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${debugState?.() ?? ""}`);
    await sleep(10);
  }
}

/** @param {Doc} doc */
const json = (doc) => JSON.stringify(doc.toJSON());

/** Everyone, and the server, hold the same document. @param {ReturnType<typeof client>[]} clients @param {ReturnType<typeof backend>} server */
function converged(clients, server) {
  debugState = () =>
    [
      `server ${JSON.stringify([...server.stored().stateVector()])}`,
      ...clients.map(
        (c) =>
          `${c.userId} sv=${JSON.stringify([...c.doc.stateVector()])} acked=${JSON.stringify([...c.provider.acked])} dirty=${c.provider.dirty} pending=${c.doc.pendingCount} live=${c.provider.connected} status=${c.provider.status}`,
      ),
    ].join("\n");
  const want = json(server.stored());
  return clients.every(
    (c) => !c.provider.dirty && c.doc.pendingCount === 0 && json(c.doc) === want,
  );
}

test("three clients typing in one paragraph, with latency and reordering, converge", async () => {
  const server = backend({ seed: 7 });
  const [a, b, c] = ["user_a", "user_b", "user_c"].map((id) => client(server, id));
  const clients = [a, b, c];
  await until(() => clients.every((x) => x.provider.connected), "connections");

  /** @type {string} */
  let para = "";
  a.edit((doc) => {
    para = doc.insertBlock({ type: "p", text: "<>" });
  });
  await until(() => clients.every((x) => x.doc.hasBlock(para)), "the paragraph everywhere");

  // Everyone types their own letter at random spots, all at once.
  const prng = createPrng(42);
  const letters = new Map([
    [a, "a"],
    [b, "b"],
    [c, "c"],
  ]);
  for (let round = 0; round < 60; round++) {
    for (const x of clients) {
      const length = x.doc.textLength(para);
      const own = [...x.doc.getText(para)]
        .map((ch, i) => (ch === letters.get(x) ? i : -1))
        .filter((i) => i >= 0);
      if (own.length > 3 && prng.next() < 0.2) {
        const at = prng.pick(own);
        x.edit((doc) => doc.deleteText(para, at, 1));
      } else {
        const at = prng.int(length + 1);
        x.edit((doc) =>
          doc.insertText(para, at, /** @type {string} */ (letters.get(x)).repeat(1 + prng.int(3))),
        );
      }
    }
    if (round % 5 === 0) await sleep(prng.int(15));
  }
  await until(() => converged(clients, server), "convergence");
  const text = a.doc.getText(para);
  assert.ok(text.startsWith("<") || text.includes("<"), "the original text is still there");
  for (const ch of ["a", "b", "c"]) assert.ok(text.includes(ch), `${ch} typed`);

  // Cursors: everyone puts theirs somewhere; everyone else sees it at the same spot.
  /** @type {Map<number, number>} */
  const offsets = new Map();
  for (const x of clients) {
    const offset = prng.int(x.doc.textLength(para) + 1);
    offsets.set(x.doc.clientId, offset);
    const pos = x.doc.createRelativePosition(para, offset);
    x.awareness.setLocal(
      localState(
        { id: x.userId, name: x.userId.toUpperCase(), image: null },
        { anchor: pos, focus: pos },
      ),
    );
  }
  await until(
    () =>
      clients.every(
        (x) =>
          x.awareness.peers.size === 2 &&
          [...x.awareness.peers.values()].every((p) => readPeer(p).cursor),
      ),
    "presence",
  );
  for (const x of clients) {
    for (const peer of x.awareness.peers.values()) {
      const them = readPeer(peer);
      const owner = /** @type {ReturnType<typeof client>} */ (
        clients.find((y) => y.doc.clientId === them.session)
      );
      assert.equal(them.userId, owner.userId, "the server vouches for the user id");
      assert.equal(them.name, owner.userId.toUpperCase());
      const here = x.doc.resolveRelativePosition(
        /** @type {NonNullable<typeof them.cursor>} */ (them.cursor).focus,
      );
      assert.deepEqual(
        here,
        { blockId: para, offset: offsets.get(them.session) },
        "cursors line up",
      );
    }
  }

  // Someone keeps typing elsewhere: cursors stay on their characters.
  b.edit((doc) => doc.insertText(para, 0, "bbbb"));
  await until(() => converged(clients, server), "convergence after more typing");
  for (const x of clients) {
    for (const peer of x.awareness.peers.values()) {
      const them = readPeer(peer);
      const owner = /** @type {ReturnType<typeof client>} */ (
        clients.find((y) => y.doc.clientId === them.session)
      );
      const ownView = owner.doc.resolveRelativePosition(
        /** @type {NonNullable<typeof them.cursor>} */ (them.cursor).focus,
      );
      assert.deepEqual(
        x.doc.resolveRelativePosition(
          /** @type {NonNullable<typeof them.cursor>} */ (them.cursor).focus,
        ),
        ownView,
      );
    }
  }

  // A leaves: the others stop seeing them.
  a.provider.destroy();
  await until(
    () =>
      [b, c].every(
        (x) => ![...x.awareness.peers.values()].some((p) => p.session === a.doc.clientId),
      ),
    "A's presence to go",
  );
});

test("each user's undo touches only their own edits, even while others type", async () => {
  const server = backend({ seed: 3 });
  const [a, b, c] = ["user_a", "user_b", "user_c"].map((id) => client(server, id));
  const clients = [a, b, c];
  await until(() => clients.every((x) => x.provider.connected), "connections");
  /** @type {string} */
  let para = "";
  c.edit((doc) => {
    para = doc.insertBlock({ type: "p", text: "" });
  });
  await until(() => clients.every((x) => x.doc.hasBlock(para)), "the paragraph everywhere");

  const prng = createPrng(9);
  for (let round = 0; round < 30; round++) {
    for (const [x, ch] of /** @type {[ReturnType<typeof client>, string][]} */ ([
      [a, "a"],
      [b, "b"],
    ])) {
      const own = [...x.doc.getText(para)].map((t, i) => (t === ch ? i : -1)).filter((i) => i >= 0);
      if (own.length > 2 && prng.next() < 0.25)
        x.edit((doc) => doc.deleteText(para, prng.pick(own), 1));
      else x.edit((doc) => doc.insertText(para, prng.int(x.doc.textLength(para) + 1), ch));
      if (prng.next() < 0.3)
        x.edit((doc) =>
          doc.format(para, 0, Math.min(1, doc.textLength(para)), "bold", ch === "a" ? true : null),
        );
    }
    if (round % 4 === 0) await sleep(5);
  }
  await until(() => converged(clients, server), "convergence");
  const before = a.doc.getText(para);
  const bs = before.replace(/[^b]/g, "");

  // A undoes everything while B keeps typing.
  let undone = 0;
  while (a.undo.canUndo()) {
    a.undo.undo();
    undone++;
    if (undone % 5 === 0)
      b.edit((doc) => doc.insertText(para, prng.int(doc.textLength(para) + 1), "B"));
  }
  await until(() => converged(clients, server), "convergence after A's undo");
  const after = c.doc.getText(para);
  assert.ok(!after.includes("a"), `A's text is gone: ${JSON.stringify(after)}`);
  assert.equal(after.replace(/[^b]/g, ""), bs, "B's text is untouched");
  assert.equal(
    after.replace(/[^B]/g, "").length,
    Math.floor(undone / 5),
    "what B typed meanwhile is there",
  );

  // B's undo, in turn, leaves nothing of B's (and doesn't bring A's back).
  while (b.undo.canUndo()) b.undo.undo();
  await until(() => converged(clients, server), "convergence after B's undo");
  assert.equal(c.doc.getText(para), "", "only A's and B's typing was there");

  // A's redo brings back exactly A's text.
  while (a.undo.canRedo()) a.undo.redo();
  await until(() => converged(clients, server), "convergence after A's redo");
  assert.equal(c.doc.getText(para), before.replace(/[^a]/g, ""));
});

test("a read-only client gets changes and presence, and shares its presence, but never writes", async () => {
  const server = backend({ jitter: 0 });
  const editor = client(server, "user_editor");
  const viewerDoc = new Doc();
  const viewerAwareness = new Awareness(viewerDoc.clientId);
  /** @type {Uint8Array[]} */
  const httpSaves = [];
  const viewer = new SyncProvider({
    doc: viewerDoc,
    acked: new Map(),
    readOnly: true,
    awareness: viewerAwareness,
    connect: () => server.sync.connect(PAGE, { userId: "user_viewer" }),
    saveHttp: async (update) => {
      httpSaves.push(update);
      return new Uint8Array([1, 3, 0]);
    },
  });
  cleanups.push(() => {
    viewer.destroy();
    viewerAwareness.destroy();
  });
  viewerAwareness.setLocal({ name: "Viewer", image: null, cursor: null });
  editor.awareness.setLocal({ name: "Editor", image: null, cursor: null }); // takes part, so it hears the viewer
  await until(() => editor.provider.connected && viewer.connected, "connections");

  /** @type {string} */
  let para = "";
  editor.edit((doc) => {
    para = doc.insertBlock({ type: "p", text: "live" });
  });
  await until(
    () => viewerDoc.hasBlock(para) && viewerDoc.getText(para) === "live",
    "the viewer to get the change",
  );
  await until(() => editor.awareness.peers.size === 1, "the editor to see the viewer");
  assert.equal([...editor.awareness.peers.values()][0].user, "user_viewer");

  // Whatever the viewer's document holds, it isn't sent.
  viewerDoc.transact(() => viewerDoc.insertText(para, 0, "nope "), LOCAL);
  await sleep(100);
  assert.equal(viewer.dirty, false);
  assert.equal(httpSaves.length, 0);
  assert.equal(server.stored().getText(para), "live");
});

test("a client that never sends presence never gets any (clients from before presence)", async () => {
  const server = backend({ jitter: 0 });
  const modern = client(server, "user_new");
  /** @type {string[]} */
  const types = [];
  const { socket } = await server.sync.connect(PAGE, { userId: "user_old" });
  socket.onopen = () => socket.send(new Uint8Array([1, 1, 3, 0])); // HELLO, empty state vector
  socket.onmessage = (event) => types.push(String(/** @type {Uint8Array} */ (event.data)[0]));
  await until(() => modern.provider.connected && types.length > 0, "both connections");
  modern.awareness.setLocal({ name: "New", image: null, cursor: null });
  modern.edit((doc) => doc.insertBlock({ type: "p", text: "hi" }));
  await until(() => types.includes("3"), "the old client to get the update");
  await sleep(100);
  assert.ok(!types.includes("6"), `the old client got ${types.join(",")}`);
  socket.close();
});
