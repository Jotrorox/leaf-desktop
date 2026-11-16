// @ts-check
import { createEffect, createSignal, createUniqueId, For, on } from "solid-js";
import { focusRoving, onGridKeyDown } from "../../lib/grid-nav.js";
import { readStorage, writeStorage } from "../../lib/storage.js";
import { PALETTE, paletteName } from "../math/palette.js";
import { useMathReady } from "../math/ready.js";
import { renderMath } from "../math/render.js";
import styles from "./EditorUI.module.css";

/** @typedef {import("../math/commands.js").TexCommand} TexCommand */

const GROUP_KEY = "leaf.mathPaletteGroup";

/**
 * Symbols to click instead of typing their TeX: a segmented control for the
 * group, then a grid of symbols. Pressing one doesn't take focus from the
 * field, so the symbol goes in at its caret; from the keyboard, Tab reaches
 * the group and the grid, arrows move, Enter or Space inserts.
 * @param {{ onInsert: (item: TexCommand) => void }} props
 */
export default function SymbolPalette(props) {
  const ready = useMathReady();
  const id = createUniqueId();
  const stored = readStorage(GROUP_KEY);
  const [group, setGroup] = createSignal(PALETTE.find((g) => g.id === stored) ?? PALETTE[0]);
  /** @type {HTMLDivElement | undefined} */
  let grid;
  /** @type {HTMLDivElement | undefined} */
  let tabs;

  const cells = () =>
    /** @type {HTMLElement[]} */ (grid ? [...grid.querySelectorAll("[data-symbol]")] : []);
  // One tab stop in the grid.
  createEffect(on(group, () => queueMicrotask(() => focusRoving(cells(), 0, { focus: false }))));

  /** @param {import("../math/palette.js").PaletteGroup} g */
  const choose = (g) => {
    setGroup(g);
    writeStorage(GROUP_KEY, g.id);
  };

  /** ←/→ move between groups (and choose them), as in a tab bar. @param {KeyboardEvent} event */
  const onTabsKeyDown = (event) => {
    const i = PALETTE.indexOf(group());
    const next =
      event.key === "ArrowRight"
        ? i + 1
        : event.key === "ArrowLeft"
          ? i - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? PALETTE.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const g = PALETTE[(next + PALETTE.length) % PALETTE.length];
    choose(g);
    /** @type {HTMLElement | null | undefined} */ (
      tabs?.querySelector(`[data-group="${g.id}"]`)
    )?.focus();
  };

  return (
    <div class={styles.palette}>
      <div
        ref={tabs}
        class={styles.segmented}
        role="tablist"
        aria-label="Symbol groups"
        onKeyDown={onTabsKeyDown}
      >
        <For each={PALETTE}>
          {(g) => (
            <button
              type="button"
              role="tab"
              id={`${id}-${g.id}`}
              data-group={g.id}
              class={styles.segment}
              aria-selected={group() === g}
              aria-controls={`${id}-grid`}
              tabIndex={group() === g ? 0 : -1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(g)}
            >
              {g.label}
            </button>
          )}
        </For>
      </div>
      <div
        ref={grid}
        id={`${id}-grid`}
        class={styles.symbols}
        role="tabpanel"
        aria-labelledby={`${id}-${group().id}`}
        onKeyDown={(event) =>
          grid &&
          onGridKeyDown(event, grid, "[data-symbol]", () =>
            /** @type {HTMLElement | null | undefined} */ (
              tabs?.querySelector(`[data-group="${group().id}"]`)
            )?.focus(),
          )
        }
      >
        <For each={group().items}>
          {(item) => (
            <button
              type="button"
              class={styles.symbol}
              tabIndex={-1}
              data-symbol
              data-tall={item.preview.includes("\\\\") ? "" : undefined}
              aria-label={paletteName(item)}
              title={paletteName(item)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onInsert(item)}
              innerHTML={(ready(), renderMath(item.preview)?.html ?? item.label)}
            />
          )}
        </For>
      </div>
    </div>
  );
}
