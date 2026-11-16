// @ts-check
import { keyBetween } from "../lib/fractional-index.js";

/**
 * Pure helpers for page-tree lists: the immutable list edits the optimistic
 * updates are made of, plus the rules for where a drag or a keyboard move
 * puts a page. Every edit returns the same array when it changes nothing,
 * which the query cache relies on. Runs under `node --test`.
 */

/** @typedef {import("../api/types.js").TreeNode} TreeNode */
/** @typedef {import("../api/types.js").Page} Page */
/** @typedef {{ id: string }} Identified */

/**
 * Where a page goes: under `parentId`, after `afterId` (null: first;
 * undefined: last).
 * @typedef {{ parentId: string | null, afterId: string | null | undefined }} Placement
 */

/** @param {Page} page @returns {TreeNode} */
export function toTreeNode(page) {
  return {
    id: page.id,
    parent_id: page.parent_id,
    title: page.title,
    icon: page.icon,
    position: page.position,
    has_children: page.has_children,
    kind: page.kind ?? "page",
  };
}

/**
 * @template {Identified} T
 * @param {readonly T[] | undefined} list
 * @param {string} id
 * @returns {T[] | undefined}
 */
export function removeNode(list, id) {
  if (!list || !list.some((item) => item.id === id)) return /** @type {T[] | undefined} */ (list);
  return list.filter((item) => item.id !== id);
}

/**
 * Shallow-merges `patch` into the item with `id`.
 * @template {Identified} T
 * @param {readonly T[] | undefined} list
 * @param {string} id
 * @param {Partial<NoInfer<T>>} patch
 * @returns {T[] | undefined}
 */
export function patchNode(list, id, patch) {
  if (!list) return undefined;
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return /** @type {T[]} */ (list);
  const item = list[index];
  const changed = Object.entries(patch).some(
    ([name, value]) => /** @type {any} */ (item)[name] !== value,
  );
  if (!changed) return /** @type {T[]} */ (list);
  const copy = list.slice();
  copy[index] = { ...item, ...patch };
  return copy;
}

/**
 * Puts `node` right after `afterId` (null: first; undefined, or an id that
 * isn't there: last), removing any earlier copy of it.
 * @template {Identified} T
 * @param {readonly T[] | undefined} list
 * @param {T} node
 * @param {string | null | undefined} afterId
 * @returns {T[] | undefined}
 */
export function placeNode(list, node, afterId) {
  if (!list) return undefined;
  const others = list.filter((item) => item.id !== node.id);
  let index = others.length;
  if (afterId === null) index = 0;
  else if (afterId !== undefined) {
    const after = others.findIndex((item) => item.id === afterId);
    if (after >= 0) index = after + 1;
  }
  const next = [...others.slice(0, index), node, ...others.slice(index)];
  return next.length === list.length && next.every((item, i) => item === list[i])
    ? /** @type {T[]} */ (list)
    : next;
}

/**
 * Inserts `node` in `position` order (code-unit comparison), replacing any
 * earlier copy of it.
 * @template {Identified & { position: string }} T
 * @param {readonly T[] | undefined} list
 * @param {T} node
 * @returns {T[] | undefined}
 */
export function insertByPosition(list, node) {
  if (!list) return undefined;
  const others = list.filter((item) => item.id !== node.id);
  const index = others.findIndex((item) => item.position > node.position);
  return placeNode(list, node, index < 0 ? undefined : index === 0 ? null : others[index - 1].id);
}

/**
 * A provisional position for a page placed after `afterId` (see
 * `placeNode`), ignoring `excludeId`. The server assigns the real one; if
 * the neighbours' positions aren't valid keys, `fallback` is kept.
 * @param {readonly (Identified & { position: string })[]} list
 * @param {string | null | undefined} afterId
 * @param {string} excludeId
 * @param {string} fallback
 */
export function positionAfter(list, afterId, excludeId, fallback) {
  const others = list.filter((item) => item.id !== excludeId);
  let index = others.length;
  if (afterId === null) index = 0;
  else if (afterId !== undefined) {
    const after = others.findIndex((item) => item.id === afterId);
    if (after >= 0) index = after + 1;
  }
  try {
    return keyBetween(others[index - 1]?.position ?? null, others[index]?.position ?? null);
  } catch {
    return fallback;
  }
}

/**
 * Whether making `newParentId` the parent of `id` would put a page inside
 * itself. `parentOf` returns a page's parent id, or undefined when it isn't
 * known (the walk stops there).
 * @param {string} id
 * @param {string | null} newParentId
 * @param {(id: string) => string | null | undefined} parentOf
 */
export function wouldCreateCycle(id, newParentId, parentOf) {
  const seen = new Set();
  for (let current = newParentId; current; current = parentOf(current) ?? null) {
    if (current === id) return true;
    if (seen.has(current)) return false;
    seen.add(current);
  }
  return false;
}

/**
 * Turns a drop on a row into a placement.
 *
 * - before: among the target's siblings, after the one above it (the
 *   dragged page itself doesn't count).
 * - after: right after the target; but after an expanded page with
 *   children, the line sits above its first child, so it means "first child".
 * - inside: last child of the target.
 *
 * @param {"before" | "after" | "inside"} zone
 * @param {{ id: string, parentId: string | null, expanded: boolean }} target
 * @param {readonly string[]} siblings Ids of the target's list, target included, in order.
 * @param {string} draggedId
 * @returns {Placement}
 */
export function resolveDrop(zone, target, siblings, draggedId) {
  if (zone === "inside") return { parentId: target.id, afterId: undefined };
  if (zone === "after") {
    return target.expanded
      ? { parentId: target.id, afterId: null }
      : { parentId: target.parentId, afterId: target.id };
  }
  const others = siblings.filter((id) => id !== draggedId);
  const index = others.indexOf(target.id);
  return { parentId: target.parentId, afterId: index > 0 ? others[index - 1] : null };
}

/**
 * Whether a placement leaves the page where it is.
 * @param {{ id: string, parentId: string | null }} page
 * @param {readonly string[]} siblings Ids of the page's current list, in order.
 * @param {Placement} placement
 */
export function isNoopMove(page, siblings, placement) {
  if (placement.parentId !== page.parentId) return false;
  const index = siblings.indexOf(page.id);
  if (index < 0) return false;
  if (placement.afterId === undefined) return index === siblings.length - 1;
  return (index === 0 ? null : siblings[index - 1]) === placement.afterId;
}

/**
 * Where a keyboard move sends a page: up or down among its siblings, in
 * (last child of the page above) or out (right after its parent). Null
 * when it can't go that way.
 * @param {"up" | "down" | "in" | "out"} direction
 * @param {string} id
 * @param {readonly string[]} siblings Ids of the page's list, in order.
 * @param {string | null} parentId
 * @param {string | null | undefined} grandparentId The parent's parent; needed for "out".
 * @returns {Placement | null}
 */
export function keyboardMove(direction, id, siblings, parentId, grandparentId) {
  const index = siblings.indexOf(id);
  if (index < 0) return null;
  switch (direction) {
    case "up":
      return index === 0 ? null : { parentId, afterId: index >= 2 ? siblings[index - 2] : null };
    case "down":
      return index === siblings.length - 1 ? null : { parentId, afterId: siblings[index + 1] };
    case "in":
      return index === 0 ? null : { parentId: siblings[index - 1], afterId: undefined };
    case "out":
      return parentId === null || grandparentId === undefined
        ? null
        : { parentId: grandparentId, afterId: parentId };
  }
}
