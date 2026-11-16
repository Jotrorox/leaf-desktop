// @ts-check
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { cx } from "../../lib/cx.js";
import { readStorage, writeStorage } from "../../lib/storage.js";
import Button from "../../ui/Button.jsx";
import IconButton from "../../ui/IconButton.jsx";
import { IconMath, IconMore } from "../../ui/icons/index.jsx";
import Menu, { MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import Popover from "../../ui/Popover.jsx";
import { texQueryAt } from "../math/commands.js";
import { copyMath } from "../math/copy.js";
import { useMathReady } from "../math/ready.js";
import { renderMath } from "../math/render.js";
import styles from "./EditorUI.module.css";
import Floating, { bottomInset } from "./Floating.jsx";
import SymbolPalette from "./SymbolPalette.jsx";
import { createTexCompletions, TexCommandList, usePageCommands } from "./TexMenu.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */

/** Whether the symbol palette shows (remembered per browser). */
const SYMBOLS_KEY = "leaf.mathSymbols";

/**
 * Editing an inline formula: a TeX field with a live preview, next to the
 * formula (or the caret, for a new one). Enter or Done saves; clicking
 * outside saves too; Escape cancels. Emptying the field and saving deletes
 * the formula.
 * @param {{ ed: EditorController }} props
 */
export default function MathPopover(props) {
  const ed = props.ed;
  const ready = useMathReady();
  const request = () => ed.mathRequest();
  const [value, setValue] = createSignal("");
  /** @type {HTMLTextAreaElement | undefined} */
  let input;
  /** Whether the press that closed the popover was in the page's text (so the caret goes there). */
  let pressedInText = false;
  const listId = createUniqueId();

  // `\` commands: the one being typed before the caret, and the list for it.
  const [command, setCommand] = createSignal(
    /** @type {{ start: number, query: string } | null} */ (null),
  );
  const completions = createTexCompletions(
    () => command()?.query ?? null,
    (picked) => {
      const at = command();
      if (input && at) insert(picked, at.start, input.selectionStart);
    },
    usePageCommands(ed),
  );
  const listOpen = () => command() !== null && completions.items().length > 0;
  const [symbols, setSymbols] = createSignal(readStorage(SYMBOLS_KEY) === true);

  /**
   * Put a command (a completion, a palette symbol) in place of the field's
   * text from `start` to `end`, with the caret where it says.
   * @param {import("../math/commands.js").TexCommand} picked @param {number} start @param {number} end
   */
  const insert = (picked, start, end) => {
    if (!input) return;
    const next = value().slice(0, start) + picked.insert + value().slice(end);
    setValue(next);
    setCommand(null);
    input.value = next;
    input.setSelectionRange(start + picked.caret, start + picked.caret);
    fit(input);
  };

  createEffect(
    on(request, (r) => {
      if (!r) return;
      setValue(r.source);
      setCommand(null);
      pressedInText = false;
      queueMicrotask(() => {
        if (!input) return;
        fit(input);
        input.setSelectionRange(input.value.length, input.value.length);
        // With the palette up on a touch screen, no keyboard until the field is tapped.
        if (untrack(symbols) && matchMedia("(pointer: coarse)").matches) {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          return;
        }
        input.focus({ preventScroll: true });
      });
    }),
  );

  const onPointerDown = (/** @type {PointerEvent} */ event) => {
    pressedInText = event.target instanceof Node && !!ed.root?.contains(event.target);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));

  /**
   * The preview. While the TeX has an error, the last formula that drew
   * (for this request) stays, dimmed.
   * @typedef {{ html: string, stale: boolean, error: string | null, request: unknown }} Preview
   */
  const preview = createMemo((/** @type {Preview | undefined} */ prev) => {
    ready();
    const r = request();
    const tex = value();
    if (tex.trim() === "") return { html: "", stale: false, error: null, request: r };
    const result = renderMath(tex, { macros: ed.mathMacros(), refs: ed.equationNumbering().refs });
    if (!result) return { html: "", stale: false, error: null, request: r };
    if (result.html !== null) return { html: result.html, stale: false, error: null, request: r };
    const last = prev && prev.request === r ? prev.html : "";
    // Half a command while its completions are up isn't an error yet.
    return {
      html: last,
      stale: last !== "",
      error: command() !== null ? null : result.error,
      request: r,
    };
  });

  const save = () => ed.finishMath(value(), "after");

  return (
    <Popover
      open={request() !== null}
      onOpenChange={(open) => {
        if (open) return;
        // Clicked away: saved, with the caret where the click put it (or
        // focus wherever it went).
        ed.finishMath(
          value(),
          pressedInText ? "keep" : document.activeElement === ed.root ? "after" : "none",
        );
      }}
      anchor={() => ed.root ?? undefined}
      anchorRect={() => ed.mathRect()}
      bottomInset={bottomInset}
      placement="bottom-start"
      offset={8}
      initialFocus="none"
      focusOnClose={() => ed.root}
      class={styles.mathPopover}
      role="dialog"
      aria-label={request()?.id === null ? "New equation" : "Edit equation"}
    >
      <div
        class={styles.mathPreview}
        data-empty={preview().html === "" && !preview().error ? "" : undefined}
      >
        <Show
          when={preview().html}
          fallback={
            <span class={styles.mathPreviewEmpty}>
              {value().trim() === "" ? "Preview" : preview().error ? "" : value()}
            </span>
          }
        >
          <span
            class={styles.mathPreviewMath}
            data-stale={preview().stale ? "" : undefined}
            innerHTML={preview().html}
            aria-hidden={preview().stale ? "true" : undefined}
          />
        </Show>
        <Show when={preview().error}>
          <p class={styles.mathError} role="status">
            {preview().error}
          </p>
        </Show>
      </div>
      <textarea
        ref={input}
        class={styles.mathInput}
        rows={1}
        value={value()}
        placeholder="E = mc^2"
        aria-label="TeX source"
        aria-autocomplete="list"
        aria-controls={listOpen() ? listId : undefined}
        aria-activedescendant={listOpen() ? `${listId}-${completions.active()}` : undefined}
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        data-1p-ignore
        onInput={(event) => {
          const el = event.currentTarget;
          setValue(el.value);
          setCommand(texQueryAt(el.value, el.selectionStart));
          fit(el);
        }}
        onBlur={() => setCommand(null)}
        onClick={() => setCommand(null)}
        onKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (listOpen()) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setCommand(null);
              return;
            }
            if (
              !event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              completions.keys(event.key)
            ) {
              event.preventDefault();
              return;
            }
          }
          if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) setCommand(null);
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            ed.finishMath(null, "after");
          }
        }}
      />
      <Show when={symbols()}>
        <div id={`${listId}-symbols`}>
          <SymbolPalette
            onInsert={(item) => input && insert(item, input.selectionStart, input.selectionEnd)}
          />
        </div>
      </Show>
      <Floating
        open={listOpen()}
        rect={() => input?.getBoundingClientRect() ?? null}
        placement="bottom-start"
        offset={4}
        class={cx(styles.menu, styles.texMenu)}
      >
        <TexCommandList id={listId} completions={completions} macros={ed.mathMacros()} />
      </Floating>
      <div class={styles.mathFooter}>
        <a
          class={styles.mathHelp}
          href="https://katex.org/docs/supported.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          TeX reference
        </a>
        <div class={styles.mathActions}>
          <IconButton
            label="Symbols"
            size="small"
            tooltipPlacement="bottom"
            aria-pressed={symbols()}
            aria-controls={symbols() ? `${listId}-symbols` : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const next = !symbols();
              setSymbols(next);
              writeStorage(SYMBOLS_KEY, next);
              // On a touch screen the palette stands in for the keyboard (there's
              // no room for both); tapping the field brings the keyboard back.
              if (next && matchMedia("(pointer: coarse)").matches) input?.blur();
            }}
          >
            <IconMath size={16} />
          </IconButton>
          <Menu
            label="More"
            placement="bottom-end"
            focusOnClose={() => input}
            trigger={(trigger) => (
              <IconButton {...trigger} label="More" size="small" tooltipPlacement="bottom">
                <IconMore size={16} />
              </IconButton>
            )}
          >
            <MenuItem onSelect={() => void copyMath([value()], "tex", false, ed.mathMacros())}>
              Copy as TeX
            </MenuItem>
            <MenuItem
              onSelect={() =>
                void copyMath(
                  [value()],
                  "mathml",
                  false,
                  ed.mathMacros(),
                  ed.equationNumbering().refs,
                )
              }
            >
              Copy as MathML
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                // The formula is saved as it is; the dialog takes over.
                ed.finishMath(value(), "none");
                ed.setMacrosOpen(true);
              }}
            >
              Page macros…
            </MenuItem>
          </Menu>
          <Button variant="primary" class={styles.mathDone} title="Done (Enter)" onClick={save}>
            Done
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/** Grow a text field to its content. @param {HTMLTextAreaElement} el */
function fit(el) {
  el.style.height = "auto";
  // scrollHeight leaves out the border, which border-box sizing counts.
  const full = el.scrollHeight + el.offsetHeight - el.clientHeight;
  el.style.height = `${full}px`;
  // A scrollbar only once it stops growing.
  el.style.overflowY = full > parseFloat(getComputedStyle(el).maxHeight) ? "auto" : "hidden";
}
