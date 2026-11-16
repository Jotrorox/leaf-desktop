//! Tauri shell for the leaf desktop app.
//!
//! The front end is the leaf web app's UI (SolidJS), served from the app
//! bundle. This side adds what a webview can't do well on its own:
//!
//! - `net`: HTTP and WebSockets from Rust, so the API and Clerk see a native
//!   client rather than an unknown browser origin.
//! - `secrets`: a private file for the Clerk client token.
//! - Deep links (`leaf://`), for finishing "Sign in with Apple" in the browser
//!   (`oauth`: a loopback listener stands in for them in development builds).
//! - A navigation guard: the window only ever shows the app; links to other
//!   sites open in the default browser.
//! - Native menus, and the window's size and position remembered.

mod net;
mod oauth;
mod secrets;

use std::time::Duration;

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const MAIN: &str = "main";
/// Where the web app lives, for "leaf on the web".
const WEB_URL: &str = "https://leaf.jotrorox.com";

/// Origins the main window may show: the bundled app (macOS/Linux use
/// `tauri://localhost`, Windows `http(s)://tauri.localhost`) and Vite's dev server.
fn is_app_url(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") => cfg!(debug_assertions) && url.port() == Some(1420),
            _ => false,
        },
        "about" | "data" | "blob" => true,
        _ => false,
    }
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &url::Url) {
    if matches!(url.scheme(), "https" | "http" | "mailto" | "tel")
        && let Err(err) = app.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("couldn't open {url}: {err}");
    }
}

/// `trafficLightPosition` in tauri.conf.json centers the traffic lights on the
/// 45px sidebar header up to macOS 15. tao makes the title bar `button height + y`
/// tall and leaves the buttons where AppKit puts them in it: near its bottom
/// before macOS 26, vertically centered since, which lifts them by this much.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS_Y_OFFSET_MACOS_26: f64 = 7.0;

/// The running macOS's major version, from the system's own version file.
#[cfg(target_os = "macos")]
fn macos_major_version() -> Option<u32> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    parse_product_version_major(&plist)
}

/// The major version in a `SystemVersion.plist`'s `ProductVersion`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_product_version_major(plist: &str) -> Option<u32> {
    let after_key = &plist[plist.find("<key>ProductVersion</key>")?..];
    let value = &after_key[after_key.find("<string>")? + "<string>".len()..];
    value.split(['.', '<']).next()?.trim().parse().ok()
}

fn create_main_window(app: &App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    let config = {
        let mut config = config;
        if macos_major_version().is_some_and(|major| major >= 26)
            && let Some(position) = config.traffic_light_position.as_mut()
        {
            position.y += TRAFFIC_LIGHTS_Y_OFFSET_MACOS_26;
        }
        config
    };

    let navigate_handle = handle.clone();
    let new_window_handle = handle.clone();
    let builder = WebviewWindowBuilder::from_config(&handle, &config)?
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            open_external(&navigate_handle, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&new_window_handle, &url);
            NewWindowResponse::Deny
        });
    let window = builder.build()?;

    // The front end shows the window once it has painted (no blank flash).
    // If it never says so (a crash on startup), show it anyway.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    });
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_page = MenuItemBuilder::with_id("new-page", "New Page")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let quick_find = MenuItemBuilder::with_id("quick-find", "Quick Find…").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar").build(app)?;
    let back = MenuItemBuilder::with_id("back", "Back")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let forward = MenuItemBuilder::with_id("forward", "Forward")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let shortcuts = MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts").build(app)?;
    let web = MenuItemBuilder::with_id("open-web", "leaf on the Web").build(app)?;
    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;

    let about = AboutMetadataBuilder::new()
        .name(Some("leaf"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();

    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "leaf")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About leaf"),
                Some(about.clone()),
            )?)
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        menu.append(&app_menu)?;
    }

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&new_page)
        .item(&quick_find)
        .separator();
    #[cfg(not(target_os = "macos"))]
    {
        file = file.item(&settings).separator();
    }
    file = file.item(&PredefinedMenuItem::close_window(app, None)?);
    #[cfg(not(target_os = "macos"))]
    {
        file = file.item(&PredefinedMenuItem::quit(app, None)?);
    }
    menu.append(&file.build()?)?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    menu.append(&edit)?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .item(&back)
        .item(&forward)
        .separator()
        .item(&reload)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    menu.append(&view)?;

    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;
    menu.append(&window)?;

    #[allow(unused_mut)] // extended on Windows and Linux
    let mut help = SubmenuBuilder::new(app, "Help").item(&shortcuts).item(&web);
    #[cfg(not(target_os = "macos"))]
    {
        help = help.separator().item(&PredefinedMenuItem::about(
            app,
            Some("About leaf"),
            Some(about),
        )?);
    }
    #[cfg(target_os = "macos")]
    let _ = about;
    menu.append(&help.build()?)?;

    Ok(menu)
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest and tungstenite share rustls; pick its crypto once, up front.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    #[allow(unused_mut)] // extended on Windows and Linux
    let mut builder = tauri::Builder::default();

    // A second launch (or a `leaf://` link on Windows/Linux) focuses the
    // running app, which receives the link through the deep-link plugin.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app)
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // The front end shows the window itself, once it has painted.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .manage(net::Net::new())
        .invoke_handler(tauri::generate_handler![
            net::http_fetch,
            net::ws_connect,
            net::ws_send,
            net::ws_close,
            oauth::oauth_redirect_url,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
        ])
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "open-web" => {
                    if let Ok(url) = url::Url::parse(WEB_URL) {
                        open_external(app, &url);
                    }
                }
                "reload" => {
                    if let Some(window) = app.get_webview_window(MAIN) {
                        let _ = window.eval("window.location.reload()");
                    }
                }
                _ => {
                    focus_main(app);
                    let _ = app.emit_to(MAIN, "menu", id);
                }
            }
        })
        .setup(|app| {
            app.manage(secrets::Secrets::new(app.handle()));
            create_main_window(app)?;
            // Installed builds register `leaf://` with the OS; development
            // builds on Windows and Linux have to do it at runtime.
            #[cfg(all(debug_assertions, any(target_os = "windows", target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            Ok(())
        })
        // macOS: closing the window hides it, like other Mac apps; the app
        // keeps running (and its caches warm) until ⌘Q.
        .on_window_event(|window, event| {
            if cfg!(target_os = "macos")
                && window.label() == MAIN
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                focus_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_urls() {
        let app = [
            "tauri://localhost/p/123",
            "http://tauri.localhost/",
            "https://tauri.localhost/settings",
        ];
        for raw in app {
            assert!(is_app_url(&url::Url::parse(raw).unwrap()), "{raw}");
        }
        let other = [
            "https://leaf.jotrorox.com/",
            "https://appleid.apple.com/auth",
            "tauri://evil/",
        ];
        for raw in other {
            assert!(!is_app_url(&url::Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn product_version_major() {
        let plist = |version: &str| {
            format!(
                "<dict>\n\t<key>BuildID</key>\n\t<string>X</string>\n\t<key>ProductVersion</key>\n\t<string>{version}</string>\n</dict>"
            )
        };
        assert_eq!(parse_product_version_major(&plist("27.3")), Some(27));
        assert_eq!(parse_product_version_major(&plist("15.7.1")), Some(15));
        assert_eq!(parse_product_version_major(&plist("26")), Some(26));
        assert_eq!(parse_product_version_major("<dict></dict>"), None);
    }
}
