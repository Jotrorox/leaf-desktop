// @ts-check

/**
 * Reopens the last page on launch (the window always starts at `/`).
 *
 * Imported first by `index.jsx`: it has to rewrite the URL before the router
 * module reads it. So it depends on nothing; `shell.js` saves the route.
 */

export const LAST_ROUTE_KEY = "leaf.last-route";

if (typeof window !== "undefined" && window.location.pathname === "/" && !window.location.search) {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY) ?? "null");
    if (
      typeof saved === "string" &&
      saved.startsWith("/") &&
      !saved.startsWith("//") &&
      !saved.startsWith("/sign-") &&
      !saved.startsWith("/s/")
    ) {
      history.replaceState(history.state, "", saved);
    }
  } catch {
    // Nothing saved, or storage is blocked: start at home.
  }
}
