// @ts-check

/**
 * Placement for floating UI (popovers, menus, tooltips). Pure: no DOM, so it
 * runs under `node --test`. All values are viewport (client) pixels.
 *
 * Puts the floating box next to the anchor on the preferred side, flips to
 * the opposite side when the preferred one is too small and the opposite has
 * more room, then shifts it along both axes so it stays `padding` away from
 * the viewport edges. If it still doesn't fit vertically, `maxHeight` says how
 * tall it may be; apply it so the content scrolls.
 */

/** @typedef {"top" | "right" | "bottom" | "left"} Side */
/** @typedef {"start" | "center" | "end"} Align */
/** @typedef {Side | `${Side}-start` | `${Side}-end`} Placement */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ width: number, height: number }} Size */

/**
 * @typedef {object} PositionOptions
 * @property {Placement} [placement] Preferred side and alignment. Default "bottom".
 * @property {number} [offset] Gap between anchor and floating box. Default 4.
 * @property {number} [padding] Minimum distance from the viewport edges. Default 8.
 */

/**
 * @typedef {object} Position
 * @property {number} x Left edge.
 * @property {number} y Top edge.
 * @property {Placement} placement The placement actually used, after flipping.
 * @property {number} maxHeight Tallest the box can be without leaving the viewport.
 */

/** @type {Record<Side, Side>} */
const OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * @param {Rect} anchor
 * @param {Size} floating Natural size of the floating box.
 * @param {Size} viewport
 * @param {PositionOptions} [options]
 * @returns {Position}
 */
export function computePosition(
  anchor,
  floating,
  viewport,
  { placement = "bottom", offset = 4, padding = 8 } = {},
) {
  const [preferred, align] = parsePlacement(placement);
  const vertical = preferred === "top" || preferred === "bottom";

  // Room between the anchor and each viewport edge, minus padding.
  /** @type {Record<Side, number>} */
  const room = {
    top: anchor.y - padding,
    bottom: viewport.height - padding - (anchor.y + anchor.height),
    left: anchor.x - padding,
    right: viewport.width - padding - (anchor.x + anchor.width),
  };

  // Flip
  let side = preferred;
  const needed = (vertical ? floating.height : floating.width) + offset;
  if (room[side] < needed && room[OPPOSITE[side]] > room[side]) side = OPPOSITE[side];

  const maxHeight = Math.max(0, vertical ? room[side] - offset : viewport.height - 2 * padding);
  const width = floating.width;
  const height = Math.min(floating.height, maxHeight);

  let x;
  let y;
  if (vertical) {
    y = side === "bottom" ? anchor.y + anchor.height + offset : anchor.y - offset - height;
    x = alignOnAxis(anchor.x, anchor.width, width, align);
  } else {
    x = side === "right" ? anchor.x + anchor.width + offset : anchor.x - offset - width;
    y = alignOnAxis(anchor.y, anchor.height, height, align);
  }

  // Shift. A box larger than the viewport is pinned to the start edge.
  x = clamp(x, padding, viewport.width - padding - width);
  y = clamp(y, padding, viewport.height - padding - height);

  return {
    x: Math.round(x),
    y: Math.round(y),
    placement: /** @type {Placement} */ (align === "center" ? side : `${side}-${align}`),
    maxHeight: Math.floor(maxHeight),
  };
}

/**
 * @param {Placement} placement
 * @returns {[Side, Align]}
 */
function parsePlacement(placement) {
  const [side, align = "center"] = /** @type {[Side, Align?]} */ (placement.split("-"));
  return [side, align];
}

/**
 * Start coordinate of a box of `size` aligned to an anchor span on one axis.
 * @param {number} start @param {number} length @param {number} size @param {Align} align
 */
function alignOnAxis(start, length, size, align) {
  if (align === "start") return start;
  if (align === "end") return start + length - size;
  return start + (length - size) / 2;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
