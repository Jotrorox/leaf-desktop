// @ts-check
import { createSignal } from "solid-js";
import { readStorage, writeStorage } from "../lib/storage.js";

/**
 * Color theme: follow the system, or force light or dark. Forcing sets
 * `data-theme` on <html>, which `tokens.css` keys off. Saved in localStorage.
 */

/** @typedef {"system" | "light" | "dark"} ThemePreference */

const STORAGE_KEY = "leaf.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const saved = readStorage(STORAGE_KEY);
const [themePreference, setPreference] = createSignal(
  /** @type {ThemePreference} */ (saved === "light" || saved === "dark" ? saved : "system"),
);

const darkMedia = window.matchMedia(DARK_QUERY);
const [systemDark, setSystemDark] = createSignal(darkMedia.matches);
darkMedia.addEventListener("change", (event) => setSystemDark(event.matches));

/** The chosen preference. Reactive. */
export { themePreference };

/** The theme actually showing. Reactive. */
export function resolvedTheme() {
  const preference = themePreference();
  return preference === "system" ? (systemDark() ? "dark" : "light") : preference;
}

/** @param {ThemePreference} preference */
export function setThemePreference(preference) {
  setPreference(preference);
  writeStorage(STORAGE_KEY, preference);
  apply();
}

function apply() {
  const preference = themePreference();
  if (preference === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
}

apply();
