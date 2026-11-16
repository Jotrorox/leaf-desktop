// @ts-check
import { createEffect, createUniqueId, onCleanup, Show, untrack } from "solid-js";
import { cx } from "../lib/cx.js";
import { shortcuts } from "../lib/shortcuts.js";
import styles from "./Dialog.module.css";
import IconButton from "./IconButton.jsx";
import { IconClose } from "./icons/index.jsx";

/** @typedef {import("solid-js").JSX.Element} JSXElement */

/**
 * A modal dialog on native `<dialog>` and `showModal()`. The browser provides
 * the top layer, the inert background, the focus trap, and Escape. This adds
 * a title and close button, closing on a backdrop click, returning focus to
 * where it was, and an exclusive shortcut scope so global shortcuts don't
 * fire underneath. Content renders only while open.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   title: JSXElement,
 *   description?: JSXElement,
 *   class?: string,
 *   children?: JSXElement,
 * }} props
 */
export default function Dialog(props) {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  /** @type {HTMLDialogElement | undefined} */
  let el;
  /** @type {(() => void) | undefined} */
  let releaseScope;
  /** @type {Element | null} */
  let returnTo = null;
  let pressedBackdrop = false;
  let closed = true;

  createEffect(() => {
    const open = props.open;
    untrack(() => (open ? show() : hide()));
  });

  function show() {
    if (!el || el.open) return;
    returnTo = document.activeElement;
    el.showModal();
    closed = false;
    releaseScope = shortcuts.pushScope("dialog", { exclusive: true });
  }

  function hide() {
    if (el?.open) el.close();
    finishClose();
  }

  /** @param {Event} event */
  function onCancel(event) {
    // Escape. Close it ourselves so the state updates now: the `close` event is
    // queued, and until it fires `open` would still read true.
    event.preventDefault();
    hide();
  }

  /** Syncs state after closing. Runs once per close, whichever path gets here first. */
  function finishClose() {
    if (closed) return;
    closed = true;
    releaseScope?.();
    releaseScope = undefined;
    // Browsers restore focus themselves; this covers the ones that don't, and
    // the case where the focused element was removed with the content.
    const active = document.activeElement;
    if (
      returnTo instanceof HTMLElement &&
      returnTo.isConnected &&
      (!active || active === document.body)
    ) {
      returnTo.focus();
    }
    returnTo = null;
    if (props.open) props.onOpenChange(false);
  }

  onCleanup(() => {
    releaseScope?.();
    if (el?.open) el.close();
  });

  return (
    <dialog
      ref={el}
      class={cx(styles.dialog, props.class)}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      onCancel={onCancel}
      onClose={finishClose}
      // A click whose press and release both land outside the panel is a backdrop click.
      onPointerDown={(event) => (pressedBackdrop = event.target === el)}
      onClick={(event) => {
        if (pressedBackdrop && event.target === el) hide();
        pressedBackdrop = false;
      }}
    >
      <Show when={props.open}>
        <div class={styles.panel}>
          <header class={styles.header}>
            <h2 id={titleId} class={styles.title}>
              {props.title}
            </h2>
            <IconButton label="Close" size="small" tooltip={false} onClick={hide}>
              <IconClose />
            </IconButton>
          </header>
          <Show when={props.description}>
            <p id={descriptionId} class={styles.description}>
              {props.description}
            </p>
          </Show>
          <div class={styles.body}>{props.children}</div>
        </div>
      </Show>
    </dialog>
  );
}
