// @ts-check

/**
 * Pointer-events drag and drop, shared by the page tree now and blocks and
 * board cards later. No HTML5 drag-and-drop: it can't style the drag, it's
 * unreliable on touch, and it can't auto-scroll a nested container.
 *
 * `startDrag(pointerdownEvent, options)` tracks one gesture:
 *
 * - The drag starts once the pointer moves `threshold` px (mouse, pen), or
 *   after holding still for `touchDelay` ms (touch, so a swipe still scrolls).
 *   Until then it's an ordinary click.
 * - While dragging, `resolve(x, y)` maps the pointer to a drop target (or
 *   null for "can't drop here"); `onMove` hears every change so the caller can
 *   draw an indicator. An optional preview element follows the pointer.
 * - Near the top or bottom edge of `scrollContainer` (or the left or right
 *   edge of `scrollContainerX`), it auto-scrolls, faster the closer the
 *   pointer gets, and re-resolves the target.
 * - Releasing over a target calls `onDrop`. Escape, pointercancel, or the
 *   window losing focus cancel. Either way the click that would follow the
 *   release is swallowed, so dropping a link doesn't also open it.
 *
 * The pure helpers (`dropZone`, `autoScrollDelta`, `pastThreshold`) run
 * under `node --test`; `startDrag` needs a DOM.
 */

/** @typedef {"before" | "after" | "inside"} DropZone */

/**
 * Which part of a row the pointer is over. With `inside`, the top and bottom
 * quarters mean before and after and the middle means inside; without it,
 * the row splits in half.
 * @param {number} offsetY Pointer y minus the row's top.
 * @param {number} height Row height.
 * @param {{ inside?: boolean, edge?: number }} [options] `edge`: fraction of the height for before/after when `inside` is allowed. Default 0.25.
 * @returns {DropZone}
 */
export function dropZone(offsetY, height, { inside = true, edge = 0.25 } = {}) {
  const ratio = height > 0 ? offsetY / height : 0.5;
  if (!inside) return ratio < 0.5 ? "before" : "after";
  if (ratio < edge) return "before";
  if (ratio >= 1 - edge) return "after";
  return "inside";
}

/**
 * How many px to scroll this frame: negative near the top edge, positive
 * near the bottom, 0 elsewhere. Speed ramps up linearly to `maxSpeed` at
 * (and past) the edge.
 * @param {number} pointer Pointer y.
 * @param {number} top Container's top edge (viewport y).
 * @param {number} bottom Container's bottom edge.
 * @param {{ edge?: number, maxSpeed?: number }} [options] `edge`: size of the hot zone in px. Default 40. `maxSpeed`: px per frame. Default 16.
 */
export function autoScrollDelta(pointer, top, bottom, { edge = 40, maxSpeed = 16 } = {}) {
  const zone = Math.min(edge, (bottom - top) / 3);
  if (zone <= 0) return 0;
  if (pointer < top + zone)
    return -Math.ceil(maxSpeed * Math.min(1, (top + zone - pointer) / zone));
  if (pointer > bottom - zone)
    return Math.ceil(maxSpeed * Math.min(1, (pointer - (bottom - zone)) / zone));
  return 0;
}

/**
 * @param {number} dx
 * @param {number} dy
 * @param {number} threshold
 */
export function pastThreshold(dx, dy, threshold) {
  return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * The nearest ancestor that scrolls vertically, or null.
 * @param {Element | null} el
 * @returns {HTMLElement | null}
 */
export function scrollParent(el) {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * @template T
 * @typedef {object} DragOptions
 * @property {(x: number, y: number) => T | null} resolve Drop target under the pointer, or null.
 * @property {(target: T) => void} onDrop
 * @property {(target: T | null) => void} [onMove] After every pointer move, scroll and target change.
 * @property {() => void} [onStart] The gesture became a drag.
 * @property {(result: "drop" | "cancel") => void} [onEnd] The drag ended (only if it started).
 * @property {() => HTMLElement} [preview] Element to show under the pointer while dragging.
 * @property {HTMLElement | null} [scrollContainer] Auto-scrolls near its top and bottom edges.
 * @property {HTMLElement | null} [scrollContainerX] Auto-scrolls near its left and right edges (a board).
 * @property {number} [threshold] px before a mouse or pen drag starts. Default 4.
 * @property {number} [touchDelay] ms to hold before a touch drag starts. Default 400.
 */

/**
 * Starts tracking a possible drag from a pointerdown. Returns null for
 * anything but a primary-button press.
 * @template T
 * @param {PointerEvent} event
 * @param {DragOptions<T>} options
 * @returns {{ cancel: () => void } | null}
 */
export function startDrag(event, options) {
  if (event.button !== 0 || !event.isPrimary) return null;
  const source = /** @type {Element} */ (event.currentTarget ?? event.target);
  const { pointerId } = event;
  const threshold = options.threshold ?? 4;
  const touch = event.pointerType === "touch";
  const startX = event.clientX;
  const startY = event.clientY;
  let x = startX;
  let y = startY;
  /** @type {"pending" | "holding" | "dragging" | "done"} */
  let phase = touch ? "holding" : "pending";
  /** @type {T | null} */
  let target = null;
  /** @type {HTMLElement | null} */
  let previewEl = null;
  let frame = 0;
  const holdTimer = touch ? setTimeout(begin, options.touchDelay ?? 400) : undefined;

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    x = e.clientX;
    y = e.clientY;
    if (phase === "holding") {
      // Moved before the hold finished: a scroll or swipe, not a drag.
      if (pastThreshold(x - startX, y - startY, threshold * 2)) finish("idle");
      return;
    }
    if (phase === "pending") {
      if (!pastThreshold(x - startX, y - startY, threshold)) return;
      begin();
    }
    if (phase === "dragging") {
      e.preventDefault();
      update();
    }
  }

  function begin() {
    if (phase === "done" || phase === "dragging") return;
    phase = "dragging";
    try {
      source.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone; pointerup will end the drag.
    }
    document.documentElement.dataset.dragging = "";
    window.getSelection()?.removeAllRanges();
    if (options.preview) {
      previewEl = options.preview();
      Object.assign(previewEl.style, {
        position: "fixed",
        left: "0",
        top: "0",
        zIndex: "1000",
        pointerEvents: "none",
      });
      document.body.append(previewEl);
    }
    options.onStart?.();
    update();
    frame = requestAnimationFrame(tick);
  }

  function update() {
    if (previewEl) previewEl.style.transform = `translate(${x + 12}px, ${y + 8}px)`;
    target = options.resolve(x, y);
    options.onMove?.(target);
  }

  function tick() {
    const container = options.scrollContainer;
    let moved = false;
    if (container) {
      const rect =
        container === document.scrollingElement
          ? { top: 0, bottom: innerHeight }
          : container.getBoundingClientRect();
      const delta = autoScrollDelta(y, rect.top, rect.bottom);
      if (delta) {
        const before = container.scrollTop;
        container.scrollTop += delta;
        moved ||= container.scrollTop !== before;
      }
    }
    const containerX = options.scrollContainerX;
    if (containerX) {
      const rect = containerX.getBoundingClientRect();
      const delta = autoScrollDelta(x, rect.left, rect.right);
      if (delta) {
        const before = containerX.scrollLeft;
        containerX.scrollLeft += delta;
        moved ||= containerX.scrollLeft !== before;
      }
    }
    if (moved) update();
    frame = requestAnimationFrame(tick);
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    if (phase === "dragging") {
      swallowNextClick(false);
      finish(target === null ? "cancel" : "drop");
    } else {
      finish("idle");
    }
  }

  /** @param {PointerEvent} e */
  function onPointerCancel(e) {
    if (e.pointerId === pointerId) finish("cancel");
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (phase !== "dragging") return;
    // Keys mean nothing mid-drag; Escape cancels it.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      // The button is still down: swallow the click its release will make.
      swallowNextClick(true);
      finish("cancel");
    }
  }

  /** @param {TouchEvent} e */
  function onTouchMove(e) {
    // Keep the page from scrolling under a touch drag.
    if (phase === "dragging" && e.cancelable) e.preventDefault();
  }

  function onBlur() {
    finish("cancel");
  }

  /** @param {"drop" | "cancel" | "idle"} result */
  function finish(result) {
    if (phase === "done") return;
    const dragged = phase === "dragging";
    phase = "done";
    clearTimeout(holdTimer);
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("blur", onBlur);
    try {
      if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
    delete document.documentElement.dataset.dragging;
    previewEl?.remove();
    if (!dragged) return;
    if (result === "drop" && target !== null) options.onDrop(target);
    options.onEnd?.(result === "drop" ? "drop" : "cancel");
  }

  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("blur", onBlur);

  return { cancel: () => finish("cancel") };
}

/**
 * Swallows the click that follows a pointer release.
 * @param {boolean} waitForRelease The pointer is still down: wait for its release first.
 */
function swallowNextClick(waitForRelease) {
  /** @param {MouseEvent} event */
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const stop = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerup", onRelease, true);
  };
  // The click is dispatched right after the release, in the same task.
  const onRelease = () => setTimeout(stop, 0);
  window.addEventListener("click", swallow, true);
  if (waitForRelease) window.addEventListener("pointerup", onRelease, true);
  else setTimeout(stop, 0);
}
