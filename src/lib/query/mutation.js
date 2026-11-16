// @ts-check
import { hashKey } from "./key.js";

/**
 * Mutations with optimistic updates and automatic rollback. Pure, like
 * `core.js`.
 *
 * A mutation's `optimistic(vars, tx)` describes its effect on the cache with
 * `tx.update(key, updater)`; the mutation gets one layer per entry (see
 * `core.js`) that applies all its updates to that entry in order, so the UI
 * updates at once. Then `mutationFn(vars)` runs. When
 * it succeeds the layers are folded into the confirmed data and
 * `onSuccess` can write the server's answer. When it fails the layers are
 * removed, so exactly this mutation's changes disappear (other pending
 * mutations stay), the touched entries are refetched (the server's state
 * is unknown after a failure), and `onError` runs (show a toast).
 *
 * `scope(vars)` names the resources the mutation writes; mutations sharing a
 * scope reach the server one at a time, in the order they were started, so
 * "create page" always lands before "rename that page".
 *
 * If the cache is cleared (sign-out) while the request is in flight, the
 * mutation settles without touching the cache or calling the callbacks.
 */

/** @typedef {import("./key.js").QueryKey} QueryKey */
/** @typedef {import("./core.js").QueryClient} QueryClient */
/** @typedef {import("./core.js").Updater} Updater */

/**
 * @typedef {object} OptimisticTx
 * @property {(key: QueryKey, update: Updater) => void} update Optimistically change one entry.
 * @property {(prefix: QueryKey, update: Updater) => void} updateAll Optimistically change every cached entry under `prefix`.
 * @property {<T = unknown>(key: QueryKey) => T | undefined} get Current data, layers included.
 */

/**
 * @template V, R
 * @typedef {object} MutationOptions
 * @property {(vars: V) => Promise<R>} mutationFn
 * @property {(vars: V, tx: OptimisticTx) => void} [optimistic]
 * @property {(result: R, vars: V) => void} [onSuccess] Runs after the layers are committed; write the server's answer with `client.setData`.
 * @property {(error: unknown, vars: V) => void} [onError] Runs after the rollback.
 * @property {(vars: V) => string | readonly (string | null | undefined)[] | null | undefined} [scope]
 * @property {(vars: V, result: R | undefined) => QueryKey[]} [invalidates] Prefixes to invalidate once it settles, either way.
 */

let nextId = 0;

/**
 * @template V, R
 * @param {QueryClient} client
 * @param {MutationOptions<V, R>} options
 */
export function createMutation(client, options) {
  let pending = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** @param {number} delta */
  function setPending(delta) {
    pending += delta;
    for (const listener of [...listeners]) listener();
  }

  /**
   * Runs the mutation. Rejects with the mutationFn's error after rolling back.
   * @param {V} vars
   * @returns {Promise<R>}
   */
  async function mutate(vars) {
    const id = `mutation:${++nextId}`;
    const epoch = client.epoch;
    /** @type {Map<string, QueryKey>} */
    const layered = new Map();
    /** Every update this mutation made per entry: one layer applies them all, in order. */
    /** @type {Map<string, Updater[]>} */
    const updates = new Map();
    /** @type {OptimisticTx} */
    const tx = {
      update(key, update) {
        const hash = hashKey(key);
        const list = [...(updates.get(hash) ?? []), update];
        const combined =
          list.length === 1
            ? update
            : (/** @type {unknown} */ data) => list.reduce((acc, fn) => fn(acc), data);
        if (client.setLayer(key, id, combined)) {
          updates.set(hash, list);
          layered.set(hash, key);
        }
      },
      updateAll(prefix, update) {
        for (const key of client.keys(prefix)) tx.update(key, update);
      },
      get: (key) => client.getData(key),
    };
    const current = () => client.epoch === epoch;

    setPending(1);
    /** @type {R | undefined} */
    let result;
    try {
      options.optimistic?.(vars, tx);
      result = await client.runInScope(scopesOf(options.scope?.(vars)), () =>
        options.mutationFn(vars),
      );
      if (current()) {
        for (const key of layered.values()) client.commitLayer(key, id);
        try {
          options.onSuccess?.(result, vars);
        } catch (error) {
          client.reportError(error);
        }
      }
      return result;
    } catch (error) {
      if (current()) {
        for (const key of layered.values()) {
          client.removeLayer(key, id);
          void client.invalidate(key);
        }
        try {
          options.onError?.(error, vars);
        } catch (callbackError) {
          client.reportError(callbackError);
        }
      }
      throw error;
    } finally {
      setPending(-1);
      if (current())
        for (const prefix of options.invalidates?.(vars, result) ?? [])
          void client.invalidate(prefix);
    }
  }

  return {
    mutate,
    /** How many runs are in flight. */
    get pending() {
      return pending;
    },
    /**
     * Called whenever `pending` changes.
     * @param {() => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * @param {string | readonly (string | null | undefined)[] | null | undefined} scope
 * @returns {string[]}
 */
function scopesOf(scope) {
  if (!scope) return [];
  const list =
    typeof scope === "string"
      ? [scope]
      : scope.filter((item) => typeof item === "string" && item !== "");
  return [.../** @type {Set<string>} */ (new Set(list))];
}
