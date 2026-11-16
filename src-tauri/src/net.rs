//! Native networking for the front end: HTTP requests and WebSockets made
//! from Rust instead of the webview.
//!
//! Why not the webview's own `fetch`/`WebSocket`? The app is served from
//! `tauri://localhost` (or `http://tauri.localhost`), an origin the leaf API's
//! CORS rules and socket origin check don't know, and one Clerk would stamp
//! into session tokens (`azp`). Requests made here carry no `Origin` at all,
//! like any native client, so they behave exactly as the web app's do. One
//! pooled HTTP/2 client also keeps connections warm between requests.
//!
//! ## Wire format
//!
//! `http_fetch` takes the request body as the raw IPC payload and the rest
//! of the request as JSON in the `x-leaf-request` header (percent-encoded).
//! It answers with raw bytes: a 4-byte big-endian length, that many bytes of
//! JSON metadata (`status`, `headers`, `url`), then the response body.
//!
//! `ws_connect` streams socket events over a channel, each a raw message
//! whose first byte is its kind (see `WS_*`), followed by its payload.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, Manager, State, http::HeaderValue};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};

const REQUEST_HEADER: &str = "x-leaf-request";
const USER_AGENT: &str = concat!("leaf-desktop/", env!("CARGO_PKG_VERSION"));

/// Socket opened. Payload: none.
const WS_OPEN: u8 = 0;
/// Binary message. Payload: the bytes.
const WS_BINARY: u8 = 1;
/// Text message. Payload: UTF-8.
const WS_TEXT: u8 = 2;
/// Closed. Payload: 2-byte big-endian code, then the UTF-8 reason.
const WS_CLOSE: u8 = 3;
/// Failed (before or after opening); a close follows. Payload: UTF-8 message.
const WS_ERROR: u8 = 4;

/// Shared networking state, managed by Tauri.
#[derive(Debug)]
pub struct Net {
    client: reqwest::Client,
    sockets: Mutex<HashMap<u32, mpsc::UnboundedSender<Message>>>,
    next_socket: AtomicU32,
}

impl Net {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            // A connection that died while the Mac slept shouldn't hang
            // requests: ping idle HTTP/2 connections, and give up on reads
            // that stall.
            .http2_keep_alive_interval(Duration::from_secs(20))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .read_timeout(Duration::from_secs(120))
            .build()
            .expect("the HTTP client's configuration is static and valid");
        Self {
            client,
            sockets: Mutex::new(HashMap::new()),
            next_socket: AtomicU32::new(1),
        }
    }
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
struct FetchRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
struct FetchMeta {
    status: u16,
    url: String,
    headers: Vec<(String, String)>,
}

/// Only the network: HTTPS anywhere, plain HTTP and WS to this machine (a
/// local backend in development). Never `file:` or other schemes.
fn allowed(url: &url::Url) -> bool {
    match url.scheme() {
        "https" | "wss" => true,
        "http" | "ws" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

fn parse_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|err| format!("invalid URL: {err}"))?;
    if !allowed(&url) {
        return Err(format!("URL not allowed: {}", url.scheme()));
    }
    Ok(url)
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Performs an HTTP request for the front end's `fetch` shim.
#[tauri::command]
pub async fn http_fetch(net: State<'_, Net>, request: Request<'_>) -> Result<Response, String> {
    let meta = request
        .headers()
        .get(REQUEST_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("missing request metadata")?;
    let spec: FetchRequest =
        serde_json::from_str(&percent_decode(meta)?).map_err(|err| err.to_string())?;
    let url = parse_url(&spec.url)?;
    let method =
        reqwest::Method::from_bytes(spec.method.as_bytes()).map_err(|err| err.to_string())?;

    let mut builder = net.client.request(method, url);
    for (name, value) in &spec.headers {
        // The webview's notion of these doesn't apply to a native request.
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "origin" | "cookie" | "host" | "content-length" | "connection"
        ) {
            continue;
        }
        builder = builder.header(name, value);
    }
    match request.body() {
        InvokeBody::Raw(bytes) if !bytes.is_empty() => builder = builder.body(bytes.clone()),
        _ => {}
    }

    let response = builder.send().await.map_err(|err| describe(&err))?;
    let meta = FetchMeta {
        status: response.status().as_u16(),
        url: response.url().to_string(),
        headers: response
            .headers()
            .iter()
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
            .collect(),
    };
    let body = response.bytes().await.map_err(|err| describe(&err))?;
    let meta = serde_json::to_vec(&meta).map_err(|err| err.to_string())?;

    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(
        &u32::try_from(meta.len())
            .map_err(|err| err.to_string())?
            .to_be_bytes(),
    );
    out.extend_from_slice(&meta);
    out.extend_from_slice(&body);
    Ok(Response::new(out))
}

fn describe(err: &reqwest::Error) -> String {
    if err.is_connect() {
        format!("Couldn't connect: {err}")
    } else if err.is_timeout() {
        format!("Timed out: {err}")
    } else {
        err.to_string()
    }
}

fn frame(kind: u8, payload: &[u8]) -> InvokeResponseBody {
    let mut out = Vec::with_capacity(1 + payload.len());
    out.push(kind);
    out.extend_from_slice(payload);
    InvokeResponseBody::Raw(out)
}

fn close_frame(code: u16, reason: &str) -> InvokeResponseBody {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    frame(WS_CLOSE, &payload)
}

/// Opens a WebSocket. Events arrive on `on_event`; returns the socket id for
/// `ws_send` and `ws_close`. `origin` is sent as the `Origin` header (the
/// API only accepts sockets from the web app's origin).
#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    net: State<'_, Net>,
    url: String,
    origin: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let parsed = parse_url(&url)?;
    let mut request = parsed
        .as_str()
        .into_client_request()
        .map_err(|err| err.to_string())?;
    request
        .headers_mut()
        .insert("user-agent", HeaderValue::from_static(USER_AGENT));
    if let Some(origin) = origin.filter(|origin| !origin.is_empty()) {
        let value = HeaderValue::from_str(&origin).map_err(|err| err.to_string())?;
        request.headers_mut().insert("origin", value);
    }

    let id = net.next_socket.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    net.sockets
        .lock()
        .map_err(|err| err.to_string())?
        .insert(id, tx);

    let events = on_event;
    tauri::async_runtime::spawn(async move {
        let finish = |code: u16, reason: &str| {
            // `State` can't move into the task, so the managed `Net` (which
            // lives as long as the app) is looked up again to forget the socket.
            if let Ok(mut sockets) = app.state::<Net>().sockets.lock() {
                sockets.remove(&id);
            }
            let _ = events.send(close_frame(code, reason));
        };
        let connect = tokio_tungstenite::connect_async(request);
        let stream = match tokio::time::timeout(Duration::from_secs(15), connect).await {
            Ok(Ok((stream, _))) => stream,
            Ok(Err(err)) => {
                let _ = events.send(frame(WS_ERROR, err.to_string().as_bytes()));
                finish(1006, "");
                return;
            }
            Err(_) => {
                let _ = events.send(frame(WS_ERROR, b"connecting timed out"));
                finish(1006, "");
                return;
            }
        };
        let _ = events.send(frame(WS_OPEN, &[]));
        let (mut write, mut read) = stream.split();
        let mut closed: Option<(u16, String)> = None;
        loop {
            tokio::select! {
                outgoing = rx.recv() => match outgoing {
                    Some(message) => {
                        let is_close = matches!(message, Message::Close(_));
                        if let Err(err) = write.send(message).await {
                            let _ = events.send(frame(WS_ERROR, err.to_string().as_bytes()));
                            break;
                        }
                        if is_close {
                            // Wait (briefly) for the server's close frame.
                            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                                while let Some(Ok(message)) = read.next().await {
                                    if let Message::Close(frame) = message {
                                        closed = frame.map(|f| (u16::from(f.code), f.reason.to_string()));
                                        break;
                                    }
                                }
                            })
                            .await;
                            closed.get_or_insert((1000, String::new()));
                            break;
                        }
                    }
                    // Every sender is gone: the front end forgot the socket.
                    None => {
                        let _ = write.send(Message::Close(None)).await;
                        closed = Some((1000, String::new()));
                        break;
                    }
                },
                incoming = read.next() => match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        if events.send(frame(WS_BINARY, &bytes)).is_err() {
                            let _ = write.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let _ = events.send(frame(WS_TEXT, text.as_bytes()));
                    }
                    Some(Ok(Message::Close(frame))) => {
                        closed = Some(frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string())));
                        break;
                    }
                    // Pings are answered by tungstenite itself.
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        let _ = events.send(frame(WS_ERROR, err.to_string().as_bytes()));
                        break;
                    }
                    None => break,
                },
            }
        }
        let (code, reason) = closed.unwrap_or((1006, String::new()));
        finish(code, &reason);
    });

    Ok(id)
}

/// Sends a binary message (the raw IPC payload) on socket `x-leaf-socket`.
#[tauri::command]
pub fn ws_send(net: State<'_, Net>, request: Request<'_>) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-leaf-socket")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or("missing socket id")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary payload".into());
    };
    let sockets = net.sockets.lock().map_err(|err| err.to_string())?;
    let socket = sockets.get(&id).ok_or("socket is closed")?;
    socket
        .send(Message::Binary(Bytes::from(bytes.clone())))
        .map_err(|_| "socket is closed".to_owned())
}

/// Starts closing a socket. Its close event follows on the channel.
#[tauri::command]
pub fn ws_close(
    net: State<'_, Net>,
    id: u32,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    let Some(socket) = net
        .sockets
        .lock()
        .map_err(|err| err.to_string())?
        .remove(&id)
    else {
        return Ok(());
    };
    let frame = CloseFrame {
        code: CloseCode::from(code.unwrap_or(1000)),
        reason: reason.unwrap_or_default().into(),
    };
    let _ = socket.send(Message::Close(Some(frame)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_network_urls() {
        let ok = [
            "https://api.leaf.jotrorox.com/v1/me",
            "wss://api.example.com/ws",
            "http://localhost:8080/v1",
        ];
        for raw in ok {
            assert!(parse_url(raw).is_ok(), "{raw}");
        }
        let bad = [
            "file:///etc/passwd",
            "http://example.com/",
            "tauri://localhost/",
            "ws://10.0.0.1/",
        ];
        for raw in bad {
            assert!(parse_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn decodes_percent_encoding() {
        assert_eq!(percent_decode("%7B%22a%22%3A1%7D").unwrap(), r#"{"a":1}"#);
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert_eq!(percent_decode("%C3%BC").unwrap(), "ü");
    }
}
