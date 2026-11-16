// @ts-check
import { createComputed, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { hashKey } from "./key.js";
import { createMutation as createCoreMutation } from "./mutation.js";

/**
 * Solid bindings for a query client from `core.js`. All the logic lives in
 * the core; this only turns cache state into signals and ties observation
 * to component lifetimes.
 */

/** @typedef {import("./key.js").QueryKey} QueryKey */
/** @typedef {import("./core.js").QueryClient} QueryClient */
/** @typedef {import("./core.js").QueryState} QueryState */

/**
 * @template T
 * @typedef {object} QueryResult
 * @property {import("solid-js").Accessor<T | undefined>} data
 * @property {import("solid-js").Accessor<unknown>} error The last fetch's error; data may still be there (stale).
 * @property {import("solid-js").Accessor<boolean>} loading No data yet, and no error: the first load.
 * @property {import("solid-js").Accessor<boolean>} fetching Any request in flight, background refetches included.
 * @property {() => Promise<T | undefined>} refetch Fetches again, ignoring freshness.
 */

/**
 * @template V, R
 * @typedef {object} MutationHandle
 * @property {(vars: V) => Promise<R | undefined>} mutate Fire and forget: resolves with the result, or undefined after a failure (handled in `onError`).
 * @property {(vars: V) => Promise<R>} mutateAsync Rejects on failure.
 * @property {import("solid-js").Accessor<boolean>} pending
 */

/** @type {QueryState} */
const EMPTY = Object.freeze({
  data: undefined,
  error: null,
  status: "pending",
  fetching: false,
  updatedAt: 0,
});

/** @param {QueryClient} client */
export function createSolidQuery(client) {
  /** Per-hash version signals for `readQuery`, created on first read. */
  /** @type {Map<string, import("solid-js").Signal<number>>} */
  const versions = new Map();
  client.onChange((hash) => versions.get(hash)?.[1]((version) => version + 1));

  /**
   * Observes `key` while the calling component (or root) lives, and fetches
   * it when it's missing or stale. The key may be reactive; return a falsy
   * value to pause. Entries are shared with every other observer of an
   * equal key.
   *
   * @template T
   * @param {QueryKey | (() => QueryKey | null | undefined | false)} key
   * @param {(context: { key: QueryKey, signal: AbortSignal }) => Promise<T>} fetcher
   * @param {{ staleTime?: number }} [options]
   * @returns {QueryResult<T>}
   */
  function createQuery(key, fetcher, { staleTime = 0 } = {}) {
    const getKey = typeof key === "function" ? key : () => key;
    const [state, setState] = createSignal(EMPTY);

    createComputed(() => {
      const current = getKey();
      if (!current) {
        setState(EMPTY);
        return;
      }
      untrack(() => {
        const stop = client.observe(current, setState);
        setState(client.getState(current));
        client.fetch(current, fetcher, { staleTime }).catch(() => {});
        onCleanup(stop);
      });
    });

    const data = createMemo(() => /** @type {T | undefined} */ (state().data));
    const error = createMemo(() => state().error);
    const loading = createMemo(() => state().data === undefined && state().status === "pending");
    const fetching = createMemo(() => state().fetching);

    return {
      data,
      error,
      loading,
      fetching,
      refetch() {
        const current = untrack(getKey);
        if (!current) return Promise.resolve(undefined);
        return client.fetch(current, fetcher, { force: true });
      },
    };
  }

  /**
   * Reads an entry's data and tracks it, without observing or fetching:
   * the computation re-runs when the entry changes.
   * @template [T=unknown]
   * @param {QueryKey} key
   * @returns {T | undefined}
   */
  function readQuery(key) {
    const hash = hashKey(key);
    let version = versions.get(hash);
    if (!version) {
      version = createSignal(0);
      versions.set(hash, version);
    }
    version[0]();
    return client.getData(key);
  }

  /**
   * A mutation with a `pending` signal. Safe to create at module level.
   * @template V, R
   * @param {import("./mutation.js").MutationOptions<V, R>} options
   * @returns {MutationHandle<V, R>}
   */
  function createMutation(options) {
    const mutation = createCoreMutation(client, options);
    const [pending, setPending] = createSignal(false);
    mutation.subscribe(() => setPending(mutation.pending > 0));
    return {
      mutate: (vars) => mutation.mutate(vars).catch(() => undefined),
      mutateAsync: mutation.mutate,
      pending,
    };
  }

  return { createQuery, readQuery, createMutation };
}
