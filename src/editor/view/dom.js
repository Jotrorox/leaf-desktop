// @ts-check
import { MATH_MARK, safeHref } from "../blocks/schema.js";
import { NO_REFS, resolveRefs } from "../math/refs.js";
import { onMathReady, renderMath } from "../math/render.js";

/**
 * The DOM side of the editor: rendering a block's text runs into its text
 * element, and mapping between DOM positions (node, offset) and model
 * positions (block id, UTF-16 offset).
 *
 * Every text element carries `data-text="<block id>"` and contains only
 * what `renderRuns` puts there: one element per run holding one text node,
 * plus a `<br>` when the text is empty or ends in a line break (so the line
 * has height and can hold the caret). Offsets therefore equal the length of
 * the text before a point.
 *
 * The exception is inline math: a formula's run is one non-editable
 * element (`data-math`) holding KaTeX's output, which counts as the length
 * of its TeX source. A position is only ever before or after it, never
 * inside. A text element ending in a formula gets a `<br>` too, so the
 * caret has somewhere to go after it, and before that an empty image (a
 * "separator", as ProseMirror calls it): WebKit paints no caret between a
 * non-editable element and a `<br>`, but does beside an image. It has no
 * text, so it counts for nothing.
 */

/** @typedef {import("../model/doc.js").TextRun} TextRun */
/** @typedef {import("../commands/commands.js").Pos} Pos */
/** @typedef {import("../commands/commands.js").Sel} Sel */

const RUN = Symbol("run key");
/** On a formula's element: its TeX source. */
const SOURCE = Symbol("math source");
/** On a formula's element: the page macros (TeX) and equation labels it's drawn with. */
const CONTEXT = Symbol("math context");
/** On a formula's element: what it was last drawn as (macros and resolved TeX). */
const DRAWN = Symbol("math drawn");

/**
 * What formulas need from their page: its macros (TeX) and its equation labels.
 * @typedef {{ macros: string, refs: import("../math/refs.js").Refs }} MathContext
 */

/** @type {MathContext} */
const NO_CONTEXT = { macros: "", refs: NO_REFS };

/** What a formula draws as in a context: a change means drawing it again. @param {string} tex @param {MathContext} math */
const drawnAs = (tex, math) => math.macros + "\0" + resolveRefs(tex, math.refs);

/** @param {TextRun} run */
function runKey(run) {
  return run.marks ? JSON.stringify(run.marks) : "";
}

/**
 * The page a mention mark points at, or null.
 * @param {unknown} value
 */
export function mentionedPage(value) {
  if (!value || typeof value !== "object") return null;
  const { type, id } = /** @type {{ type?: unknown, id?: unknown }} */ (value);
  return type === "page" && typeof id === "string" && id !== "" ? id : null;
}

/** @param {TextRun} run */
const isMathRun = (run) => run.marks?.[MATH_MARK] !== undefined && run.marks?.[MATH_MARK] !== null;

/**
 * Whether a node is a formula's element.
 * @param {Node | null | undefined} node
 * @returns {node is HTMLElement}
 */
export function isMathElement(node) {
  return (
    !!node && node.nodeType === Node.ELEMENT_NODE && /** @type {any} */ (node)[SOURCE] !== undefined
  );
}

/** Whether a node is the separator after a formula at the end of a text element. @param {Node | null | undefined} node */
function isSeparator(node) {
  return (
    !!node &&
    node.nodeName === "IMG" &&
    /** @type {HTMLElement} */ (node).dataset.separator !== undefined
  );
}

function createSeparator() {
  const img = document.createElement("img");
  img.dataset.separator = "";
  img.alt = "";
  img.setAttribute("role", "presentation");
  return img;
}

/** A formula element's TeX source. @param {HTMLElement} el @returns {string} */
export function mathSource(el) {
  return /** @type {any} */ (el)[SOURCE] ?? "";
}

/** How much of the text a child of a text element stands for. @param {Node} node */
function nodeLength(node) {
  return isMathElement(node) ? mathSource(node).length : (node.textContent?.length ?? 0);
}

let waitingForMath = false;

/**
 * Draw a formula element's KaTeX output: the source in monospace while
 * KaTeX loads (all of them are drawn once it's there), and the source with
 * the error as a tooltip when it doesn't parse.
 * @param {HTMLElement} el
 */
function drawMath(el) {
  const tex = mathSource(el);
  /** @type {MathContext} */
  const math = /** @type {any} */ (el)[CONTEXT] ?? NO_CONTEXT;
  /** @type {any} */ (el)[DRAWN] = drawnAs(tex, math);
  const result = renderMath(tex, math);
  if (result && result.html !== null) {
    el.innerHTML = result.html;
    delete el.dataset.mathState;
    el.removeAttribute("title");
    return;
  }
  el.textContent = tex;
  if (result) {
    el.dataset.mathState = "error";
    el.title = result.error;
  } else {
    el.dataset.mathState = "pending";
    el.removeAttribute("title");
    if (!waitingForMath) {
      waitingForMath = true;
      onMathReady(() => {
        for (const pending of document.querySelectorAll("[data-math-state='pending']")) {
          if (isMathElement(pending)) drawMath(pending);
        }
      });
    }
  }
}

/** @param {TextRun} run @param {MathContext} math */
function createMath(run, math) {
  const el = document.createElement("span");
  el.className = "m-math";
  el.contentEditable = "false";
  el.dataset.math = "";
  if (typeof run.marks?.color === "string") el.dataset.color = run.marks.color;
  /** @type {any} */ (el)[SOURCE] = run.text;
  /** @type {any} */ (el)[CONTEXT] = math;
  /** @type {any} */ (el)[RUN] = runKey(run);
  drawMath(el);
  return el;
}

/** @param {TextRun} run @param {MathContext} math */
function createRun(run, math) {
  if (isMathRun(run)) return createMath(run, math);
  const m = run.marks ?? {};
  const page = mentionedPage(m.mention);
  const href = page ? `/p/${encodeURIComponent(page)}` : safeHref(m.link);
  /** @type {HTMLElement} */
  const el = href ? document.createElement("a") : document.createElement("span");
  if (page) {
    el.setAttribute("href", /** @type {string} */ (href));
    el.dataset.mention = page;
  } else if (href) {
    el.setAttribute("href", href);
    el.setAttribute("rel", "noopener noreferrer");
    el.setAttribute("target", "_blank");
  }
  /** @type {string[]} */
  const classes = [];
  for (const name of ["bold", "italic", "underline", "strike", "code"])
    if (m[name]) classes.push(`m-${name}`);
  if (page) classes.push("m-mention");
  else if (href) classes.push("m-link");
  if (classes.length) el.className = classes.join(" ");
  if (typeof m.color === "string") el.dataset.color = m.color;
  el.appendChild(document.createTextNode(run.text));
  /** @type {any} */ (el)[RUN] = runKey(run);
  return el;
}

/**
 * Make `el`'s content show `runs`, touching only what differs: unchanged
 * runs keep their nodes (so spellcheck marks and IME state survive), and
 * stray nodes (left by the browser during composition) are removed.
 *
 * @param {HTMLElement} el
 * @param {TextRun[]} runs
 * @param {MathContext} [math] The page's macros and equation labels, for formulas; a formula redraws when what it draws changes.
 */
export function renderRuns(el, runs, math = NO_CONTEXT) {
  const nodes = [...el.childNodes];
  let i = 0;
  for (const run of runs) {
    const node = nodes[i];
    const key = runKey(run);
    if (node && /** @type {any} */ (node)[RUN] === key && isMathElement(node)) {
      if (mathSource(node) === run.text) {
        /** @type {any} */ (node)[CONTEXT] = math;
        if (/** @type {any} */ (node)[DRAWN] !== drawnAs(run.text, math))
          drawMath(/** @type {HTMLElement} */ (node));
        i++;
        continue;
      }
    } else if (
      node &&
      /** @type {any} */ (node)[RUN] === key &&
      node.childNodes.length === 1 &&
      node.firstChild?.nodeType === Node.TEXT_NODE
    ) {
      const text = /** @type {Text} */ (node.firstChild);
      if (text.data !== run.text) text.data = run.text;
      i++;
      continue;
    }
    const fresh = createRun(run, math);
    if (node) el.replaceChild(fresh, node);
    else el.appendChild(fresh);
    nodes[i] = fresh;
    i++;
  }
  const text = runs.map((r) => r.text).join("");
  const last = runs[runs.length - 1];
  const mathEnd = !!last && isMathRun(last);
  if (mathEnd) {
    if (isSeparator(nodes[i])) i++;
    else {
      const img = createSeparator();
      if (nodes[i]) el.insertBefore(img, nodes[i]);
      else el.appendChild(img);
      nodes.splice(i, 0, img);
      i++;
    }
  }
  const needsBreak = text === "" || mathEnd || text.endsWith("\n");
  const tail = nodes[i];
  if (needsBreak) {
    if (tail && tail.nodeName === "BR") i++;
    else {
      const br = document.createElement("br");
      if (tail) el.insertBefore(br, tail);
      else el.appendChild(br);
      nodes.splice(i, 0, br);
      i++;
    }
  }
  for (let j = nodes.length - 1; j >= i; j--) nodes[j].remove();
  // Text nodes the browser added directly (composition) were replaced above
  // only if they sat where a run goes; drop any left between runs.
  for (const child of [...el.childNodes]) {
    if (
      child.nodeName !== "BR" &&
      !isSeparator(child) &&
      /** @type {any} */ (child)[RUN] === undefined
    )
      child.remove();
  }
  if (text === "") el.dataset.empty = "";
  else delete el.dataset.empty;
}

/** The text an element shows, as the model counts it (a formula as its source). @param {Node} el */
export function domText(el) {
  if (isMathElement(el)) return mathSource(el);
  if (
    el.nodeType !== Node.ELEMENT_NODE ||
    !(/** @type {Element} */ (el).querySelector("[data-math]"))
  )
    return el.textContent ?? "";
  let out = "";
  for (const child of el.childNodes) out += domText(child);
  return out;
}

/** @param {Node | null} node */
export function textElementOf(node) {
  const el =
    node === null
      ? null
      : node.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (node)
        : node.parentElement;
  return /** @type {HTMLElement | null} */ (el?.closest("[data-text]") ?? null);
}

/**
 * Offset of a DOM point inside a text element: the length of the text
 * before it. A point inside a formula snaps to its end (or its start, for
 * the point right before its content).
 * @param {HTMLElement} textEl @param {Node} node @param {number} offset
 */
function offsetIn(textEl, node, offset) {
  if (node === textEl) {
    let n = 0;
    const kids = textEl.childNodes;
    for (let i = 0; i < offset && i < kids.length; i++) n += nodeLength(kids[i]);
    return n;
  }
  /** @type {Node} */
  let child = node;
  while (child.parentNode && child.parentNode !== textEl) child = child.parentNode;
  if (child.parentNode !== textEl) return 0;
  let n = 0;
  for (const c of textEl.childNodes) {
    if (c === child) break;
    n += nodeLength(c);
  }
  if (isMathElement(child)) return n + (node === child && offset === 0 ? 0 : nodeLength(child));
  const range = document.createRange();
  range.setStart(child, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return n;
  }
  return n + range.toString().length;
}

/**
 * The model position of a DOM point inside the editor `root`, or null.
 * Points between blocks or in non-text parts (bullets, checkboxes) snap to
 * the nearest text.
 *
 * @param {HTMLElement} root @param {Node} node @param {number} offset
 * @returns {Pos | null}
 */
export function domToPos(root, node, offset) {
  if (!root.contains(node)) return null;
  const textEl = textElementOf(node);
  if (textEl && root.contains(textEl)) {
    return {
      block: /** @type {string} */ (textEl.dataset.text),
      offset: offsetIn(textEl, node, offset),
    };
  }
  // An element point: look at the child after it, then before it.
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = /** @type {Element} */ (node);
    const after = el.childNodes[offset] ?? null;
    const inAfter = after && firstText(after);
    if (inAfter) return { block: /** @type {string} */ (inAfter.dataset.text), offset: 0 };
    const before = offset > 0 ? el.childNodes[offset - 1] : null;
    const inBefore = before && lastText(before);
    if (inBefore)
      return {
        block: /** @type {string} */ (inBefore.dataset.text),
        offset: domText(inBefore).length,
      };
  }
  // Inside a block's non-text part: the start of that block's text.
  const block = (
    node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement
  )?.closest("[data-block-id]");
  const own = block?.querySelector(":scope > [data-row] [data-text]");
  if (own instanceof HTMLElement)
    return { block: /** @type {string} */ (own.dataset.text), offset: 0 };
  return null;
}

/** @param {Node} node @returns {HTMLElement | null} */
function firstText(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = /** @type {HTMLElement} */ (node);
  if (el.dataset.text !== undefined) return el;
  return el.querySelector("[data-text]");
}

/** @param {Node} node @returns {HTMLElement | null} */
function lastText(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = /** @type {HTMLElement} */ (node);
  if (el.dataset.text !== undefined) return el;
  const all = el.querySelectorAll("[data-text]");
  return /** @type {HTMLElement | null} */ (all[all.length - 1] ?? null);
}

/**
 * The DOM point for an offset in a text element. At a boundary between two
 * runs it prefers the end of the earlier one; next to a formula, it's the
 * text beside it, or the text element's own point before or after it.
 * @param {HTMLElement} textEl @param {number} offset
 * @returns {{ node: Node, offset: number }}
 */
export function posToDom(textEl, offset) {
  const kids = [...textEl.childNodes];
  let left = offset;
  /** @type {{ node: Node, offset: number }} */
  let last = { node: textEl, offset: 0 };
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (isMathElement(child)) {
      const length = mathSource(child).length;
      if (left === 0) return { node: textEl, offset: i };
      if (left <= length) {
        // After it (a point inside snaps to the end): the start of the text
        // that follows, or past the separator at the end of the line.
        const next = kids[i + 1];
        if (isSeparator(next)) return { node: textEl, offset: i + 2 };
        const text = next && !isMathElement(next) ? firstTextNode(next) : null;
        return text ? { node: text, offset: 0 } : { node: textEl, offset: i + 1 };
      }
      left -= length;
      last = { node: textEl, offset: i + 1 };
      continue;
    }
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    for (
      let n = /** @type {Text | null} */ (
        child.nodeType === Node.TEXT_NODE ? child : walker.nextNode()
      );
      n !== null;
      n = /** @type {Text | null} */ (n === child ? null : walker.nextNode())
    ) {
      if (left <= n.data.length) {
        // After a trailing line break, the caret belongs on the next line: before the <br>.
        if (left === n.data.length && n.data.endsWith("\n") && left > 0) {
          const next = kids[i + 1];
          if (next && next.nodeName === "BR") return { node: textEl, offset: i + 1 };
        }
        return { node: n, offset: left };
      }
      left -= n.data.length;
      last = { node: n, offset: n.data.length };
    }
  }
  return last;
}

/** @param {Node} node @returns {Text | null} */
function firstTextNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return /** @type {Text} */ (node);
  if (node.nodeName === "BR") return null;
  return /** @type {Text | null} */ (
    document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
  );
}

/**
 * The formulas drawn in a text element, with their offsets.
 * @param {HTMLElement} textEl
 * @returns {{ el: HTMLElement, start: number, end: number }[]}
 */
export function mathElements(textEl) {
  /** @type {{ el: HTMLElement, start: number, end: number }[]} */
  const out = [];
  let pos = 0;
  for (const child of textEl.childNodes) {
    const length = nodeLength(child);
    if (isMathElement(child)) out.push({ el: child, start: pos, end: pos + length });
    pos += length;
  }
  return out;
}

/**
 * The editor's selection in model terms, or null when it's outside.
 * @param {HTMLElement} root
 * @returns {Sel | null}
 */
export function readSelection(root) {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const anchor = domToPos(root, sel.anchorNode, sel.anchorOffset);
  const focus = domToPos(root, sel.focusNode, sel.focusOffset);
  if (!anchor || !focus) return null;
  return { anchor, focus };
}

/**
 * Whether a DOM point is a text element's own point after its closing
 * `<br>` (the browser leaves the caret there when the node it was in goes).
 * @param {Node | null} node @param {number} offset
 */
function afterTrailingBreak(node, offset) {
  if (
    !node ||
    node.nodeType !== Node.ELEMENT_NODE ||
    /** @type {HTMLElement} */ (node).dataset.text === undefined
  )
    return false;
  return (
    offset > 0 && offset === node.childNodes.length && node.childNodes[offset - 1].nodeName === "BR"
  );
}

/**
 * Put the DOM selection at a model selection (unless it's already there).
 * @param {HTMLElement} root
 * @param {(id: string) => HTMLElement | undefined} textEl
 * @param {Sel} sel
 * @returns {boolean} false if a block isn't rendered.
 */
export function writeSelection(root, textEl, sel) {
  const a = textEl(sel.anchor.block);
  const f = textEl(sel.focus.block);
  if (!a || !f) return false;
  const current = readSelection(root);
  const domSel = root.ownerDocument.getSelection();
  if (!domSel) return false;
  const focused = root.ownerDocument.activeElement === root;
  if (
    focused &&
    current &&
    current.anchor.block === sel.anchor.block &&
    current.anchor.offset === sel.anchor.offset &&
    current.focus.block === sel.focus.block &&
    current.focus.offset === sel.focus.offset &&
    // The browser may report the right offset at a node we're about to remove.
    root.contains(domSel.anchorNode) &&
    root.contains(domSel.focusNode) &&
    // ...or between blocks, where a moved block (a table row) left it.
    textElementOf(domSel.anchorNode) !== null &&
    textElementOf(domSel.focusNode) !== null &&
    // ...or past a trailing <br>, where the caret shows on a line that isn't there.
    !afterTrailingBreak(domSel.anchorNode, domSel.anchorOffset) &&
    !afterTrailingBreak(domSel.focusNode, domSel.focusOffset)
  ) {
    return true;
  }
  const ad = posToDom(a, sel.anchor.offset);
  const fd = posToDom(f, sel.focus.offset);
  if (!focused) root.focus({ preventScroll: true });
  domSel.setBaseAndExtent(ad.node, ad.offset, fd.node, fd.offset);
  return true;
}

/**
 * Scroll the caret into view if it's off screen.
 * @param {HTMLElement} root
 */
export function scrollCaretIntoView(root) {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  let rect = range.getBoundingClientRect();
  if (rect.height === 0) {
    const el = textElementOf(sel.focusNode);
    if (!el) return;
    rect = el.getBoundingClientRect();
  }
  const view = root.ownerDocument.defaultView;
  if (!view) return;
  const top = view.visualViewport?.offsetTop ?? 0;
  const height = view.visualViewport?.height ?? view.innerHeight;
  const margin = 48;
  if (rect.bottom > top + height - margin || rect.top < top + margin) {
    const el = textElementOf(sel.focusNode);
    el?.scrollIntoView({ block: "nearest" });
    // scrollIntoView may still leave the caret under the bottom edge on long blocks.
    const after = range.getBoundingClientRect();
    if (after.height && after.bottom > top + height - margin) {
      const scroller = scrollParent(root);
      scroller?.scrollBy({ top: after.bottom - (top + height - margin) });
    }
  }
}

/** @param {HTMLElement} el */
function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight)
      return p;
  }
  return el.ownerDocument.scrollingElement;
}

/**
 * The on-screen box of a text position (a zero-width caret box), for
 * anchoring menus. Falls back to the text element's first line when the
 * browser gives an empty box (an empty block, a position at a line break).
 * @param {HTMLElement} textEl @param {number} offset
 * @returns {DOMRect}
 */
export function rectAt(textEl, offset) {
  const line = parseFloat(getComputedStyle(textEl).lineHeight) || 24;
  // A closed equation's source is hidden: its row stands in.
  if (textEl.getClientRects().length === 0) {
    const row = textEl.closest("[data-row]")?.getBoundingClientRect();
    return row
      ? new DOMRect(row.left, row.top, 0, Math.min(line, row.height || line))
      : new DOMRect(0, 0, 0, 0);
  }
  const { node, offset: at } = posToDom(textEl, offset);
  // Beside a formula, the caret is at its edge.
  if (node === textEl) {
    const before = isSeparator(textEl.childNodes[at - 1])
      ? textEl.childNodes[at - 2]
      : textEl.childNodes[at - 1];
    const after = textEl.childNodes[at];
    const edge = isMathElement(before) ? [...before.getClientRects()].at(-1) : null;
    if (edge) return new DOMRect(edge.right, edge.top, 0, edge.height);
    const start = isMathElement(after) ? after.getClientRects()[0] : null;
    if (start) return new DOMRect(start.left, start.top, 0, start.height);
  }
  const range = document.createRange();
  range.setStart(node, at);
  range.collapse(true);
  const rect = [...range.getClientRects()].at(-1) ?? range.getBoundingClientRect();
  if (rect.height > 0) return rect;
  const box = textEl.getBoundingClientRect();
  return new DOMRect(box.left, box.top, 0, Math.min(line, box.height || line));
}

/**
 * The box around the DOM selection, or null when there's none.
 * @param {Document} doc
 * @returns {DOMRect | null}
 */
export function selectionRect(doc) {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The on-screen boxes of the text between two offsets of a text element,
 * one per line fragment (for drawing someone else's selection). Taken
 * from the text nodes only, so a run's own box doesn't overlap its text;
 * a formula in the range adds its own box.
 * @param {HTMLElement} textEl @param {number} start @param {number} end
 * @returns {DOMRect[]}
 */
export function textRects(textEl, start, end) {
  /** @type {DOMRect[]} */
  const out = [];
  if (end <= start) return out;
  const range = document.createRange();
  let pos = 0;
  for (const child of textEl.childNodes) {
    if (pos >= end) break;
    if (isMathElement(child)) {
      const length = mathSource(child).length;
      if (pos < end && pos + length > start)
        for (const r of child.getClientRects()) if (r.width > 0 && r.height > 0) out.push(r);
      pos += length;
      continue;
    }
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    for (
      let n = /** @type {Text | null} */ (
        child.nodeType === Node.TEXT_NODE ? child : walker.nextNode()
      );
      n !== null && pos < end;
      n = /** @type {Text | null} */ (n === child ? null : walker.nextNode())
    ) {
      const from = Math.max(start, pos);
      const to = Math.min(end, pos + n.data.length);
      if (to > from) {
        range.setStart(n, from - pos);
        range.setEnd(n, to - pos);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push(r);
      }
      pos += n.data.length;
    }
  }
  return out;
}
