// @ts-check

/**
 * KaTeX's stylesheet gives every font as woff2, woff and ttf. Browsers that
 * run leaf all take the woff2 and never fetch the others, but the build
 * would still bundle all three (60 files). This drops the woff and ttf
 * sources from its `@font-face` rules before Vite resolves their `url()`s,
 * so only the woff2 files ship.
 *
 * Pure (`woff2Only`), plus the Vite plugin that applies it (`vite.config.js`).
 */

const KATEX_CSS = /[\\/]katex[\\/]dist[\\/]katex(?:-swap)?(?:\.min)?\.css$/;

/**
 * The stylesheet with only the woff2 source in each `src`.
 * @param {string} css
 */
export function woff2Only(css) {
  return css.replace(
    /,\s*url\([^)]*\.woff\)\s*format\(["']woff["']\)|,\s*url\([^)]*\.ttf\)\s*format\(["']truetype["']\)/g,
    "",
  );
}

/** @returns {import("vite").Plugin} */
export function katexWoff2Only() {
  return {
    name: "leaf:katex-woff2-only",
    // Before Vite's CSS plugin turns the url()s into bundled assets.
    enforce: "pre",
    transform(code, id) {
      if (!KATEX_CSS.test(id.split("?")[0])) return null;
      return { code: woff2Only(code), map: null };
    },
  };
}
