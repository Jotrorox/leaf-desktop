//! A tiny credential store for the front end: Clerk's client token, which
//! keeps the user signed in across launches.
//!
//! It lives in a JSON file in the app's data directory, readable only by the
//! user (0600 on Unix), outside the webview's storage so page scripts and
//! "clear site data" can't reach it. The OS keychain would prompt on every
//! rebuild of an ad-hoc-signed app, so a private file is used instead.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State};

/// Keys the front end may use. Anything else is refused.
const KEYS: &[&str] = &["clerk.client"];

#[derive(Debug, Default)]
pub struct Secrets {
    path: Option<PathBuf>,
    values: Mutex<Option<HashMap<String, String>>>,
}

impl Secrets {
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        let path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("credentials.json"));
        Self {
            path,
            values: Mutex::new(None),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, String>) -> T) -> Result<T, String> {
        let mut guard = self.values.lock().map_err(|err| err.to_string())?;
        if guard.is_none() {
            // Only a missing file means "nothing stored". Any other failure
            // is an error (and retried next time), never mistaken for a
            // signed-out user whose token may then be overwritten.
            let loaded = match self.path.as_ref().map(fs::read) {
                None => return Err("no app data directory".into()),
                Some(Ok(bytes)) => serde_json::from_slice(&bytes)
                    .map_err(|err| format!("unreadable credentials file: {err}"))?,
                Some(Err(err)) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
                Some(Err(err)) => return Err(format!("couldn't read credentials: {err}")),
            };
            *guard = Some(loaded);
        }
        let values = guard.as_mut().ok_or("credentials not loaded")?;
        Ok(f(values))
    }

    fn save(&self, values: &HashMap<String, String>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Err("no app data directory".into());
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|err| err.to_string())?;
        }
        let bytes = serde_json::to_vec(values).map_err(|err| err.to_string())?;
        // Write to a sibling and rename, so a crash can't leave half a file.
        let tmp = path.with_extension("json.tmp");
        write_private(&tmp, &bytes).map_err(|err| err.to_string())?;
        fs::rename(&tmp, path).map_err(|err| err.to_string())
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(path, bytes)
}

fn check(key: &str) -> Result<(), String> {
    if KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("unknown secret {key:?}"))
    }
}

#[tauri::command]
pub fn secret_get(secrets: State<'_, Secrets>, key: String) -> Result<Option<String>, String> {
    check(&key)?;
    secrets.with(|values| values.get(&key).cloned())
}

#[tauri::command]
pub fn secret_set(secrets: State<'_, Secrets>, key: String, value: String) -> Result<(), String> {
    check(&key)?;
    let snapshot = secrets.with(|values| {
        if values.get(&key) == Some(&value) {
            return None;
        }
        values.insert(key, value);
        Some(values.clone())
    })?;
    snapshot.map_or(Ok(()), |values| secrets.save(&values))
}

#[tauri::command]
pub fn secret_delete(secrets: State<'_, Secrets>, key: String) -> Result<(), String> {
    check(&key)?;
    let snapshot = secrets.with(|values| values.remove(&key).map(|_| values.clone()))?;
    snapshot.map_or(Ok(()), |values| secrets.save(&values))
}
