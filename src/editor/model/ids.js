// @ts-check

/**
 * Op ids. Every op (and every character and placement it creates) is named
 * by `(client, clock)`: the author's random client id and a Lamport clock.
 * Ids are totally ordered by clock first, then client, so "newer wins"
 * rules are deterministic on every replica.
 */

/** @typedef {{ client: number, clock: number }} Id */

/** Client ids are random integers in [1, 2^52). 0 is reserved for sentinels. */
export const MAX_CLIENT_ID = 2 ** 52 - 1;

/**
 * A random client id for one editing session. Never reuse one across
 * sessions that may be open at the same time.
 */
export function createClientId() {
  const words = new Uint32Array(2);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(words);
  else {
    words[0] = Math.floor(Math.random() * 2 ** 32);
    words[1] = Math.floor(Math.random() * 2 ** 32);
  }
  // 20 high bits from one word, 32 low bits from the other.
  const id = (words[0] & 0xfffff) * 2 ** 32 + words[1];
  return id === 0 ? 1 : id;
}

/**
 * Compare two ids: negative if `a` is older (smaller), positive if newer.
 *
 * @param {Id} a
 * @param {Id} b
 */
export function compareIds(a, b) {
  return a.clock - b.clock || a.client - b.client;
}

/**
 * The public string form of a block id: client and clock of the block's
 * NEW_BLOCK op in base 36, joined by ":".
 *
 * @param {number} client
 * @param {number} clock
 */
export function blockKey(client, clock) {
  return `${client.toString(36)}:${clock.toString(36)}`;
}

/**
 * Inverse of `blockKey`. Returns null for strings that aren't block ids.
 *
 * @param {string} key
 * @returns {Id | null}
 */
export function parseBlockKey(key) {
  const m = /^([0-9a-z]+):([0-9a-z]+)$/.exec(key);
  if (!m) return null;
  const client = parseInt(m[1], 36);
  const clock = parseInt(m[2], 36);
  if (!Number.isSafeInteger(client) || !Number.isSafeInteger(clock)) return null;
  return { client, clock };
}
