// @ts-check

/**
 * Fuzzy matching for quick find: does `query` match `text` with its
 * characters in order, and how well? Higher scores are better; null is no
 * match. Pure: runs under `node --test`.
 *
 * What scores: matching at the start of the text, at the start of a word
 * ("mn" in "Meeting notes"), characters in a row, and a short text. Gaps
 * cost a little. Case is ignored, and so are accents ("cafe" finds "Café").
 * Spaces in the query are ignored ("mt n" finds "Meeting notes").
 */

/** @param {string} s */
function fold(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** @param {string} c */
const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);

/**
 * @typedef {object} FuzzyMatch
 * @property {number} score
 * @property {number[]} positions Matched character indexes in `text` (for highlighting).
 */

/**
 * @param {string} query
 * @param {string} text
 * @returns {FuzzyMatch | null}
 */
export function fuzzyMatch(query, text) {
  const q = [...fold(query).replace(/\s+/g, "")];
  // Folding can change the length (ligatures are rare in titles); keep
  // positions on the folded text, which matches the original for most.
  const t = [...fold(text)];
  if (q.length === 0) return { score: 0, positions: [] };
  if (q.length > t.length) return null;

  // Greedy from the left, but prefer a word start when one is ahead: try
  // every start for the first character and keep the best.
  /** @type {FuzzyMatch | null} */
  let best = null;
  for (let start = 0; start <= t.length - q.length; start++) {
    if (t[start] !== q[0]) continue;
    const result = matchFrom(q, t, start);
    if (result && (!best || result.score > best.score)) best = result;
  }
  return best;
}

/**
 * @param {string[]} q @param {string[]} t @param {number} start
 * @returns {FuzzyMatch | null}
 */
function matchFrom(q, t, start) {
  /** @type {number[]} */
  const positions = [start];
  let score = 0;
  let i = start + 1;
  for (let k = 1; k < q.length; k++) {
    // The next occurrence, preferring one at a word start within reach.
    let next = -1;
    let wordStart = -1;
    for (let j = i; j < t.length; j++) {
      if (t[j] !== q[k]) continue;
      if (next < 0) next = j;
      if (j === i) break;
      if (!isWordChar(t[j - 1] ?? " ")) {
        wordStart = j;
        break;
      }
    }
    if (next < 0) return null;
    const at = wordStart >= 0 && next !== i ? wordStart : next;
    positions.push(at);
    i = at + 1;
  }
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k];
    const prev = positions[k - 1];
    if (p === 0) score += 12;
    else if (!isWordChar(t[p - 1])) score += 8;
    if (prev !== undefined && p === prev + 1) score += 5;
    else if (prev !== undefined) score -= Math.min(3, (p - prev - 1) * 0.5);
  }
  // Whole-prefix and exact matches stand out; shorter texts win ties.
  if (positions.every((p, k) => p === k)) score += 10;
  if (positions.length === t.length) score += 10;
  score -= t.length * 0.05;
  return { score, positions };
}

/**
 * Sorts items by how well `query` matches their text, dropping those that
 * don't match. Ties keep the input order (which can carry recency).
 * @template T
 * @param {string} query
 * @param {readonly T[]} items
 * @param {(item: T) => string} textOf
 * @returns {{ item: T, match: FuzzyMatch }[]}
 */
export function fuzzyFilter(query, items, textOf) {
  /** @type {{ item: T, match: FuzzyMatch, index: number }[]} */
  const scored = [];
  items.forEach((item, index) => {
    const match = fuzzyMatch(query, textOf(item));
    if (match) scored.push({ item, match, index });
  });
  scored.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return scored.map(({ item, match }) => ({ item, match }));
}
