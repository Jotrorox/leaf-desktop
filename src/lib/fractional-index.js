// @ts-check

/**
 * Fractional indexing: order keys that always have room for another key
 * between any two, so moving an item only rewrites that item's key.
 * Pure: runs under `node --test`.
 *
 * Keys are strings compared by plain code-unit order (`<` in JS, `COLLATE "C"`
 * or `bytea` order in Postgres; never a locale collation, which would sort
 * "a" and "A" together). A key is an integer part followed by an optional
 * fraction, both in base 62 (`0-9A-Za-z`, already in ASCII order):
 *
 * - The integer part's first character encodes its length. `a`–`z` start
 *   non-negative integers of 1–26 digits; `A`–`Z` start negative ones of
 *   26–1 digits, so every negative integer sorts before every positive one.
 *   `a0` is zero, and the first key ever handed out.
 * - Appending or prepending steps the integer part, so long runs of appends
 *   (the common case) stay short: "a0", "a1", … "az", "b00", ….
 * - Inserting between two keys with the same integer part extends the
 *   fraction by about one character per ~6 inserts at the same spot.
 *
 * A fraction never ends in "0" (so there's always a key before it), and the
 * smallest integer can't be used as a key on its own.
 *
 * This is the scheme from David Greenspan's "Implementing Fractional
 * Indexing" (observablehq.com/@dgreensp/implementing-fractional-indexing).
 * The backend generates positions with the same algorithm; the client only
 * uses it for optimistic positions until the server's answer arrives.
 */

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ZERO = "a0";
const SMALLEST_INTEGER = `A${"0".repeat(26)}`;

/**
 * A key that sorts strictly between `a` and `b`. Pass null for "no bound":
 * `keyBetween(null, null)` is the first key, `keyBetween(last, null)` appends,
 * `keyBetween(null, first)` prepends.
 * @param {string | null} a
 * @param {string | null} b
 * @returns {string}
 */
export function keyBetween(a, b) {
  if (a !== null) assertValidKey(a);
  if (b !== null) assertValidKey(b);
  if (a !== null && b !== null && a >= b)
    throw new RangeError(`keyBetween: "${a}" is not before "${b}"`);

  if (a === null) {
    if (b === null) return ZERO;
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint("", fracB);
    // b has a fraction: its bare integer part sorts before it.
    if (intB < b) return intB;
    const decremented = decrementInteger(intB);
    if (decremented === null) throw new RangeError("keyBetween: no key before the smallest key");
    return decremented;
  }

  const intA = integerPart(a);
  const fracA = a.slice(intA.length);

  if (b === null) {
    const incremented = incrementInteger(intA);
    return incremented === null ? intA + midpoint(fracA, null) : incremented;
  }

  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const incremented = incrementInteger(intA);
  if (incremented === null) throw new RangeError("keyBetween: integer part overflowed");
  return incremented < b ? incremented : intA + midpoint(fracA, null);
}

/**
 * `n` keys in ascending order, all strictly between `a` and `b`. Spreads
 * them out (bisecting) when both bounds are set, so the keys stay short.
 * @param {string | null} a
 * @param {string | null} b
 * @param {number} n
 * @returns {string[]}
 */
export function nKeysBetween(a, b, n) {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`nKeysBetween: n must be a non-negative integer, got ${n}`);
  if (n === 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const keys = [keyBetween(a, null)];
    while (keys.length < n) keys.push(keyBetween(/** @type {string} */ (keys.at(-1)), null));
    return keys;
  }
  if (a === null) {
    const keys = [keyBetween(null, b)];
    while (keys.length < n) keys.push(keyBetween(null, /** @type {string} */ (keys.at(-1))));
    return keys.reverse();
  }
  const half = Math.floor(n / 2);
  const middle = keyBetween(a, b);
  return [...nKeysBetween(a, middle, half), middle, ...nKeysBetween(middle, b, n - half - 1)];
}

/**
 * Whether `key` is a well-formed order key.
 * @param {unknown} key
 * @returns {key is string}
 */
export function isValidKey(key) {
  if (typeof key !== "string" || key === "" || key === SMALLEST_INTEGER) return false;
  const length = integerLength(key[0]);
  if (length === 0 || key.length < length) return false;
  for (const char of key) if (!DIGITS.includes(char)) return false;
  return !key.slice(length).endsWith("0");
}

/** @param {string} key */
function assertValidKey(key) {
  if (!isValidKey(key)) throw new TypeError(`Invalid order key: "${key}"`);
}

/**
 * Length of the integer part (head character included) for a head
 * character, or 0 when it isn't one.
 * @param {string} head
 */
function integerLength(head) {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  return 0;
}

/** @param {string} key */
function integerPart(key) {
  return key.slice(0, integerLength(key[0]));
}

/**
 * A fraction strictly between fractions `a` and `b` (null: no upper
 * bound). Neither may end in "0"; the result doesn't either.
 * @param {string} a
 * @param {string | null} b
 * @returns {string}
 */
function midpoint(a, b) {
  if (b !== null) {
    // Skip the common prefix, treating a missing digit in `a` as "0".
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  // Adjacent digits: take b's first digit if b continues past it (b[0] alone
  // sorts before b), else keep a's digit and recurse into the rest of a.
  if (b !== null && b.length > 1) return b[0];
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * The next integer part, growing to the next length when the digits
 * overflow, or null past the largest one.
 * @param {string} int
 * @returns {string | null}
 */
function incrementInteger(int) {
  const head = int[0];
  const digits = int.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i]) + 1;
    if (next < DIGITS.length) {
      digits[i] = DIGITS[next];
      return head + digits.join("");
    }
    digits[i] = DIGITS[0];
  }
  // Every digit wrapped: move to the next head character.
  if (head === "Z") return `a${DIGITS[0]}`;
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  // Positive integers get one digit longer per head step; negative ones one shorter.
  if (nextHead > "a") digits.push(DIGITS[0]);
  else digits.pop();
  return nextHead + digits.join("");
}

/**
 * The previous integer part, or null before the smallest one.
 * @param {string} int
 * @returns {string | null}
 */
function decrementInteger(int) {
  const head = int[0];
  const digits = int.slice(1).split("");
  const top = DIGITS[DIGITS.length - 1];
  for (let i = digits.length - 1; i >= 0; i--) {
    const previous = DIGITS.indexOf(digits[i]) - 1;
    if (previous >= 0) {
      digits[i] = DIGITS[previous];
      return head + digits.join("");
    }
    digits[i] = top;
  }
  if (head === "a") return `Z${top}`;
  if (head === "A") return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < "Z") digits.push(top);
  else digits.pop();
  return previousHead + digits.join("");
}
