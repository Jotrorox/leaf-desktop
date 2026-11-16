// @ts-check
import { hasText } from "../blocks/schema.js";

/**
 * A page's plain text, for search, and the uploaded files its image blocks
 * show, so the server can delete files no page uses any more. The server
 * stores documents without reading them (docs/sync-protocol.md), so the
 * editor sends both itself (`PUT /v1/pages/:id/text`) a little after
 * changes settle, and when the page is left. With the files goes the
 * document's state vector: the server trusts the list only while that's
 * the stored document's. Only editors send; the server refuses anyone else.
 */

/** @typedef {import("../model/doc.js").Doc} Doc */

/**
 * Every visible block's text, in reading order, a line each; image
 * captions too.
 * @param {Doc} doc
 * @returns {string}
 */
export function docText(doc) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string | null} parent @param {number} depth */
  const walk = (parent, depth) => {
    if (depth > 64) return;
    for (const id of doc.children(parent)) {
      const type = doc.getType(id);
      if (hasText(type)) {
        const text = doc.getText(id).trim();
        if (text) lines.push(text);
      } else if (type === "image") {
        const caption = doc.getAttrs(id).caption;
        if (typeof caption === "string" && caption.trim()) lines.push(caption.trim());
      }
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

/** An uploaded file's address, as a pasted image's `src` may hold it. */
const FILE_SRC = /\/v1\/files\/([A-Za-z0-9_-]{1,64})(?:[?#]|$)/;

/**
 * The ids of the uploaded files the visible image blocks show, sorted, each
 * once. Every block counts, however deeply nested: a file left out here is
 * deleted.
 * @param {Doc} doc
 * @returns {string[]}
 */
export function docFiles(doc) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const id of doc.visibleBlockIds()) {
    if (doc.getType(id) !== "image") continue;
    const { file, src } = doc.getAttrs(id);
    if (typeof file === "string" && file) ids.add(file);
    const match = typeof src === "string" ? FILE_SRC.exec(src) : null;
    if (match) ids.add(match[1]);
  }
  return [...ids].sort();
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * What the editor reports about a document.
 * @typedef {{ text: string, files: string[], state: string }} DocReport
 */

/** @param {Doc} doc @returns {DocReport} */
export function docReport(doc) {
  return { text: docText(doc), files: docFiles(doc), state: base64(doc.encodeStateVector()) };
}

/**
 * Sends a document's report when it changes: `delay` ms after the last
 * change (anyone's), and right away on `flush()` (leaving the page). Nothing
 * is sent when it's what was last sent. It's also sent once `delay` ms after
 * opening, so pages written before search (or by an older client) get theirs.
 * Any change at all is sent, not only one to the text or the files: the
 * state vector says which document the files were read from.
 * @param {{
 *   doc: Doc,
 *   send: (report: DocReport, options: { keepalive: boolean }) => Promise<void>,
 *   delay?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 */
export function createTextSync({
  doc,
  send,
  delay = 3000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let sent = "";
  /** @type {any} */
  let timer = setTimer(() => push(false), delay);
  let dirty = true;

  /** @param {boolean} keepalive */
  function push(keepalive) {
    clearTimer(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    const report = docReport(doc);
    const key = JSON.stringify(report);
    if (key === sent) return;
    const previous = sent;
    sent = key;
    send(report, { keepalive }).catch(() => {
      // Try again with the next change (or the next visit).
      if (sent === key) sent = previous;
    });
  }

  const stop = doc.observe(() => {
    dirty = true;
    clearTimer(timer);
    timer = setTimer(() => push(false), delay);
  });

  return {
    /** Send now if anything changed (leaving the page). */
    flush() {
      push(true);
    },
    destroy() {
      push(true);
      stop();
    },
  };
}
