// @ts-check

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

/**
 * Elements inside `root` that Tab can reach, in DOM order.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export function getTabbable(root) {
  const candidates = /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(TABBABLE));
  return [...candidates].filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}
