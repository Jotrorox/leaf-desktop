// @ts-check
import { createEffect, For, on, Show } from "solid-js";
import { focusRoving, onGridKeyDown } from "../../lib/grid-nav.js";
import Button from "../../ui/Button.jsx";
import Popover from "../../ui/Popover.jsx";
import { COVERS } from "./covers.js";
import styles from "./PageHeader.module.css";

/**
 * Cover presets in a popover: a grid of swatches (arrow keys move, Enter
 * picks), "Upload image" and "Remove".
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   current: string | null,
 *   onSelect: (cover: string | null) => void,
 *   onUpload?: () => void,
 * }} props `onUpload`: offer "Upload image".
 */
export default function CoverPicker(props) {
  /** @type {HTMLDivElement | undefined} */
  let grid;
  const swatches = () =>
    /** @type {HTMLElement[]} */ (grid ? [...grid.querySelectorAll("[data-cover]")] : []);

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const list = swatches();
        focusRoving(
          list,
          Math.max(
            0,
            COVERS.findIndex((cover) => cover.id === props.current),
          ),
          { focus: false },
        );
      },
    ),
  );

  /** @param {string | null} cover */
  function pick(cover) {
    props.onSelect(cover);
    props.onOpenChange(false);
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      initialFocus={(panel) =>
        /** @type {HTMLElement | null} */ (panel.querySelector('[data-cover][tabindex="0"]'))
      }
      placement="bottom-end"
      role="dialog"
      aria-label="Choose a cover"
      class={styles.coverPicker}
    >
      <div class={styles.pickerHeader}>
        <h2 class={styles.pickerTitle}>Colors and gradients</h2>
        <Show when={props.onUpload}>
          <Button
            variant="ghost"
            class={styles.pickerRemove}
            onClick={() => {
              props.onOpenChange(false);
              props.onUpload?.();
            }}
          >
            Upload image
          </Button>
        </Show>
        <Show when={props.current}>
          <Button variant="ghost" class={styles.pickerRemove} onClick={() => pick(null)}>
            Remove
          </Button>
        </Show>
      </div>
      <div
        ref={grid}
        class={styles.swatches}
        onKeyDown={(event) => grid && onGridKeyDown(event, grid, "[data-cover]")}
      >
        <For each={COVERS}>
          {(cover) => (
            <button
              type="button"
              class={styles.swatch}
              style={{ background: cover.background }}
              tabindex="-1"
              data-cover={cover.id}
              aria-label={cover.label}
              aria-pressed={props.current === cover.id}
              title={cover.label}
              onClick={() => pick(cover.id)}
            />
          )}
        </For>
      </div>
    </Popover>
  );
}
