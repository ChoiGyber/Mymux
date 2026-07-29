//! Phase C: Mymux owns a Chromium-based browser launched with a remote
//! debugging (CDP) port. The user's AI tooling (Playwright MCP) connects to the
//! same browser via `--cdp-endpoint`, so AI automation and the live view stay in
//! sync. Phase A will render this browser inside a tab via CDP screencast; for
//! now it opens as a separate window the app controls.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, Rect, State, WebviewUrl};

/// A launched browser process plus the parameters needed to describe it.
struct BrowserProc {
    child: Child,
    port: u16,
    browser: String,
}

#[derive(Default)]
pub struct BrowserManager {
    proc: Mutex<Option<BrowserProc>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Drop for BrowserManager {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.proc.lock()
            && let Some(mut proc) = guard.take()
        {
            let _ = proc.child.kill();
        }
    }
}

#[derive(Serialize, Clone)]
pub struct BrowserStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub endpoint: Option<String>,
    pub browser: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub browser: String,
    pub name: String,
    pub profile: String,
}

impl BrowserStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            port: None,
            endpoint: None,
            browser: None,
        }
    }

    fn running(port: u16, browser: String) -> Self {
        Self {
            running: true,
            port: Some(port),
            endpoint: Some(endpoint(port)),
            browser: Some(browser),
        }
    }
}

fn endpoint(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// Isolated profile dir. A non-default `--user-data-dir` is mandatory: modern
/// Chrome/Edge refuse `--remote-debugging-port` on the default profile.
fn user_data_dir(port: u16) -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("mycli").join(format!("browser-{port}"))
}

#[cfg(windows)]
fn known_browser_roots() -> Vec<(&'static str, PathBuf)> {
    let Some(local) = dirs::data_local_dir() else { return Vec::new() };
    vec![
        ("Chrome", local.join(r"Google\Chrome\User Data")),
        ("Edge", local.join(r"Microsoft\Edge\User Data")),
    ]
}

/// List only profile metadata. Cookie databases and login data are not opened
/// until the user explicitly confirms an import.
#[tauri::command]
pub fn browser_profiles() -> Result<Vec<BrowserProfile>, String> {
    #[cfg(windows)]
    {
        let mut profiles = Vec::new();
        for (browser, root) in known_browser_roots() {
            let Ok(entries) = std::fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                    || !(name == "Default" || name.starts_with("Profile "))
                {
                    continue;
                }
                let display_name = std::fs::read_to_string(path.join("Preferences"))
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|v| v.get("profile")?.get("name")?.as_str().map(str::to_owned))
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| name.clone());
                profiles.push(BrowserProfile {
                    id: format!("{}:{}", browser.to_lowercase(), name),
                    browser: browser.to_string(),
                    name: display_name,
                    profile: name,
                });
            }
        }
        profiles.sort_by(|a, b| a.browser.cmp(&b.browser).then(a.name.cmp(&b.name)));
        return Ok(profiles);
    }
    #[cfg(not(windows))]
    {
        Err("Browser profile import is currently supported on Windows only.".into())
    }
}

#[cfg(windows)]
fn browser_process_running(browser: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let exe = if browser == "Edge" { "msedge.exe" } else { "chrome.exe" };
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {exe}")])
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains(&exe.to_ascii_lowercase()))
        .unwrap_or(false)
}

#[cfg(windows)]
fn copy_profile_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|e| format!("create import directory: {e}"))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("read browser profile: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "Cache" || name == "Code Cache" || name == "GPUCache"
            || name.starts_with("Singleton") || name == "LOCK"
        {
            continue;
        }
        let target = destination.join(&name);
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_profile_tree(&path, &target)?;
        } else if kind.is_file() {
            std::fs::copy(&path, &target).map_err(|e| format!("copy {name}: {e}"))?;
        }
    }
    Ok(())
}

/// Copy a selected Chrome/Edge profile into Mymux's isolated CDP profile.
/// The source profile is never modified. The caller must provide explicit
/// consent because cookies and login sessions are sensitive credentials.
#[tauri::command]
pub fn browser_import_profile(
    browser: String,
    profile: String,
    port: Option<u16>,
    consent: bool,
) -> Result<String, String> {
    if !consent {
        return Err("Profile import requires explicit user consent.".into());
    }
    #[cfg(windows)]
    {
        let browser = match browser.as_str() {
            "Chrome" | "Edge" => browser,
            _ => return Err("Unsupported browser profile.".into()),
        };
        if !(profile == "Default" || profile.starts_with("Profile ")) {
            return Err("Unsupported browser profile name.".into());
        }
        if browser_process_running(&browser) {
            return Err(format!("Close {browser} before importing its profile."));
        }
        let root = known_browser_roots()
            .into_iter()
            .find(|(label, _)| *label == browser)
            .map(|(_, path)| path)
            .ok_or("Browser profile root not found.")?;
        let source_profile = root.join(&profile);
        if !source_profile.is_dir() {
            return Err("Selected browser profile no longer exists.".into());
        }
        let destination = user_data_dir(port.unwrap_or(9222));
        std::fs::create_dir_all(&destination).map_err(|e| format!("create Mymux profile: {e}"))?;
        // Local State contains the Chromium encryption key needed by the
        // copied cookie database. It is DPAPI-bound to the current Windows
        // user and is copied only after the explicit consent above.
        let local_state = root.join("Local State");
        if local_state.is_file() {
            std::fs::copy(&local_state, destination.join("Local State"))
                .map_err(|e| format!("copy Local State: {e}"))?;
        }
        copy_profile_tree(&source_profile, &destination.join("Default"))?;
        return Ok(format!("Imported {browser} {profile} into Mymux browser profile."));
    }
    #[cfg(not(windows))]
    {
        let _ = (browser, profile, port);
        Err("Browser profile import is currently supported on Windows only.".into())
    }
}

/// Locate an installed Chromium-based browser. Chrome is preferred over Edge.
fn find_browser(preferred: Option<&str>) -> Option<(String, String)> {
    #[cfg(windows)]
    {
        let mut candidates: Vec<(String, String)> = Vec::new();
        if let Some(local) = dirs::data_local_dir() {
            candidates.push((
                "Chrome".into(),
                local
                    .join(r"Google\Chrome\Application\chrome.exe")
                    .display()
                    .to_string(),
            ));
        }
        for p in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ] {
            candidates.push(("Chrome".into(), p.to_string()));
        }
        for p in [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ] {
            candidates.push(("Edge".into(), p.to_string()));
        }
        let mut installed: Vec<_> = candidates
            .into_iter()
            .filter(|(_, p)| Path::new(p).exists())
            .collect();
        if let Some(preferred) = preferred {
            installed.sort_by_key(|(label, _)| if label == preferred { 0 } else { 1 });
        }
        installed.into_iter().next()
    }
    #[cfg(target_os = "macos")]
    {
        let mut candidates = Vec::new();
        for (label, p) in [
            (
                "Chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ),
            (
                "Edge",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ),
            (
                "Chromium",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ),
        ] {
            if Path::new(p).exists() { candidates.push((label.to_string(), p.to_string())); }
        }
        if let Some(preferred) = preferred {
            candidates.sort_by_key(|(label, _)| if label == preferred { 0 } else { 1 });
        }
        candidates.into_iter().next()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut candidates = Vec::new();
        for (label, exe) in [
            ("Chrome", "google-chrome"),
            ("Chrome", "google-chrome-stable"),
            ("Chromium", "chromium"),
            ("Chromium", "chromium-browser"),
            ("Edge", "microsoft-edge"),
        ] {
            if let Some(path) = which_unix(exe) { candidates.push((label.to_string(), path)); }
        }
        if let Some(preferred) = preferred {
            candidates.sort_by_key(|(label, _)| if label == preferred { 0 } else { 1 });
        }
        candidates.into_iter().next()
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn which_unix(exe: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
        .map(|p| p.display().to_string())
}

/// Launch (or report an already-running) CDP browser on `port`.
#[tauri::command]
pub fn browser_launch(
    state: State<'_, Arc<BrowserManager>>,
    port: Option<u16>,
    url: Option<String>,
    headless: Option<bool>,
    browser: Option<String>,
) -> Result<BrowserStatus, String> {
    let port = port.unwrap_or(9222);
    // Embedded mode (default): run headless so the only view is the in-tab
    // screencast. Headed mode also opens a real OS window alongside the embed.
    let headless = headless.unwrap_or(true);
    let mut guard = state.proc.lock().map_err(|e| e.to_string())?;

    // Already running? Report it instead of double-launching.
    if let Some(proc) = guard.as_mut() {
        if matches!(proc.child.try_wait(), Ok(None)) {
            return Ok(BrowserStatus::running(proc.port, proc.browser.clone()));
        }
        // Previous process exited — clear and relaunch below.
        *guard = None;
    }

    let (label, exe) = find_browser(browser.as_deref())
        .ok_or("Chrome/Edge not found. Please install Chrome or Edge.")?;

    let profile = user_data_dir(port);
    std::fs::create_dir_all(&profile).map_err(|e| format!("Failed to create profile directory: {e}"))?;

    let start_url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "about:blank".to_string());

    let mut cmd = Command::new(&exe);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        // Allow only the embedded WebView's own origin(s) to attach over CDP —
        // never '*', which would let any local process or visited web page drive
        // the debugging browser.
        .arg("--remote-allow-origins=http://tauri.localhost,https://tauri.localhost,tauri://localhost")
        .arg("--no-first-run")
        .arg("--no-default-browser-check");
    if headless {
        cmd.arg("--headless=new");
    } else {
        cmd.arg("--new-window");
    }
    cmd.arg(start_url);

    // No flashing console window on Windows (CREATE_NO_WINDOW).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("{label} failed to launch: {e}"))?;

    *guard = Some(BrowserProc {
        child,
        port,
        browser: label.clone(),
    });

    Ok(BrowserStatus::running(port, label))
}

/// Current browser state, reaping the handle if the process has exited.
#[tauri::command]
pub fn browser_status(state: State<'_, Arc<BrowserManager>>) -> Result<BrowserStatus, String> {
    let mut guard = state.proc.lock().map_err(|e| e.to_string())?;
    if let Some(proc) = guard.as_mut() {
        if matches!(proc.child.try_wait(), Ok(None)) {
            return Ok(BrowserStatus::running(proc.port, proc.browser.clone()));
        }
        *guard = None;
    }
    Ok(BrowserStatus::stopped())
}

/// Kill the managed browser process, if any.
#[tauri::command]
pub fn browser_close(state: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    let mut guard = state.proc.lock().map_err(|e| e.to_string())?;
    if let Some(mut proc) = guard.take() {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageTarget {
    pub ws_url: String,
    pub target_id: String,
    pub url: String,
}

fn parse_page_targets(body: &str) -> Result<Vec<PageTarget>, String> {
    let targets: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Failed to parse CDP response: {e}"))?;
    let arr = targets.as_array().ok_or("CDP response is not an array")?;
    Ok(arr
        .iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|t| {
            Some(PageTarget {
                ws_url: t.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
                target_id: t.get("id")?.as_str()?.to_string(),
                url: t.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub fn browser_page_targets(port: Option<u16>) -> Result<Vec<PageTarget>, String> {
    let body = cdp_http_get(port.unwrap_or(9222), "/json/list")?;
    parse_page_targets(&body)
}

/// Find a `page` debugging target so the frontend can open its CDP WebSocket
/// for screencast + input. Done in Rust to dodge the WebView's CORS wall on
/// the CDP HTTP endpoint (the WebSocket itself is allowed via
/// `--remote-allow-origins=*`).
#[tauri::command]
pub fn browser_page_target(port: Option<u16>) -> Result<PageTarget, String> {
    browser_page_targets(port)?
        .into_iter()
        .next()
        .ok_or("No page target yet (the browser may still be starting)".to_string())
}

#[tauri::command]
pub fn browser_new_tab(port: Option<u16>, url: Option<String>) -> Result<PageTarget, String> {
    let port = port.unwrap_or(9222);
    let requested = url.unwrap_or_else(|| "about:blank".to_string());
    let body = cdp_http_request(port, "PUT", &format!("/json/new?url={}", percent_encode(&requested)))?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse new-tab response: {e}"))?;
    Ok(PageTarget {
        ws_url: value.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).ok_or("New tab websocket URL missing")?.to_string(),
        target_id: value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        url: value.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    })
}

#[tauri::command]
pub fn browser_close_tab(port: Option<u16>, target_id: String) -> Result<(), String> {
    if target_id.is_empty() || target_id.contains('/') || target_id.contains('?') {
        return Err("Invalid browser target id".into());
    }
    let body = cdp_http_request(port.unwrap_or(9222), "GET", &format!("/json/close/{target_id}"))?;
    if !body.trim().is_empty() && body.trim() != "Target is closing" {
        return Err(body);
    }
    Ok(())
}

fn percent_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
        out
    })
}

/// Minimal dependency-free HTTP GET against the local CDP endpoint.
fn cdp_http_get(port: u16, path: &str) -> Result<String, String> {
    cdp_http_request(port, "GET", path)
}

fn cdp_http_request(port: u16, method: &str, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("CDP connection failed (:{port}) — is the browser running? {e}"))?;
    let timeout = Some(std::time::Duration::from_secs(2));
    stream.set_read_timeout(timeout).map_err(|e| e.to_string())?;
    stream.set_write_timeout(timeout).map_err(|e| e.to_string())?;
    let req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut resp = String::new();
    stream
        .read_to_string(&mut resp)
        .map_err(|e| e.to_string())?;

    let body_start = resp
        .find("\r\n\r\n")
        .map(|i| i + 4)
        .ok_or("Malformed HTTP response")?;
    let body = resp[body_start..].to_string();
    if !(resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.1 204")) {
        return Err(format!("CDP HTTP error: {}", body.trim()));
    }
    Ok(body)
}

// ── Native embedded browser (Phase: dual-mode) ─────────────────────────────
// A real child WebView overlaying the Browser tab's viewport, for human
// browsing (no external Chrome). The AI/CDP screencast path stays separate.
//
// CRITICAL: every webview operation (add_child / set_bounds / hide / show /
// navigate / ...) is dispatched via `run_on_main_thread`. Calling these from an
// async command thread does a *blocking* cross-thread dispatch to the WebView2
// UI thread, which deadlocks the whole app on Windows. Running them ON the main
// thread loop makes the calls direct and non-blocking.

const PANE_LABEL: &str = "browser-pane";

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    let normalized = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    let parsed: tauri::Url = normalized.parse().map_err(|e| format!("Failed to parse URL: {e}"))?;
    // Only http/https into the embedded WebView — block file:/data:/about: etc.
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("Disallowed URL scheme: {other} (http/https only)")),
    }
}

fn pane_rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
}

/// Run a closure on the main thread with the pane webview, if it exists.
fn with_pane<F>(app: &tauri::AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce(tauri::webview::Webview) + Send + 'static,
{
    let a = app.clone();
    app.run_on_main_thread(move || {
        if let Some(wv) = a.get_webview(PANE_LABEL) {
            f(wv);
        }
    })
    .map_err(|e| e.to_string())
}

/// Create (or navigate + reposition + show) the embedded browser webview.
#[tauri::command]
pub async fn browser_pane_open(
    window: tauri::Window,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = parse_url(&url)?;
    let win = window.clone();
    window
        .app_handle()
        .run_on_main_thread(move || {
            if let Some(wv) = win.get_webview(PANE_LABEL) {
                let _ = wv.set_bounds(pane_rect(x, y, width, height));
                let _ = wv.navigate(target);
                let _ = wv.show();
                let _ = wv.set_focus();
            } else if let Err(e) = win.add_child(
                WebviewBuilder::new(PANE_LABEL, WebviewUrl::External(target)),
                LogicalPosition::new(x, y),
                LogicalSize::new(width.max(1.0), height.max(1.0)),
            ) {
                eprintln!("browser_pane add_child failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_pane_set_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    with_pane(&app, move |wv| {
        let _ = wv.set_bounds(pane_rect(x, y, width, height));
    })
}

#[tauri::command]
pub async fn browser_pane_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = parse_url(&url)?;
    with_pane(&app, move |wv| {
        let _ = wv.navigate(target);
    })
}

#[tauri::command]
pub async fn browser_pane_back(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.eval("history.back()");
    })
}

#[tauri::command]
pub async fn browser_pane_forward(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.eval("history.forward()");
    })
}

#[tauri::command]
pub async fn browser_pane_reload(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.reload();
    })
}

#[tauri::command]
pub async fn browser_pane_show(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.show();
    })
}

#[tauri::command]
pub async fn browser_pane_hide(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.hide();
    })
}

#[tauri::command]
pub async fn browser_pane_close(app: tauri::AppHandle) -> Result<(), String> {
    with_pane(&app, |wv| {
        let _ = wv.close();
    })
}

/// Current URL of the embedded browser (to reflect link clicks in the URL bar).
/// Runs `url()` on the main thread and returns it via a channel.
#[tauri::command]
pub async fn browser_pane_url(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let a = app.clone();
    app.run_on_main_thread(move || {
        let url = a
            .get_webview(PANE_LABEL)
            .and_then(|wv| wv.url().ok())
            .map(|u| u.to_string());
        let _ = tx.send(url);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())
}
