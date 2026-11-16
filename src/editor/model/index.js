// @ts-check

/**
 * The document model: a CRDT for one page, with sync and undo.
 * The algorithm and wire format are specified in docs/sync-protocol.md.
 */

export { Doc, MARKS } from "./doc.js";
export { blockKey, compareIds, createClientId, parseBlockKey } from "./ids.js";
export { decodeRelativePosition, encodeRelativePosition } from "./relative-position.js";
export { UndoManager } from "./undo.js";
export { decodeStateVector, encodeStateVector } from "./update.js";
