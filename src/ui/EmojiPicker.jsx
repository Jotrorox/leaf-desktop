// @ts-check
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { focusRoving, onGridKeyDown } from "../lib/grid-nav.js";
import Button from "./Button.jsx";
import styles from "./EmojiPicker.module.css";
import { EMOJI_GROUPS, searchEmoji } from "./emoji-data.js";
import Popover from "./Popover.jsx";

/**
 * A small emoji grid in a popover, for page icons. Focus starts in the
 * filter field; ↓ (or Tab) enters the grid, arrows move, Enter or Space
 * picks, and Enter in the field picks the first match.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   current: string | null,
 *   onSelect: (emoji: string) => void,
 *   onRemove?: () => void,
 *   onUpload?: () => void,
 * }} props `onUpload`: offer "Upload" (an image as the icon).
 */
export default function EmojiPicker(props) {
  const [query, setQuery] = createSignal("");
  const groups = createMemo(() =>
    query().trim() ? [{ label: "Results", items: searchEmoji(query()) }] : EMOJI_GROUPS,
  );
  const empty = () => groups().every((group) => group.items.length === 0);
  /** @type {HTMLInputElement | undefined} */
  let search;
  /** @type {HTMLDivElement | undefined} */
  let grid;

  const cells = () =>
    /** @type {HTMLElement[]} */ (grid ? [...grid.querySelectorAll("[data-emoji]")] : []);

  createEffect(
    on(
      () => props.open,
      (open) => open && setQuery(""),
      { defer: true },
    ),
  );
  // One tab stop in the grid: the current icon, else the first cell.
  createEffect(
    on(groups, () =>
      queueMicrotask(() => {
        const list = cells();
        const selected = list.findIndex((el) => el.dataset.emoji === props.current);
        focusRoving(list, Math.max(selected, 0), { focus: false });
      }),
    ),
  );

  /** @param {string} emoji */
  function pick(emoji) {
    props.onSelect(emoji);
    props.onOpenChange(false);
  }

  /** @param {KeyboardEvent} event */
  function onSearchKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const list = cells();
      if (list.length) focusRoving(list, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = groups()[0]?.items[0];
      if (first) pick(first.emoji);
    }
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      initialFocus={() => search}
      placement="bottom-start"
      role="dialog"
      aria-label="Choose an icon"
      class={styles.picker}
    >
      <div class={styles.toolbar}>
        <input
          ref={search}
          type="search"
          class={styles.search}
          placeholder="Filter…"
          aria-label="Filter emoji"
          autocomplete="off"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
        />
        <Show when={props.onUpload}>
          <Button
            variant="ghost"
            class={styles.remove}
            onClick={() => {
              props.onOpenChange(false);
              props.onUpload?.();
            }}
          >
            Upload
          </Button>
        </Show>
        <Show when={props.current && props.onRemove}>
          <Button
            variant="ghost"
            class={styles.remove}
            onClick={() => {
              props.onRemove?.();
              props.onOpenChange(false);
            }}
          >
            Remove
          </Button>
        </Show>
      </div>
      <div
        ref={grid}
        class={styles.grid}
        onKeyDown={(event) =>
          grid && onGridKeyDown(event, grid, "[data-emoji]", () => search?.focus())
        }
      >
        <For each={groups()}>
          {(group) => (
            <Show when={group.items.length}>
              <section class={styles.group} aria-label={group.label}>
                <h3 class={styles.groupLabel} aria-hidden="true">
                  {group.label}
                </h3>
                <div class={styles.cells}>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class={styles.cell}
                        tabindex="-1"
                        data-emoji={item.emoji}
                        aria-label={item.name}
                        aria-pressed={props.current === item.emoji}
                        title={item.name}
                        onClick={() => pick(item.emoji)}
                      >
                        {item.emoji}
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          )}
        </For>
        <Show when={empty()}>
          <p class={styles.empty}>No emoji match “{query()}”.</p>
        </Show>
      </div>
    </Popover>
  );
}
