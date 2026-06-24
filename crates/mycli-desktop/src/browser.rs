//! Phase C: MyCli owns a Chromium-based browser launched with a remote
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

/// Locate an installed Chromium-based browser. Chrome is preferred over Edge.
fn find_browser() -> Option<(String, String)> {
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
        candidates
            .into_iter()
            .find(|(_, p)| Path::new(p).exists())
    }
    #[cfg(target_os = "macos")]
    {
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
            if Path::new(p).exists() {
                return Some((label.to_string(), p.to_string()));
            }
        }
        None
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (label, exe) in [
            ("Chrome", "google-chrome"),
            ("Chrome", "google-chrome-stable"),
            ("Chromium", "chromium"),
            ("Chromium", "chromium-browser"),
            ("Edge", "microsoft-edge"),
        ] {
            if let Some(path) = which_unix(exe) {
                return Some((label.to_string(), path));
            }
        }
        None
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

    let (label, exe) = find_browser()
        .ok_or("Chrome/Edge를 찾을 수 없습니다. Chrome 또는 Edge를 설치하세요.")?;

    let profile = user_data_dir(port);
    std::fs::create_dir_all(&profile).map_err(|e| format!("프로필 디렉토리 생성 실패: {e}"))?;

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

    let child = cmd
        .spawn()
        .map_err(|e| format!("{label} 실행 실패: {e}"))?;

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

/// Find a `page` debugging target so the frontend can open its CDP WebSocket
/// for screencast + input. Done in Rust to dodge the WebView's CORS wall on
/// the CDP HTTP endpoint (the WebSocket itself is allowed via
/// `--remote-allow-origins=*`).
#[tauri::command]
pub fn browser_page_target(port: Option<u16>) -> Result<PageTarget, String> {
    let port = port.unwrap_or(9222);
    let body = cdp_http_get(port, "/json/list")?;
    let targets: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("CDP 응답 파싱 실패: {e}"))?;
    let arr = targets.as_array().ok_or("CDP 응답이 배열이 아닙니다")?;

    let page = arr
        .iter()
        .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .ok_or("페이지 타깃이 아직 없습니다 (브라우저 준비 중일 수 있음)")?;

    let ws_url = page
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or("webSocketDebuggerUrl 없음")?
        .to_string();

    Ok(PageTarget {
        ws_url,
        target_id: page
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        url: page
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Minimal dependency-free HTTP GET against the local CDP endpoint.
fn cdp_http_get(port: u16, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("CDP 연결 실패 (:{port}) — 브라우저가 실행 중인가요? {e}"))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
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
        .ok_or("HTTP 응답 형식 오류")?;
    Ok(resp[body_start..].to_string())
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
    let parsed: tauri::Url = normalized.parse().map_err(|e| format!("URL 파싱 실패: {e}"))?;
    // Only http/https into the embedded WebView — block file:/data:/about: etc.
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("허용되지 않은 URL 스킴입니다: {other} (http/https만 가능)")),
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
