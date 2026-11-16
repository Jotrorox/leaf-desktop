// @ts-check
import { cx } from "../lib/cx.js";
import { IconLeaf } from "./icons/index.jsx";
import styles from "./LogoMark.module.css";

/**
 * The leaf mark: a white leaf on the accent square. Decorative; the link or
 * wordmark around it carries the name. `public/favicon.svg` draws the same.
 * @param {{ size?: number, class?: string, "data-loading"?: boolean }} props
 */
export default function LogoMark(props) {
  const size = () => props.size ?? 22;
  return (
    <span
      class={cx(styles.mark, props.class)}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      data-loading={props["data-loading"]}
      aria-hidden="true"
    >
      <IconLeaf size={Math.round(size() * 0.68)} />
    </span>
  );
}
