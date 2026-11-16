// @ts-check
import { createSignal, For } from "solid-js";
import { shortcuts } from "../lib/shortcuts.js";
import Dialog from "../ui/Dialog.jsx";
import Kbd from "../ui/Kbd.jsx";
import styles from "./ShortcutsDialog.module.css";

const [open, setOpen] = createSignal(false);

export function openShortcutsDialog() {
  setOpen(true);
}

/** Keys that work inside menus and popovers; handled by the components, not the registry. */
const LIST_KEYS = [
  { keys: ["arrowdown", "arrowup"], description: "Move through menu items" },
  { keys: ["home", "end"], description: "First or last menu item" },
  { keys: ["enter"], description: "Pick the focused item" },
  { keys: ["escape"], description: "Close menu, popover or dialog" },
];

/** Keys in the page editor; handled by the editor (`src/editor/editor.js`). */
const EDITOR_KEYS = [
  { keys: ["/"], description: "Insert a block (at the start of a line or after a space)" },
  { keys: ["@"], description: "Mention a page" },
  { keys: ["mod+/"], description: "Block actions: delete, duplicate, turn into, color" },
  { keys: ["mod+d"], description: "Duplicate block" },
  { keys: ["mod+shift+arrowup", "mod+shift+arrowdown"], description: "Move block up or down" },
  { keys: ["tab", "shift+tab"], description: "Indent or outdent" },
  {
    keys: ["mod+b", "mod+i", "mod+u", "mod+shift+s", "mod+e"],
    description: "Bold, italic, underline, strikethrough, code",
  },
  { keys: ["mod+k"], description: "Link the selected text (to a web address or a page)" },
  { keys: ["mod+shift+e"], description: "Inline equation (over selected text: turn it into one)" },
  { keys: ["mod+shift+h"], description: "Apply the last text color" },
  { keys: ["mod+alt+0", "mod+alt+1"], description: "Turn into text, heading 1… (0–9)" },
  { keys: ["mod+alt+e"], description: "Turn into an equation" },
  {
    keys: ["mod+enter"],
    description: "Check a to-do, open a toggle, leave a code block or equation",
  },
  { keys: ["escape"], description: "Close an equation's source" },
];

/** Keys on a focused page in the sidebar tree; handled by `PageTree`. */
const TREE_KEYS = [
  { keys: ["arrowdown", "arrowup"], description: "Move between pages" },
  { keys: ["arrowright", "arrowleft"], description: "Expand or collapse" },
  { keys: ["enter"], description: "Open the page" },
  { keys: ["f2"], description: "Rename" },
  { keys: ["shift+f10"], description: "More actions" },
  { keys: ["mod+backspace", "delete"], description: "Move to trash" },
  { keys: ["mod+shift+arrowup", "mod+shift+arrowdown"], description: "Move up or down" },
  {
    keys: ["mod+shift+arrowright", "mod+shift+arrowleft"],
    description: "Move into the page above, or out",
  },
];

/** Lists the registered global shortcuts, with labels for the current platform. */
export default function ShortcutsDialog() {
  return (
    <Dialog open={open()} onOpenChange={setOpen} title="Keyboard shortcuts">
      <h3 class={styles.heading}>General</h3>
      <ShortcutList items={globalShortcuts()} />
      <h3 class={styles.heading}>Editor</h3>
      <ShortcutList items={EDITOR_KEYS} />
      <h3 class={styles.heading}>Page tree</h3>
      <ShortcutList items={TREE_KEYS} />
      <h3 class={styles.heading}>Menus</h3>
      <ShortcutList items={LIST_KEYS} />
    </Dialog>
  );
}

/** Global bindings, with bindings that share a description merged into one row. */
function globalShortcuts() {
  /** @type {Map<string, string[]>} */
  const rows = new Map();
  for (const item of shortcuts.list()) {
    if (item.scope !== "global") continue;
    rows.set(item.description, [...(rows.get(item.description) ?? []), ...item.keys]);
  }
  return [...rows].map(([description, keys]) => ({ description, keys }));
}

/** @param {{ items: { keys: string[], description: string }[] }} props */
function ShortcutList(props) {
  return (
    <dl class={styles.list}>
      <For each={props.items}>
        {(item) => (
          <div class={styles.row}>
            <dt>{item.description}</dt>
            <dd class={styles.keys}>
              <For each={item.keys}>{(keys) => <Kbd keys={keys} boxed />}</For>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}
