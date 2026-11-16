// @ts-check
import { Show } from "solid-js";
import { fileIdOf, fileUrl } from "../api/files.js";
import { cx } from "../lib/cx.js";
import { IconPage, IconTable } from "./icons/index.jsx";
import styles from "./PageIcon.module.css";

/**
 * A page's icon: its emoji or uploaded image, or the generic page glyph (a
 * table for a database). Decorative; the page title next to it carries the
 * meaning.
 * @param {{ icon: string | null | undefined, kind?: string, size?: number, class?: string }} props
 */
export default function PageIcon(props) {
  const size = () => props.size ?? 18;
  return (
    <span
      class={cx(styles.icon, props.class)}
      style={{ "--icon-size": `${size()}px` }}
      aria-hidden="true"
    >
      <Show
        when={props.icon}
        fallback={
          props.kind === "database" ? <IconTable size={size()} /> : <IconPage size={size()} />
        }
      >
        {(icon) => <IconGlyph icon={icon()} />}
      </Show>
    </span>
  );
}

/**
 * Just the icon itself, sized by the surrounding `--icon-size` (or 1em):
 * an emoji, or an uploaded image (`file:<id>`).
 * @param {{ icon: string, class?: string }} props
 */
export function IconGlyph(props) {
  const file = () => fileIdOf(props.icon);
  return (
    <Show when={file()} fallback={<span class={cx(styles.emoji, props.class)}>{props.icon}</span>}>
      {(id) => (
        <img class={cx(styles.image, props.class)} src={fileUrl(id())} alt="" draggable={false} />
      )}
    </Show>
  );
}

/** An icon as text (an emoji, or nothing for an image), for plain-text places. @param {string | null | undefined} icon */
export function iconText(icon) {
  return icon && !fileIdOf(icon) ? icon : "";
}
