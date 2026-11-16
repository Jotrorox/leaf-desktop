// KaTeX and its stylesheet, as one lazily loaded chunk: `render.js`
// imports this file only when a page first shows math. Vite loads a
// chunk's CSS before resolving the import, so formulas never draw
// unstyled. The fonts in the stylesheet are bundled and served with the
// app, like Geist.
import katex from "katex";
import "katex/dist/katex-swap.min.css";
import "./katex-fixes.css";

export default katex;
