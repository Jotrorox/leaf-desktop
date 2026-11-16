// @ts-check

/**
 * Query keys are arrays of JSON-like values: `["page", id]`,
 * `["tree", workspaceId, parentId]`. Two keys are the same when they're
 * structurally equal, so `["a", { x: 1, y: 2 }]` and `["a", { y: 2, x: 1 }]`
 * share one cache entry. Pure: runs under `node --test`.
 */

/** @typedef {readonly unknown[]} QueryKey */

/**
 * A stable string for a key: JSON with object keys sorted. `undefined`
 * array items become `null`, as in JSON.
 * @param {QueryKey} key
 * @returns {string}
 */
export function hashKey(key) {
  if (!Array.isArray(key))
    throw new TypeError(`Query keys must be arrays, got ${JSON.stringify(key)}`);
  return JSON.stringify(key, (_, value) => (isPlainObject(value) ? sortedCopy(value) : value));
}

/**
 * Whether `prefix` matches the start of `key`, element by element and
 * structurally. The empty prefix matches every key.
 * @param {QueryKey} prefix
 * @param {QueryKey} key
 */
export function keyStartsWith(key, prefix) {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (hashKey([prefix[i]]) !== hashKey([key[i]])) return false;
  }
  return true;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {Record<string, unknown>} value */
function sortedCopy(value) {
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const name of Object.keys(value).sort()) copy[name] = value[name];
  return copy;
}
