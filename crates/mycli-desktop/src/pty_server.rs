//! Per-user PTY owner. The GUI is a short-lived client; this helper owns every
//! PTY from spawn and can outlive the window when the user explicitly consents.

use crate::terminal::{self, TerminalManager};
use serde_json::{Value, json};
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const SERVER_ARG: &str = "--mymux-pty-server";
const PIPE_NAME: &str = r"\\.\pipe\mymux-pty-server-v1";

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
    if !server_responds() {
        launch_server()?;
    }
    for _ in 0..100 {
        if let Ok(reply) = exchange(&json!({ "op": op, "payload": payload })) {
            return reply
                .get("error")
                .and_then(Value::as_str)
                .map(|e| Err(e.to_string()))
                .unwrap_or(Ok(reply));
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
    command
        .arg(SERVER_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
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
    command
        .spawn()
        .map_err(|e| format!("start PTY background server: {e}"))?;
    Ok(())
}

pub(crate) fn dispatch(manager: &Arc<TerminalManager>, request: &Value) -> Value {
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let p = request.get("payload").cloned().unwrap_or(Value::Null);
    let result: Result<Value, String> = (|| match op {
        "health" => Ok(json!({ "ok": true })),
        "mobileGatewayStart" => {
            let port = parse_mobile_gateway_port(p.get("port"))?;
            crate::mobile_gateway::start(Arc::clone(manager), port)
        }
        "mobileGatewayStop" => Ok(crate::mobile_gateway::stop()),
        "mobileGatewayStatus" => Ok(crate::mobile_gateway::status()),
        "mobileGatewayApprove" => crate::mobile_gateway::approve(
            &required_string(&p, "publicKey")?,
            &required_string(&p, "name")?,
        )
        .map(|_| json!({})),
        "mobileGatewayRevoke" => {
            crate::mobile_gateway::revoke(&required_string(&p, "publicKey")?).map(|_| json!({}))
        }
        // Metadata-only discovery; this operation never exposes terminal output.
        "list" => Ok(json!({ "sessions": terminal::list_local(manager) })),
        // Mobile operations are also called by the LAN gateway only after its
        // Noise handshake and paired-device authorization have succeeded.
        "mobileList" => Ok(json!({ "sessions": terminal::list_mobile(manager) })),
        "mobileAgentsUpdate" => {
            let id = required_id(&p)?;
            let agents = parse_mobile_agents(p.get("agents").cloned().unwrap_or(Value::Null))?;
            terminal::update_mobile_agents(manager, id, agents)?;
            Ok(json!({}))
        }
        "spawn" => {
            let key = required_string(&p, "sessionKey")?;
            let existing_id = { manager.session_keys.lock().unwrap().get(&key).copied() };
            if let Some(id) = existing_id {
                terminal::resize_local(
                    manager,
                    id,
                    p.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16,
                    p.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16,
                )?;
                let label = p.get("label").and_then(Value::as_str).unwrap_or("Terminal");
                manager
                    .session_labels
                    .lock()
                    .unwrap()
                    .insert(id, safe_session_label(label));
                let mobile_id = terminal::ensure_mobile_session_id(manager, id);
                return Ok(json!({ "id": id, "mobileId": mobile_id, "attached": true }));
            }
            let shell = p.get("shell").and_then(Value::as_str).map(str::to_owned);
            let args = p.get("args").and_then(Value::as_array).map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
            let cwd = p.get("cwd").and_then(Value::as_str).map(str::to_owned);
            let cols = p.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = p.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
            let id = terminal::spawn_local(manager, shell, args, cwd, cols, rows)?;
            manager.session_keys.lock().unwrap().insert(key, id);
            let label = p.get("label").and_then(Value::as_str).unwrap_or("Terminal");
            manager
                .session_labels
                .lock()
                .unwrap()
                .insert(id, safe_session_label(label));
            let mobile_id = terminal::ensure_mobile_session_id(manager, id);
            Ok(json!({ "id": id, "mobileId": mobile_id, "attached": false }))
        }
        "read" => {
            let id = required_id(&p)?;
            // Missing offsets read from the oldest retained byte. An optional
            // byte cap keeps polling responses bounded for mobile transports.
            let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let max_bytes = p
                .get("maxBytes")
                .and_then(Value::as_u64)
                .map(|n| n.min(terminal::OUTPUT_READ_BATCH_MAX_BYTES as u64) as usize);
            let r = terminal::read_local_limited(manager, id, offset, max_bytes)?;
            Ok(
                json!({ "data": r.chunks, "next": r.next, "exited": r.exited, "truncated": r.truncated }),
            )
        }
        "mobileRead" => {
            let id = required_mobile_id(manager, &p)?;
            let offset = match p.get("offset") {
                Some(value) => value.as_u64().ok_or("invalid output offset")?,
                None => 0,
            };
            let max_bytes = match p.get("maxBytes") {
                Some(value) => value.as_u64().ok_or("invalid output batch size")?,
                None => terminal::OUTPUT_READ_BATCH_MAX_BYTES as u64,
            }
            .clamp(4, terminal::OUTPUT_READ_BATCH_MAX_BYTES as u64)
                as usize;
            let r = terminal::read_local_limited(manager, id, offset, Some(max_bytes))?;
            Ok(
                json!({ "chunks": r.chunks, "next": r.next, "exited": r.exited, "truncated": r.truncated }),
            )
        }
        "mobileWrite" => {
            let id = required_mobile_id(manager, &p)?;
            let data = required_string(&p, "data")?;
            if data.len() > 16 * 1024 {
                return Err("input batch is too large".into());
            }
            terminal::write_local(manager, id, data)?;
            Ok(json!({}))
        }
        "mobileResize" => {
            let id = required_mobile_id(manager, &p)?;
            let cols = p.get("cols").and_then(Value::as_u64).unwrap_or(0);
            let rows = p.get("rows").and_then(Value::as_u64).unwrap_or(0);
            if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
                return Err("terminal dimensions are out of range".into());
            }
            terminal::resize_local(manager, id, cols as u16, rows as u16)?;
            Ok(json!({}))
        }
        "mobileClose" => {
            let id = required_mobile_id(manager, &p)?;
            terminal::close_local(manager, id)?;
            Ok(json!({}))
        }
        "write" => {
            terminal::write_local(manager, required_id(&p)?, required_string(&p, "data")?)?;
            Ok(json!({}))
        }
        "resize" => {
            terminal::resize_local(
                manager,
                required_id(&p)?,
                p["cols"].as_u64().unwrap_or(80) as u16,
                p["rows"].as_u64().unwrap_or(24) as u16,
            )?;
            Ok(json!({}))
        }
        "close" => {
            terminal::close_local(manager, required_id(&p)?)?;
            Ok(json!({}))
        }
        "aiProcess" => {
            Ok(json!({ "process": terminal::ai_process_local(manager, required_id(&p)?)? }))
        }
        "handoff" => {
            let keys: Vec<String> = p
                .get("sessionKeys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let ids: std::collections::HashSet<u32> = {
                let map = manager.session_keys.lock().unwrap();
                keys.iter()
                    .filter_map(|key| map.get(key).copied())
                    .collect()
            };
            let all: Vec<u32> = manager.sessions.lock().unwrap().keys().copied().collect();
            for id in all {
                if !ids.contains(&id) {
                    terminal::close_local(manager, id)?;
                }
            }
            let live_keys: Vec<String> = keys
                .into_iter()
                .filter(|key| manager.session_keys.lock().unwrap().contains_key(key))
                .collect();
            *manager.background_keys.lock().unwrap() = live_keys.iter().cloned().collect();
            Ok(json!({ "kept": live_keys, "shutdown": live_keys.is_empty() }))
        }
        "shutdown" => {
            let ids: Vec<u32> = manager.sessions.lock().unwrap().keys().copied().collect();
            for id in ids {
                terminal::close_local(manager, id)?;
            }
            *manager.background_keys.lock().unwrap() = Default::default();
            Ok(json!({ "shutdown": true }))
        }
        _ => Err(format!("unknown PTY server operation: {op}")),
    })();
    result.unwrap_or_else(|error| json!({ "error": error }))
}

fn parse_mobile_gateway_port(value: Option<&Value>) -> Result<Option<u16>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .map(Some)
            .ok_or_else(|| "mobile gateway port is invalid".into()),
    }
}

#[cfg(test)]
mod mobile_gateway_port_tests {
    use super::parse_mobile_gateway_port;
    use serde_json::json;

    #[test]
    fn gateway_port_rejects_values_that_would_wrap_when_cast() {
        assert_eq!(parse_mobile_gateway_port(None).unwrap(), None);
        assert_eq!(
            parse_mobile_gateway_port(Some(&json!(49152))).unwrap(),
            Some(49152)
        );
        assert!(parse_mobile_gateway_port(Some(&json!(114688))).is_err());
        assert!(parse_mobile_gateway_port(Some(&json!("49152"))).is_err());
    }
}

fn safe_session_label(input: &str) -> String {
    let label: String = input.chars().filter(|c| !c.is_control()).take(64).collect();
    let label = label.trim();
    if label.is_empty() {
        "Terminal".into()
    } else {
        label.to_owned()
    }
}

fn parse_mobile_agents(value: Value) -> Result<Vec<terminal::MobileAgentSnapshot>, String> {
    let agents: Vec<terminal::MobileAgentSnapshot> =
        serde_json::from_value(value).map_err(|_| "invalid mobile agents payload".to_string())?;
    if agents.len() > 60 {
        return Err("too many mobile agents".into());
    }
    let mut ids = std::collections::HashSet::new();
    for agent in &agents {
        if agent.id.is_empty()
            || agent.id.len() > 96
            || !agent
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            || agent.name.trim().is_empty()
            || agent.name.chars().count() > 80
            || agent.description.chars().count() > 256
            || agent
                .name
                .chars()
                .chain(agent.description.chars())
                .any(char::is_control)
            || !matches!(
                agent.status.as_str(),
                "running" | "done" | "failed" | "cancelled" | "ended"
            )
            || !ids.insert(agent.id.as_str())
        {
            return Err("invalid mobile agent entry".into());
        }
    }
    Ok(agents)
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key}"))
}
fn required_id(value: &Value) -> Result<u32, String> {
    value
        .get("id")
        .and_then(Value::as_u64)
        .map(|id| id as u32)
        .ok_or_else(|| "missing id".into())
}

fn required_mobile_id(manager: &TerminalManager, value: &Value) -> Result<u32, String> {
    let id = required_string(value, "sessionId")?;
    if id.len() != 36
        || uuid::Uuid::parse_str(&id)
            .map(|parsed| parsed.to_string() != id)
            .unwrap_or(true)
    {
        return Err("invalid mobile session ID".into());
    }
    terminal::resolve_mobile_session_id(manager, &id)
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
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut stream, value).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn run_unix_server() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    let Ok(path) = socket_path() else { return };
    if path.exists() {
        if UnixStreamProbe::connect(&path) {
            return;
        }
        let _ = std::fs::remove_file(&path);
    }
    let Ok(listener) = UnixListener::bind(&path) else {
        return;
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = listener.set_nonblocking(false);
    let manager = Arc::new(TerminalManager::new());
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let mut line = String::new();
        let response = match BufReader::new(&stream).read_line(&mut line) {
            Ok(_) => dispatch(
                &manager,
                &serde_json::from_str(&line).unwrap_or(Value::Null),
            ),
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    // Tauri may dispatch a synchronous command from a Tokio worker. Keep the
    // named-pipe runtime on a dedicated thread so block_on never nests inside
    // the app's runtime.
    let value = value.clone();
    std::thread::spawn(move || {
        let runtime = RUNTIME.get_or_init(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
                .unwrap()
        });
        runtime.block_on(async move {
            let mut stream = ClientOptions::new()
                .open(PIPE_NAME)
                .map_err(|e| e.to_string())?;
            let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
            let mut line = Vec::new();
            tokio::io::BufReader::new(stream)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::from_slice(&line).map_err(|e| e.to_string())
        })
    })
    .join()
    .map_err(|_| "PTY named-pipe client thread panicked".to_string())?
}

#[cfg(windows)]
fn run_windows_server() {
    use fs2::FileExt;
    use tokio::net::windows::named_pipe::ServerOptions;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".mycli");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(lock) = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(dir.join("mymux-pty-v1.lock"))
    else {
        return;
    };
    if lock.try_lock_exclusive().is_err() {
        return;
    }
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap()
    });
    let manager = Arc::new(TerminalManager::new());
    runtime.block_on(async {
        loop {
            let server = match ServerOptions::new()
                .first_pipe_instance(false)
                .create(PIPE_NAME)
            {
                Ok(s) => s,
                Err(_) => break,
            };
            if server.connect().await.is_err() {
                continue;
            }
            let manager = Arc::clone(&manager);
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                let (reader, mut writer) = tokio::io::split(server);
                let mut reader = tokio::io::BufReader::new(reader);
                let mut line = String::new();
                if reader.read_line(&mut line).await.is_ok() {
                    let response = dispatch(
                        &manager,
                        &serde_json::from_str(&line).unwrap_or(Value::Null),
                    );
                    let shutdown = response.get("shutdown").and_then(Value::as_bool) == Some(true);
                    let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                    bytes.push(b'\n');
                    let _ = writer.write_all(&bytes).await;
                    if shutdown {
                        std::process::exit(0);
                    }
                }
            });
        }
    });
}
