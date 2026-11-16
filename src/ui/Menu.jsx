// @ts-check
import { createContext, createSignal, createUniqueId, Show, useContext } from "solid-js";
import { cx } from "../lib/cx.js";
import { shortcuts } from "../lib/shortcuts.js";
import { createTypeaheadBuffer, findTypeaheadMatch } from "../lib/typeahead.js";
import { IconCheck } from "./icons/index.jsx";
import Kbd from "./Kbd.jsx";
import styles from "./Menu.module.css";
import Popover, { createToggleHandlers } from "./Popover.jsx";

/** @typedef {import("solid-js").JSX.Element} JSXElement */

/**
 * Props to spread onto the trigger button.
 * @typedef {object} MenuTriggerProps
 * @property {(el: HTMLElement) => void} ref
 * @property {string} id
 * @property {"menu"} aria-haspopup
 * @property {string} aria-controls
 * @property {boolean} aria-expanded
 * @property {() => void} onPointerDown
 * @property {(event: MouseEvent) => void} onClick
 * @property {(event: KeyboardEvent) => void} onKeyDown
 */

const MenuContext = createContext(/** @type {{ close: () => void } | undefined} */ (undefined));

const ITEM = '[role="menuitem"], [role="menuitemradio"]';
const ENABLED_ITEM = ':is([role="menuitem"], [role="menuitemradio"]):not([aria-disabled="true"])';

/**
 * A menu button (ARIA menu pattern) on `Popover`.
 *
 * Items are `MenuItem`s, optionally grouped with `MenuGroup` (for a set of
 * radio items) and split by `MenuSeparator`.
 *
 * Trigger: Enter, Space or ↓ opens on the first item, ↑ on the last.
 * Menu: ↑/↓ move (wrapping), Home/End jump, typing a letter jumps to the
 * next item starting with it, Enter/Space pick, Escape or Tab close and
 * return focus to the trigger. Focus is roving: the focused item has
 * tabindex 0 and the others -1. Disabled items are skipped.
 *
 * @param {{
 *   trigger?: (props: MenuTriggerProps) => JSXElement,
 *   anchor?: () => HTMLElement | undefined,
 *   open?: boolean,
 *   onOpenChange?: (open: boolean) => void,
 *   label?: string,
 *   placement?: import("../lib/position.js").Placement,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   class?: string,
 *   children: JSXElement,
 * }} props `focusOnClose`: where focus goes when the menu closes, instead
 *   of the trigger (e.g. a tree item whose menu button is hover-only).
 *   Without a `trigger`, the menu is controlled: pass `open`,
 *   `onOpenChange` and an `anchor` to place it by (the block menu, opened
 *   from a shortcut as well as a button).
 */
export default function Menu(props) {
  const id = createUniqueId();
  const [innerOpen, setInnerOpen] = createSignal(false);
  const open = () => props.open ?? innerOpen();
  /** @param {boolean} next */
  const setOpen = (next) => {
    if (props.onOpenChange) props.onOpenChange(next);
    else setInnerOpen(next);
  };
  const typeahead = createTypeaheadBuffer();
  /** @type {HTMLElement | undefined} */
  let trigger;
  /** @type {HTMLDivElement | undefined} */
  let menu;
  let focusLast = false;

  const toggle = createToggleHandlers(open, (next) => {
    focusLast = false;
    setOpen(next);
  });

  /** @returns {HTMLElement[]} */
  const items = (selector = ENABLED_ITEM) =>
    (menu ? [...menu.querySelectorAll(selector)] : []).filter((el) => el instanceof HTMLElement);

  function close() {
    typeahead.reset();
    setOpen(false);
  }

  /** @param {number} index */
  function focusItem(index) {
    items()[index]?.focus();
  }

  /** @type {MenuTriggerProps} */
  const triggerProps = {
    ref: (el) => (trigger = el),
    id: `${id}-trigger`,
    "aria-haspopup": "menu",
    "aria-controls": id,
    get "aria-expanded"() {
      return open();
    },
    onPointerDown: toggle.onPointerDown,
    onClick: toggle.onClick,
    onKeyDown(event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      focusLast = event.key === "ArrowUp";
      if (open()) focusItem(focusLast ? items().length - 1 : 0);
      else setOpen(true);
    },
  };

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const list = items();
    const index = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const last = list.length - 1;

    switch (event.key) {
      case "ArrowDown":
        focusItem(index < 0 || index === last ? 0 : index + 1);
        break;
      case "ArrowUp":
        focusItem(index <= 0 ? last : index - 1);
        break;
      case "Home":
      case "PageUp":
        focusItem(0);
        break;
      case "End":
      case "PageDown":
        focusItem(last);
        break;
      case "Escape":
      case "Tab":
        close();
        break;
      case "Enter":
        list[index]?.click();
        break;
      case " ":
        // Space continues a type-ahead search ("Sign out"); otherwise it picks.
        if (typeahead.active) typeAhead(" ", list, index);
        else list[index]?.click();
        break;
      default:
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        typeAhead(event.key, list, index);
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** @param {string} char @param {HTMLElement[]} list @param {number} index */
  function typeAhead(char, list, index) {
    const labels = list.map((item) => item.dataset.textValue ?? item.textContent ?? "");
    const match = findTypeaheadMatch(labels, index, typeahead.push(char));
    if (match >= 0) list[match].focus();
  }

  /** @param {FocusEvent} event */
  function onFocusIn(event) {
    for (const item of items(ITEM)) item.tabIndex = item === event.target ? 0 : -1;
  }

  return (
    <>
      {props.trigger?.(triggerProps)}
      <Popover
        id={id}
        ref={(el) => (menu = el)}
        role="menu"
        aria-label={props.label}
        aria-labelledby={props.label || !props.trigger ? undefined : `${id}-trigger`}
        class={cx(styles.menu, props.class)}
        open={open()}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        anchor={() => props.anchor?.() ?? trigger}
        focusOnClose={props.focusOnClose}
        placement={props.placement ?? "bottom-start"}
        initialFocus={() => {
          const list = items();
          return focusLast ? list.at(-1) : list[0];
        }}
        onKeyDown={onKeyDown}
        onFocusIn={onFocusIn}
      >
        <MenuContext.Provider value={{ close }}>{props.children}</MenuContext.Provider>
      </Popover>
    </>
  );
}

/**
 * @param {{
 *   onSelect?: () => void,
 *   disabled?: boolean,
 *   checked?: boolean,
 *   icon?: JSXElement,
 *   shortcut?: string,
 *   textValue?: string,
 *   children: JSXElement,
 * }} props `textValue` overrides the text used for type-ahead. Passing
 *   `checked` makes it a radio item (`menuitemradio`) with a check mark;
 *   put its siblings in a `MenuGroup`.
 */
export function MenuItem(props) {
  const menu = useContext(MenuContext);

  function select() {
    if (props.disabled) return;
    // Close first, so focus is back on the trigger before onSelect opens a
    // dialog (which then returns focus there) or navigates.
    menu?.close();
    props.onSelect?.();
  }

  return (
    <div
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      tabindex="-1"
      class={styles.item}
      aria-checked={props.checked === undefined ? undefined : props.checked}
      aria-disabled={props.disabled ? "true" : undefined}
      aria-keyshortcuts={props.shortcut ? shortcuts.aria(props.shortcut) : undefined}
      data-text-value={props.textValue}
      onClick={select}
      onPointerMove={(event) => {
        if (!props.disabled && document.activeElement !== event.currentTarget)
          event.currentTarget.focus();
      }}
    >
      <Show when={props.icon}>
        <span class={styles.icon}>{props.icon}</span>
      </Show>
      <span class={styles.label}>{props.children}</span>
      <Show when={props.shortcut}>{(keys) => <Kbd keys={keys()} aria-hidden="true" />}</Show>
      <Show when={props.checked}>
        <span class={styles.check}>
          <IconCheck size={16} />
        </span>
      </Show>
    </div>
  );
}

/** A labelled set of items, e.g. radio items. @param {{ label: string, children: JSXElement }} props */
export function MenuGroup(props) {
  return (
    <div role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" class={styles.separator} />;
}
