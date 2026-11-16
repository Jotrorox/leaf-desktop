// @ts-check
import { getDoc } from "../api/docs.js";
import { onClearLocalData } from "../auth/local-data.js";
import { prefetchChildren, prefetchPage, prefetchWorkspaces } from "../data/pages.js";
import { Doc } from "../editor/model/doc.js";
import { writeCachedDoc } from "../editor/sync/cache.js";
import { openDatabase, request } from "../lib/idb.js";

/**
 * Keeps a local copy of the whole workspace, so every note opens instantly,
 * and offline too: a quiet background walk of the page tree that caches
 * each level, each page's details, and each page's document (in the same
 * IndexedDB store the editor opens pages from, `editor/sync/cache.js`).
 *
 * A document that's already cached is refreshed only when its copy is old;
 * an open page keeps its own copy current through live sync anyway. Runs a
 * few requests at a time, after launch and when coming back online, and
 * stops on sign-out.
 */

/** Pages walked per run, at most. */
const MAX_PAGES = 2_000;
/** Requests at a time. */
const CONCURRENCY = 3;
/** Cached documents older than this are fetched again. */
const REFRESH_AFTER = 6 * 60 * 60_000;
/** Wait after launch, so the first screen gets the network to itself. */
const START_DELAY = 2_500;
/** And again at most this often. */
const RERUN_EVERY = 30 * 60_000;

let generation = 0;
let running = false;
let lastRun = 0;

onClearLocalData(() => {
  generation++;
  lastRun = 0;
});

/**
 * Starts warming the cache (soon), and again on reconnect.
 * @returns {() => void} Stops.
 */
export function startBackgroundSync() {
  const timer = setTimeout(() => void run(), START_DELAY);
  const onOnline = () => {
    if (Date.now() - lastRun > 60_000) void run();
  };
  const interval = setInterval(() => void run(), RERUN_EVERY);
  window.addEventListener("online", onOnline);
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener("online", onOnline);
    generation++;
  };
}

async function run() {
  if (running || !navigator.onLine) return;
  running = true;
  lastRun = Date.now();
  const mine = generation;
  const stale = () => generation !== mine;
  try {
    const workspaces = await prefetchWorkspaces();
    const savedAt = await cachedDocTimes();
    for (const workspace of workspaces ?? []) {
      if (stale()) return;
      await walk(workspace.id, savedAt, stale);
    }
  } catch (err) {
    // Offline or signed out mid-way: the next run picks it up.
    if (!stale()) console.debug("Background sync stopped:", err);
  } finally {
    running = false;
  }
}

/**
 * Breadth-first over the tree, with a small pool of workers.
 * @param {string} workspaceId
 * @param {Map<string, number>} savedAt When each page's document was cached.
 * @param {() => boolean} stale
 */
async function walk(workspaceId, savedAt, stale) {
  /** @type {(string | null)[]} */
  const parents = [null];
  /** @type {import("../api/types.js").TreeNode[]} */
  const pages = [];
  let seen = 0;

  const worker = async () => {
    while (!stale()) {
      const parent = parents.shift();
      if (parent !== undefined) {
        const children = await prefetchChildren(workspaceId, parent).catch(() => []);
        for (const node of children) {
          if (seen >= MAX_PAGES) break;
          seen++;
          pages.push(node);
          if (node.has_children) parents.push(node.id);
        }
        continue;
      }
      const page = pages.shift();
      if (!page) return;
      await prefetchPage(page.id).catch(() => {});
      if ((page.kind ?? "page") === "page") await cacheDoc(page.id, savedAt, stale).catch(() => {});
    }
  };

  // Levels are found while pages are fetched, so workers keep going until
  // both queues stay empty.
  while (!stale() && (parents.length > 0 || pages.length > 0)) {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }
}

/**
 * Caches a page's document unless a recent copy is there.
 * @param {string} pageId
 * @param {Map<string, number>} savedAt
 * @param {() => boolean} stale Signed out meanwhile: write nothing back.
 */
async function cacheDoc(pageId, savedAt, stale) {
  const saved = savedAt.get(pageId);
  if (saved !== undefined && Date.now() - saved < REFRESH_AFTER) return;
  const snapshot = await getDoc(pageId);
  if (!snapshot || stale()) return;
  const doc = Doc.fromSnapshot(snapshot);
  // Everything in it came from the server, so the server has all of it.
  await writeCachedDoc(pageId, doc, doc.stateVector());
}

/** When each cached document was saved, by page id. */
async function cachedDocTimes() {
  /** @type {Map<string, number>} */
  const times = new Map();
  try {
    const database = await openDatabase("leaf.docs", 1, (db) => {
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
    });
    const store = database.transaction("docs", "readonly").objectStore("docs");
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    keys.forEach((key, i) => {
      const value = /** @type {{ savedAt?: number } | undefined} */ (values[i]);
      if (typeof key === "string") times.set(key, value?.savedAt ?? 0);
    });
  } catch {
    // No cache yet.
  }
  return times;
}
