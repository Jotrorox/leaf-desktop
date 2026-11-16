// @ts-check
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { formatShortcut, isApplePlatform } from "../../lib/shortcuts.js";
import Button from "../../ui/Button.jsx";
import Dialog from "../../ui/Dialog.jsx";
import { useMathReady } from "../math/ready.js";
import { parseMacros, renderMath } from "../math/render.js";
import styles from "./EditorUI.module.css";

/** @typedef {import("../editor.js").EditorController} EditorController */

const PLACEHOLDER =
  "\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}";

/**
 * Page macros: TeX definitions (`\newcommand`, `\def`) every formula on the
 * page can use, kept in the document (so they sync, undo and travel with
 * the page). KaTeX checks them as they're typed; each command it accepts is
 * shown drawn. Save (or ⌘Enter) applies them as one undo step.
 * @param {{ ed: EditorController }} props
 */
export default function MacrosDialog(props) {
  const ed = props.ed;
  const ready = useMathReady();
  const statusId = createUniqueId();
  const [value, setValue] = createSignal("");
  createEffect(
    on(
      () => ed.macrosOpen(),
      (open) => {
        if (open) setValue(ed.mathMacros());
      },
    ),
  );
  const parsed = createMemo(() => {
    ready();
    return parseMacros(value());
  });

  const close = () => {
    ed.setMacrosOpen(false);
    queueMicrotask(() => ed.restoreFocus());
  };
  const save = () => {
    ed.setMathMacros(value());
    close();
  };

  return (
    <Dialog
      open={ed.macrosOpen()}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Page macros"
      description="Commands every formula on this page can use."
      class={styles.macrosDialog}
    >
      <form
        class={styles.macrosForm}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <textarea
          class={styles.macrosInput}
          rows={7}
          maxLength={10000}
          value={value()}
          placeholder={PLACEHOLDER}
          aria-label="Macro definitions"
          aria-describedby={statusId}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          data-1p-ignore
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
        />
        <div id={statusId} class={styles.macrosStatus}>
          <Show when={parsed()?.error}>
            {(error) => (
              <p class={styles.mathError} role="status">
                {error()}
              </p>
            )}
          </Show>
          <Show
            when={(parsed()?.names.length ?? 0) > 0}
            fallback={
              <p class={styles.macrosHint}>
                Write <code>\newcommand{"{\\name}{…}"}</code>, with <code>[n]</code> after the name
                for arguments (<code>#1</code>, <code>#2</code>…). A command KaTeX already has needs{" "}
                <code>\renewcommand</code>.
              </p>
            }
          >
            <ul class={styles.macrosList} aria-label="Defined commands">
              <For each={parsed()?.names ?? []}>
                {(m) => {
                  const call =
                    `\\${m.name}` +
                    Array.from({ length: m.args }, (_, i) => `{${"xyzuvw"[i] ?? "x"}}`).join("");
                  return (
                    <li class={styles.macrosItem}>
                      <code>{`\\${m.name}`}</code>
                      <span
                        aria-hidden="true"
                        innerHTML={renderMath(call, { macros: value() })?.html ?? ""}
                      />
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
        <div class={styles.macrosActions}>
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            title={`Save (${formatShortcut("mod+enter", isApplePlatform())})`}
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
