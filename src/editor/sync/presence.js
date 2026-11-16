// @ts-check
import { createSignal } from "solid-js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { decodeRelativePosition, encodeRelativePosition } from "../model/relative-position.js";

/**
 * What the editor shares as its presence state (the awareness state, see
 * `awareness.js`), how other people's states are read back, and the open
 * page's collaborators for the top bar.
 *
 * The shared state is JSON: `{ name, image, cursor }`, where `cursor` holds
 * the selection as relative positions (docs/sync-protocol.md 8.8, base64),
 * so it stays on the same characters while text changes around it, or is
 * null until there's a selection. The user id doesn't come from the
 * state: the server fills it in, so it can be trusted (the name can't, but
 * it's only a label).
 */

/** @typedef {import("../model/doc.js").RelativePosition} RelativePosition */
/** @typedef {import("./awareness.js").Peer} Peer */

/**
 * @typedef {object} LocalUser
 * @property {string} id
 * @property {string} name
 * @property {string | null} image An avatar URL.
 */

/**
 * Someone else on the page.
 * @typedef {object} Collaborator
 * @property {number} session
 * @property {string} userId
 * @property {string} name
 * @property {string | null} image
 * @property {string} color
 * @property {{ anchor: RelativePosition, focus: RelativePosition } | null} cursor
 */

/**
 * Cursor colors: distinct hues dark enough for white label text (4.5:1),
 * and visible on the dark theme's background.
 */
export const CURSOR_COLORS = Object.freeze([
  "#d2335c", // rose
  "#c2410c", // orange
  "#a16207", // amber
  "#15803d", // green
  "#0f766e", // teal
  "#0369a1", // sky
  "#4f46e5", // indigo
  "#7e22ce", // purple
  "#be185d", // pink
]);

/**
 * A user's color: the same on every screen, from their id.
 * @param {string} userId
 */
export function userColor(userId) {
  // FNV-1a.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return CURSOR_COLORS[(h >>> 0) % CURSOR_COLORS.length];
}

/** Initials for an avatar without a picture. @param {string} name */
export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * Our presence state.
 * @param {LocalUser} user
 * @param {{ anchor: RelativePosition, focus: RelativePosition } | null} cursor
 */
export function localState(user, cursor) {
  return {
    name: user.name,
    image: user.image,
    cursor: cursor && {
      anchor: bytesToBase64(encodeRelativePosition(cursor.anchor)),
      focus: bytesToBase64(encodeRelativePosition(cursor.focus)),
    },
  };
}

/**
 * Read someone's presence. Anything malformed is dropped (a bad cursor
 * just means no cursor).
 * @param {Peer} peer
 * @returns {Collaborator}
 */
export function readPeer(peer) {
  const state = /** @type {Record<string, unknown>} */ (
    peer.state && typeof peer.state === "object" ? peer.state : {}
  );
  const name =
    typeof state.name === "string" && state.name.trim() !== ""
      ? state.name.trim().slice(0, 80)
      : "Someone";
  const image =
    typeof state.image === "string" && /^https:\/\//i.test(state.image) ? state.image : null;
  /** @type {Collaborator["cursor"]} */
  let cursor = null;
  const c = /** @type {Record<string, unknown> | null} */ (
    state.cursor && typeof state.cursor === "object" ? state.cursor : null
  );
  if (c && typeof c.anchor === "string" && typeof c.focus === "string") {
    try {
      cursor = {
        anchor: decodeRelativePosition(base64ToBytes(c.anchor)),
        focus: decodeRelativePosition(base64ToBytes(c.focus)),
      };
    } catch {
      cursor = null;
    }
  }
  return {
    session: peer.session,
    userId: peer.user,
    name,
    image,
    color: userColor(peer.user),
    cursor,
  };
}

// --- The open page's collaborators, for the top bar -----------------------------

const [collaborators, setCollaborators] = createSignal(/** @type {readonly Collaborator[]} */ ([]));

/** Everyone else on the open page (one entry per session). Reactive. */
export { collaborators, setCollaborators };

/** @type {((session: number) => void) | null} */
let jumpHandler = null;

/** The editor says how to scroll to someone's cursor. @param {((session: number) => void) | null} fn */
export function setJumpHandler(fn) {
  jumpHandler = fn;
}

/** Scroll to someone's cursor (clicking their avatar). @param {number} session */
export function jumpToCollaborator(session) {
  jumpHandler?.(session);
}
