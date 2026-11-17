// @ts-check

/**
 * A least-recently-used map with a size budget: once the entries' total
 * size passes `maxSize` (or their count passes `maxEntries`), the least
 * recently used ones are dropped. `get` counts as a use. An entry larger
 * than the whole budget isn't kept at all.
 *
 * Pure: runs under `node --test`.
 *
 * @template K, V
 */
export class LruCache {
  /** @type {Map<K, { value: V, size: number }>} */
  #map = new Map();
  #size = 0;

  /**
   * @param {{ maxSize?: number, maxEntries?: number, sizeOf?: (value: V) => number }} [options]
   *   `sizeOf` defaults to 1 per entry.
   */
  constructor({ maxSize = Infinity, maxEntries = Infinity, sizeOf = () => 1 } = {}) {
    this.maxSize = maxSize;
    this.maxEntries = maxEntries;
    this.sizeOf = sizeOf;
  }

  /** @param {K} key */
  has(key) {
    return this.#map.has(key);
  }

  /** @param {K} key @returns {V | undefined} */
  get(key) {
    const item = this.#map.get(key);
    if (!item) return undefined;
    this.#map.delete(key);
    this.#map.set(key, item);
    return item.value;
  }

  /** The value without counting it as a use. @param {K} key @returns {V | undefined} */
  peek(key) {
    return this.#map.get(key)?.value;
  }

  /** @param {K} key @param {V} value */
  set(key, value) {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxSize) return;
    this.#map.set(key, { value, size });
    this.#size += size;
    while (this.#size > this.maxSize || this.#map.size > this.maxEntries) {
      const oldest = /** @type {K} */ (this.#map.keys().next().value);
      this.delete(oldest);
    }
  }

  /** @param {K} key */
  delete(key) {
    const item = this.#map.get(key);
    if (!item) return false;
    this.#map.delete(key);
    this.#size -= item.size;
    return true;
  }

  clear() {
    this.#map.clear();
    this.#size = 0;
  }

  /** Number of entries. */
  get count() {
    return this.#map.size;
  }

  /** Total size of the entries. */
  get size() {
    return this.#size;
  }
}
