// @ts-check
import { createEffect, createMemo, createSignal, For, on } from "solid-js";
import { cx } from "../../lib/cx.js";
import { matchTexCommands, pageCommands } from "../math/commands.js";
import { useMathReady } from "../math/ready.js";
import { parseMacros, renderMath } from "../math/render.js";
import styles from "./EditorUI.module.css";
import Floating from "./Floating.jsx";
import {
  openSuggestion,
  suggestionRect,
  useActiveDescendant,
  useSuggestionKeys,
} from "./SlashMenu.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */
/** @typedef {import("../math/commands.js").TexCommand} TexCommand */

/**
 * The page's own completions, tracked: its macros (once KaTeX is loaded)
 * and references to its labelled equations.
 * @param {EditorController} ed
 */
export function usePageCommands(ed) {
  const ready = useMathReady();
  return createMemo(() => {
    ready();
    return pageCommands(parseMacros(ed.mathMacros())?.names ?? [], ed.equationNumbering().refs);
  });
}

/**
 * The state of a TeX command list: the matches for `query` (null: closed),
 * the active one, and the keys that move through and pick them. The field
 * being typed in keeps focus and hands its keys to `keys`. `extra`: the
 * page's own commands, listed first.
 * @param {() => string | null} query @param {(command: TexCommand) => void} pick @param {() => TexCommand[]} [extra]
 */
export function createTexCompletions(query, pick, extra = () => []) {
  const items = createMemo(() => {
    const q = query();
    return q === null ? [] : matchTexCommands(q, 8, extra());
  });
  const [active, setActive] = createSignal(0);
  createEffect(on(query, () => setActive(0)));
  /** ↑/↓ move, Enter or Tab pick. Returns whether the key was used. @param {string} key */
  const keys = (key) => {
    const all = items();
    if (all.length === 0) return false;
    if (key === "ArrowDown") setActive((i) => (i + 1) % all.length);
    else if (key === "ArrowUp") setActive((i) => (i - 1 + all.length) % all.length);
    else if (key === "Enter" || key === "Tab") pick(all[Math.min(active(), all.length - 1)]);
    else return false;
    return true;
  };
  return { items, active, setActive, keys, pick };
}

/**
 * The list itself: each command's drawing and its name.
 * @param {{ id: string, completions: ReturnType<typeof createTexCompletions>, macros: string }} props `macros`: the page's, to draw its own commands.
 */
export function TexCommandList(props) {
  const ready = useMathReady();
  const c = props.completions;
  /** @type {HTMLDivElement | undefined} */
  let list;
  createEffect(() => {
    const index = c.active();
    list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  });
  return (
    <div ref={list} id={props.id} role="listbox" aria-label="TeX commands" class={styles.texList}>
      <For each={c.items()}>
        {(command, index) => (
          <div
            id={`${props.id}-${index()}`}
            role="option"
            aria-selected={c.active() === index()}
            data-index={index()}
            class={cx(
              styles.option,
              styles.optionCompact,
              c.active() === index() && styles.optionActive,
            )}
            onPointerMove={() => c.setActive(index())}
            onClick={() => c.pick(command)}
          >
            <span
              class={styles.texPreview}
              aria-hidden="true"
              innerHTML={
                (ready(), renderMath(command.preview, { macros: props.macros })?.html ?? "")
              }
            />
            <span class={styles.texName}>\{command.label}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Completion for `\` commands in an equation block's source, under the
 * typed backslash, like the slash menu.
 * @param {{ ed: EditorController, id: string }} props `id`: the listbox id.
 */
export default function TexMenu(props) {
  const ed = props.ed;
  const s = () => openSuggestion(ed, "tex");
  const completions = createTexCompletions(
    () => s()?.query ?? null,
    (command) => ed.applyTexCommand(command),
    usePageCommands(ed),
  );
  const open = () => s() !== null && completions.items().length > 0;
  useSuggestionKeys(ed, open, completions.keys);
  useActiveDescendant(ed, props.id, open, completions.active);
  return (
    <Floating
      open={open()}
      rect={() => suggestionRect(ed, s())}
      class={cx(styles.menu, styles.texMenu)}
    >
      <TexCommandList id={props.id} completions={completions} macros={ed.mathMacros()} />
    </Floating>
  );
}
