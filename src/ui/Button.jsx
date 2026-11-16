// @ts-check
import { splitProps } from "solid-js";
import { cx } from "../lib/cx.js";
import styles from "./Button.module.css";

/**
 * @typedef {import("solid-js").JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
 *   variant?: "default" | "primary" | "ghost" | "danger",
 * }} ButtonProps
 */

/** A text button. Defaults to `type="button"`. @param {ButtonProps} props */
export default function Button(props) {
  const [local, rest] = splitProps(props, ["variant", "class"]);
  return (
    <button
      type="button"
      {...rest}
      class={cx(
        styles.button,
        local.variant === "primary" && styles.primary,
        local.variant === "ghost" && styles.ghost,
        local.variant === "danger" && styles.danger,
        local.class,
      )}
    />
  );
}
