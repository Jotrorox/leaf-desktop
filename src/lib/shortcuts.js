// @ts-check

/**
 * Global keyboard shortcut registry.
 *
 * Every binding belongs to a scope. Active scopes form a stack with "global"
 * at the bottom; UI that wants first claim on keys (a modal dialog now, the
 * editor later) pushes its scope while it's active. A keydown walks the stack
 * from the top, and the first matching binding whose handler doesn't return
 * `false` handles the key. An exclusive scope ends the walk, so global
 * shortcuts are dead while, say, a modal dialog is open.
 *
 * Bindings don't fire while focus is in a text field unless they opt in with
 * `allowInInputs` (the editor's bindings will, since it's contenteditable).
 * The listener sits on `window` in the bubble phase, so a component that
 * handles a key itself calls `preventDefault()` and the registry skips it.
 *
 * Key syntax: "mod+\\", "mod+shift+k", "?", "escape". `mod` is ⌘ on Apple
 * platforms and Ctrl elsewhere. Symbols like "?" ignore Shift (it's needed to
 * type them); letters and named keys require Shift only when it's listed.
 *
 * Pure apart from `installShortcuts()`, so it runs under `node --test`.
 */

/**
 * @typedef {object} Combo
 * @property {string} key Lowercased `KeyboardEvent.key`.
 * @property {boolean} mod
 * @property {boolean} ctrl
 * @property {boolean} meta
 * @property {boolean} alt
 * @property {boolean | null} shift null: either state is fine.
 */

/**
 * @typedef {object} Binding
 * @property {string | string[]} keys One combo, or several that do the same thing.
 * @property {(event: KeyboardEvent) => boolean | void} handler Return false to let the key fall through.
 * @property {string} [scope] Default "global".
 * @property {string} [description] Listed in the shortcuts dialog when set.
 * @property {boolean} [allowInInputs] Also fire while focus is in a text field.
 * @property {boolean} [repeat] Also fire on auto-repeat while the key is held.
 */

/**
 * @typedef {object} ShortcutInfo
 * @property {string[]} keys
 * @property {string} description
 * @property {string} scope
 */

/**
 * The subset of KeyboardEvent the registry reads, so tests can pass plain objects.
 * @typedef {Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented" | "target" | "preventDefault">} KeyEventLike
 */

const KEY_ALIASES = /** @type {Record<string, string>} */ ({
  esc: "escape",
  space: " ",
  plus: "+",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  return: "enter",
});

const SYMBOL_CODES = /** @type {Record<string, string>} */ ({
  "\\": "Backslash",
  "/": "Slash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
});

const KEY_LABELS = /** @type {Record<string, string>} */ ({
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  " ": "Space",
  tab: "Tab",
});

const MAC_KEY_LABELS = /** @type {Record<string, string>} */ ({
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
});

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** @param {string} key */
const isSymbol = (key) => key.length === 1 && !/[\p{L}\p{N} ]/u.test(key);

/**
 * @param {string} keys e.g. "mod+shift+k"
 * @returns {Combo}
 */
export function parseShortcut(keys) {
  const parts = keys.toLowerCase().split("+");
  let key = /** @type {string} */ (parts.pop());
  // "mod++" splits into [..., "", ""]: the key is "+".
  if (key === "" && parts.at(-1) === "") {
    parts.pop();
    key = "+";
  }
  key = KEY_ALIASES[key] ?? key;
  if (!key) throw new Error(`Shortcut has no key: "${keys}"`);

  const combo = {
    key,
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: /** @type {boolean | null} */ (false),
  };
  let shiftListed = false;
  for (const part of parts) {
    if (part === "mod") combo.mod = true;
    else if (part === "ctrl" || part === "control") combo.ctrl = true;
    else if (part === "meta" || part === "cmd" || part === "command") combo.meta = true;
    else if (part === "alt" || part === "option") combo.alt = true;
    else if (part === "shift") shiftListed = true;
    else throw new Error(`Unknown modifier "${part}" in "${keys}"`);
  }
  combo.shift = shiftListed ? true : isSymbol(key) ? null : false;
  return combo;
}

/**
 * @param {Combo} combo
 * @param {Pick<KeyEventLike, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">} event
 * @param {boolean} mac
 */
export function matchesShortcut(combo, event, mac) {
  const meta = combo.meta || (combo.mod && mac);
  const ctrl = combo.ctrl || (combo.mod && !mac);
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== combo.alt) return false;
  if (combo.shift !== null && event.shiftKey !== combo.shift) return false;
  if (event.key.toLowerCase() === combo.key) return true;
  // With Option held, macOS changes the character (⌥K types "˚"): fall back to the physical key.
  return event.altKey && event.code === codeFor(combo.key);
}

/**
 * Human-readable label for the current platform: "⌘\" on macOS, "Ctrl+\" elsewhere.
 * @param {string} keys
 * @param {boolean} mac
 */
export function formatShortcut(keys, mac) {
  const combo = parseShortcut(keys);
  const meta = combo.meta || (combo.mod && mac);
  const ctrl = combo.ctrl || (combo.mod && !mac);
  const key = (mac && MAC_KEY_LABELS[combo.key]) || KEY_LABELS[combo.key] || capitalize(combo.key);
  if (mac) {
    return [ctrl && "⌃", combo.alt && "⌥", combo.shift && "⇧", meta && "⌘", key]
      .filter(Boolean)
      .join("");
  }
  return [ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", meta && "Meta", key]
    .filter(Boolean)
    .join("+");
}

/**
 * Value for the `aria-keyshortcuts` attribute, e.g. "Meta+\".
 * @param {string} keys
 * @param {boolean} mac
 */
export function ariaKeyShortcuts(keys, mac) {
  const combo = parseShortcut(keys);
  const meta = combo.meta || (combo.mod && mac);
  const ctrl = combo.ctrl || (combo.mod && !mac);
  const key =
    combo.key === " "
      ? "Space"
      : combo.key.length === 1
        ? combo.key.toUpperCase()
        : capitalize(combo.key);
  return [ctrl && "Control", combo.alt && "Alt", combo.shift && "Shift", meta && "Meta", key]
    .filter(Boolean)
    .join("+");
}

/**
 * True for elements where typing produces text: text-like inputs, textareas,
 * selects, and contenteditable.
 * @param {EventTarget | null} target
 */
export function isTextInput(target) {
  const el =
    /** @type {{ tagName?: string, type?: string, isContentEditable?: boolean } | null} */ (target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has(String(el.type).toLowerCase());
}

/** True on macOS and iOS/iPadOS, where `mod` means ⌘. */
export function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const nav = /** @type {Navigator & { userAgentData?: { platform?: string } }} */ (navigator);
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || "");
}

/**
 * @param {{ mac?: boolean }} [options]
 */
export function createShortcutRegistry({ mac = isApplePlatform() } = {}) {
  /** @type {(Binding & { scope: string, combos: Combo[] })[]} */
  const bindings = [];
  /** @type {{ name: string, exclusive: boolean }[]} */
  const scopes = [{ name: "global", exclusive: false }];

  /**
   * @param {KeyEventLike} event
   * @returns {boolean} Whether a binding handled the key.
   */
  function handleKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.key === "Process") return false;
    const inInput = isTextInput(event.target);
    for (let s = scopes.length - 1; s >= 0; s--) {
      const scope = scopes[s];
      // Later registrations win within a scope.
      for (let b = bindings.length - 1; b >= 0; b--) {
        const binding = bindings[b];
        if (binding.scope !== scope.name) continue;
        if (inInput && !binding.allowInInputs) continue;
        if (event.repeat && !binding.repeat) continue;
        if (!binding.combos.some((combo) => matchesShortcut(combo, event, mac))) continue;
        if (binding.handler(/** @type {KeyboardEvent} */ (event)) === false) continue;
        event.preventDefault();
        return true;
      }
      if (scope.exclusive) break;
    }
    return false;
  }

  return {
    mac,
    handleKeydown,

    /**
     * Adds a binding. Bindings outside the active scopes stay registered but don't fire.
     * @param {Binding} binding
     * @returns {() => void} Removes the binding.
     */
    register(binding) {
      const keys = Array.isArray(binding.keys) ? binding.keys : [binding.keys];
      const entry = {
        ...binding,
        scope: binding.scope ?? "global",
        combos: keys.map(parseShortcut),
      };
      bindings.push(entry);
      return () => {
        const index = bindings.indexOf(entry);
        if (index >= 0) bindings.splice(index, 1);
      };
    },

    /**
     * Activates a scope on top of the stack.
     * @param {string} name
     * @param {{ exclusive?: boolean }} [options] exclusive: scopes below it don't get the key.
     * @returns {() => void} Deactivates it again (it may be anywhere in the stack by then).
     */
    pushScope(name, { exclusive = false } = {}) {
      const entry = { name, exclusive };
      scopes.push(entry);
      return () => {
        const index = scopes.indexOf(entry);
        if (index > 0) scopes.splice(index, 1);
      };
    },

    /**
     * Bindings that have a description, in registration order.
     * @returns {ShortcutInfo[]}
     */
    list() {
      return bindings
        .filter((binding) => binding.description)
        .map((binding) => ({
          keys: Array.isArray(binding.keys) ? binding.keys : [binding.keys],
          description: /** @type {string} */ (binding.description),
          scope: binding.scope,
        }));
    },

    /** @param {string} keys */
    format: (keys) => formatShortcut(keys, mac),
    /** @param {string} keys */
    aria: (keys) => ariaKeyShortcuts(keys, mac),
  };
}

/** The app-wide registry. */
export const shortcuts = createShortcutRegistry();

/**
 * Starts listening for keydown on `window`.
 * @returns {() => void} Stops listening.
 */
export function installShortcuts() {
  /** @param {KeyboardEvent} event */
  const listener = (event) => void shortcuts.handleKeydown(event);
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

/** @param {string} key */
function codeFor(key) {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return SYMBOL_CODES[key];
}

/** @param {string} key */
function capitalize(key) {
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}
