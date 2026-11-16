// @ts-check
import { splitProps } from "solid-js";
import { cx } from "../lib/cx.js";
import { shortcuts } from "../lib/shortcuts.js";
import styles from "./Button.module.css";
import Tooltip from "./Tooltip.jsx";

/**
 * @typedef {Omit<import("solid-js").JSX.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
 *   label: string,
 *   shortcut?: string,
 *   size?: "small" | "medium",
 *   tooltip?: boolean,
 *   tooltipPlacement?: import("../lib/position.js").Placement,
 * }} IconButtonProps
 */

/**
 * A square, icon-only button. `label` is required: it's the accessible name
 * and the tooltip text. `shortcut` is shown in the tooltip and exposed as
 * `aria-keyshortcuts`; it doesn't register anything.
 *
 * @param {IconButtonProps} props
 */
export default function IconButton(props) {
  const [local, rest] = splitProps(props, [
    "label",
    "shortcut",
    "size",
    "tooltip",
    "tooltipPlacement",
    "class",
  ]);
  const button = (
    <button
      type="button"
      {...rest}
      class={cx(styles.button, styles.icon, local.size === "small" && styles.small, local.class)}
      aria-label={local.label}
      aria-keyshortcuts={local.shortcut ? shortcuts.aria(local.shortcut) : undefined}
    />
  );
  if (local.tooltip === false) return button;
  return (
    <Tooltip
      content={local.label}
      shortcut={local.shortcut}
      placement={local.tooltipPlacement}
      describe={false}
    >
      {button}
    </Tooltip>
  );
}
