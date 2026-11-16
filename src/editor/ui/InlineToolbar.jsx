// @ts-check
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { cx } from "../../lib/cx.js";
import { shortcuts } from "../../lib/shortcuts.js";
import { IconChevronRight, IconLink, IconMath } from "../../ui/icons/index.jsx";
import { COLORS } from "../blocks/colors.js";
import { BLOCKS, spec } from "../blocks/schema.js";
import { isCollapsed, selectedBlocks } from "../commands/commands.js";
import { selectionRect } from "../view/dom.js";
import styles from "./EditorUI.module.css";
import Floating from "./Floating.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */

/** Block types the turn-into lists offer (not the divider, a database or a table: they have no text to keep; nor a table's cells). */
export const TURN_INTO_TYPES = Object.keys(BLOCKS).filter(
  (type) => BLOCKS[type].text && !BLOCKS[type].part,
);

const MARK_BUTTONS = [
  { mark: "bold", label: "Bold", keys: "mod+b", glyph: "B", class: "glyphBold" },
  { mark: "italic", label: "Italic", keys: "mod+i", glyph: "i", class: "glyphItalic" },
  { mark: "underline", label: "Underline", keys: "mod+u", glyph: "U", class: "glyphUnderline" },
  { mark: "strike", label: "Strikethrough", keys: "mod+shift+s", glyph: "S", class: "glyphStrike" },
  { mark: "code", label: "Code", keys: "mod+e", glyph: "</>", class: "glyphCode" },
];

/** Whether this device's main pointer is a finger (the mobile toolbar is used instead). */
export function useCoarsePointer() {
  const query = window.matchMedia("(pointer: coarse)");
  const [coarse, setCoarse] = createSignal(query.matches);
  const update = () => setCoarse(query.matches);
  query.addEventListener("change", update);
  onCleanup(() => query.removeEventListener("change", update));
  return coarse;
}

/**
 * The toolbar over selected text: turn into, bold, italic, underline,
 * strikethrough, code, link, inline equation and color. It shows once the selection is
 * made (not while the mouse is still selecting) and never takes focus, so
 * the selection stays; every button has a keyboard shortcut too.
 * @param {{ ed: EditorController }} props
 */
export default function InlineToolbar(props) {
  const ed = props.ed;
  const coarse = useCoarsePointer();
  const [pointerDown, setPointerDown] = createSignal(false);
  const [panel, setPanel] = createSignal(/** @type {"turn" | "color" | null} */ (null));

  onMount(() => {
    const down = () => {
      setPointerDown(true);
      setPanel(null);
    };
    const up = () => setPointerDown(false);
    ed.root?.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    onCleanup(() => {
      ed.root?.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    });
  });

  const open = createMemo(() => {
    const sel = ed.trackedSelection();
    return (
      !ed.readOnly &&
      !coarse() &&
      !pointerDown() &&
      sel !== null &&
      !isCollapsed(sel) &&
      ed.focusedBlock() !== null &&
      ed.suggestion() === null &&
      ed.linkRequest() === null &&
      ed.mathRequest() === null &&
      // A selected formula opens on Enter or a click; formatting doesn't apply to it.
      !ed.selectionIsFormula() &&
      ed.highlighted().size === 0
    );
  });

  const blocks = createMemo(() => {
    const sel = ed.trackedSelection();
    ed.structure();
    return sel && !isCollapsed(sel) ? selectedBlocks(ed.ctx, sel) : [];
  });
  /** Turning into applies to text blocks; a selection inside a table has none. */
  const canTurn = createMemo(() =>
    blocks().some((id) => (ed.version(id), spec(ed.doc.getType(id)).text)),
  );
  const typeLabel = createMemo(() => {
    const ids = blocks();
    const types = new Set(ids.map((id) => (ed.version(id), ed.doc.getType(id))));
    return types.size === 1 ? spec([...types][0]).label : "Mixed";
  });

  const rect = () => {
    if (!open()) return null;
    ed.trackedSelection();
    return selectionRect(document);
  };

  /** @param {() => void} fn */
  const act = (fn) => () => {
    fn();
    setPanel(null);
  };

  return (
    <Floating
      open={open()}
      rect={rect}
      placement="top-start"
      offset={8}
      class={styles.toolbarPanel}
    >
      <div class={styles.toolbar} role="toolbar" aria-label="Text formatting">
        <Show when={canTurn()}>
          <button
            type="button"
            class={cx(styles.toolButton, styles.toolButtonWide)}
            aria-haspopup="true"
            aria-expanded={panel() === "turn"}
            title="Turn into"
            onClick={() => setPanel(panel() === "turn" ? null : "turn")}
          >
            {typeLabel()}
            <IconChevronRight size={14} class={styles.chevronDown} />
          </button>
          <span class={styles.toolDivider} />
        </Show>
        <For each={MARK_BUTTONS}>
          {(b) => (
            <button
              type="button"
              class={cx(styles.toolButton, styles[b.class])}
              aria-label={b.label}
              aria-pressed={ed.selectionHasMark(b.mark)}
              title={`${b.label} ${shortcuts.format(b.keys)}`}
              onClick={act(() => ed.toggleMark(b.mark))}
            >
              {b.glyph}
            </button>
          )}
        </For>
        <span class={styles.toolDivider} />
        <button
          type="button"
          class={styles.toolButton}
          aria-label="Link"
          aria-pressed={ed.selectionHasMark("link")}
          title={`Link ${shortcuts.format("mod+k")}`}
          onClick={act(() => ed.requestLink())}
        >
          <IconLink size={16} />
        </button>
        <button
          type="button"
          class={styles.toolButton}
          aria-label="Inline equation"
          aria-pressed={ed.selectionHasMark("math")}
          title={`Inline equation ${shortcuts.format("mod+shift+e")}`}
          onClick={act(() => ed.toggleInlineMath())}
        >
          <IconMath size={16} />
        </button>
        <button
          type="button"
          class={cx(styles.toolButton, styles.toolButtonWide)}
          aria-label="Color"
          aria-haspopup="true"
          aria-expanded={panel() === "color"}
          title={`Color (${shortcuts.format("mod+shift+h")} repeats the last one)`}
          onClick={() => setPanel(panel() === "color" ? null : "color")}
        >
          <span class={styles.colorGlyph} data-color={ed.selectionColor() ?? undefined}>
            A
          </span>
          <IconChevronRight size={14} class={styles.chevronDown} />
        </button>
      </div>
      <Show when={panel() === "turn"}>
        <div class={styles.subPanel} role="menu" aria-label="Turn into">
          <For each={TURN_INTO_TYPES}>
            {(type) => (
              <button
                type="button"
                role="menuitem"
                class={styles.subItem}
                onClick={act(() => ed.turnBlocksInto(blocks(), type))}
              >
                {BLOCKS[type].label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={panel() === "color"}>
        <ColorPanel
          current={ed.selectionColor()}
          onPick={(color) => act(() => ed.setTextColor(color))()}
        />
      </Show>
    </Floating>
  );
}

/**
 * Text colors and backgrounds, as swatches.
 * @param {{ current: string | null, onPick: (color: string | null) => void }} props
 */
export function ColorPanel(props) {
  return (
    <div class={styles.subPanel} role="menu" aria-label="Color">
      <div class={styles.groupLabel}>Text color</div>
      <div class={styles.swatches}>
        <Swatch value={null} label="Default" current={props.current} onPick={props.onPick} />
        <For each={COLORS}>
          {(c) => (
            <Swatch value={c.name} label={c.label} current={props.current} onPick={props.onPick} />
          )}
        </For>
      </div>
      <div class={styles.groupLabel}>Background</div>
      <div class={styles.swatches}>
        <For each={COLORS}>
          {(c) => (
            <Swatch
              value={`${c.name}_background`}
              label={`${c.label} background`}
              current={props.current}
              onPick={props.onPick}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/** @param {{ value: string | null, label: string, current: string | null, onPick: (color: string | null) => void }} props */
function Swatch(props) {
  return (
    <button
      type="button"
      role="menuitemradio"
      class={styles.swatch}
      data-color={props.value ?? undefined}
      aria-label={props.label}
      aria-checked={props.current === props.value}
      title={props.label}
      onClick={() => props.onPick(props.value)}
    >
      A
    </button>
  );
}
