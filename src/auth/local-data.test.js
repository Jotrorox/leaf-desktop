// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearLocalData,
  clearStorageKeys,
  deleteAppDatabases,
  onClearLocalData,
} from "./local-data.js";

/** A Map-backed stand-in for Storage. @param {Record<string, string>} entries */
function fakeStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    /** @param {number} i */
    key: (i) => [...map.keys()][i] ?? null,
    /** @param {string} key */
    removeItem: (key) => void map.delete(key),
  };
}

/** @param {string[]} names @param {"success" | "blocked" | "error"} [outcome] */
function fakeIdb(names, outcome = "success") {
  /** @type {string[]} */
  const deleted = [];
  return {
    deleted,
    databases: async () => names.map((name) => ({ name, version: 1 })),
    /** @param {string} name */
    deleteDatabase(name) {
      deleted.push(name);
      /** @type {any} */
      const request = {};
      queueMicrotask(() => request[`on${outcome}`]?.());
      return request;
    },
  };
}

test("clearStorageKeys removes only app keys", () => {
  const storage = fakeStorage({
    "leaf.sidebar": "{}",
    "leaf.theme": '"dark"',
    __clerk_db_jwt: "x",
    other: "y",
  });

  const removed = clearStorageKeys(storage);

  assert.deepEqual(removed.sort(), ["leaf.sidebar", "leaf.theme"]);
  assert.deepEqual([...storage.map.keys()].sort(), ["__clerk_db_jwt", "other"]);
});

test("deleteAppDatabases deletes only app databases, and doesn't hang when blocked", async () => {
  const idb = fakeIdb(["leaf.docs", "leaf.outbox", "someone-else"], "blocked");

  const deleted = await deleteAppDatabases(/** @type {any} */ (idb));

  assert.deepEqual(deleted, ["leaf.docs", "leaf.outbox"]);
  assert.deepEqual(idb.deleted, ["leaf.docs", "leaf.outbox"]);
});

test("clearLocalData runs registered cleanups and clears every store, even if one step fails", async () => {
  const local = fakeStorage({ "leaf.sidebar": "{}" });
  const session = fakeStorage({ "leaf.router.scroll": "[]" });
  const idb = fakeIdb(["leaf.docs"]);
  let ran = 0;
  const offs = [
    onClearLocalData(() => {
      throw new Error("broken cache");
    }),
    onClearLocalData(async () => {
      ran++;
    }),
  ];
  const realError = console.error;
  console.error = () => {};
  try {
    await clearLocalData({ storages: [local, session], idb: /** @type {any} */ (idb) });
  } finally {
    console.error = realError;
    for (const off of offs) off();
  }

  assert.equal(ran, 1);
  assert.equal(local.map.size, 0);
  assert.equal(session.map.size, 0);
  assert.deepEqual(idb.deleted, ["leaf.docs"]);
});
