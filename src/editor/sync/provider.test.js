// @ts-check
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError } from "../../api/client.js";
import { createDb } from "../../api/mock/db.js";
import { seedState } from "../../api/mock/seed.js";
import { createMockSync } from "../../api/mock/sync.js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { Doc } from "../model/doc.js";
import { SyncProvider } from "./provider.js";

const PAGE = "pg_tasks";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Every provider a test made, stopped after it (also when it fails, so no timers keep the process alive). */
/** @type {SyncProvider[]} */
const providers = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.destroy();
});

/**
 * A mock backend with a network switch.
 * @param {{ maxDocSize?: number }} [options]
 */
function backend(options = {}) {
  let offline = false;
  let db = createDb(seedState(new Date("2026-10-12T12:00:00Z")), options);
  const sync = createMockSync({ db: () => db, offline: () => offline });
  return {
    sync,
    get db() {
      return db;
    },
    /** @param {boolean} value */
    setOffline(value) {
      offline = value;
      if (value) sync.dropAll();
    },
    /** Lose everything stored (a server restored from an old backup). */
    wipe() {
      db = createDb(seedState(new Date("2026-10-12T12:00:00Z")), options);
    },
    /** @param {Uint8Array} update */
    async saveHttp(update) {
      if (offline) throw new ApiError(0, "network_error", "offline");
      return base64ToBytes(db.saveDoc(PAGE, { update: bytesToBase64(update) }).state_vector);
    },
    /** The stored document's text, block by block. */
    text() {
      const { snapshot } = db.getDoc(PAGE);
      if (!snapshot) return [];
      const doc = Doc.fromSnapshot(base64ToBytes(snapshot), { clientId: 1 });
      return doc.root().map((id) => doc.getText(id));
    },
  };
}

/**
 * A client: a document and its provider.
 * @param {ReturnType<typeof backend>} server
 * @param {{ doc?: Doc, acked?: Map<number, number> }} [from]
 */
function client(server, from = {}) {
  const doc = from.doc ?? new Doc();
  /** @type {string[]} */
  const statuses = [];
  const events = { readOnly: 0, gone: 0, tooLarge: 0 };
  const provider = new SyncProvider({
    doc,
    acked: from.acked ?? new Map(),
    connect: () => server.sync.connect(PAGE),
    saveHttp: (update) => server.saveHttp(update),
    onStatus: (s) => statuses.push(s),
    onReadOnly: () => events.readOnly++,
    onGone: () => events.gone++,
    onTooLarge: () => events.tooLarge++,
    // Every delay a hundred times shorter.
    setTimer: /** @type {typeof setTimeout} */ ((fn, ms) => setTimeout(fn, (ms ?? 0) / 100)),
  });
  providers.push(provider);
  return {
    doc,
    provider,
    statuses,
    events,
    /** @param {string} text */
    write(text) {
      doc.transact(() => {
        const id = doc.insertBlock({ type: "p", parent: null });
        doc.insertText(id, 0, text);
      }, "local");
    },
    texts: () => doc.root().map((id) => doc.getText(id)),
  };
}

/** Wait until `check` passes (or fail after a second). @param {() => void} check */
async function eventually(check) {
  const until = Date.now() + 1000;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await sleep(5);
    }
  }
}

test("changes reach the server and the other client, and get acknowledged", async () => {
  const server = backend();
  const a = client(server);
  const b = client(server);
  await eventually(() => assert.equal(a.provider.connected && b.provider.connected, true));
  a.write("from a");
  await eventually(() => assert.deepEqual(b.texts(), ["from a"]));
  await eventually(() => assert.equal(a.provider.dirty, false));
  assert.equal(a.provider.status, "saved");
  assert.deepEqual(server.text(), ["from a"]);
  b.write("from b");
  await eventually(() => assert.deepEqual(a.texts().sort(), ["from a", "from b"]));
  a.provider.destroy();
  b.provider.destroy();
});

test("others' changes count as on the server: receiving them leaves nothing to send", async () => {
  const server = backend();
  const a = client(server);
  const b = client(server);
  await eventually(() => assert.equal(a.provider.connected && b.provider.connected, true));
  a.write("from a");
  await eventually(() => assert.deepEqual(b.texts(), ["from a"]));
  // B never sends anything, so it never gets an ACK; still, nothing is unsaved.
  assert.equal(b.provider.dirty, false);
  assert.deepEqual(b.provider.acked, a.doc.stateVector());
  // And a newcomer whose SYNC brings A's change has nothing to send either.
  const c = client(server);
  await eventually(() => assert.deepEqual(c.texts(), ["from a"]));
  assert.equal(c.provider.dirty, false);
});

test("a client that joins later gets everything in SYNC", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  a.write("one");
  a.write("two");
  await eventually(() => assert.equal(a.provider.dirty, false));
  const b = client(server);
  await eventually(() => assert.deepEqual(b.texts(), ["one", "two"]));
  a.provider.destroy();
  b.provider.destroy();
});

test("offline edits are kept, shown as offline, and sent on reconnect", async () => {
  const server = backend();
  const a = client(server);
  const b = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  server.setOffline(true);
  await eventually(() => assert.equal(a.provider.connected, false));
  a.write("typed offline");
  await eventually(() => assert.equal(a.provider.status, "offline"));
  assert.deepEqual(server.text(), []);
  server.setOffline(false);
  a.provider.retryNow();
  b.provider.retryNow();
  await eventually(() => assert.deepEqual(server.text(), ["typed offline"]));
  await eventually(() => assert.deepEqual(b.texts(), ["typed offline"]));
  await eventually(() => assert.equal(a.provider.status, "saved"));
  a.provider.destroy();
  b.provider.destroy();
});

test("unconfirmed edits survive a crash through the cached document and acked state", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  a.write("confirmed");
  await eventually(() => assert.equal(a.provider.dirty, false));
  const cachedAcked = a.provider.acked;
  server.setOffline(true);
  await eventually(() => assert.equal(a.provider.connected, false));
  a.write("never confirmed");
  // The tab dies: only the cache is left (the document, and what was acked).
  const cached = a.doc.encodeSnapshot();
  a.provider.destroy();
  server.setOffline(false);
  const reopened = client(server, { doc: Doc.fromSnapshot(cached), acked: cachedAcked });
  await eventually(() => assert.deepEqual(server.text(), ["confirmed", "never confirmed"]));
  await eventually(() => assert.equal(reopened.provider.dirty, false));
  reopened.provider.destroy();
});

test("a server restart (close 4000) loses nothing typed meanwhile", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  for (let i = 0; i < 5; i++) {
    a.write(`line ${i}`);
    if (i === 2) {
      server.sync.dropAll();
    }
    await sleep(1);
  }
  await eventually(() => assert.equal(server.text().length, 5));
  assert.deepEqual(server.text(), ["line 0", "line 1", "line 2", "line 3", "line 4"]);
  a.provider.destroy();
});

test("a gap (the server lost something) is repaired by resending everything it lacks", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  a.write("base");
  await eventually(() => assert.equal(a.provider.dirty, false));
  server.wipe();
  // A change that builds on "base", which the server no longer has.
  const id = a.doc.root()[0];
  a.doc.transact(() => a.doc.insertText(id, 4, "!"), "local");
  await eventually(() => assert.deepEqual(server.text(), ["base!"]));
  a.provider.destroy();
});

test("the trash makes the page read-only; the HTTP fallback saves while the socket is down", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  // Sockets can't connect, but HTTP works: changes are still saved.
  const realConnect = server.sync.connect;
  server.sync.connect = async () => {
    throw new ApiError(0, "network_error", "blocked");
  };
  server.sync.dropAll();
  await eventually(() => assert.equal(a.provider.connected, false));
  a.write("over http");
  await eventually(() => assert.deepEqual(server.text(), ["over http"]));
  await eventually(() => assert.equal(a.provider.status, "saved"));
  server.sync.connect = realConnect;
  a.provider.retryNow();
  await eventually(() => assert.equal(a.provider.connected, true));
  server.db.trashPage(PAGE);
  server.sync.refresh();
  await eventually(() => assert.equal(a.events.readOnly, 1));
  assert.equal(a.provider.status, "error");
  a.provider.destroy();
});

test("while sockets are blocked but HTTP saves work, the status stays saved", async () => {
  const server = backend();
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  server.sync.connect = async () => {
    throw new ApiError(0, "network_error", "blocked");
  };
  server.sync.dropAll();
  await eventually(() => assert.equal(a.provider.connected, false));
  a.write("over http");
  await eventually(() => assert.equal(a.provider.status, "saved"));
  // Reconnect attempts keep failing meanwhile (every few ms at this speed).
  const from = a.statuses.length;
  await sleep(150);
  assert.deepEqual(a.statuses.slice(from), []);
  assert.equal(a.provider.status, "saved");
  // A failed HTTP save does mean offline.
  server.setOffline(true);
  a.write("typed offline");
  await eventually(() => assert.equal(a.provider.status, "offline"));
});

test("a document the server refuses as too large stops the saving and says so", async () => {
  const server = backend({ maxDocSize: 2000 });
  const a = client(server);
  await eventually(() => assert.equal(a.provider.connected, true));
  a.write("x".repeat(3000));
  // The server closes the socket with 4413; reconnecting can't help.
  await eventually(() => assert.equal(a.events.tooLarge, 1));
  assert.equal(a.provider.status, "error");
  await sleep(100);
  assert.equal(a.provider.connected, false);
  assert.equal(a.events.tooLarge, 1);
  assert.deepEqual(server.text(), []);
  assert.deepEqual(a.texts(), ["x".repeat(3000)]);
});

test("a too-large refusal over HTTP stops the saving too", async () => {
  const server = backend({ maxDocSize: 2000 });
  server.sync.connect = async () => {
    throw new ApiError(0, "network_error", "blocked");
  };
  const a = client(server);
  a.write("x".repeat(3000));
  await eventually(() => assert.equal(a.events.tooLarge, 1));
  assert.equal(a.provider.status, "error");
});
