# leaf desktop

Desktop app for leaf, built with [Tauri 2](https://v2.tauri.app) and [SolidJS](https://www.solidjs.com).

The UI is the leaf web app's (`leaf-frontend`): the same sidebar, editor, databases,
sharing and settings, talking to the same API and Clerk instance. On top of it the
desktop app adds:

- **Instant start, offline-ready.** The signed-in user, `/v1/me` and the whole query
  cache (sidebar, pages, databases) are saved locally and shown the moment the window
  opens, then refreshed in the background. A background sync keeps a local copy of
  every page's document (`src/desktop/prefetch.js`), so notes open instantly and work
  offline; edits are stored locally and sent when the connection is back.
- **Native networking.** API and Clerk requests and live-sync sockets go through Rust
  (`src-tauri/src/net.rs`): one pooled HTTP/2 client, no browser CORS or origin rules.
- **Clerk as a native client** (`src/auth/clerk.js`): Clerk's JS and UI are bundled
  (no remote scripts), sessions use Clerk's Native API (client token in a private
  file, `src-tauri/src/secrets.rs`), and Sign in with Apple runs in the system browser
  and returns through `leaf://sso-callback`.
- **Desktop behavior.** macOS title bar overlay with the traffic lights in the sidebar,
  native menus (⌘N new page, ⌘, settings, ⌘[ / ⌘] back and forward), the last page
  reopened on launch, window size and position remembered, external links opened in
  the default browser.

## Setup

Tools are managed by [mise](https://mise.jdx.dev) (`mise.toml`: node, pnpm, actionlint);
Rust comes from rustup via `rust-toolchain.toml`.

```sh
mise install
mise run dev       # run the app (against leaf's production services)
mise run dev-mock  # the UI in a browser, against an in-memory mock backend
mise run check     # fmt-check, lint, test (what CI runs)
mise run build     # production bundle for the current OS
mise run icons     # regenerate src-tauri/icons from app-icon.svg
```

### Configuration

`.env` holds the public build settings (API URL, Clerk publishable key, web app
origin) and points at production. For a local backend, override them in `.env.local`:

```sh
VITE_API_URL=http://localhost:8080
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
VITE_WEB_ORIGIN=http://localhost:5173   # must equal the backend's ALLOWED_ORIGIN
```

### Clerk dashboard

For each Clerk instance the app uses (Native applications page):

- **Native API** must be enabled (it is, for both leaf instances).
- **Sign in with Apple:** add `leaf://sso-callback` to the allowlist for mobile/native
  SSO redirects. Until then the Apple button shows Clerk's "redirect url does not match"
  error; email sign-in works regardless. Deep links only reach installed builds on
  macOS (`mise run build`), not `tauri dev`.

## Releasing

```sh
mise run release 0.2.0          # bump versions, commit, tag v0.2.0
git push origin main --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds macOS (universal),
Windows and Linux bundles and attaches them to a draft GitHub release.
