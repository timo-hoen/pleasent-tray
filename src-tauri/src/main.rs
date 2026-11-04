#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod clipboard;
mod credentials;
mod edit;
mod entry;
mod index;
mod pleasant;
mod session_lock;
mod tray;

use pleasant::{FetchError, LoginOutcome, TokenResult};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

const IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);
const LOCK_CHECK: Duration = Duration::from_secs(1);

/// The unlocked login. Exists only in RAM and is dropped when the app locks.
#[derive(Clone)]
struct Session {
    server: String,
    username: String,
    password: String,
}

struct AppState {
    client: reqwest::Client,
    server: RwLock<String>,
    session: Mutex<Option<Session>>,
    /// Counts locks, so a login that was running during a lock can notice it.
    lock_generation: AtomicU64,
    /// Wall clock and monotonic clock: either one alone can miss idle time.
    last_activity: RwLock<(SystemTime, Instant)>,
    startup_warning: RwLock<Option<String>>,
    token: Mutex<Option<String>>,
    tree: RwLock<Option<index::TreeNode>>,
    totp: RwLock<Option<entry::Totp>>,
}

/// Wall clock time, so that a computer that was asleep counts as idle.
fn is_idle(last_activity: SystemTime, now: SystemTime) -> bool {
    now.duration_since(last_activity).is_ok_and(|elapsed| elapsed >= IDLE_LIMIT)
}

fn mark_activity(state: &AppState) {
    if let Ok(mut last_activity) = state.last_activity.write() {
        *last_activity = (SystemTime::now(), Instant::now());
    }
}

/// Drops everything that was only available while unlocked.
async fn clear_session(state: &AppState) {
    state.lock_generation.fetch_add(1, Ordering::SeqCst);
    clipboard::clear_sensitive();
    *state.session.lock().await = None;
    *state.token.lock().await = None;
    if let Ok(mut tree) = state.tree.write() {
        *tree = None;
    }
    if let Ok(mut totp) = state.totp.write() {
        *totp = None;
    }
}

pub(crate) async fn lock_and_notify(app: &AppHandle) {
    clear_session(&app.state::<AppState>()).await;
    let _ = app.emit("locked", ());
}

/// Locks after inactivity and as soon as Windows locks the session.
async fn watch_lock_triggers(app: AppHandle) {
    loop {
        tokio::time::sleep(LOCK_CHECK).await;
        let state = app.state::<AppState>();
        let unlocked = state.session.lock().await.is_some();
        // A poisoned lock counts as idle: locking is the safe side.
        let idle = state.last_activity.read().map_or(true, |activity| {
            is_idle(activity.0, SystemTime::now()) || activity.1.elapsed() >= IDLE_LIMIT
        });
        if unlocked && (idle || session_lock::is_locked() == Some(true)) {
            lock_and_notify(&app).await;
        }
    }
}

/// A request that was running while the app locked must not store its result.
async fn ensure_unlocked(state: &AppState) -> Result<(), String> {
    if state.session.lock().await.is_some() {
        Ok(())
    } else {
        Err("AUTH".into())
    }
}

#[tauri::command]
fn touch(state: State<'_, AppState>) {
    mark_activity(&state);
}

#[tauri::command]
async fn lock(app: AppHandle) {
    lock_and_notify(&app).await;
}

#[derive(Serialize)]
struct ServerInfo {
    url: String,
    label: String,
    username: String,
    warning: Option<String>,
}

/// The server and user of the stored login, or the default server without one.
#[tauri::command]
fn server_info(state: State<'_, AppState>) -> ServerInfo {
    let stored = credentials::load();
    let url = stored
        .as_ref()
        .map_or_else(|| pleasant::DEFAULT_SERVER.to_string(), |s| s.server.clone());
    let label = pleasant::server_label(&url);
    let warning = state.startup_warning.read().ok().and_then(|warning| warning.clone());
    ServerInfo { url, label, username: stored.map(|s| s.username).unwrap_or_default(), warning }
}

/// Unlocks the app. The server checks the password, so there is no local copy to attack.
#[tauri::command]
async fn login(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    otp: Option<String>,
    provider: Option<String>,
) -> Result<LoginOutcome, String> {
    let server = pleasant::normalize_server(&server)?;
    if password.is_empty() {
        return Err("Bitte Passwort eingeben".into());
    }
    let session = Session { server, username: username.trim().to_string(), password };
    let otp_pair = otp.as_deref().zip(provider.as_deref());
    let generation = state.lock_generation.load(Ordering::SeqCst);
    let outcome = authenticate(&state, &session, otp_pair).await?;
    if !matches!(outcome, LoginOutcome::Ok) {
        return Ok(outcome);
    }
    let saved = credentials::save(&credentials::Stored {
        server: session.server.clone(),
        username: session.username.clone(),
    });
    if let Err(message) = saved {
        *state.token.lock().await = None;
        return Err(message);
    }
    // The save overwrote any old password, so an earlier cleanup failure no longer applies.
    if let Ok(mut warning) = state.startup_warning.write() {
        *warning = None;
    }
    mark_activity(&state);
    let mut current = state.session.lock().await;
    if state.lock_generation.load(Ordering::SeqCst) != generation {
        drop(current);
        *state.token.lock().await = None;
        return Err("Die App wurde während der Anmeldung gesperrt".into());
    }
    *current = Some(session);
    Ok(outcome)
}

async fn authenticate(
    state: &AppState,
    session: &Session,
    otp: Option<(&str, &str)>,
) -> Result<LoginOutcome, String> {
    match pleasant::request_token(&state.client, &session.server, &session.username, &session.password, otp).await? {
        TokenResult::Token(token) => {
            *state.server.write().map_err(|_| "Server nicht verfügbar")? = session.server.clone();
            *state.token.lock().await = Some(token);
            Ok(LoginOutcome::Ok)
        }
        TokenResult::OtpRequired(provider) => Ok(LoginOutcome::OtpRequired { provider }),
    }
}

fn current_server(state: &AppState) -> Result<String, String> {
    Ok(state.server.read().map_err(|_| "Server nicht verfügbar")?.clone())
}

/// Authenticated API call. An expired token is renewed once from the unlocked session.
/// Fails with "AUTH" when a new login is needed: locked, or the account uses 2FA.
async fn call(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    ensure_unlocked(state).await?;
    let token = state.token.lock().await.clone().ok_or("AUTH")?;
    let server = current_server(state)?;
    match pleasant::request(&state.client, &server, &token, method.clone(), path, body).await {
        Ok(value) => return Ok(value),
        Err(FetchError::Other(message)) => return Err(message),
        Err(FetchError::Unauthorized) => {}
    }
    let session = state.session.lock().await.clone().ok_or("AUTH")?;
    let outcome = authenticate(state, &session, None).await.map_err(|_| "AUTH")?;
    if !matches!(outcome, LoginOutcome::Ok) {
        return Err("AUTH".into());
    }
    if ensure_unlocked(state).await.is_err() {
        *state.token.lock().await = None;
        return Err("AUTH".into());
    }
    let token = state.token.lock().await.clone().ok_or("AUTH")?;
    let server = current_server(state)?;
    pleasant::request(&state.client, &server, &token, method, path, body).await.map_err(|e| match e {
        FetchError::Unauthorized => "AUTH".to_string(),
        FetchError::Other(message) => message,
    })
}

#[derive(Serialize, serde::Deserialize)]
struct CachedTree {
    saved_at: u64,
    tree: index::TreeNode,
}

#[derive(Serialize)]
struct CacheInfo {
    count: usize,
    saved_at: u64,
}

#[derive(Serialize)]
struct RefreshResult {
    count: usize,
    cache_error: Option<String>,
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("Cache-Ordner fehlt: {e}"))?;
    Ok(dir.join("folders.cache"))
}

fn account_of(session: &Session) -> String {
    format!("{}\n{}", session.server, session.username)
}

/// The file is replaced in one step, so a crash cannot leave half a cache behind.
async fn save_cache(app: &AppHandle, state: &AppState, tree: index::TreeNode) -> Result<(), String> {
    let session = state.session.lock().await.clone().ok_or("AUTH")?;
    let saved_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let plain = serde_json::to_vec(&CachedTree { saved_at, tree }).map_err(|e| e.to_string())?;
    let sealed = tauri::async_runtime::spawn_blocking(move || {
        cache::seal(&plain, &session.password, &account_of(&session))
    })
    .await
    .map_err(|e| e.to_string())??;
    let path = cache_path(app)?;
    let temp = path.with_extension("tmp");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&temp, sealed).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// Shows the cached folders after unlocking. `None` means the server has to be asked.
#[tauri::command]
async fn load_cached(app: AppHandle, state: State<'_, AppState>) -> Result<Option<CacheInfo>, String> {
    let session = state.session.lock().await.clone().ok_or("AUTH")?;
    let Ok(data) = std::fs::read(cache_path(&app)?) else {
        return Ok(None);
    };
    let plain = tauri::async_runtime::spawn_blocking(move || {
        cache::open(&data, &session.password, &account_of(&session))
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(cached) = plain.and_then(|p| serde_json::from_slice::<CachedTree>(&p).ok()) else {
        return Ok(None);
    };
    ensure_unlocked(&state).await?;
    let info = CacheInfo { count: cached.tree.entry_count(), saved_at: cached.saved_at };
    *state.tree.write().map_err(|_| "Index nicht verfügbar")? = Some(cached.tree);
    Ok(Some(info))
}

/// Reads the folders from the server and renews the cache. A cache that cannot be written
/// is reported but does not fail the refresh, the folders are loaded either way.
#[tauri::command]
async fn refresh_index(app: AppHandle, state: State<'_, AppState>) -> Result<RefreshResult, String> {
    let tree = call(&state, Method::GET, "/api/v5/rest/folders", None).await?;
    let root = serde_json::from_value(tree).map_err(|e| format!("Einträge nicht lesbar: {e}"))?;
    let folders = index::build_tree(&root, "", "0");
    let count = folders.entry_count();
    ensure_unlocked(&state).await?;
    *state.tree.write().map_err(|_| "Index nicht verfügbar")? = Some(folders.clone());
    let cache_error = save_cache(&app, &state, folders).await.err();
    Ok(RefreshResult { count, cache_error })
}

#[tauri::command]
fn folder_tree(state: State<'_, AppState>) -> Result<Option<index::TreeNode>, String> {
    Ok(state.tree.read().map_err(|_| "Index nicht verfügbar")?.clone())
}

/// Rejects anything that is not a GUID, because the id becomes part of a URL path.
fn valid_id(id: &str) -> Result<&str, String> {
    let ok = id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err("Ungültige Eintrags-ID".into())
    }
}

/// Loads an entry. Without TOTP data in v5, the v7 model is tried: it defines TOTP
/// fields, but its route is undocumented, so a failure there is not an error.
#[tauri::command]
async fn open_entry(state: State<'_, AppState>, id: String) -> Result<entry::Detail, String> {
    let id = valid_id(&id)?;
    let value = call(&state, Method::GET, &format!("/api/v5/rest/entries/{id}"), None).await?;
    let (mut detail, mut totp) = entry::parse(&value);
    if totp.is_none() {
        let v7_path = format!("/api/v7/rest/entries/{id}");
        if let Ok(v7) = call(&state, Method::GET, &v7_path, None).await {
            totp = entry::totp_from(&v7);
            detail.has_totp = totp.is_some();
        }
    }
    ensure_unlocked(&state).await?;
    *state.totp.write().map_err(|_| "TOTP nicht verfügbar")? = totp;
    Ok(detail)
}

#[tauri::command]
fn close_entry(state: State<'_, AppState>) -> Result<(), String> {
    *state.totp.write().map_err(|_| "TOTP nicht verfügbar")? = None;
    Ok(())
}

#[derive(Serialize)]
struct TotpCode {
    code: String,
    remaining: u64,
    period: u64,
}

fn current_code(state: &AppState) -> Result<TotpCode, String> {
    let guard = state.totp.read().map_err(|_| "TOTP nicht verfügbar")?;
    let totp = guard.as_ref().ok_or("Kein TOTP für diesen Eintrag")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let (code, remaining) = totp.code(now);
    Ok(TotpCode { code, remaining, period: totp.period })
}

#[tauri::command]
fn totp_code(state: State<'_, AppState>) -> Result<TotpCode, String> {
    current_code(&state)
}

#[tauri::command]
fn copy_totp(state: State<'_, AppState>) -> Result<(), String> {
    clipboard::copy(&current_code(&state)?.code, true)
}

#[tauri::command]
fn copy_text(text: String, sensitive: bool) -> Result<(), String> {
    clipboard::copy(&text, sensitive)
}

async fn fetch_password(
    state: &AppState,
    id: &str,
    comment: Option<String>,
) -> Result<String, String> {
    let id = valid_id(id)?;
    let path = format!("/api/v5/rest/entries/{id}/password");
    let value = match comment {
        Some(comment) => {
            call(state, Method::POST, &path, Some(&json!({ "Comment": comment }))).await?
        }
        None => call(state, Method::GET, &path, None).await?,
    };
    ensure_unlocked(state).await?;
    value.as_str().map(str::to_string).ok_or_else(|| "Eintrag hat kein Passwort".to_string())
}

#[tauri::command]
async fn copy_password(
    state: State<'_, AppState>,
    id: String,
    comment: Option<String>,
) -> Result<(), String> {
    clipboard::copy(&fetch_password(&state, &id, comment).await?, true)
}

/// Only called when the user presses the show button; the UI masks it again afterwards.
#[tauri::command]
async fn reveal_password(
    state: State<'_, AppState>,
    id: String,
    comment: Option<String>,
) -> Result<String, String> {
    fetch_password(&state, &id, comment).await
}

/// Returns the id of the new entry.
#[tauri::command]
async fn create_entry(
    state: State<'_, AppState>,
    group_id: String,
    input: edit::EntryInput,
) -> Result<String, String> {
    let group_id = valid_id(&group_id).map_err(|_| "In diesem Ordner nicht möglich")?;
    let body = edit::create_body(group_id, &input)?;
    let value = call(&state, Method::POST, "/api/v5/rest/entries", Some(&body)).await?;
    value.as_str().map(str::to_string).ok_or_else(|| "Unerwartete Antwort vom Server".to_string())
}

/// Changes only the sent fields, custom fields and an unchanged password stay as they are.
#[tauri::command]
async fn update_entry(
    state: State<'_, AppState>,
    id: String,
    input: edit::EntryInput,
) -> Result<(), String> {
    let id = valid_id(&id)?;
    let body = edit::patch_body(&input)?;
    call(&state, Method::PATCH, &format!("/api/v5/rest/entries/{id}"), Some(&body)).await?;
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Nur http- und https-Adressen werden geöffnet".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| format!("Öffnen fehlgeschlagen: {e}"))
}

#[tauri::command]
async fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    clear_session(&state).await;
    match std::fs::remove_file(cache_path(&app)?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cache nicht gelöscht: {e}")),
    }
    credentials::clear()
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn idle_only_after_the_limit() {
        let start = UNIX_EPOCH + Duration::from_secs(1000);
        assert!(!is_idle(start, start + IDLE_LIMIT - Duration::from_secs(1)));
        assert!(is_idle(start, start + IDLE_LIMIT));
    }

    #[test]
    fn clock_going_backwards_does_not_lock() {
        let start = UNIX_EPOCH + Duration::from_secs(1000);
        assert!(!is_idle(start, start - Duration::from_secs(1)));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    const TEST_PASSWORD: &str = "Api-Test-Pw-1";
    const NEW_PASSWORD: &str = "Api-Test-Pw-2";

    /// Runs against the real server and leaves one test entry behind. Prints no secrets. Needs
    /// PLEASANT_TEST_FOLDER, PLEASANT_TEST_USER and PLEASANT_TEST_PASSWORD; run with
    /// `cargo test live_ -- --ignored`.
    #[test]
    #[ignore = "writes to the real server"]
    fn live_create_and_patch_keep_other_fields() {
        let folder = std::env::var("PLEASANT_TEST_FOLDER").expect("PLEASANT_TEST_FOLDER");
        let stored = Session {
            server: pleasant::DEFAULT_SERVER.to_string(),
            username: std::env::var("PLEASANT_TEST_USER").expect("PLEASANT_TEST_USER"),
            password: std::env::var("PLEASANT_TEST_PASSWORD").expect("PLEASANT_TEST_PASSWORD"),
        };
        let client = pleasant::build_client().unwrap();
        tauri::async_runtime::block_on(async {
            let TokenResult::Token(token) = pleasant::request_token(
                &client, &stored.server, &stored.username, &stored.password, None,
            )
            .await
            .unwrap() else {
                panic!("account needs 2FA");
            };
            let send = |method: Method, path: String, body: Option<Value>| {
                let (client, server, token) = (&client, &stored.server, &token);
                async move {
                    pleasant::request(client, server, token, method, &path, body.as_ref())
                        .await
                        .map_err(|e| match e {
                            FetchError::Unauthorized => "401".to_string(),
                            FetchError::Other(message) => message,
                        })
                        .unwrap()
                }
            };
            let mut body = edit::create_body(&folder, &edit::EntryInput {
                name: "API-Test".into(),
                username: "tester".into(),
                url: "https://example.invalid".into(),
                notes: "angelegt per API".into(),
                password: Some(TEST_PASSWORD.into()),
            })
            .unwrap();
            body["CustomUserFields"] = json!({ "Testfeld": "bleibt" });
            let created = send(Method::POST, "/api/v5/rest/entries".into(), Some(body)).await;
            let id = created.as_str().expect("guid").to_string();
            let path = format!("/api/v5/rest/entries/{id}");
            let password_path = format!("{path}/password");

            let patch = edit::patch_body(&edit::EntryInput {
                name: "API-Test geändert".into(),
                username: "tester".into(),
                url: String::new(),
                notes: "angelegt per API".into(),
                password: None,
            })
            .unwrap();
            send(Method::PATCH, path.clone(), Some(patch)).await;
            let read = send(Method::GET, path.clone(), None).await;
            assert_eq!(read["Name"], "API-Test geändert");
            assert_eq!(read["Url"], "");
            assert_eq!(read["GroupId"].as_str().map(str::to_lowercase), Some(folder.to_lowercase()));
            assert_eq!(read["CustomUserFields"]["Testfeld"], "bleibt", "custom field lost");
            let kept = send(Method::GET, password_path.clone(), None).await;
            assert!(kept == json!(TEST_PASSWORD), "password changed by patch");

            let change = edit::patch_body(&edit::EntryInput {
                name: "API-Test geändert".into(),
                username: "tester".into(),
                url: String::new(),
                notes: "angelegt per API".into(),
                password: Some(NEW_PASSWORD.into()),
            })
            .unwrap();
            send(Method::PATCH, path.clone(), Some(change)).await;
            let changed = send(Method::GET, password_path, None).await;
            assert!(changed == json!(NEW_PASSWORD), "password not changed");
            let read = send(Method::GET, path, None).await;
            assert_eq!(read["CustomUserFields"]["Testfeld"], "bleibt", "custom field lost");
        });
    }
}

fn main() {
    let client = match pleasant::build_client() {
        Ok(client) => client,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    let startup_warning = credentials::remove_legacy_password().err().map(|message| {
        format!("Altes Passwort konnte nicht entfernt werden. {message}")
    });
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| tray::show_main(app)))
        .manage(AppState { client, server: RwLock::new(pleasant::DEFAULT_SERVER.to_string()), session: Mutex::new(None), lock_generation: AtomicU64::new(0), last_activity: RwLock::new((SystemTime::now(), Instant::now())), startup_warning: RwLock::new(startup_warning), token: Mutex::new(None), tree: RwLock::new(None), totp: RwLock::new(None) })
        .invoke_handler(tauri::generate_handler![
            touch, lock, load_cached, login, server_info, folder_tree, refresh_index, logout, open_entry, close_entry,
            totp_code, copy_totp, copy_text, copy_password, reveal_password, open_url,
            create_entry, update_entry
        ])
        .setup(|app| {
            tray::create(app.handle())?;
            tauri::async_runtime::spawn(watch_lock_triggers(app.handle().clone()));
            if let Some(window) = app.get_webview_window("main") {
                tray::hide_on_close(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("App konnte nicht starten: {error}");
        std::process::exit(1);
    }
}
