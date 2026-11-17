// @ts-check
import { hashKey, keyStartsWith } from "./key.js";

/**
 * The query cache. Pure: no Solid, no DOM, injectable clock and timers, so
 * it runs under `node --test`. `solid.js` adapts it to signals.
 *
 * One entry per key (keys compared structurally, see `key.js`), shared by
 * every observer of that key:
 *
 * - **Fetching.** `fetch()` starts the entry's fetcher unless the data is
 *   still fresh (`staleTime`) or a request is already in flight, in which
 *   case callers share that request. A fetcher gets an AbortSignal.
 * - **Confirmed data and optimistic layers.** An entry keeps `base` (what
 *   the server last said, or a confirmed write via `setData`) and a stack of
 *   optimistic layers on top: `data` is `base` with every layer's updater
 *   applied, oldest first. A refetch replaces `base` and the pending layers
 *   are re-applied to it, so an optimistic change survives a refetch that
 *   doesn't know about it yet. Removing a layer (rollback) only undoes that
 *   change, not another mutation's that's still pending. Layer updaters must
 *   be pure and idempotent ("set the title to X", "insert P if missing"), and
 *   should return the same object when they change nothing.
 * - **Invalidation.** `invalidate(prefix)` marks matching entries stale and
 *   refetches the ones somebody observes, replacing any request in flight
 *   (whose answer may predate the change).
 * - **Garbage collection.** An entry nobody observes is dropped `gcTime` ms later.
 * - **Scopes.** `runInScope()` runs async work one at a time per scope name
 *   (mutations to the same page, in order); `whenIdle(scope)` lets a fetcher
 *   wait for those writes so it reads its own writes.
 * - **clearAll()** (sign-out) drops everything and bumps `epoch`, so
 *   mutations that settle afterwards don't write the old user's data back.
 */

/** @typedef {import("./key.js").QueryKey} QueryKey */
/** @typedef {"pending" | "success" | "error"} QueryStatus */

/**
 * @typedef {object} QueryState
 * @property {unknown} data Confirmed data with optimistic layers applied; undefined until there is some.
 * @property {unknown} error The last fetch's error, cleared by the next success.
 * @property {QueryStatus} status "pending" until the first fetch settles (or a write).
 * @property {boolean} fetching A request is in flight.
 * @property {number} updatedAt When `base` last changed (ms), 0 if never.
 */

/** @typedef {(context: { key: QueryKey, signal: AbortSignal }) => unknown} Fetcher */
/** @typedef {(data: any) => any} Updater */

/**
 * @typedef {object} Entry
 * @property {QueryKey} key
 * @property {string} hash
 * @property {unknown} base
 * @property {boolean} hasBase
 * @property {{ id: string, update: Updater }[]} layers
 * @property {unknown} data
 * @property {unknown} error
 * @property {QueryStatus} status
 * @property {number} updatedAt
 * @property {boolean} invalidated
 * @property {Fetcher | null} fetcher
 * @property {number} fetchId Bumped by every fetch and by anything that makes the current one obsolete.
 * @property {{ id: number, controller: AbortController, promise: Promise<unknown> } | null} inflight
 * @property {Set<(state: QueryState) => void>} listeners
 * @property {number} observers
 * @property {ReturnType<typeof setTimeout> | undefined} gcTimer
 * @property {boolean} removed
 * @property {QueryState | null} snapshot
 */

/**
 * @typedef {object} QueryClientOptions
 * @property {number} [gcTime] ms an unobserved entry is kept. Default 5 minutes.
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(handle: any) => void} [clearTimer]
 * @property {(error: unknown) => void} [reportError] For errors in updaters and listeners.
 */

/** @type {QueryState} */
const EMPTY_STATE = Object.freeze({
  data: undefined,
  error: null,
  status: "pending",
  fetching: false,
  updatedAt: 0,
});

/** @param {QueryClientOptions} [options] */
export function createQueryClient({
  gcTime = 5 * 60_000,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  reportError = (error) => console.error(error),
} = {}) {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {Set<(hash: string) => void>} */
  const changeListeners = new Set();
  /** @type {Map<string, Promise<void>>} */
  const scopeTails = new Map();
  let epoch = 0;

  /** @param {QueryKey} key @param {string} hash @returns {Entry} */
  function createEntry(key, hash) {
    return {
      key,
      hash,
      base: undefined,
      hasBase: false,
      layers: [],
      data: undefined,
      error: null,
      status: "pending",
      updatedAt: 0,
      invalidated: false,
      fetcher: null,
      fetchId: 0,
      inflight: null,
      listeners: new Set(),
      observers: 0,
      gcTimer: undefined,
      removed: false,
      snapshot: null,
    };
  }

  /** @param {QueryKey} key */
  function find(key) {
    return entries.get(hashKey(key));
  }

  /** @param {QueryKey} key */
  function ensure(key) {
    const hash = hashKey(key);
    let entry = entries.get(hash);
    if (!entry) {
      entry = createEntry(key, hash);
      entries.set(hash, entry);
      scheduleGc(entry);
    }
    return entry;
  }

  /** @param {Entry} entry @returns {QueryState} */
  function stateOf(entry) {
    entry.snapshot ??= {
      data: entry.data,
      error: entry.error,
      status: entry.status,
      fetching: entry.inflight !== null,
      updatedAt: entry.updatedAt,
    };
    return entry.snapshot;
  }

  /** @param {Entry} entry */
  function notify(entry) {
    entry.snapshot = null;
    const state = stateOf(entry);
    for (const listener of [...entry.listeners]) {
      try {
        listener(state);
      } catch (error) {
        reportError(error);
      }
    }
    for (const listener of [...changeListeners]) {
      try {
        listener(entry.hash);
      } catch (error) {
        reportError(error);
      }
    }
  }

  /**
   * Recomputes `data` from `base` and the layers.
   * @param {Entry} entry
   * @returns {boolean} Whether `data` changed.
   */
  function recompute(entry) {
    let data = entry.base;
    for (const layer of entry.layers) {
      try {
        data = layer.update(data);
      } catch (error) {
        reportError(error);
      }
    }
    const changed = data !== entry.data;
    entry.data = data;
    return changed;
  }

  /** @param {Entry} entry */
  function scheduleGc(entry) {
    clearTimer(entry.gcTimer);
    entry.gcTimer = undefined;
    if (entry.observers > 0 || gcTime === Infinity) return;
    entry.gcTimer = setTimer(() => {
      if (entry.observers > 0 || entries.get(entry.hash) !== entry) return;
      entry.inflight?.controller.abort();
      entry.inflight = null;
      entry.fetchId++;
      entry.removed = true;
      entries.delete(entry.hash);
    }, gcTime);
  }

  /**
   * Makes the request in flight (if any) obsolete: it's aborted and its
   * answer ignored.
   * @param {Entry} entry
   */
  function dropInflight(entry) {
    if (!entry.inflight) return;
    entry.inflight.controller.abort();
    entry.inflight = null;
    entry.fetchId++;
  }

  /**
   * What a superseded fetch resolves with: the newer request's result, or
   * the current data.
   * @param {Entry} entry
   */
  function afterSuperseded(entry) {
    if (entry.removed) throw abortError("The query was removed from the cache");
    return entry.inflight ? entry.inflight.promise : entry.data;
  }

  /** @param {Entry} entry @returns {Promise<unknown>} */
  function startFetch(entry) {
    const fetcher = entry.fetcher;
    if (!fetcher) return Promise.reject(new Error(`No fetcher for query ${entry.hash}`));
    dropInflight(entry);
    const id = ++entry.fetchId;
    const controller = new AbortController();
    const inflight = {
      id,
      controller,
      promise: /** @type {Promise<unknown>} */ (Promise.resolve()),
    };
    entry.inflight = inflight;
    // The executor runs the fetcher now; a synchronous throw becomes a rejection.
    const request = new Promise((resolve) =>
      resolve(fetcher({ key: entry.key, signal: controller.signal })),
    );
    inflight.promise = request.then(
      (data) => {
        if (entry.fetchId !== id) return afterSuperseded(entry);
        entry.inflight = null;
        entry.base = data;
        entry.hasBase = true;
        entry.error = null;
        entry.status = "success";
        entry.updatedAt = now();
        entry.invalidated = false;
        recompute(entry);
        notify(entry);
        return entry.data;
      },
      (error) => {
        if (entry.fetchId !== id) return afterSuperseded(entry);
        entry.inflight = null;
        entry.error = error;
        entry.status = "error";
        notify(entry);
        throw error;
      },
    );
    notify(entry);
    return inflight.promise;
  }

  /** @param {Entry} entry @param {number} staleTime */
  function isFresh(entry, staleTime) {
    return entry.status === "success" && !entry.invalidated && now() - entry.updatedAt < staleTime;
  }

  /** @param {Entry} entry */
  function reset(entry) {
    dropInflight(entry);
    entry.fetchId++;
    entry.base = undefined;
    entry.hasBase = false;
    entry.layers = [];
    entry.data = undefined;
    entry.error = null;
    entry.status = "pending";
    entry.updatedAt = 0;
    entry.invalidated = false;
  }

  return {
    /** Bumped by `clearAll()`. Work that started in an older epoch must not write to the cache. */
    get epoch() {
      return epoch;
    },

    /**
     * The entry's current state; `EMPTY_STATE` for keys not in the cache.
     * Snapshots are immutable and shared until the next change.
     * @param {QueryKey} key
     * @returns {QueryState}
     */
    getState(key) {
      const entry = find(key);
      return entry ? stateOf(entry) : EMPTY_STATE;
    },

    /**
     * @template [T=unknown]
     * @param {QueryKey} key
     * @returns {T | undefined}
     */
    getData(key) {
      return /** @type {T | undefined} */ (find(key)?.data);
    },

    /**
     * Keys of the cached entries that start with `prefix`.
     * @param {QueryKey} prefix
     * @returns {QueryKey[]}
     */
    keys(prefix) {
      return [...entries.values()]
        .filter((entry) => keyStartsWith(entry.key, prefix))
        .map((entry) => entry.key);
    },

    /**
     * Keeps the entry alive and, with a listener, reports every change to it.
     * @param {QueryKey} key
     * @param {(state: QueryState) => void} [listener]
     * @returns {() => void} Stops observing.
     */
    observe(key, listener) {
      const entry = ensure(key);
      entry.observers++;
      clearTimer(entry.gcTimer);
      entry.gcTimer = undefined;
      if (listener) entry.listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (listener) entry.listeners.delete(listener);
        entry.observers--;
        if (entry.observers === 0 && entries.get(entry.hash) === entry) scheduleGc(entry);
      };
    },

    /**
     * Calls `listener(hash)` after any entry changes.
     * @param {(hash: string) => void} listener
     * @returns {() => void} Unsubscribes.
     */
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    /**
     * Resolves with the entry's data, fetching only when needed: there's no
     * data yet, it's older than `staleTime` ms, or it was invalidated. A
     * request already in flight is shared, never duplicated. `force`
     * ignores freshness (a manual refresh).
     *
     * @template [T=unknown]
     * @param {QueryKey} key
     * @param {((context: { key: QueryKey, signal: AbortSignal }) => T | Promise<T>) | null} [fetcher] Remembered for refetches; can be omitted once set.
     * @param {{ staleTime?: number, force?: boolean }} [options]
     * @returns {Promise<T>}
     */
    fetch(key, fetcher, { staleTime = 0, force = false } = {}) {
      const entry = ensure(key);
      if (fetcher) entry.fetcher = fetcher;
      if (entry.inflight) return /** @type {Promise<T>} */ (entry.inflight.promise);
      if (!force && isFresh(entry, staleTime))
        return Promise.resolve(/** @type {T} */ (entry.data));
      return /** @type {Promise<T>} */ (startFetch(entry));
    },

    /**
     * Writes confirmed data, e.g. the server's answer to a mutation.
     * `updater` gets the current confirmed data (without optimistic layers)
     * and returns the new value. Returning the previous value unchanged
     * (or `undefined` for an entry with no data) is a no-op. Otherwise a
     * request in flight is dropped, since its answer may predate this write.
     * @param {QueryKey} key
     * @param {unknown | Updater} updater A value, or a function of the previous one.
     */
    setData(key, updater) {
      const entry = find(key) ?? null;
      const previous = entry?.hasBase ? entry.base : undefined;
      const next =
        typeof updater === "function" ? /** @type {Updater} */ (updater)(previous) : updater;
      if (entry?.hasBase ? next === previous : next === undefined) return;
      const target = entry ?? ensure(key);
      dropInflight(target);
      target.base = next;
      target.hasBase = true;
      target.error = null;
      target.status = "success";
      target.updatedAt = now();
      target.invalidated = false;
      recompute(target);
      notify(target);
    },

    /**
     * Marks entries whose key starts with `prefix` as stale and refetches
     * the observed ones. A request in flight is replaced by a new one.
     * @param {QueryKey} [prefix] Everything when omitted.
     * @returns {Promise<void>} Resolves when the refetches settle (failures included).
     */
    invalidate(prefix = []) {
      /** @type {Promise<unknown>[]} */
      const refetches = [];
      for (const entry of [...entries.values()]) {
        if (!keyStartsWith(entry.key, prefix)) continue;
        entry.invalidated = true;
        if (entry.observers > 0 && entry.fetcher) refetches.push(startFetch(entry).catch(() => {}));
      }
      return Promise.all(refetches).then(() => {});
    },

    /**
     * Adds or replaces the optimistic layer `id` on an entry (creating the
     * entry if needed). A new layer that changes nothing is discarded
     * unless the entry is still waiting for data, where it may matter once
     * the data arrives.
     * @param {QueryKey} key
     * @param {string} id
     * @param {Updater} update
     * @returns {boolean} Whether the layer is in place (and needs removing or committing later).
     */
    setLayer(key, id, update) {
      const entry = ensure(key);
      const index = entry.layers.findIndex((layer) => layer.id === id);
      if (index >= 0) entry.layers[index] = { id, update };
      else entry.layers.push({ id, update });
      const changed = recompute(entry);
      if (!changed && index < 0 && entry.hasBase && !entry.inflight) {
        entry.layers.pop();
        return false;
      }
      if (changed) notify(entry);
      return true;
    },

    /**
     * Removes the optimistic layer `id` (rollback).
     * @param {QueryKey} key
     * @param {string} id
     */
    removeLayer(key, id) {
      const entry = find(key);
      if (!entry) return;
      const before = entry.layers.length;
      entry.layers = entry.layers.filter((layer) => layer.id !== id);
      if (entry.layers.length !== before && recompute(entry)) notify(entry);
    },

    /**
     * Folds the optimistic layer `id` into the confirmed data: the server
     * accepted the change. A request that was already in flight is
     * restarted, since its answer may predate the change.
     * @param {QueryKey} key
     * @param {string} id
     */
    commitLayer(key, id) {
      const entry = find(key);
      const layer = entry?.layers.find((item) => item.id === id);
      if (!entry || !layer) return;
      entry.layers = entry.layers.filter((item) => item !== layer);
      let base = entry.base;
      try {
        base = layer.update(entry.base);
      } catch (error) {
        reportError(error);
      }
      if (base !== undefined) {
        entry.base = base;
        if (!entry.hasBase) {
          entry.hasBase = true;
          entry.status = "success";
          entry.updatedAt = now();
        }
      }
      if (entry.inflight && entry.fetcher) void startFetch(entry).catch(() => {});
      if (recompute(entry)) notify(entry);
    },

    /**
     * Runs `fn` after every earlier task in any of `scopes` has settled.
     * Tasks in different scopes run concurrently.
     * @template T
     * @param {string[]} scopes
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    runInScope(scopes, fn) {
      const previous = scopes
        .map((scope) => scopeTails.get(scope))
        .filter((tail) => tail !== undefined);
      const run = (previous.length ? Promise.all(previous) : Promise.resolve()).then(fn);
      const tail = run.then(
        () => {},
        () => {},
      );
      for (const scope of scopes) scopeTails.set(scope, tail);
      void tail.then(() => {
        for (const scope of scopes) if (scopeTails.get(scope) === tail) scopeTails.delete(scope);
      });
      return run;
    },

    /**
     * Resolves once no task is running or queued in `scope`. Fetchers await
     * this to read their own writes. Don't await it from a task in the same
     * scope: it would wait for itself.
     * @param {string} scope
     * @returns {Promise<void>}
     */
    whenIdle(scope) {
      const tail = scopeTails.get(scope);
      return tail ? tail.then(() => this.whenIdle(scope)) : Promise.resolve();
    },

    /**
     * Drops all cached data (sign-out). Requests in flight are aborted.
     * Observed entries are reset in place, so their observers see empty
     * data instead of being cut off; the rest are deleted.
     */
    clearAll() {
      epoch++;
      scopeTails.clear();
      for (const entry of [...entries.values()]) {
        clearTimer(entry.gcTimer);
        entry.gcTimer = undefined;
        reset(entry);
        if (entry.observers > 0) {
          notify(entry);
        } else {
          entry.removed = true;
          entries.delete(entry.hash);
        }
      }
    },

    /**
     * The confirmed data of every entry that has some, newest first (at most
     * `limit`), for saving to disk. Optimistic layers are left out: they're
     * changes still on their way to the server.
     * @param {number} [limit]
     * @returns {{ key: QueryKey, data: unknown, updatedAt: number }[]}
     */
    dehydrate(limit = Infinity) {
      return [...entries.values()]
        .filter((entry) => entry.hasBase && entry.base !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((entry) => ({ key: entry.key, data: entry.base, updatedAt: entry.updatedAt }));
    },

    /**
     * One entry's confirmed data, as `dehydrate` gives it, or null when it
     * has none or isn't cached. For saving entries one at a time, as
     * `onChange` reports them.
     * @param {string} hash
     * @returns {{ key: QueryKey, data: unknown, updatedAt: number } | null}
     */
    dehydrateEntry(hash) {
      const entry = entries.get(hash);
      if (!entry?.hasBase || entry.base === undefined) return null;
      return { key: entry.key, data: entry.base, updatedAt: entry.updatedAt };
    },

    /**
     * Seeds the cache with saved data (from `dehydrate`). Each restored
     * entry counts as stale: it shows at once, and the first observer
     * refetches it. Entries that already have data are left alone.
     * @param {{ key: QueryKey, data: unknown, updatedAt: number }[]} saved
     */
    hydrate(saved) {
      for (const item of saved) {
        if (!Array.isArray(item?.key) || item.data === undefined) continue;
        const entry = ensure(item.key);
        if (entry.hasBase || entry.inflight) continue;
        entry.base = item.data;
        entry.hasBase = true;
        entry.status = "success";
        entry.updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : 0;
        entry.invalidated = true;
        recompute(entry);
        notify(entry);
      }
    },

    /** Number of cached entries; for tests and debugging. */
    get size() {
      return entries.size;
    },

    reportError,
  };
}

/** @typedef {ReturnType<typeof createQueryClient>} QueryClient */

/** @param {string} message */
function abortError(message) {
  return new DOMException(message, "AbortError");
}
