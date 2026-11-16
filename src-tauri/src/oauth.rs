//! Where the browser sends people back after "Sign in with Apple".
//!
//! Installed builds use `leaf://sso-callback`: the OS hands the link to the
//! app through the deep-link plugin. Development builds can't rely on that,
//! because macOS only routes a URL scheme to an installed `.app` bundle, and
//! `tauri dev` runs a bare binary. So in debug builds the callback goes to a
//! loopback listener instead (`http://127.0.0.1:52184/sso-callback`), which
//! passes the URL on to the front end as an `oauth-callback` event.
//!
//! Both redirect URLs have to be on the Clerk instance's allowlist
//! (dashboard → Native applications).

use tauri::AppHandle;

/// The redirect URL installed builds use.
#[cfg(not(debug_assertions))]
const DEEP_LINK_REDIRECT: &str = "leaf://sso-callback";

/// The loopback port for development builds. Fixed, so the redirect URL can
/// be allowlisted.
#[cfg(debug_assertions)]
const LOOPBACK_PORT: u16 = 52184;
#[cfg(debug_assertions)]
const CALLBACK_PATH: &str = "/sso-callback";

/// The redirect URL to start a browser sign-in with. In development builds
/// this also starts the loopback listener (once).
#[tauri::command]
pub async fn oauth_redirect_url(app: AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        loopback::ensure_started(app).await?;
        Ok(format!("http://127.0.0.1:{LOOPBACK_PORT}{CALLBACK_PATH}"))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Ok(DEEP_LINK_REDIRECT.to_owned())
    }
}

#[cfg(debug_assertions)]
mod loopback {
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;

    use super::{CALLBACK_PATH, LOOPBACK_PORT};
    use crate::{MAIN, focus_main};

    static STARTED: Mutex<bool> = Mutex::const_new(false);

    const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>leaf</title>\
        <body style=\"font:15px -apple-system,system-ui,sans-serif;margin:4em auto;max-width:28em;text-align:center\">\
        <h1 style=\"font-size:1.3em\">Signed in</h1><p>You can close this tab and go back to leaf.</p>";

    pub async fn ensure_started(app: AppHandle) -> Result<(), String> {
        let mut started = STARTED.lock().await;
        if *started {
            return Ok(());
        }
        let listener = TcpListener::bind(("127.0.0.1", LOOPBACK_PORT))
            .await
            .map_err(|err| {
                format!(
                    "Couldn't listen on 127.0.0.1:{LOOPBACK_PORT} for the sign-in callback: {err}"
                )
            })?;
        *started = true;
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ =
                        tokio::time::timeout(Duration::from_secs(10), handle(app, stream)).await;
                });
            }
        });
        Ok(())
    }

    async fn handle(app: AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
        // Only the request line matters: `GET /sso-callback?… HTTP/1.1`.
        let mut buf = vec![0u8; 16 * 1024];
        let mut len = 0;
        while len < buf.len() {
            let n = stream.read(&mut buf[len..]).await?;
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(2).any(|w| w == b"\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..len]);
        let target = callback_target(&head);

        let (status, body) = match target {
            Some(_) => ("200 OK", DONE_PAGE),
            None => ("404 Not Found", "Not found"),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        let _ = stream.shutdown().await;

        if let Some(target) = target {
            let url = format!("http://127.0.0.1:{LOOPBACK_PORT}{target}");
            focus_main(&app);
            let _ = app.emit_to(MAIN, "oauth-callback", url);
        }
        Ok(())
    }

    /// The request target when the request is a GET of the callback path.
    pub(super) fn callback_target(head: &str) -> Option<&str> {
        let mut parts = head.lines().next()?.split(' ');
        let (method, target) = (parts.next()?, parts.next()?);
        let path = target.split('?').next()?;
        (method == "GET" && path == CALLBACK_PATH).then_some(target)
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::loopback::callback_target;

    #[test]
    fn callback_requests() {
        assert_eq!(
            callback_target("GET /sso-callback?rotating_token_nonce=abc HTTP/1.1\r\nHost: x\r\n"),
            Some("/sso-callback?rotating_token_nonce=abc")
        );
        assert_eq!(
            callback_target("GET /sso-callback HTTP/1.1\r\n"),
            Some("/sso-callback")
        );
        assert_eq!(callback_target("GET /favicon.ico HTTP/1.1\r\n"), None);
        assert_eq!(callback_target("POST /sso-callback HTTP/1.1\r\n"), None);
        assert_eq!(callback_target(""), None);
    }
}
