// @ts-check

/**
 * Type-ahead for lists (menus, later the page tree). Pure, so it runs under
 * `node --test`.
 *
 * Typing a single letter jumps to the next item that starts with it, and
 * typing the same letter again cycles through those items. Typing several
 * letters quickly ("se") searches for that prefix from the current item on,
 * so the current item stays selected while it still matches.
 *
 * @param {readonly string[]} labels Item labels, in order.
 * @param {number} current Index of the focused item, or -1.
 * @param {string} typed Everything typed since the buffer last reset.
 * @returns {number} Index of the match, or -1.
 */
export function findTypeaheadMatch(labels, current, typed) {
  const query = typed.toLowerCase();
  if (!query || !labels.length) return -1;
  const repeated = [...query].every((char) => char === query[0]);
  const prefix = repeated ? query[0] : query;
  // A fresh or repeated letter starts after the current item; a longer prefix starts at it.
  const start = repeated ? current + 1 : Math.max(current, 0);
  for (let i = 0; i < labels.length; i++) {
    const index = (start + i) % labels.length;
    if (labels[index].trim().toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}

/**
 * Keeps the typed buffer and resets it after a pause.
 * @param {number} [timeout] ms of inactivity before the buffer resets
 */
export function createTypeaheadBuffer(timeout = 500) {
  let typed = "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return {
    /** Appends a character and returns the whole buffer. @param {string} char */
    push(char) {
      clearTimeout(timer);
      timer = setTimeout(() => (typed = ""), timeout);
      typed += char;
      return typed;
    },
    /** True while a search is in progress, so Space can count as a character. */
    get active() {
      return typed !== "";
    },
    reset() {
      clearTimeout(timer);
      typed = "";
    },
  };
}
