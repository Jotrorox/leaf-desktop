// @ts-check
import { children, createEffect, createUniqueId, onCleanup, Show } from "solid-js";
import { computePosition } from "../lib/position.js";
import Kbd from "./Kbd.jsx";
import styles from "./Tooltip.module.css";

const SHOW_DELAY = 500;
const HIDE_DELAY = 100;
/** After a tooltip hides, the next one shows without delay for this long, so scanning a toolbar is quick. */
const WARM_WINDOW = 400;

let warmUntil = 0;
/** @type {(() => void) | null} */
let hideCurrent = null;

/**
 * @typedef {object} TooltipProps
 * @property {import("solid-js").JSX.Element} content
 * @property {string} [shortcut] Shown after the content, e.g. "mod+\\".
 * @property {import("../lib/position.js").Placement} [placement] Default "bottom".
 * @property {number} [delay] ms before showing on hover or focus. Default 500.
 * @property {boolean} [describe] Link the tooltip with `aria-describedby`. Turn off when it repeats the trigger's label. Default true.
 * @property {import("solid-js").JSX.Element} children A single element: the trigger.
 */

/**
 * A short label next to its child, shown on hover and on keyboard focus after
 * a delay. Hides on pointer leave (unless the pointer moves onto the
 * tooltip), blur, press, scroll, and Escape. Uses `popover="manual"`, so it
 * renders in the top layer without closing open menus.
 *
 * @param {TooltipProps} props
 */
export default function Tooltip(props) {
  const id = createUniqueId();
  const resolved = children(() => props.children);
  /** @type {HTMLDivElement | undefined} */
  let tip;
  /** @type {HTMLElement | undefined} */
  let trigger;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let showTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hideTimer;

  function show() {
    clearTimeout(hideTimer);
    if (!tip || !trigger?.isConnected || tip.matches(":popover-open")) return;
    if (hideCurrent) hideCurrent();
    hideCurrent = hide;
    tip.showPopover();
    place();
    document.addEventListener("keydown", onDocumentKeydown, true);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (!tip?.matches(":popover-open")) return;
    tip.hidePopover();
    warmUntil = performance.now() + WARM_WINDOW;
    if (hideCurrent === hide) hideCurrent = null;
    document.removeEventListener("keydown", onDocumentKeydown, true);
    window.removeEventListener("scroll", hide, { capture: true });
  }

  function scheduleShow() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (performance.now() < warmUntil) show();
    else showTimer = setTimeout(show, props.delay ?? SHOW_DELAY);
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function place() {
    if (!tip || !trigger) return;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const rect = trigger.getBoundingClientRect();
    const root = document.documentElement;
    const pos = computePosition(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: root.clientWidth, height: root.clientHeight },
      { placement: props.placement ?? "bottom", offset: 6 },
    );
    tip.style.left = `${pos.x}px`;
    tip.style.top = `${pos.y}px`;
  }

  /** @param {KeyboardEvent} event */
  function onDocumentKeydown(event) {
    if (event.key === "Escape") hide();
  }

  /** @param {PointerEvent} event */
  function onPointerEnter(event) {
    if (event.pointerType !== "touch") scheduleShow();
  }

  function onFocus() {
    // Only keyboard focus: a click also focuses, and shouldn't pop a tooltip.
    if (trigger?.matches(":focus-visible")) scheduleShow();
  }

  createEffect(() => {
    const el = resolved();
    if (!(el instanceof HTMLElement)) return;
    trigger = el;
    el.addEventListener("pointerenter", onPointerEnter);
    el.addEventListener("pointerleave", scheduleHide);
    el.addEventListener("pointerdown", hide);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", hide);
    if (props.describe !== false) {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      el.setAttribute("aria-describedby", [...ids, id].join(" "));
    }
    onCleanup(() => {
      el.removeEventListener("pointerenter", onPointerEnter);
      el.removeEventListener("pointerleave", scheduleHide);
      el.removeEventListener("pointerdown", hide);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", hide);
      hide();
    });
  });

  return (
    <>
      {resolved()}
      <div
        ref={tip}
        id={id}
        popover="manual"
        role="tooltip"
        aria-hidden={props.describe === false ? "true" : undefined}
        class={styles.tooltip}
        onPointerEnter={() => clearTimeout(hideTimer)}
        onPointerLeave={scheduleHide}
      >
        <span>{props.content}</span>
        <Show when={props.shortcut}>{(keys) => <Kbd keys={keys()} />}</Show>
      </div>
    </>
  );
}
