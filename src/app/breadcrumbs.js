// @ts-check
import { createRenderEffect, createSignal, onCleanup } from "solid-js";

/**
 * @typedef {object} Crumb
 * @property {string} label
 * @property {string} [href] Omitted for the current page.
 * @property {string | null} [icon] Set for pages: their emoji, or null for the default page icon.
 */

const [crumbs, setCrumbs] = createSignal(/** @type {Crumb[]} */ ([]));

/** The top bar's breadcrumbs; the last one is the current page. Reactive. */
export { crumbs };

/**
 * Sets the breadcrumbs (and with them the document title) while the calling
 * component is mounted. Route components call this; the page route passes
 * the page's ancestors from the tree.
 * @param {() => Crumb[]} items
 */
export function useBreadcrumbs(items) {
  createRenderEffect(() => setCrumbs(items()));
  onCleanup(() => setCrumbs([]));
}
