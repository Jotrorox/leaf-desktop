// @ts-check

/**
 * Colors for text (the `color` mark) and blocks (the `color` attr). A value
 * is a color name for text color, or `<name>_background` for a background,
 * as in Notion. The view maps them to the `--tag-*` tokens.
 *
 * Pure: shared by the toolbar, the block menu and the view.
 */

/** @type {{ name: string, label: string }[]} */
export const COLORS = [
  { name: "gray", label: "Gray" },
  { name: "brown", label: "Brown" },
  { name: "orange", label: "Orange" },
  { name: "yellow", label: "Yellow" },
  { name: "green", label: "Green" },
  { name: "blue", label: "Blue" },
  { name: "purple", label: "Purple" },
  { name: "pink", label: "Pink" },
  { name: "red", label: "Red" },
];

const NAMES = new Set(COLORS.map((c) => c.name));

/**
 * A stored color value the view can draw, or null for anything else
 * (unknown names from a newer client are drawn as default).
 * @param {unknown} value
 * @returns {{ name: string, background: boolean } | null}
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const background = value.endsWith("_background");
  const name = background ? value.slice(0, -"_background".length) : value;
  return NAMES.has(name) ? { name, background } : null;
}
