// @ts-check
import { createEffect, onCleanup, onMount, splitProps, untrack } from "solid-js";
import { cx } from "../lib/cx.js";
import { getTabbable } from "../lib/focus.js";
import { computePosition } from "../lib/position.js";
import styles from "./Popover.module.css";

/**
 * @typedef {"first" | "last" | "container" | "none" | ((panel: HTMLElement) => HTMLElement | null | undefined)} InitialFocus
 */

/**
 * @typedef {Omit<import("solid-js").JSX.HTMLAttributes<HTMLDivElement>, "ref"> & {
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   anchorRect?: () => DOMRect | null,
 *   placement?: import("../lib/position.js").Placement,
 *   offset?: number,
 *   initialFocus?: InitialFocus,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   bottomInset?: () => number,
 *   ref?: (el: HTMLDivElement) => void,
 * }} PopoverProps
 */

/**
 * A floating panel on the native Popover API (`popover="auto"`). The browser
 * provides the top layer, light dismiss on outside click, and Escape. This
 * adds placement next to `anchor` (flip and shift via `lib/position.js`,
 * kept up to date on scroll and resize; `anchorRect` places it next to a
 * spot inside the anchor instead, like a word in a text) and focus handling: focus moves in
 * on open (`initialFocus`, default the first tabbable element), back to the
 * anchor (or `focusOnClose()`) on close, and the panel closes when Tab moves
 * focus out of it. It stays inside the visual viewport, so an on-screen
 * keyboard doesn't cover it (`bottomInset`: space to keep clear above that,
 * like a toolbar over the keyboard).
 *
 * Controlled: pass `open` and `onOpenChange`. Render it right after its
 * trigger, so Tab order runs trigger → panel → whatever follows, and give
 * the trigger `createToggleHandlers()` so clicking it while open closes it.
 *
 * @param {PopoverProps} props
 */
export default function Popover(props) {
  const [local, rest] = splitProps(props, [
    "open",
    "onOpenChange",
    "anchor",
    "anchorRect",
    "placement",
    "offset",
    "initialFocus",
    "focusOnClose",
    "bottomInset",
    "ref",
    "class",
    "children",
  ]);
  /** @type {HTMLDivElement | undefined} */
  let el;
  /** @type {ResizeObserver | undefined} */
  let observer;
  let frame = 0;
  let returnFocus = true;
  let closing = false;

  createEffect(() => {
    const open = local.open;
    untrack(() => (open ? show() : hide()));
  });

  function show() {
    if (!el || el.matches(":popover-open")) return;
    returnFocus = true;
    el.showPopover();
    place();
    startTracking();
    focusInitial();
  }

  function hide() {
    if (!closing && el?.matches(":popover-open")) el.hidePopover();
  }

  function place() {
    const anchor = local.anchor();
    if (!el || !anchor || !el.matches(":popover-open")) return;
    // Measure the natural size at the origin, where nothing constrains it.
    const scrollTop = el.scrollTop;
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.maxHeight = "";
    const rect = local.anchorRect?.() ?? anchor.getBoundingClientRect();
    const root = document.documentElement;
    // The visual viewport: on iOS it shrinks for the keyboard, the layout one doesn't.
    const vv = window.visualViewport;
    const ox = vv?.offsetLeft ?? 0;
    const oy = vv?.offsetTop ?? 0;
    const pos = computePosition(
      { x: rect.left - ox, y: rect.top - oy, width: rect.width, height: rect.height },
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: vv?.width ?? root.clientWidth,
        height: (vv?.height ?? root.clientHeight) - (local.bottomInset?.() ?? 0),
      },
      { placement: local.placement, offset: local.offset },
    );
    el.style.left = `${pos.x + ox}px`;
    el.style.top = `${pos.y + oy}px`;
    el.style.maxHeight = `${pos.maxHeight}px`;
    el.dataset.placement = pos.placement;
    el.scrollTop = scrollTop;
  }

  function schedulePlace() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  }

  /** @param {Event} event */
  function onScroll(event) {
    // Scrolling inside the panel doesn't move it.
    if (event.target instanceof Node && el?.contains(event.target)) return;
    schedulePlace();
  }

  function startTracking() {
    if (!el) return;
    observer = new ResizeObserver(schedulePlace);
    observer.observe(el);
    const anchor = local.anchor();
    if (anchor) observer.observe(anchor);
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", schedulePlace);
    window.visualViewport?.addEventListener("scroll", schedulePlace);
  }

  function stopTracking() {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    observer = undefined;
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.visualViewport?.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("scroll", schedulePlace);
  }

  function focusInitial() {
    const option = local.initialFocus ?? "first";
    if (!el || option === "none") return;
    /** @type {HTMLElement | null | undefined} */
    let target;
    if (typeof option === "function") target = option(el);
    else if (option === "first") target = getTabbable(el)[0];
    else if (option === "last") target = getTabbable(el).at(-1);
    (target ?? el).focus({ preventScroll: true });
  }

  /** @param {Event} event */
  function onBeforeToggle(event) {
    if (/** @type {ToggleEvent} */ (event).newState !== "closed" || !el) return;
    stopTracking();
    // Hand focus back to the anchor if it would otherwise be lost: it was in
    // the panel (Escape, picking an item) or on <body> (click on nothing).
    // A click on another focusable element keeps its focus.
    const active = document.activeElement;
    const lost = !active || active === document.body || el.contains(active);
    const target = local.focusOnClose?.() ?? local.anchor();
    if (returnFocus && lost && target?.isConnected) target.focus({ preventScroll: true });

    // Light dismiss and Escape close the popover without asking: sync the
    // state now, not on the queued `toggle` event. `closing` stops the effect
    // from calling hidePopover() again while this one is in progress.
    closing = true;
    try {
      if (local.open) local.onOpenChange(false);
    } finally {
      closing = false;
    }
  }

  /** @param {FocusEvent} event */
  function onFocusOut(event) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || el?.contains(next) || local.anchor()?.contains(next)) return;
    returnFocus = false;
    local.onOpenChange(false);
  }

  onMount(() => {
    el?.addEventListener("beforetoggle", onBeforeToggle);
  });

  onCleanup(() => {
    stopTracking();
    el?.removeEventListener("beforetoggle", onBeforeToggle);
  });

  return (
    <div
      {...rest}
      ref={(node) => {
        el = node;
        local.ref?.(node);
      }}
      popover="auto"
      tabindex="-1"
      class={cx(styles.popover, local.class)}
      onFocusOut={onFocusOut}
    >
      {local.children}
    </div>
  );
}

/**
 * Click handling for a button that toggles a popover.
 *
 * Clicking the trigger of an open auto popover light-dismisses it on
 * pointerup, and the click that follows would open it again. Remembering
 * whether it was open at pointerdown keeps that click a "close". Keyboard
 * clicks (`detail === 0`) never light-dismiss, so they just toggle.
 *
 * @param {() => boolean} open
 * @param {(open: boolean) => void} setOpen
 */
export function createToggleHandlers(open, setOpen) {
  let openAtPointerDown = false;
  return {
    onPointerDown() {
      openAtPointerDown = open();
    },
    /** @param {MouseEvent} event */
    onClick(event) {
      const wasOpen = event.detail === 0 ? open() : openAtPointerDown;
      openAtPointerDown = false;
      setOpen(!wasOpen);
    },
  };
}
