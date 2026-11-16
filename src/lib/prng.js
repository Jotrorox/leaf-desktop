// @ts-check

/**
 * Seeded pseudo-random numbers for reproducible fuzz tests (mulberry32).
 * Not for anything security-related.
 *
 * @param {number} seed
 */
export function createPrng(seed) {
  let state = seed >>> 0;
  /** A float in [0, 1). */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    /** An integer in [0, max). @param {number} max */
    int: (max) => Math.floor(next() * max),
    /** @template T @param {readonly T[]} items @returns {T} */
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}
