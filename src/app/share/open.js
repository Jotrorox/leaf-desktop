// @ts-check
import { createSignal } from "solid-js";

/**
 * Whether the share panel of the open page is showing. Its button lives in
 * the top bar; quick find's "Share this page" opens it too.
 */
const [shareOpen, setShareOpen] = createSignal(false);

export { setShareOpen, shareOpen };
