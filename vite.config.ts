import process from "node:process";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
// @ts-expect-error: a plain JS module (the KaTeX font filter shared with the web app).
import { katexWoff2Only } from "./src/editor/math/woff2-only.js";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [solid(), katexWoff2Only()],

  // Vite options tailored for Tauri development, applied in `tauri dev` / `tauri build`:
  // 1. don't hide Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if it is taken
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // 3. don't watch the Rust side
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Env vars starting with TAURI_ENV_* are exposed to the front end.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses WebView2 (Chromium) on Windows and WebKit on macOS and Linux.
    // The UI relies on CSS light-dark() and top-level await.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome123" : "safari17",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    // Everything loads from disk; one big chunk beats many small requests,
    // except Clerk (and React, which only its UI uses), loaded after the first frame.
    chunkSizeWarningLimit: 4096,
    modulePreload: { polyfill: false },
    rollupOptions: {
      onwarn(warning, warn) {
        // Clerk's UI marks itself "use client" (a React Server Components hint); irrelevant here.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
