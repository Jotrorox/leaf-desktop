// @ts-check
import { createEffect, createSignal, onCleanup, splitProps } from "solid-js";
import { cx } from "../../lib/cx.js";
import { computePosition } from "../../lib/position.js";
import styles from "./EditorUI.module.css";

/**
 * Space taken at the bottom of the visual viewport by the mobile toolbar,
 * which floating panels keep clear of.
 */
export const [bottomInset, setBottomInset] = createSignal(0);

/**
 * @typedef {Omit<import("solid-js").JSX.HTMLAttributes<HTMLDivElement>, "ref"> & {
 *   open: boolean,
 *   rect: () => DOMRect | null,
 *   placement?: import("../../lib/position.js").Placement,
 *   offset?: number,
 *   ref?: (el: HTMLDivElement) => void,
 * }} FloatingProps
 */

/**
 * A panel next to a spot in the editor (the caret, a selection) that never
 * takes focus: the caret stays in the text, so typing keeps filtering a
 * menu, and the editor hands the menu its keys. It's a manual popover (top
 * layer, no light dismiss; the editor decides when it closes), placed in
 * the visual viewport so an on-screen keyboard doesn't cover it. Pressing
 * the mouse on it doesn't move focus or the selection.
 *
 * @param {FloatingProps} props
 */
export default function Floating(props) {
  const [local, rest] = splitProps(props, [
    "open",
    "rect",
    "placement",
    "offset",
    "ref",
    "class",
    "children",
  ]);
  /** @type {HTMLDivElement | undefined} */
  let el;
  let frame = 0;

  function place() {
    if (!el || !el.matches(":popover-open")) return;
    const rect = local.rect();
    if (!rect) {
      el.style.visibility = "hidden";
      return;
    }
    el.style.visibility = "";
    const vv = window.visualViewport;
    const root = document.documentElement;
    const ox = vv?.offsetLeft ?? 0;
    const oy = vv?.offsetTop ?? 0;
    const scrollTop = el.scrollTop;
    el.style.maxHeight = "";
    const pos = computePosition(
      { x: rect.left - ox, y: rect.top - oy, width: rect.width, height: rect.height },
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: vv?.width ?? root.clientWidth,
        height: (vv?.height ?? root.clientHeight) - bottomInset(),
      },
      { placement: local.placement ?? "bottom-start", offset: local.offset ?? 6 },
    );
    el.style.left = `${pos.x + ox}px`;
    el.style.top = `${pos.y + oy}px`;
    el.style.maxHeight = `${pos.maxHeight}px`;
    el.dataset.placement = pos.placement;
    el.scrollTop = scrollTop;
  }

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  }

  createEffect(() => {
    if (!el) return;
    if (local.open) {
      if (!el.matches(":popover-open")) el.showPopover();
      // Track the anchor (it's reactive) and the inset.
      local.rect();
      bottomInset();
      place();
    } else if (el.matches(":popover-open")) {
      el.hidePopover();
    }
  });

  const observer = new ResizeObserver(schedule);
  const onScroll = (/** @type {Event} */ event) => {
    if (event.target instanceof Node && el?.contains(event.target)) return;
    schedule();
  };
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  onCleanup(() => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  });

  return (
    <div
      {...rest}
      ref={(node) => {
        el = node;
        observer.observe(node);
        local.ref?.(node);
      }}
      popover="manual"
      class={cx(styles.floating, local.class)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {local.children}
    </div>
  );
}
