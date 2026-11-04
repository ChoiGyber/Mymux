//! Per-user PTY owner. The GUI is a short-lived client; this helper owns every
//! PTY from spawn and can outlive the window when the user explicitly consents.

use crate::terminal::{self, TerminalManager};
use serde_json::{json, Value};
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const SERVER_ARG: &str = "--mymux-pty-server";
const PIPE_NAME: &str = r"\\.\pipe\mymux-pty-server-v1";
static SERVER_READY: AtomicBool = AtomicBool::new(false);
static SERVER_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn is_server_invocation() -> bool {
    std::env::args().any(|arg| arg == SERVER_ARG)
}

pub fn run_server() {
    #[cfg(unix)]
    run_unix_server();
    #[cfg(windows)]
    run_windows_server();
}

/// Launch or reuse the same-executable helper. The socket/pipe is per-user,
/// and Unix permissions are restricted to the current account.
pub fn request(op: &str, payload: Value) -> Result<Value, String> {
    let request = json!({ "op": op, "payload": payload });
    for attempt in 0..2 {
        ensure_server()?;
        match exchange(&request) {
            Ok(reply) => {
                return reply
                    .get("error")
                    .and_then(Value::as_str)
                    .map(|e| Err(e.to_string()))
                    .unwrap_or(Ok(reply));
            }
            Err(_) if attempt == 0 => {
                // The helper may have exited after the cached readiness check.
                // Recheck/relaunch once, then retry this request.
                SERVER_READY.store(false, Ordering::Release);
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(format!("PTY server request failed: {error}")),
        }
    }
    unreachable!("request loop returns on success or final error")
}

fn ensure_server() -> Result<(), String> {
    if SERVER_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let _guard = SERVER_START_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if SERVER_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    if server_responds() {
        SERVER_READY.store(true, Ordering::Release);
        return Ok(());
    }
    launch_server()?;
    for _ in 0..100 {
        if server_responds() {
            SERVER_READY.store(true, Ordering::Release);
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err("PTY background server did not become ready".into())
}

fn server_responds() -> bool {
    exchange(&json!({ "op": "health" })).is_ok()
}

fn launch_server() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(exe);
    command.arg(SERVER_ARG).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map_err(|e| format!("start PTY background server: {e}"))?;
    Ok(())
}

fn dispatch(manager: &Arc<TerminalManager>, request: Value) -> Value {
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let p = request.get("payload").cloned().unwrap_or(Value::Null);
    let result: Result<Value, String> = (|| match op {
        "health" => Ok(json!({ "ok": true })),
        "spawn" => {
            let key = required_string(&p, "sessionKey")?;
            if let Some(id) = manager.session_keys.lock().unwrap().get(&key).copied() {
                terminal::resize_local(manager, id, p.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16, p.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16)?;
                return Ok(json!({ "id": id, "attached": true }));
            }
            let shell = p.get("shell").and_then(Value::as_str).map(str::to_owned);
            let args = p.get("args").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).collect());
            let cwd = p.get("cwd").and_then(Value::as_str).map(str::to_owned);
            let cols = p.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = p.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
            let id = terminal::spawn_local(manager, shell, args, cwd, cols, rows)?;
            manager.session_keys.lock().unwrap().insert(key, id);
            Ok(json!({ "id": id, "attached": false }))
        }
        "read" => {
            let id = required_id(&p)?;
            let (data, exited) = terminal::read_local(manager, id)?;
            Ok(json!({ "data": data, "exited": exited }))
        }
        "write" => { terminal::write_local(manager, required_id(&p)?, required_string(&p, "data")?)?; Ok(json!({})) }
        "resize" => { terminal::resize_local(manager, required_id(&p)?, p["cols"].as_u64().unwrap_or(80) as u16, p["rows"].as_u64().unwrap_or(24) as u16)?; Ok(json!({})) }
        "close" => { terminal::close_local(manager, required_id(&p)?)?; Ok(json!({})) }
        "aiProcess" => Ok(json!({ "process": terminal::ai_process_local(manager, required_id(&p)?)? })),
        "handoff" => {
            let keys: Vec<String> = p.get("sessionKeys").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            let ids: std::collections::HashSet<u32> = {
                let map = manager.session_keys.lock().unwrap();
                keys.iter().filter_map(|key| map.get(key).copied()).collect()
            };
            let all: Vec<u32> = manager.sessions.lock().unwrap().keys().copied().collect();
            for id in all { if !ids.contains(&id) { terminal::close_local(manager, id)?; } }
            let live_keys: Vec<String> = keys.into_iter().filter(|key| manager.session_keys.lock().unwrap().contains_key(key)).collect();
            *manager.background_keys.lock().unwrap() = live_keys.iter().cloned().collect();
            Ok(json!({ "kept": live_keys, "shutdown": live_keys.is_empty() }))
        }
        "shutdown" => {
            let ids: Vec<u32> = manager.sessions.lock().unwrap().keys().copied().collect();
            for id in ids { terminal::close_local(manager, id)?; }
            *manager.background_keys.lock().unwrap() = Default::default();
            Ok(json!({ "shutdown": true }))
        }
        _ => Err(format!("unknown PTY server operation: {op}")),
    })();
    result.unwrap_or_else(|error| json!({ "error": error }))
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("missing {key}"))
}
fn required_id(value: &Value) -> Result<u32, String> {
    value.get("id").and_then(Value::as_u64).map(|id| id as u32).ok_or_else(|| "missing id".into())
}

#[cfg(unix)]
fn socket_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("home directory not found")?;
    let dir = home.join(".mycli");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mymux-pty-v1.sock"))
}

#[cfg(unix)]
fn exchange(value: &Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path()?).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut stream, value).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn run_unix_server() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    let Ok(path) = socket_path() else { return };
    if path.exists() {
        if UnixStreamProbe::connect(&path) { return; }
        let _ = std::fs::remove_file(&path);
    }
    let Ok(listener) = UnixListener::bind(&path) else { return };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = listener.set_nonblocking(false);
    let manager = Arc::new(TerminalManager::new());
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let mut line = String::new();
        let response = match BufReader::new(&stream).read_line(&mut line) {
            Ok(_) => dispatch(&manager, serde_json::from_str(&line).unwrap_or(Value::Null)),
            Err(e) => json!({ "error": e.to_string() }),
        };
        let _ = serde_json::to_writer(&mut stream, &response);
        let _ = stream.write_all(b"\n");
        if response.get("shutdown").and_then(Value::as_bool) == Some(true) {
            break;
        }
    }
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
struct UnixStreamProbe;
#[cfg(unix)]
impl UnixStreamProbe {
    fn connect(path: &std::path::Path) -> bool {
        use std::os::unix::net::UnixStream;
        UnixStream::connect(path).is_ok()
    }
}

#[cfg(windows)]
fn exchange(value: &Value) -> Result<Value, String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    // Tauri may dispatch a synchronous command from a Tokio worker. Keep the
    // named-pipe runtime on a dedicated thread so block_on never nests inside
    // the app's runtime.
    let value = value.clone();
    std::thread::spawn(move || {
        let runtime = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap());
        runtime.block_on(async move {
            let mut stream = ClientOptions::new().open(PIPE_NAME).map_err(|e| e.to_string())?;
            let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
            let mut line = Vec::new();
            tokio::io::BufReader::new(stream).read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            serde_json::from_slice(&line).map_err(|e| e.to_string())
        })
    }).join().map_err(|_| "PTY named-pipe client thread panicked".to_string())?
}

#[cfg(windows)]
fn run_windows_server() {
    use tokio::net::windows::named_pipe::ServerOptions;
    use fs2::FileExt;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".mycli");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let Ok(lock) = std::fs::OpenOptions::new().create(true).read(true).write(true).open(dir.join("mymux-pty-v1.lock")) else { return };
    if lock.try_lock_exclusive().is_err() { return; }
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap());
    let manager = Arc::new(TerminalManager::new());
    runtime.block_on(async {
        loop {
            let server = match ServerOptions::new().first_pipe_instance(false).create(PIPE_NAME) { Ok(s) => s, Err(_) => break };
            if server.connect().await.is_err() { continue; }
            let manager = Arc::clone(&manager);
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                let (reader, mut writer) = tokio::io::split(server);
                let mut reader = tokio::io::BufReader::new(reader);
                let mut line = String::new();
                if reader.read_line(&mut line).await.is_ok() {
                    let response = dispatch(&manager, serde_json::from_str(&line).unwrap_or(Value::Null));
                    let shutdown = response.get("shutdown").and_then(Value::as_bool) == Some(true);
                    let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                    bytes.push(b'\n');
                    let _ = writer.write_all(&bytes).await;
                    if shutdown { std::process::exit(0); }
                }
            });
        }
    });
}

