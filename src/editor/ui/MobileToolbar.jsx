// @ts-check
import { createEffect, createSignal, For, onCleanup } from "solid-js";
import { cx } from "../../lib/cx.js";
import { IconLink, IconMath, IconPlus } from "../../ui/icons/index.jsx";
import { isCollapsed } from "../commands/commands.js";
import styles from "./EditorUI.module.css";
import { setBottomInset } from "./Floating.jsx";
import { useCoarsePointer } from "./InlineToolbar.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */

const HEIGHT = 44;

/**
 * The formatting toolbar on touch screens, pinned above the on-screen
 * keyboard (it follows the visual viewport, which the keyboard shrinks).
 * It shows while the editor has focus. Buttons never take focus, so the
 * keyboard stays up; the row scrolls sideways when it doesn't fit.
 * @param {{ ed: EditorController }} props
 */
export default function MobileToolbar(props) {
  const ed = props.ed;
  const coarse = useCoarsePointer();
  const [top, setTop] = createSignal(0);
  const open = () => coarse() && !ed.readOnly && ed.focusedBlock() !== null;

  const place = () => {
    const vv = window.visualViewport;
    setTop((vv ? vv.offsetTop + vv.height : window.innerHeight) - HEIGHT);
  };
  place();
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
  window.addEventListener("resize", place);
  onCleanup(() => {
    window.visualViewport?.removeEventListener("resize", place);
    window.visualViewport?.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    setBottomInset(0);
  });
  createEffect(() => setBottomInset(open() ? HEIGHT : 0));

  const selected = () => {
    const sel = ed.trackedSelection();
    return sel !== null && !isCollapsed(sel);
  };

  const MARKS = [
    { mark: "bold", label: "Bold", glyph: "B", class: "glyphBold" },
    { mark: "italic", label: "Italic", glyph: "i", class: "glyphItalic" },
    { mark: "underline", label: "Underline", glyph: "U", class: "glyphUnderline" },
    { mark: "strike", label: "Strikethrough", glyph: "S", class: "glyphStrike" },
    { mark: "code", label: "Code", glyph: "</>", class: "glyphCode" },
  ];

  /** @param {() => void} fn */
  const tap = (fn) => (/** @type {MouseEvent} */ event) => {
    event.preventDefault();
    fn();
  };

  return (
    <div
      class={cx(styles.mobileBar, open() && styles.mobileBarOpen)}
      style={{ top: `${top()}px`, height: `${HEIGHT}px` }}
      role="toolbar"
      aria-label="Formatting"
      aria-hidden={open() ? undefined : "true"}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        // Keep focus (and the keyboard) in the editor.
        if (event.pointerType !== "mouse") event.preventDefault();
      }}
    >
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Add a block below"
        onClick={tap(() => {
          const block = ed.selection?.focus.block;
          if (block) ed.insertBelow(block);
        })}
      >
        <IconPlus size={20} />
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Block actions"
        onClick={tap(() => {
          const block = ed.selection?.focus.block;
          if (block) ed.onBlockMenu(block);
        })}
      >
        <svg viewBox="0 0 10 16" width="12" height="18" aria-hidden="true">
          <For each={[3, 8, 13]}>
            {(cy) => (
              <>
                <circle cx="2.5" cy={cy} r="1.3" fill="currentColor" />
                <circle cx="7.5" cy={cy} r="1.3" fill="currentColor" />
              </>
            )}
          </For>
        </svg>
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Mention a page"
        onClick={tap(() => ed.insertTrigger("mention"))}
      >
        @
      </button>
      <span class={styles.toolDivider} />
      <For each={MARKS}>
        {(b) => (
          <button
            type="button"
            class={cx(styles.mobileButton, styles[b.class])}
            aria-label={b.label}
            aria-pressed={ed.selectionHasMark(b.mark)}
            onClick={tap(() => ed.toggleMark(b.mark))}
          >
            {b.glyph}
          </button>
        )}
      </For>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Link"
        aria-disabled={selected() ? undefined : "true"}
        onClick={tap(() => ed.requestLink())}
      >
        <IconLink size={20} />
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Inline equation"
        aria-pressed={ed.selectionHasMark("math")}
        onClick={tap(() => ed.toggleInlineMath())}
      >
        <IconMath size={20} />
      </button>
      <span class={styles.toolDivider} />
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Outdent"
        onClick={tap(() => ed.indentSelection(true))}
      >
        ⇤
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Indent"
        onClick={tap(() => ed.indentSelection(false))}
      >
        ⇥
      </button>
      <span class={styles.toolDivider} />
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Undo"
        onClick={tap(() => ed.history(false))}
      >
        ↶
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Redo"
        onClick={tap(() => ed.history(true))}
      >
        ↷
      </button>
      <button
        type="button"
        class={styles.mobileButton}
        aria-label="Hide keyboard"
        onClick={tap(() => ed.root?.blur())}
      >
        ⌄
      </button>
    </div>
  );
}
