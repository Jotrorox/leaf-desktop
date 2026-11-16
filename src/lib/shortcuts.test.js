// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ariaKeyShortcuts,
  createShortcutRegistry,
  formatShortcut,
  isTextInput,
  matchesShortcut,
  parseShortcut,
} from "./shortcuts.js";

/**
 * A plain object standing in for a KeyboardEvent.
 * @param {string} key
 * @param {Partial<{ code: string, meta: boolean, ctrl: boolean, alt: boolean, shift: boolean, repeat: boolean, isComposing: boolean, target: object | null }>} [init]
 */
function keydown(key, init = {}) {
  const event = {
    key,
    code: init.code ?? "",
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    repeat: init.repeat ?? false,
    isComposing: init.isComposing ?? false,
    target: init.target ?? null,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return /** @type {KeyboardEvent} */ (/** @type {unknown} */ (event));
}

const textInput = { tagName: "INPUT", type: "text" };

test("parseShortcut reads modifiers, aliases and the key", () => {
  assert.deepEqual(parseShortcut("mod+shift+K"), {
    key: "k",
    mod: true,
    ctrl: false,
    meta: false,
    alt: false,
    shift: true,
  });
  assert.equal(parseShortcut("esc").key, "escape");
  assert.equal(parseShortcut("mod++").key, "+");
  assert.throws(() => parseShortcut("hyper+k"), /Unknown modifier/);
});

test("symbols don't care about Shift; letters require it only when listed", () => {
  assert.equal(parseShortcut("?").shift, null);
  assert.equal(parseShortcut("k").shift, false);
  assert.equal(parseShortcut("shift+k").shift, true);
});

test("mod is ⌘ on macOS and Ctrl elsewhere", () => {
  const combo = parseShortcut("mod+\\");
  assert.equal(matchesShortcut(combo, keydown("\\", { meta: true }), true), true);
  assert.equal(matchesShortcut(combo, keydown("\\", { ctrl: true }), true), false);
  assert.equal(matchesShortcut(combo, keydown("\\", { ctrl: true }), false), true);
  assert.equal(matchesShortcut(combo, keydown("\\", { meta: true }), false), false);
});

test("extra modifiers prevent a match", () => {
  const combo = parseShortcut("mod+k");
  assert.equal(matchesShortcut(combo, keydown("K", { meta: true, shift: true }), true), false);
  assert.equal(
    matchesShortcut(combo, keydown("k", { meta: true, alt: true, code: "KeyK" }), true),
    false,
  );
  assert.equal(matchesShortcut(combo, keydown("k", { meta: true }), true), true);
});

test("symbols typed with Shift still match", () => {
  assert.equal(matchesShortcut(parseShortcut("?"), keydown("?", { shift: true }), true), true);
});

test("with Option held, letters fall back to the physical key", () => {
  assert.equal(
    matchesShortcut(parseShortcut("alt+k"), keydown("˚", { alt: true, code: "KeyK" }), true),
    true,
  );
  assert.equal(
    matchesShortcut(parseShortcut("alt+k"), keydown("˚", { alt: true, code: "KeyL" }), true),
    false,
  );
});

test("formatShortcut uses the platform's labels", () => {
  assert.equal(formatShortcut("mod+\\", true), "⌘\\");
  assert.equal(formatShortcut("mod+\\", false), "Ctrl+\\");
  assert.equal(formatShortcut("mod+shift+k", true), "⇧⌘K");
  assert.equal(formatShortcut("mod+shift+k", false), "Ctrl+Shift+K");
  assert.equal(formatShortcut("alt+arrowup", true), "⌥↑");
  assert.equal(formatShortcut("?", true), "?");
  assert.equal(formatShortcut("enter", true), "↩");
  assert.equal(formatShortcut("enter", false), "Enter");
});

test("ariaKeyShortcuts uses key names", () => {
  assert.equal(ariaKeyShortcuts("mod+\\", true), "Meta+\\");
  assert.equal(ariaKeyShortcuts("mod+shift+k", false), "Control+Shift+K");
  assert.equal(ariaKeyShortcuts("escape", false), "Escape");
});

test("isTextInput", () => {
  assert.equal(isTextInput(/** @type {any} */ (textInput)), true);
  assert.equal(isTextInput(/** @type {any} */ ({ tagName: "INPUT", type: "search" })), true);
  assert.equal(isTextInput(/** @type {any} */ ({ tagName: "INPUT", type: "checkbox" })), false);
  assert.equal(isTextInput(/** @type {any} */ ({ tagName: "TEXTAREA" })), true);
  assert.equal(isTextInput(/** @type {any} */ ({ tagName: "DIV", isContentEditable: true })), true);
  assert.equal(isTextInput(/** @type {any} */ ({ tagName: "BUTTON" })), false);
  assert.equal(isTextInput(null), false);
});

test("a global binding fires and prevents the default", () => {
  const registry = createShortcutRegistry({ mac: true });
  let calls = 0;
  registry.register({ keys: "mod+\\", handler: () => void calls++ });
  const event = keydown("\\", { meta: true });
  assert.equal(registry.handleKeydown(event), true);
  assert.equal(calls, 1);
  assert.equal(event.defaultPrevented, true);
});

test("text inputs block bindings unless they opt in", () => {
  const registry = createShortcutRegistry({ mac: true });
  /** @type {string[]} */
  const calls = [];
  registry.register({ keys: "?", handler: () => void calls.push("help") });
  registry.register({
    keys: "mod+\\",
    allowInInputs: true,
    handler: () => void calls.push("sidebar"),
  });
  assert.equal(registry.handleKeydown(keydown("?", { shift: true, target: textInput })), false);
  assert.equal(registry.handleKeydown(keydown("\\", { meta: true, target: textInput })), true);
  assert.equal(
    registry.handleKeydown(
      keydown("?", { shift: true, target: { tagName: "INPUT", type: "checkbox" } }),
    ),
    true,
  );
  assert.deepEqual(calls, ["sidebar", "help"]);
});

test("a higher scope claims keys before global", () => {
  const registry = createShortcutRegistry({ mac: true });
  /** @type {string[]} */
  const calls = [];
  registry.register({ keys: "mod+b", handler: () => void calls.push("global") });
  registry.register({ keys: "mod+b", scope: "editor", handler: () => void calls.push("editor") });

  registry.handleKeydown(keydown("b", { meta: true }));
  const release = registry.pushScope("editor");
  registry.handleKeydown(keydown("b", { meta: true }));
  release();
  registry.handleKeydown(keydown("b", { meta: true }));

  assert.deepEqual(calls, ["global", "editor", "global"]);
});

test("returning false falls through to lower bindings", () => {
  const registry = createShortcutRegistry({ mac: true });
  /** @type {string[]} */
  const calls = [];
  registry.register({ keys: "escape", handler: () => void calls.push("global") });
  registry.register({
    keys: "escape",
    scope: "editor",
    handler: () => (calls.push("editor"), false),
  });
  registry.pushScope("editor");
  assert.equal(registry.handleKeydown(keydown("Escape")), true);
  assert.deepEqual(calls, ["editor", "global"]);
});

test("an exclusive scope blocks the scopes below it", () => {
  const registry = createShortcutRegistry({ mac: true });
  let calls = 0;
  registry.register({ keys: "?", handler: () => void calls++ });
  const release = registry.pushScope("dialog", { exclusive: true });
  assert.equal(registry.handleKeydown(keydown("?", { shift: true })), false);
  release();
  assert.equal(registry.handleKeydown(keydown("?", { shift: true })), true);
  assert.equal(calls, 1);
});

test("scopes can be released out of order", () => {
  const registry = createShortcutRegistry({ mac: true });
  let calls = 0;
  registry.register({ keys: "x", handler: () => void calls++ });
  const releaseA = registry.pushScope("a", { exclusive: true });
  const releaseB = registry.pushScope("b");
  releaseA();
  registry.handleKeydown(keydown("x"));
  releaseB();
  assert.equal(calls, 1);
});

test("ignores handled, composing, and repeated keys", () => {
  const registry = createShortcutRegistry({ mac: true });
  let calls = 0;
  registry.register({ keys: "x", handler: () => void calls++ });
  const handled = keydown("x");
  handled.preventDefault();
  registry.handleKeydown(handled);
  registry.handleKeydown(keydown("x", { isComposing: true }));
  registry.handleKeydown(keydown("x", { repeat: true }));
  assert.equal(calls, 0);
});

test("unregister removes a binding; list shows described ones", () => {
  const registry = createShortcutRegistry({ mac: false });
  const off = registry.register({
    keys: ["?", "mod+/"],
    description: "Keyboard shortcuts",
    handler: () => {},
  });
  registry.register({ keys: "x", handler: () => {} });
  assert.deepEqual(registry.list(), [
    { keys: ["?", "mod+/"], description: "Keyboard shortcuts", scope: "global" },
  ]);
  off();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.handleKeydown(keydown("/", { ctrl: true })), false);
});
