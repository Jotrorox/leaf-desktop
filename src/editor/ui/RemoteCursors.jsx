// @ts-check
import { createEffect, createSignal, Index, onCleanup, onMount } from "solid-js";
import { textRanges } from "../commands/commands.js";
import { rectAt, textRects } from "../view/dom.js";
import styles from "./RemoteCursors.module.css";

/**
 * Other people's cursors and selections, drawn over the editor: a caret
 * with their name, and their selection as tinted boxes from the text's
 * client rects. Positions come from their relative positions (anchored to
 * characters), resolved against our document, so they stay put while text
 * changes. Redrawn (once per frame at most) when presence changes, when the
 * document changes, and when the layout does.
 *
 * The name shows for a few seconds after a cursor moves, then fades to
 * just the caret.
 */

/** @typedef {import("../editor.js").EditorController} EditorController */
/** @typedef {import("../sync/presence.js").Collaborator} Collaborator */

/** How long a name stays up after its cursor moves (ms). */
const LABEL_TIME = 3000;

/**
 * @typedef {object} Box
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {object} Drawn
 * @property {number} session
 * @property {string} name
 * @property {string} color
 * @property {Box} caret
 * @property {Box[]} rects
 * @property {boolean} recent The cursor moved lately: show the name.
 * @property {boolean} flip The caret is near the top: the name goes below.
 */

/**
 * @param {{
 *   ed: EditorController,
 *   collaborators: () => readonly Collaborator[],
 *   container: () => HTMLElement | undefined,
 *   registerJump?: (fn: ((session: number) => void) | null) => void,
 * }} props
 */
export default function RemoteCursors(props) {
  const ed = props.ed;
  const [drawn, setDrawn] = createSignal(/** @type {Drawn[]} */ ([]));
  /** session → [cursor key, when it last moved] */
  /** @type {Map<number, { key: string, at: number }>} */
  const moved = new Map();
  /** @type {number | undefined} */
  let frame;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let labelTimer;

  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      draw();
    });
  };

  /** Where someone's selection is now, or null if it isn't on screen. @param {Collaborator} c */
  function resolve(c) {
    if (!c.cursor) return null;
    const a = ed.doc.resolveRelativePosition(c.cursor.anchor);
    const f = ed.doc.resolveRelativePosition(c.cursor.focus);
    if (!a || !f || !ed.doc.hasBlock(a.blockId) || !ed.doc.hasBlock(f.blockId)) return null;
    if (!ed.doc.isVisible(a.blockId) || !ed.doc.isVisible(f.blockId)) return null;
    return {
      anchor: { block: a.blockId, offset: a.offset },
      focus: { block: f.blockId, offset: f.offset },
    };
  }

  function draw() {
    const container = props.container();
    if (!container) return;
    const box = container.getBoundingClientRect();
    /** @param {DOMRect} r @returns {Box} */
    const local = (r) => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
    const now = Date.now();
    let nextExpiry = Infinity;
    /** @type {Drawn[]} */
    const out = [];
    const live = new Set();
    for (const c of props.collaborators()) {
      live.add(c.session);
      const sel = resolve(c);
      const key = sel
        ? `${sel.anchor.block}:${sel.anchor.offset}:${sel.focus.block}:${sel.focus.offset}`
        : "";
      const last = moved.get(c.session);
      if (!last || last.key !== key)
        moved.set(c.session, { key, at: last ? now : now - LABEL_TIME / 2 });
      if (!sel) continue;
      const focusEl = ed.textEls.get(sel.focus.block);
      if (!focusEl || !focusEl.isConnected) continue;
      const caret = local(rectAt(focusEl, sel.focus.offset));
      /** @type {Box[]} */
      const rects = [];
      if (sel.anchor.block !== sel.focus.block || sel.anchor.offset !== sel.focus.offset) {
        try {
          for (const { block, start, end } of textRanges(ed.ctx, sel)) {
            const el = ed.textEls.get(block);
            if (el) for (const r of textRects(el, start, end)) rects.push(local(r));
          }
        } catch {
          // A block of the selection isn't in the visible tree (a closed toggle).
        }
      }
      const at = /** @type {{ at: number }} */ (moved.get(c.session)).at;
      const recent = now - at < LABEL_TIME;
      if (recent) nextExpiry = Math.min(nextExpiry, at + LABEL_TIME);
      out.push({
        session: c.session,
        name: c.name,
        color: c.color,
        caret,
        rects,
        recent,
        flip: caret.y < 24,
      });
    }
    for (const session of [...moved.keys()]) if (!live.has(session)) moved.delete(session);
    setDrawn(out);
    clearTimeout(labelTimer);
    if (nextExpiry !== Infinity) labelTimer = setTimeout(schedule, nextExpiry - now + 20);
  }

  // Presence changed, or blocks were added, removed or moved.
  createEffect(() => {
    props.collaborators();
    ed.structure();
    schedule();
  });

  onMount(() => {
    const unobserve = ed.doc.observe(schedule);
    const resize = new ResizeObserver(schedule);
    const container = props.container();
    if (container) resize.observe(container);
    if (ed.root) resize.observe(ed.root);
    window.addEventListener("resize", schedule);
    // Webfonts change line breaks once they load.
    document.fonts?.ready.then(schedule).catch(() => {});
    props.registerJump?.((session) => {
      const c = props.collaborators().find((x) => x.session === session);
      const sel = c && resolve(c);
      const el = sel && ed.textEls.get(sel.focus.block);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      moved.delete(session); // show the name again
      schedule();
    });
    onCleanup(() => {
      unobserve();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      props.registerJump?.(null);
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(labelTimer);
    });
  });

  return (
    <div class={styles.layer} aria-hidden="true">
      <Index each={drawn()}>
        {(d) => (
          <div
            class={styles.cursor}
            style={{ "--cursor-color": d().color }}
            data-session={d().session}
          >
            <Index each={d().rects}>
              {(r) => (
                <div
                  class={styles.selection}
                  style={{
                    left: `${r().x}px`,
                    top: `${r().y}px`,
                    width: `${r().w}px`,
                    height: `${r().h}px`,
                  }}
                />
              )}
            </Index>
            <div
              class={styles.caret}
              style={{
                left: `${d().caret.x}px`,
                top: `${d().caret.y}px`,
                height: `${d().caret.h}px`,
              }}
            >
              <span
                class={styles.label}
                data-visible={d().recent ? "" : undefined}
                data-flip={d().flip ? "" : undefined}
              >
                {d().name}
              </span>
            </div>
          </div>
        )}
      </Index>
    </div>
  );
}
