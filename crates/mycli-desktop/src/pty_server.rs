//! Per-user PTY owner. The GUI is a short-lived client; this helper owns every
//! PTY from spawn and can outlive the window when the user explicitly consents.

use crate::terminal::{self, TerminalManager};
use serde_json::{Value, json};
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const SERVER_ARG: &str = "--mymux-pty-server";
#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\mymux-pty-server-v1";

/// A debug build started with `MYMUX_DEV_INSTANCE=<name>` gets its own PTY
/// server, lock and session file. Without it a test instance attaches to the
/// server of the installed app, and closing the test window shuts down the
/// sessions the user is working in. Release builds always return "".
pub(crate) fn instance_suffix() -> String {
    #[cfg(debug_assertions)]
    if let Ok(name) = std::env::var("MYMUX_DEV_INSTANCE") {
        let safe = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if safe {
            return format!("-{name}");
        }
    }
    String::new()
}

#[cfg(windows)]
fn pipe_name() -> String {
    format!("{PIPE_NAME}{}", instance_suffix())
}

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
    let message = json!({ "op": op, "payload": payload });
    // The server is almost always running, so ask it directly. Probing its
    // health first doubled the round trips of every read and every keystroke.
    let mut reply = exchange(&message);
    if reply.is_err() {
        ensure_server()?;
        for _ in 0..100 {
            reply = exchange(&message);
            if reply.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    let reply = reply.map_err(|_| "PTY background server did not become ready".to_string())?;
    reply
        .get("error")
        .and_then(Value::as_str)
        .map(|e| Err(e.to_string()))
        .unwrap_or(Ok(reply))
}

/// Start the server unless it answers. Reads run on worker threads and
/// keystrokes on the main thread, so two callers can find it missing together;
/// the lock keeps them from launching it twice.
fn ensure_server() -> Result<(), String> {
    static STARTING: Mutex<()> = Mutex::new(());
    let _guard = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if !server_responds() {
        launch_server()?;
    }
    Ok(())
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
        // One round trip for every pane the window is polling. A pane that
        // fails (closed meanwhile) reports its own error and does not fail the
        // others.
        "readMany" => {
            let reads = p
                .get("reads")
                .and_then(Value::as_array)
                .ok_or("missing reads")?;
            let replies: Vec<Value> = reads
                .iter()
                .map(|read| {
                    let Some(id) = read.get("id").and_then(Value::as_u64) else {
                        return json!({ "error": "missing id" });
                    };
                    let offset = read.get("offset").and_then(Value::as_u64).unwrap_or(0);
                    let max_bytes = read
                        .get("maxBytes")
                        .and_then(Value::as_u64)
                        .map(|n| n.min(terminal::OUTPUT_READ_BATCH_MAX_BYTES as u64) as usize);
                    match terminal::read_local_limited(manager, id as u32, offset, max_bytes) {
                        Ok(r) => json!({
                            "id": id, "data": r.chunks, "next": r.next,
                            "exited": r.exited, "truncated": r.truncated,
                        }),
                        Err(error) => json!({ "id": id, "error": error }),
                    }
                })
                .collect();
            Ok(json!({ "replies": replies }))
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
    Ok(dir.join(format!("mymux-pty-v1{}.sock", instance_suffix())))
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

/// Connect to the server, waiting while every pipe instance is taken.
///
/// The server keeps a single instance listening and makes the next one only
/// after accepting a client, so a second caller arriving in that gap gets
/// ERROR_PIPE_BUSY. Treating that as a failure dropped or delayed keystrokes
/// whenever a read was in flight. Nothing has been sent yet, so waiting is safe.
#[cfg(windows)]
fn open_pipe(name: &str) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    const ERROR_PIPE_BUSY: i32 = 231;

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let wide: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    loop {
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            // Never let the server impersonate this process.
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(name);
        match opened {
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                // Returns as soon as an instance is listening again. Another
                // waiter may take it first; the loop then waits once more.
                unsafe { WaitNamedPipeW(wide.as_ptr(), 50) };
            }
            result => return result,
        }
    }
}

#[cfg(windows)]
fn exchange(value: &Value) -> Result<Value, String> {
    use std::io::{BufRead, BufReader, Write};

    // A plain blocking pipe on the calling thread. The previous client spawned
    // and joined an OS thread, with an async runtime inside, for every read and
    // every keystroke.
    let mut stream = open_pipe(&pipe_name()).map_err(|e| e.to_string())?;
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = Vec::new();
    BufReader::new(stream)
        .read_until(b'\n', &mut line)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&line).map_err(|e| e.to_string())
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
        .open(dir.join(format!("mymux-pty-v1{}.lock", instance_suffix())))
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
                .create(pipe_name())
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

#[cfg(test)]
mod read_many_tests {
    use super::dispatch;
    use crate::terminal::TerminalManager;
    use serde_json::json;
    use std::sync::Arc;

    /// One closed pane must not hide the output of the others in the batch.
    #[test]
    fn a_missing_pane_reports_its_own_error() {
        let manager = Arc::new(TerminalManager::new());
        let reply = dispatch(
            &manager,
            &json!({ "op": "readMany", "payload": { "reads": [{ "id": 7, "offset": 0 }, { "offset": 3 }] } }),
        );
        let replies = reply["replies"].as_array().expect("replies");
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["id"], 7);
        assert_eq!(replies[0]["error"], "Session not found");
        assert_eq!(replies[1]["error"], "missing id");
        assert!(reply.get("error").is_none(), "the batch itself succeeds");
    }

    #[test]
    fn a_batch_without_reads_is_rejected() {
        let manager = Arc::new(TerminalManager::new());
        let reply = dispatch(&manager, &json!({ "op": "readMany", "payload": {} }));
        assert_eq!(reply["error"], "missing reads");
    }
}

#[cfg(all(test, windows))]
mod pipe_tests {
    use super::open_pipe;
    use std::io::{BufRead, BufReader, Write};
    use std::time::{Duration, Instant};
    use tokio::net::windows::named_pipe::ServerOptions;

    /// The server keeps one waiting instance. A client that arrives while that
    /// instance is taken gets ERROR_PIPE_BUSY; it has to wait for the next one
    /// instead of failing, or a keystroke sent during a read is lost.
    #[test]
    fn open_waits_for_a_busy_pipe_instead_of_failing() {
        let name = format!(r"\\.\pipe\mymux-busy-test-{}", std::process::id());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let first = runtime.block_on(async {
            ServerOptions::new().first_pipe_instance(true).create(&name).unwrap()
        });
        // Takes the only instance: from here on the pipe is busy.
        let _taken = open_pipe(&name).expect("first client connects");
        runtime.block_on(async { first.connect().await.unwrap() });

        let late_name = name.clone();
        let late_server = runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            let server = ServerOptions::new().create(&late_name).unwrap();
            server.connect().await.unwrap();
            server
        });

        let started = Instant::now();
        let client = open_pipe(&name);
        assert!(client.is_ok(), "a busy pipe must be waited out: {:?}", client.err());
        assert!(started.elapsed() >= Duration::from_millis(80), "it cannot connect before an instance exists");
        runtime.block_on(late_server).unwrap();
    }

    /// The blocking client speaks the same line protocol as the async server.
    #[test]
    fn blocking_client_round_trips_with_the_async_server() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let name = format!(r"\\.\pipe\mymux-roundtrip-test-{}", std::process::id());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let server = runtime.block_on(async { ServerOptions::new().create(&name).unwrap() });
        let serving = runtime.spawn(async move {
            server.connect().await.unwrap();
            let (reader, mut writer) = tokio::io::split(server);
            let mut line = String::new();
            tokio::io::BufReader::new(reader).read_line(&mut line).await.unwrap();
            writer.write_all(format!("echo:{line}").as_bytes()).await.unwrap();
        });
        let mut client = open_pipe(&name).unwrap();
        client.write_all("안녕\n".as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(client).read_line(&mut reply).unwrap();
        assert_eq!(reply, "echo:안녕\n");
        runtime.block_on(serving).unwrap();
    }
}

/// End to end against a real server process: `cargo build` first, then
/// `cargo test -p mycli-desktop real_server -- --ignored --nocapture`.
/// The server runs under its own instance name, so the installed app's PTY
/// server and its sessions are never touched.
#[cfg(all(test, windows, debug_assertions))]
mod real_server_tests {
    use super::{exchange, request};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn server_exe() -> std::path::PathBuf {
        // target/debug/deps/Mymux-<hash>.exe -> target/debug/Mymux.exe
        let test_exe = std::env::current_exe().unwrap();
        test_exe.parent().unwrap().parent().unwrap().join("Mymux.exe")
    }

    /// Keystrokes go out while four readers poll in parallel, the way the main
    /// thread writes while worker threads read. The server offers one pipe
    /// instance at a time, so the callers collide constantly; every write must
    /// still arrive, once and in order.
    #[test]
    #[ignore = "needs target/debug/Mymux.exe; starts a real PTY server and shell"]
    fn every_keystroke_arrives_while_readers_poll_in_parallel() {
        let instance = format!("itest{}", std::process::id());
        // SAFETY: the only test in this binary that touches the variable, and it
        // is run alone (--ignored with a filter).
        unsafe { std::env::set_var("MYMUX_DEV_INSTANCE", &instance) };
        let mut server = std::process::Command::new(server_exe())
            .arg(super::SERVER_ARG)
            .env("MYMUX_DEV_INSTANCE", &instance)
            .spawn()
            .expect("start the built Mymux.exe as a PTY server");
        let deadline = Instant::now() + Duration::from_secs(10);
        while exchange(&json!({ "op": "health" })).is_err() {
            assert!(Instant::now() < deadline, "server did not come up");
            std::thread::sleep(Duration::from_millis(50));
        }

        let result = std::panic::catch_unwind(|| {
            let spawned = request(
                "spawn",
                json!({ "sessionKey": "itest", "shell": "cmd", "cols": 120, "rows": 30 }),
            )
            .expect("spawn");
            let id = spawned["id"].as_u64().expect("id");

            let stop = Arc::new(AtomicBool::new(false));
            let reads = Arc::new(AtomicUsize::new(0));
            let read_errors = Arc::new(AtomicUsize::new(0));
            let readers: Vec<_> = (0..4)
                .map(|_| {
                    let (stop, reads, read_errors) = (stop.clone(), reads.clone(), read_errors.clone());
                    std::thread::spawn(move || {
                        while !stop.load(Ordering::Relaxed) {
                            match request("readMany", json!({ "reads": [{ "id": id, "offset": 0, "maxBytes": 1024 }] })) {
                                Ok(_) => reads.fetch_add(1, Ordering::Relaxed),
                                Err(_) => read_errors.fetch_add(1, Ordering::Relaxed),
                            };
                        }
                    })
                })
                .collect();

            std::thread::sleep(Duration::from_millis(800)); // let cmd print its banner
            let lines = 120;
            let mut slowest = Duration::ZERO;
            let started = Instant::now();
            for n in 0..lines {
                let at = Instant::now();
                request("write", json!({ "id": id, "data": format!("echo K{n:04}\r") })).expect("write");
                slowest = slowest.max(at.elapsed());
            }
            let write_time = started.elapsed();
            std::thread::sleep(Duration::from_millis(2500));
            stop.store(true, Ordering::Relaxed);
            for reader in readers {
                reader.join().unwrap();
            }

            // Collect everything the shell printed.
            let mut output = String::new();
            let mut offset = 0u64;
            loop {
                let reply = request("readMany", json!({ "reads": [{ "id": id, "offset": offset }] })).expect("final read");
                let pane = &reply["replies"][0];
                let chunks: Vec<String> = serde_json::from_value(pane["data"].clone()).unwrap();
                if chunks.is_empty() {
                    break;
                }
                output.push_str(&chunks.concat());
                offset = pane["next"].as_u64().unwrap();
            }
            // ConPTY shows each command three times: the typed line, the window
            // title, and the result, which follows the title's terminator.
            let mut last_position = 0;
            for n in 0..lines {
                let result_line = format!("\x1b\\K{n:04}\r\n");
                let found = output[last_position..].find(&result_line);
                assert!(found.is_some(), "line {n} is missing or out of order");
                last_position += found.unwrap();
                assert_eq!(
                    output.matches(&result_line).count(),
                    1,
                    "line {n} was executed more than once"
                );
                assert_eq!(
                    output.matches(&format!("echo K{n:04}\x1b[")).count(),
                    1,
                    "the keystrokes of line {n} were not typed exactly once"
                );
            }
            println!(
                "{lines} writes in {write_time:?} (slowest {slowest:?}) while 4 readers made {} reads, {} read errors",
                reads.load(Ordering::Relaxed),
                read_errors.load(Ordering::Relaxed)
            );
            assert_eq!(read_errors.load(Ordering::Relaxed), 0, "a read failed instead of waiting");
            assert!(slowest < Duration::from_millis(500), "a keystroke waited {slowest:?}");

            let unknown = request("noSuchOperation", json!({})).unwrap_err();
            assert!(unknown.starts_with("unknown PTY server operation"), "{unknown}");
        });

        let _ = request("shutdown", json!({}));
        std::thread::sleep(Duration::from_millis(300));
        let _ = server.kill();
        let _ = server.wait();
        if let Some(home) = dirs::home_dir() {
            let _ = std::fs::remove_file(home.join(".mycli").join(format!("mymux-pty-v1-{instance}.lock")));
        }
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
