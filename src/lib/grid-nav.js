// @ts-check

/**
 * Arrow-key movement among items laid out in rows (emoji and cover
 * pickers), from their on-screen rectangles, so rows can have any length
 * and groups can start new rows. Pure: runs under `node --test`.
 *
 * ←/→ step through items in DOM order, ↑/↓ go to the item in the nearest
 * row above or below whose center is closest horizontally, Home/End jump
 * to the first or last item. ↑ from the top row returns -1, so the caller
 * can move focus out (to a search field); ↓ from the bottom row stays.
 *
 * @param {readonly { x: number, y: number, width: number }[]} rects Items in DOM order.
 * @param {number} index Current item.
 * @param {string} key `KeyboardEvent.key`.
 * @returns {number | null} The next index, -1 for "leave the grid upward", or null when the key isn't a grid key.
 */
export function spatialMove(rects, index, key) {
  if (rects.length === 0 || index < 0 || index >= rects.length) return null;
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, rects.length - 1);
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return rects.length - 1;
    case "ArrowDown":
    case "ArrowUp": {
      const down = key === "ArrowDown";
      const current = rects[index];
      // The nearest row in that direction (1px tolerance for subpixel layout).
      /** @type {number | null} */
      let rowY = null;
      for (const rect of rects) {
        const beyond = down ? rect.y > current.y + 1 : rect.y < current.y - 1;
        if (beyond && (rowY === null || (down ? rect.y < rowY : rect.y > rowY))) rowY = rect.y;
      }
      if (rowY === null) return down ? index : -1;
      const center = current.x + current.width / 2;
      let best = index;
      let bestDistance = Infinity;
      rects.forEach((rect, i) => {
        if (Math.abs(rect.y - /** @type {number} */ (rowY)) > 1) return;
        const distance = Math.abs(rect.x + rect.width / 2 - center);
        if (distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      });
      return best;
    }
    default:
      return null;
  }
}

/**
 * Keydown handler for a roving-focus grid: moves focus among the elements
 * matching `selector` inside `container`, keeping exactly one of them in the
 * tab order. DOM only (not used by the tests).
 * @param {KeyboardEvent} event
 * @param {HTMLElement} container
 * @param {string} selector
 * @param {() => void} [onLeaveUp] Called for ↑ from the top row.
 * @returns {boolean} Whether the key was handled.
 */
export function onGridKeyDown(event, container, selector, onLeaveUp) {
  const items = /** @type {HTMLElement[]} */ ([...container.querySelectorAll(selector)]);
  const index = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const rects = items.map((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width };
  });
  const next = spatialMove(rects, index, event.key);
  if (next === null) return false;
  event.preventDefault();
  if (next === -1) onLeaveUp?.();
  else focusRoving(items, next);
  return true;
}

/**
 * Makes `items[index]` the grid's only tab stop and focuses it.
 * @param {HTMLElement[]} items
 * @param {number} index
 * @param {{ focus?: boolean }} [options]
 */
export function focusRoving(items, index, { focus = true } = {}) {
  items.forEach((el, i) => (el.tabIndex = i === index ? 0 : -1));
  if (focus) {
    items[index]?.focus();
    items[index]?.scrollIntoView({ block: "nearest" });
  }
}
