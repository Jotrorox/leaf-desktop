# leaf desktop

The desktop app for [leaf](https://leaf.jotrorox.com), built with [Tauri 2](https://v2.tauri.app)
and [SolidJS](https://www.solidjs.com). Same UI, API and accounts as the web app, plus:

- **Instant start, works offline:** the session and query cache are stored locally and
  every page is synced in the background; offline edits are sent when you reconnect.
- **Native networking:** API, Clerk and live-sync traffic goes through Rust (`src-tauri/src/net.rs`).
- **Native sign-in:** Clerk's Native API, with Sign in with Apple in the system browser.
- **Desktop behavior:** native menus and shortcuts, and it remembers your window and last page.

## Download

Get the latest build for macOS (universal), Windows or Linux from
[Releases](https://github.com/Jotrorox/leaf-desktop/releases/latest).

> The macOS build is not notarized yet. If macOS says the app is damaged, run
> `xattr -cr /Applications/leaf.app` once.

## Development

Tools come from [mise](https://mise.jdx.dev) (`mise.toml`), Rust from `rust-toolchain.toml`.

```sh
mise install
mise run dev       # run the app against production services
mise run dev-mock  # UI in a browser with an in-memory mock backend
mise run check     # fmt-check, lint, test (what CI runs)
mise run build     # bundle for the current OS
```

To use a local backend, override `.env` in `.env.local` (`VITE_API_URL`,
`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WEB_ORIGIN`).

Sign in with Apple needs `leaf://sso-callback` and `http://127.0.0.1:52184/sso-callback`
(debug builds) on the Clerk instance's native SSO redirect allowlist.

## Releasing

```sh
mise run release 0.2.0             # bump versions, commit, tag v0.2.0
git push origin main --follow-tags
```

The tag triggers `.github/workflows/release.yml`. It builds every platform and publishes the
GitHub release once all bundles are uploaded. macOS signing and notarization turn on when
the `APPLE_*` secrets are set in the `release` environment.
