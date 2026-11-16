// @ts-check

/**
 * Page cover presets: the pastel tag colors and a few gradients, each with
 * a dark-mode variant. A page stores the preset's id (`color:blue`,
 * `gradient:dusk`), or `file:<id>` for an uploaded image.
 */
import { fileIdOf, fileUrl } from "../../api/files.js";

/** @typedef {{ id: string, label: string, background: string }} Cover */

/** @param {string} from @param {string} to @param {string} darkFrom @param {string} darkTo */
const gradient = (from, to, darkFrom, darkTo) =>
  `linear-gradient(120deg, light-dark(${from}, ${darkFrom}), light-dark(${to}, ${darkTo}))`;

/** @type {Cover[]} */
export const COVERS = [
  ...["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"].map(
    (name) => ({
      id: `color:${name}`,
      label: name[0].toUpperCase() + name.slice(1),
      background: `var(--tag-${name}-bg)`,
    }),
  ),
  {
    id: "gradient:sunrise",
    label: "Sunrise gradient",
    background: gradient("#fde2c8", "#f8c4d4", "#5a3b26", "#4f2a3c"),
  },
  {
    id: "gradient:ocean",
    label: "Ocean gradient",
    background: gradient("#c9e4f6", "#d9d4f7", "#1f3a52", "#33295a"),
  },
  {
    id: "gradient:forest",
    label: "Forest gradient",
    background: gradient("#d3ecd6", "#eef2c4", "#1f4030", "#3b4222"),
  },
  {
    id: "gradient:dusk",
    label: "Dusk gradient",
    background: gradient("#dcd3f5", "#f6cfe0", "#342a55", "#53293f"),
  },
  {
    id: "gradient:sand",
    label: "Sand gradient",
    background: gradient("#f6ecd2", "#f1d6c2", "#4a3f26", "#4d3426"),
  },
  {
    id: "gradient:slate",
    label: "Slate gradient",
    background: gradient("#e2e7ee", "#c8d2df", "#2a3038", "#3a4552"),
  },
];

/**
 * The CSS background for a stored cover value, or null for none. Values
 * this client doesn't know (from a newer one) get a neutral gray rather
 * than vanishing.
 * @param {string | null | undefined} cover
 */
export function coverBackground(cover) {
  if (!cover) return null;
  const file = fileIdOf(cover);
  if (file)
    return `center / cover no-repeat url(${JSON.stringify(fileUrl(file))}), var(--tag-gray-bg)`;
  return COVERS.find((item) => item.id === cover)?.background ?? "var(--tag-gray-bg)";
}
