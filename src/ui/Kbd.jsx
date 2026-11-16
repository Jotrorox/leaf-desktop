// @ts-check
import { splitProps } from "solid-js";
import { cx } from "../lib/cx.js";
import { shortcuts } from "../lib/shortcuts.js";
import styles from "./Kbd.module.css";

/**
 * A shortcut label for the current platform: "⌘\" on macOS, "Ctrl+\" elsewhere.
 * @param {Omit<import("solid-js").JSX.HTMLAttributes<HTMLElement>, "children"> & { keys: string, boxed?: boolean }} props
 */
export default function Kbd(props) {
  const [local, rest] = splitProps(props, ["keys", "boxed", "class"]);
  return (
    <kbd {...rest} class={cx(styles.kbd, local.boxed && styles.boxed, local.class)}>
      {shortcuts.format(local.keys)}
    </kbd>
  );
}
