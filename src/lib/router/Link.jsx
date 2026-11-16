// @ts-check
import { splitProps } from "solid-js";
import { location, navigate } from "./location.js";

/**
 * @typedef {import("solid-js").JSX.AnchorHTMLAttributes<HTMLAnchorElement> & {
 *   href: string,
 *   replace?: boolean,
 * }} LinkProps
 */

/**
 * An `<a>` that navigates client-side. Clicks with a modifier key (⌘, Ctrl,
 * Shift, Alt), any button but the primary one, a `target` other than `_self`,
 * a `download` attribute, or an off-site `href` fall through to the browser,
 * so ⌘-click and middle-click still open a new tab.
 *
 * Sets `aria-current="page"` while `href` is the current path.
 *
 * @param {LinkProps} props
 */
export default function Link(props) {
  const [local, rest] = splitProps(props, ["href", "replace", "onClick"]);

  const isCurrent = () =>
    new URL(local.href, window.location.origin).pathname === location().pathname;

  /** @param {MouseEvent & { currentTarget: HTMLAnchorElement, target: Element }} event */
  function onClick(event) {
    if (typeof local.onClick === "function") local.onClick(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.currentTarget;
    if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash, { replace: local.replace });
  }

  return (
    <a
      aria-current={isCurrent() ? "page" : undefined}
      {...rest}
      href={local.href}
      onClick={onClick}
    />
  );
}
