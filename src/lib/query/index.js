// @ts-check
import { createQueryClient } from "./core.js";
import { createSolidQuery } from "./solid.js";

/**
 * The app-wide query cache and its Solid bindings. Use these, not
 * `core.js`, in components; tests build their own client.
 *
 * - `createQuery(key, fetcher, { staleTime })` → `{ data, error, loading, fetching, refetch }`
 * - `createMutation({ mutationFn, optimistic, onSuccess, onError, scope, invalidates })`
 * - `invalidate(prefix)`, `mutate(key, updater)`, `clearAll()`
 */

export { hashKey, keyStartsWith } from "./key.js";

/**
 * Desktop: entries are kept for the whole session (and saved to disk, see
 * `persist.js`), so going back to anything already seen is instant.
 */
export const queryClient = createQueryClient({ gcTime: Infinity });

export const { createQuery, readQuery, createMutation } = createSolidQuery(queryClient);

/**
 * Marks entries under `prefix` stale and refetches the observed ones.
 * @param {import("./key.js").QueryKey} [prefix]
 */
export function invalidate(prefix) {
  return queryClient.invalidate(prefix);
}

/**
 * Writes confirmed data for `key`: a value, or a function of the previous one.
 * @param {import("./key.js").QueryKey} key
 * @param {unknown} updater
 */
export function mutate(key, updater) {
  queryClient.setData(key, updater);
}

/** Drops every cached query (sign-out). */
export function clearAll() {
  queryClient.clearAll();
}
