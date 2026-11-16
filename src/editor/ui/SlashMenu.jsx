// @ts-check
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { cx } from "../../lib/cx.js";
import { CELL_SLASH_ITEMS, filterSlashItems } from "../blocks/slash-items.js";
import { domText, rectAt } from "../view/dom.js";
import styles from "./EditorUI.module.css";
import Floating from "./Floating.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */
/** @typedef {import("../editor.js").Suggestion} Suggestion */
/** @typedef {import("../blocks/slash-items.js").SlashItem} SlashItem */

/** What each item's tile shows. */
const GLYPHS = /** @type {Record<string, string>} */ ({
  p: "Aa",
  h1: "H1",
  h2: "H2",
  h3: "H3",
  bulleted: "•",
  numbered: "1.",
  todo: "☑",
  toggle: "▸",
  quote: "❝",
  code: "</>",
  callout: "💡",
  divider: "—",
  table: "▤",
  database: "▦",
  equation: "∑",
  mention: "@",
  "inline-equation": "√x",
});

/**
 * The open menu of `kind`, tracked, or null.
 * @param {EditorController} ed @param {Suggestion["kind"]} kind
 */
export function openSuggestion(ed, kind) {
  const s = ed.suggestion();
  return s && s.kind === kind ? s : null;
}

/**
 * Where a suggestion menu goes: under its trigger character, so it doesn't
 * move while the query is typed.
 * @param {EditorController} ed @param {Suggestion | null} s
 */
export function suggestionRect(ed, s) {
  if (!s) return null;
  ed.version(s.block);
  const el = ed.textEls.get(s.block);
  return el ? rectAt(el, Math.min(s.offset, domText(el).length)) : null;
}

/**
 * Give the editor this menu's key handler while it's open.
 * @param {EditorController} ed @param {() => boolean} isOpen @param {(key: string) => boolean} handler
 */
export function useSuggestionKeys(ed, isOpen, handler) {
  createEffect(() => {
    if (isOpen()) ed.suggestionKeys = handler;
    else if (ed.suggestionKeys === handler) ed.suggestionKeys = null;
  });
  onCleanup(() => {
    if (ed.suggestionKeys === handler) ed.suggestionKeys = null;
  });
}

/**
 * While a menu is open, the editor (which keeps focus) points assistive
 * tech at it and at its active option.
 * @param {EditorController} ed @param {string} listId @param {() => boolean} isOpen @param {() => number} active
 */
export function useActiveDescendant(ed, listId, isOpen, active) {
  createEffect(() => {
    const root = ed.root;
    if (!root) return;
    if (isOpen()) {
      root.setAttribute("aria-controls", listId);
      root.setAttribute("aria-activedescendant", `${listId}-${active()}`);
    } else if (root.getAttribute("aria-controls") === listId) {
      root.removeAttribute("aria-controls");
      root.removeAttribute("aria-activedescendant");
    }
  });
}

/**
 * The `/` menu: block types (and a page mention), filtered by what's typed
 * after the slash, with each one's Markdown shortcut. ↑/↓ move, Enter or
 * Tab pick, Escape closes; clicking picks too.
 * @param {{ ed: EditorController, id: string }} props `id`: the listbox id (the editor points `aria-controls` at it).
 */
export default function SlashMenu(props) {
  const ed = props.ed;
  const s = () => openSuggestion(ed, "slash");
  const items = createMemo(() => {
    const open = s();
    return open
      ? filterSlashItems(
          open.query,
          ed.doc.hasBlock(open.block) && ed.doc.getType(open.block) === "table_cell"
            ? CELL_SLASH_ITEMS
            : undefined,
        )
      : [];
  });
  const [active, setActive] = createSignal(0);
  createEffect(
    on(
      () => s()?.query,
      () => setActive(0),
    ),
  );
  /** @type {HTMLDivElement | undefined} */
  let list;

  /** @param {SlashItem} item */
  const pick = (item) => ed.applySlashItem(item);

  /** @param {string} key */
  const keys = (key) => {
    const all = items();
    if (all.length === 0) return false;
    if (key === "ArrowDown") setActive((i) => (i + 1) % all.length);
    else if (key === "ArrowUp") setActive((i) => (i - 1 + all.length) % all.length);
    else if (key === "Enter") pick(all[Math.min(active(), all.length - 1)]);
    else return false;
    return true;
  };
  useSuggestionKeys(ed, () => s() !== null, keys);
  useActiveDescendant(ed, props.id, () => s() !== null && items().length > 0, active);

  // Keep the active item in view.
  createEffect(() => {
    const index = active();
    if (!s()) return;
    list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  });

  /** Items with a group heading before the first of each group. */
  const rows = createMemo(() => {
    const all = items();
    const query = s()?.query ?? "";
    return all.map((item, index) => ({
      item,
      index,
      heading:
        query === "" && (index === 0 || all[index - 1].group !== item.group) ? item.group : null,
    }));
  });

  return (
    <Floating open={s() !== null} rect={() => suggestionRect(ed, s())} class={styles.menu}>
      <div ref={list} id={props.id} role="listbox" aria-label="Blocks">
        <For each={rows()}>
          {(row) => (
            <>
              <Show when={row.heading}>
                <div class={styles.groupLabel} aria-hidden="true">
                  {row.heading}
                </div>
              </Show>
              <div
                id={`${props.id}-${row.index}`}
                role="option"
                aria-selected={active() === row.index}
                data-index={row.index}
                class={cx(styles.option, active() === row.index && styles.optionActive)}
                onPointerMove={() => setActive(row.index)}
                onClick={() => pick(row.item)}
              >
                <span class={styles.tile} aria-hidden="true">
                  {GLYPHS[row.item.id] ?? "·"}
                </span>
                <span class={styles.optionText}>
                  <span class={styles.optionLabel}>{row.item.label}</span>
                  <span class={styles.optionDescription}>{row.item.description}</span>
                </span>
                <Show when={row.item.hint}>
                  <span class={styles.hint} aria-hidden="true">
                    {row.item.hint}
                  </span>
                </Show>
              </div>
            </>
          )}
        </For>
        <Show when={items().length === 0}>
          <div class={styles.empty}>No results</div>
        </Show>
      </div>
    </Floating>
  );
}
