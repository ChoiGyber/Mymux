//! Noise protected LAN WebSocket gateway for already approved mobile devices.
//! PTY ownership stays in the helper process; the gateway only forwards the
//! narrow mobile RPC operations to that process's in-memory PTY manager.

use crate::{pty_server, terminal::TerminalManager};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use snow::Builder;
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Semaphore};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{Request, Response},
        protocol::WebSocketConfig,
        Message,
    },
};

const NOISE_NAME: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
const DEFAULT_PORT: u16 = 49152;
const MAX_NOISE_MESSAGE: usize = 65_535;
const MAX_RPC_PLAINTEXT: usize = 60 * 1024;
const MAX_INPUT: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 8;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const IDENTITY_FILE: &str = "mobile-gateway-v1.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedDevice {
    public_key: String,
    name: String,
    approved_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayIdentity {
    server_private_key: String,
    server_public_key: String,
    #[serde(default)]
    devices: Vec<ApprovedDevice>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDevice {
    public_key: String,
    first_seen: u64,
}

struct GatewayState {
    identity: Mutex<GatewayIdentity>,
    pending: Mutex<HashMap<String, PendingDevice>>,
    pairing_ticket: Mutex<Option<PairingTicket>>,
    path: PathBuf,
}

#[derive(Clone)]
struct PairingTicket {
    nonce: String,
    expires_at: u64,
}

struct GatewayController {
    // Keep start/stop transitions atomic. In particular, a stop must not run
    // between binding the socket and publishing the thread handle.
    transition: Mutex<()>,
    state: Mutex<Option<Arc<GatewayState>>>,
    stop: Mutex<Option<watch::Sender<bool>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    bound: Mutex<Option<(String, u16)>>,
}

static CONTROLLER: OnceLock<GatewayController> = OnceLock::new();

#[tauri::command]
pub fn mobile_gateway_start(port: Option<u16>) -> Result<Value, String> {
    pty_server::request("mobileGatewayStart", json!({ "port": port }))
}

#[tauri::command]
pub fn mobile_gateway_stop() -> Result<Value, String> {
    pty_server::request("mobileGatewayStop", json!({}))
}

#[tauri::command]
pub fn mobile_gateway_status() -> Result<Value, String> {
    pty_server::request("mobileGatewayStatus", json!({}))
}

#[tauri::command]
pub fn mobile_gateway_approve(public_key: String, name: String) -> Result<(), String> {
    pty_server::request(
        "mobileGatewayApprove",
        json!({ "publicKey": public_key, "name": name }),
    )?;
    Ok(())
}

#[tauri::command]
pub fn mobile_gateway_revoke(public_key: String) -> Result<(), String> {
    pty_server::request("mobileGatewayRevoke", json!({ "publicKey": public_key }))?;
    Ok(())
}

fn controller() -> &'static GatewayController {
    CONTROLLER.get_or_init(|| GatewayController {
        transition: Mutex::new(()),
        state: Mutex::new(None),
        stop: Mutex::new(None),
        thread: Mutex::new(None),
        bound: Mutex::new(None),
    })
}

fn identity_path() -> Result<PathBuf, String> {
    let root = dirs::config_dir()
        .or_else(dirs::home_dir)
        .ok_or("user config directory is unavailable")?;
    let dir = root.join("Mymux");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create mobile gateway directory: {e}"))?;
    Ok(dir.join(IDENTITY_FILE))
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn load_or_create_identity(path: &PathBuf) -> Result<GatewayIdentity, String> {
    if path.exists() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("read mobile gateway identity: {e}"))?;
        let identity: GatewayIdentity = serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse mobile gateway identity: {e}"))?;
        let private = URL_SAFE_NO_PAD
            .decode(&identity.server_private_key)
            .map_err(|_| "invalid stored mobile server key")?;
        let public = URL_SAFE_NO_PAD
            .decode(&identity.server_public_key)
            .map_err(|_| "invalid stored mobile public key")?;
        if private.len() != 32 || public.len() != 32 {
            return Err("stored mobile gateway key has an invalid size".into());
        }
        return Ok(identity);
    }
    let params = NOISE_NAME
        .parse()
        .map_err(|_| "unsupported Noise protocol".to_string())?;
    let keypair = Builder::new(params)
        .generate_keypair()
        .map_err(|e| format!("generate mobile server key: {e}"))?;
    let identity = GatewayIdentity {
        server_private_key: URL_SAFE_NO_PAD.encode(keypair.private),
        server_public_key: URL_SAFE_NO_PAD.encode(keypair.public),
        devices: Vec::new(),
    };
    persist_identity(path, &identity)?;
    Ok(identity)
}

fn persist_identity(path: &PathBuf, identity: &GatewayIdentity) -> Result<(), String> {
    let bytes = serde_json::to_vec(identity).map_err(|e| e.to_string())?;
    let temp = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mobile-gateway"),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("create mobile gateway identity: {e}"))?;
    use std::io::Write;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write mobile gateway identity: {error}"));
    }
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let moved = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            let error = std::io::Error::last_os_error();
            let _ = std::fs::remove_file(&temp);
            return Err(format!("replace mobile gateway identity: {error}"));
        }
    }
    #[cfg(not(windows))]
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("replace mobile gateway identity: {error}"));
    }
    Ok(())
}

fn lan_ipv4() -> Result<Ipv4Addr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    // UDP connect selects the route without sending a packet.
    socket
        .connect((Ipv4Addr::new(192, 0, 2, 1), 9))
        .map_err(|e| e.to_string())?;
    match socket.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(ip) if is_private_ipv4(ip) => Ok(ip),
        _ => Err("no private IPv4 LAN interface was found".into()),
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || a == 172 && (16..=31).contains(&b) || a == 192 && b == 168
}

fn gateway_interface_changed(bound_host: Option<&str>, current_host: &str) -> bool {
    bound_host.is_some_and(|host| host != current_host)
}

fn authorization_error(was_approved_during_connection: bool) -> &'static str {
    if was_approved_during_connection {
        "mobile device approval was revoked"
    } else {
        "pairing approval required"
    }
}

fn initial_connection_authorization(
    approved: bool,
    has_pairing_nonce: bool,
    nonce_is_current: bool,
) -> (bool, bool) {
    (
        approved || !has_pairing_nonce,
        !approved && has_pairing_nonce && nonce_is_current,
    )
}

pub fn start(manager: Arc<TerminalManager>, port: Option<u16>) -> Result<Value, String> {
    let ctl = controller();
    let _transition = ctl.transition.lock().unwrap();
    let lan_ip = lan_ipv4()?;
    let host = lan_ip.to_string();
    let interface_changed = gateway_interface_changed(
        ctl.bound
            .lock()
            .unwrap()
            .as_ref()
            .map(|(bound_host, _)| bound_host.as_str()),
        &host,
    );
    if interface_changed {
        stop_locked(ctl);
    }
    if let Some((host, running_port)) = ctl.bound.lock().unwrap().clone() {
        let state = ctl
            .state
            .lock()
            .unwrap()
            .clone()
            .ok_or("mobile gateway state is unavailable")?;
        let identity = state.identity.lock().unwrap();
        let server_key = identity.server_public_key.clone();
        drop(identity);
        let ticket = create_pairing_ticket()?;
        let response = pairing_response(&host, running_port, &server_key, &ticket)?;
        *state.pairing_ticket.lock().unwrap() = Some(ticket.clone());
        state.pending.lock().unwrap().clear();
        return Ok(response);
    }
    let requested_port = port.unwrap_or(DEFAULT_PORT);
    if !(1024..=65535).contains(&requested_port) {
        return Err("mobile gateway port is out of range".into());
    }
    let path = identity_path()?;
    let identity = load_or_create_identity(&path)?;
    let state = Arc::new(GatewayState {
        identity: Mutex::new(identity),
        pending: Mutex::new(HashMap::new()),
        pairing_ticket: Mutex::new(None),
        path,
    });
    // Bind only the route-selected private LAN interface advertised by the
    // pairing QR. A wildcard listener would also expose the gateway on VPN,
    // public, and unrelated local interfaces.
    let bind = SocketAddr::from((lan_ip, requested_port));
    let listener = std::net::TcpListener::bind(bind)
        .map_err(|e| format!("bind mobile gateway on port {requested_port}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("configure mobile gateway listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (stop_tx, stop_rx) = watch::channel(false);
    let state_thread = Arc::clone(&state);
    let handle = std::thread::Builder::new()
        .name("mymux-mobile-gateway".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(_) => return,
            };
            runtime.block_on(run_listener(listener, state_thread, manager, stop_rx));
        })
        .map_err(|e| format!("start mobile gateway thread: {e}"))?;
    *ctl.state.lock().unwrap() = Some(Arc::clone(&state));
    *ctl.stop.lock().unwrap() = Some(stop_tx);
    *ctl.thread.lock().unwrap() = Some(handle);
    *ctl.bound.lock().unwrap() = Some((host.clone(), port));
    let identity = state.identity.lock().unwrap();
    let server_key = identity.server_public_key.clone();
    drop(identity);
    let ticket = create_pairing_ticket()?;
    *state.pairing_ticket.lock().unwrap() = Some(ticket.clone());
    match pairing_response(&host, port, &server_key, &ticket) {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = stop();
            Err(error)
        }
    }
}

pub fn stop() -> Value {
    let ctl = controller();
    let _transition = ctl.transition.lock().unwrap();
    stop_locked(ctl)
}

fn stop_locked(ctl: &GatewayController) -> Value {
    if let Some(sender) = ctl.stop.lock().unwrap().take() {
        let _ = sender.send(true);
    }
    if let Some(handle) = ctl.thread.lock().unwrap().take() {
        let _ = handle.join();
    }
    *ctl.bound.lock().unwrap() = None;
    *ctl.state.lock().unwrap() = None;
    json!({ "running": false })
}

#[cfg(test)]
mod gateway_interface_tests {
    use super::{authorization_error, gateway_interface_changed, initial_connection_authorization};

    #[test]
    fn gateway_rebinds_only_when_the_selected_interface_changes() {
        assert!(!gateway_interface_changed(None, "192.168.1.4"));
        assert!(!gateway_interface_changed(
            Some("192.168.1.4"),
            "192.168.1.4"
        ));
        assert!(gateway_interface_changed(Some("192.168.1.4"), "10.0.0.8"));
    }

    #[test]
    fn revoked_devices_are_distinguishable_from_pending_pairings() {
        assert_eq!(
            authorization_error(true),
            "mobile device approval was revoked"
        );
        assert_eq!(authorization_error(false), "pairing approval required");
    }

    #[test]
    fn pairing_nonce_distinguishes_new_approval_from_saved_device_reconnect() {
        assert_eq!(
            initial_connection_authorization(false, true, true),
            (false, true)
        );
        assert_eq!(
            initial_connection_authorization(false, true, false),
            (false, false)
        );
        assert_eq!(
            initial_connection_authorization(false, false, false),
            (true, false)
        );
        assert_eq!(
            initial_connection_authorization(true, false, false),
            (true, false)
        );
    }
}

pub fn status() -> Value {
    let ctl = controller();
    let bound = ctl.bound.lock().unwrap().clone();
    let Some((host, port)) = bound else {
        return json!({ "running": false, "pending": [], "devices": [] });
    };
    let state_guard = ctl.state.lock().unwrap();
    let Some(state) = state_guard.as_ref() else {
        return json!({ "running": false, "pending": [], "devices": [] });
    };
    let identity = state.identity.lock().unwrap();
    let pending: Vec<_> = state.pending.lock().unwrap().values().cloned().collect();
    let server_key = identity.server_public_key.clone();
    let devices = identity.devices.clone();
    drop(identity);
    let ticket = state
        .pairing_ticket
        .lock()
        .unwrap()
        .clone()
        .filter(|ticket| ticket.expires_at > current_millis());
    let pairing =
        ticket.and_then(|ticket| pairing_response(&host, port, &server_key, &ticket).ok());
    json!({ "running": true, "host": host, "port": port, "serverKey": server_key, "pending": pending, "devices": devices, "pairing": pairing })
}

fn create_pairing_ticket() -> Result<PairingTicket, String> {
    let params = NOISE_NAME
        .parse()
        .map_err(|_| "unsupported Noise protocol")?;
    let keypair = Builder::new(params)
        .generate_keypair()
        .map_err(|e| e.to_string())?;
    let mut nonce_bytes = keypair.private;
    let nonce = URL_SAFE_NO_PAD.encode(&nonce_bytes);
    nonce_bytes.fill(0);
    Ok(PairingTicket {
        nonce,
        expires_at: current_millis().saturating_add(180_000),
    })
}

fn pairing_response(
    host: &str,
    port: u16,
    server_key: &str,
    ticket: &PairingTicket,
) -> Result<Value, String> {
    let payload = json!({ "v": 1, "kind": "mymux-pair", "host": host, "port": port, "serverKey": server_key, "nonce": ticket.nonce, "expiresAt": ticket.expires_at });
    let raw = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let code = QrCode::new(raw.as_bytes()).map_err(|e| format!("create pairing QR code: {e}"))?;
    let qr_svg = code.render::<svg::Color>().min_dimensions(256, 256).build();
    Ok(
        json!({ "running": true, "host": host, "port": port, "serverKey": server_key, "pairingCode": payload, "qrSvg": qr_svg }),
    )
}

pub fn approve(public_key: &str, name: &str) -> Result<(), String> {
    let state = controller()
        .state
        .lock()
        .unwrap()
        .clone()
        .ok_or("mobile gateway is not initialized")?;
    let decoded = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| "invalid mobile device key")?;
    if decoded.len() != 32
        || name.trim().is_empty()
        || name.chars().count() > 80
        || name.chars().any(char::is_control)
    {
        return Err("invalid mobile device approval".into());
    }
    let mut identity = state.identity.lock().unwrap();
    if !identity
        .devices
        .iter()
        .any(|device| device.public_key == public_key)
    {
        if identity.devices.len() >= 32 {
            return Err("maximum paired device count reached".into());
        }
        identity.devices.push(ApprovedDevice {
            public_key: public_key.into(),
            name: name.trim().into(),
            approved_at: current_millis(),
        });
        persist_identity(&state.path, &identity)?;
    }
    state.pending.lock().unwrap().remove(public_key);
    Ok(())
}

pub fn revoke(public_key: &str) -> Result<(), String> {
    let state = controller()
        .state
        .lock()
        .unwrap()
        .clone()
        .ok_or("mobile gateway is not initialized")?;
    let removed = {
        let mut identity = state.identity.lock().unwrap();
        let previous_count = identity.devices.len();
        identity
            .devices
            .retain(|device| device.public_key != public_key);
        if identity.devices.len() != previous_count {
            persist_identity(&state.path, &identity)?;
            true
        } else {
            false
        }
    };
    if removed {
        state.pending.lock().unwrap().remove(public_key);
    }
    Ok(())
}

async fn run_listener(
    listener: std::net::TcpListener,
    state: Arc<GatewayState>,
    manager: Arc<TerminalManager>,
    mut stop: watch::Receiver<bool>,
) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut handlers = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
            Some(_) = handlers.join_next(), if !handlers.is_empty() => {}
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else { continue; };
                let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { drop(stream); continue; };
                let state = Arc::clone(&state);
                let manager = Arc::clone(&manager);
                handlers.spawn(async move { let _permit = permit; let _ = serve_connection(stream, state, manager).await; });
            }
        }
    }
    // Stop must tear down established clients too. Their keys are no longer
    // authorized once the user disables the gateway.
    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    state: Arc<GatewayState>,
    manager: Arc<TerminalManager>,
) -> Result<(), String> {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_NOISE_MESSAGE);
    config.max_frame_size = Some(MAX_NOISE_MESSAGE);
    let mut socket = accept_hdr_async_with_config(
        stream,
        |request: &Request, response: Response| {
            if request.uri().path() == "/mymux/v1" {
                Ok(response)
            } else {
                Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(404)
                    .body(None)
                    .unwrap())
            }
        },
        Some(config),
    )
    .await
    .map_err(|e| e.to_string())?;
    let private = {
        let identity = state.identity.lock().unwrap();
        URL_SAFE_NO_PAD
            .decode(&identity.server_private_key)
            .map_err(|_| "invalid server identity")?
    };
    let params = NOISE_NAME
        .parse()
        .map_err(|_| "unsupported Noise protocol")?;
    let mut handshake = Builder::new(params)
        .local_private_key(&private)
        .map_err(|e| e.to_string())?
        .build_responder()
        .map_err(|e| e.to_string())?;
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, receive_binary(&mut socket))
        .await
        .map_err(|_| "Noise handshake timed out")??;
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
    let first_payload_size = handshake
        .read_message(&first, &mut payload)
        .map_err(|e| e.to_string())?;
    let requested_nonce = if first_payload_size == 0 {
        None
    } else {
        let first_payload: Value = serde_json::from_slice(&payload[..first_payload_size])
            .map_err(|_| "invalid Noise client payload")?;
        if first_payload.as_object().map(|fields| fields.len()) != Some(1) {
            return Err("invalid Noise client payload".into());
        }
        Some(
            first_payload
                .get("nonce")
                .and_then(Value::as_str)
                .ok_or("pairing nonce is missing")?
                .to_string(),
        )
    };
    let nonce_is_current = requested_nonce.as_ref().is_some_and(|nonce| {
        state
            .pairing_ticket
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|ticket| ticket.expires_at > current_millis() && ticket.nonce == *nonce)
    });
    let mut second = vec![0u8; MAX_NOISE_MESSAGE];
    let second_len = handshake
        .write_message(&[], &mut second)
        .map_err(|e| e.to_string())?;
    socket
        .send(Message::Binary(second[..second_len].to_vec().into()))
        .await
        .map_err(|e| e.to_string())?;
    let third = tokio::time::timeout(HANDSHAKE_TIMEOUT, receive_binary(&mut socket))
        .await
        .map_err(|_| "Noise handshake timed out")??;
    let third_payload_size = handshake
        .read_message(&third, &mut payload)
        .map_err(|e| e.to_string())?;
    if third_payload_size != 0 {
        return Err("unexpected Noise client payload".into());
    }
    let remote = handshake
        .get_remote_static()
        .ok_or("Noise client key is missing")?;
    let public_key = URL_SAFE_NO_PAD.encode(remote);
    let mut approved = state
        .identity
        .lock()
        .unwrap()
        .devices
        .iter()
        .any(|device| device.public_key == public_key);
    let (mut was_approved_during_connection, mut waiting_for_pairing_approval) =
        initial_connection_authorization(approved, requested_nonce.is_some(), nonce_is_current);
    if !approved && requested_nonce.is_some() {
        if !nonce_is_current {
            return Err("pairing code is invalid or expired".into());
        }
        let mut ticket = state.pairing_ticket.lock().unwrap();
        if !ticket.as_ref().is_some_and(|ticket| {
            ticket.expires_at > current_millis()
                && requested_nonce.as_deref() == Some(ticket.nonce.as_str())
        }) {
            return Err("pairing code has already been used".into());
        }
        *ticket = None;
        state
            .pending
            .lock()
            .unwrap()
            .entry(public_key.clone())
            .or_insert(PendingDevice {
                public_key: public_key.clone(),
                first_seen: current_millis(),
            });
    }
    let mut transport = handshake.into_transport_mode().map_err(|e| e.to_string())?;
    loop {
        let message = tokio::time::timeout(IDLE_TIMEOUT, socket.next())
            .await
            .map_err(|_| "mobile websocket idle timeout")?
            .ok_or("mobile websocket closed")?
            .map_err(|e| e.to_string())?;
        match message {
            Message::Binary(ciphertext) => {
                if ciphertext.len() < 16 || ciphertext.len() > MAX_RPC_PLAINTEXT + 16 {
                    return Err("invalid Noise message size".into());
                }
                let mut plaintext = vec![0u8; MAX_RPC_PLAINTEXT];
                let size = transport
                    .read_message(&ciphertext, &mut plaintext)
                    .map_err(|e| e.to_string())?;
                let request: Value = serde_json::from_slice(&plaintext[..size])
                    .map_err(|_| "invalid mobile RPC JSON")?;
                let fields = request
                    .as_object()
                    .ok_or("mobile RPC request must be an object")?;
                if fields
                    .keys()
                    .any(|key| !["v", "id", "op", "payload"].contains(&key.as_str()))
                {
                    return Err("mobile RPC request has unknown fields".into());
                }
                if request.get("v").and_then(Value::as_u64) != Some(1) {
                    return Err("unsupported mobile RPC version".into());
                }
                let id = request
                    .get("id")
                    .and_then(Value::as_u64)
                    .filter(|id| *id > 0 && *id <= i32::MAX as u64)
                    .ok_or("invalid RPC request id")?;
                let op = request
                    .get("op")
                    .and_then(Value::as_str)
                    .ok_or("mobile RPC operation is missing")?;
                let payload = request.get("payload");
                if payload.is_some_and(|value| !value.is_object()) {
                    return Err("mobile RPC payload must be an object".into());
                }
                if (op == "session.list") != payload.is_none() {
                    return Err("mobile RPC payload does not match its operation".into());
                }
                let payload = if op != "session.list" {
                    let payload = payload
                        .and_then(Value::as_object)
                        .ok_or("mobile RPC payload is missing")?;
                    let expected: &[&str] = match op {
                        "terminal.output" => &["sessionId", "offset", "maxBytes"],
                        "terminal.input" => &["sessionId", "data"],
                        "terminal.resize" => &["sessionId", "cols", "rows"],
                        "session.close" => &["sessionId"],
                        _ => return Err("unsupported mobile operation".into()),
                    };
                    if payload.keys().any(|key| !expected.contains(&key.as_str()))
                        || expected.iter().any(|key| !payload.contains_key(*key))
                    {
                        return Err("mobile RPC payload fields do not match its operation".into());
                    }
                    Some(payload)
                } else {
                    if op != "session.list" {
                        return Err("unsupported mobile operation".into());
                    }
                    None
                };
                if let Some(payload) = payload {
                    match op {
                        "terminal.output" => {
                            if payload.get("sessionId").and_then(Value::as_str).is_none()
                                || payload.get("offset").and_then(Value::as_u64).is_none()
                                || payload.get("maxBytes").and_then(Value::as_u64).is_none()
                            {
                                return Err("invalid terminal.output payload".into());
                            }
                        }
                        "terminal.input" => {
                            if payload.get("sessionId").and_then(Value::as_str).is_none()
                                || payload.get("data").and_then(Value::as_str).is_none()
                            {
                                return Err("invalid terminal.input payload".into());
                            }
                        }
                        "terminal.resize" => {
                            if payload.get("sessionId").and_then(Value::as_str).is_none()
                                || payload.get("cols").and_then(Value::as_u64).is_none()
                                || payload.get("rows").and_then(Value::as_u64).is_none()
                            {
                                return Err("invalid terminal.resize payload".into());
                            }
                        }
                        "session.close" => {
                            if payload.get("sessionId").and_then(Value::as_str).is_none() {
                                return Err("invalid session.close payload".into());
                            }
                        }
                        _ => return Err("unsupported mobile operation".into()),
                    }
                }
                approved = state
                    .identity
                    .lock()
                    .unwrap()
                    .devices
                    .iter()
                    .any(|device| device.public_key == public_key);
                if !approved && waiting_for_pairing_approval && op == "session.list" {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
                    while !approved && tokio::time::Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        approved = state
                            .identity
                            .lock()
                            .unwrap()
                            .devices
                            .iter()
                            .any(|device| device.public_key == public_key);
                    }
                }
                if approved {
                    was_approved_during_connection = true;
                    waiting_for_pairing_approval = false;
                }
                let reply = {
                    let identity = state.identity.lock().unwrap();
                    if identity
                        .devices
                        .iter()
                        .any(|device| device.public_key == public_key)
                    {
                        // Serialize revocation with dispatch; this operation
                        // is synchronous and does not hold the lock over await.
                        Some(dispatch_mobile_rpc(&manager, request, id))
                    } else {
                        None
                    }
                };
                let Some(reply) = reply else {
                    let error = authorization_error(was_approved_during_connection);
                    let bytes = serde_json::to_vec(&json!({ "v": 1, "id": id, "error": error }))
                        .map_err(|e| e.to_string())?;
                    let mut encrypted = vec![0u8; bytes.len() + 16];
                    let encrypted_len = transport
                        .write_message(&bytes, &mut encrypted)
                        .map_err(|e| e.to_string())?;
                    socket
                        .send(Message::Binary(encrypted[..encrypted_len].to_vec().into()))
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                };
                let bytes = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
                if bytes.len() > MAX_RPC_PLAINTEXT {
                    return Err("mobile RPC response is too large".into());
                }
                let mut encrypted = vec![0u8; bytes.len() + 16];
                let encrypted_len = transport
                    .write_message(&bytes, &mut encrypted)
                    .map_err(|e| e.to_string())?;
                socket
                    .send(Message::Binary(encrypted[..encrypted_len].to_vec().into()))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Message::Close(_) => break,
            Message::Ping(data) => socket
                .send(Message::Pong(data))
                .await
                .map_err(|e| e.to_string())?,
            Message::Pong(_) => {}
            _ => return Err("unsupported mobile websocket message".into()),
        }
    }
    Ok(())
}

async fn receive_binary(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Result<Vec<u8>, String> {
    match socket
        .next()
        .await
        .ok_or("mobile websocket closed during Noise handshake")?
        .map_err(|e| e.to_string())?
    {
        Message::Binary(bytes) if !bytes.is_empty() && bytes.len() <= MAX_NOISE_MESSAGE => {
            Ok(bytes.to_vec())
        }
        _ => Err("invalid Noise handshake message".into()),
    }
}

fn dispatch_mobile_rpc(manager: &Arc<TerminalManager>, request: Value, id: u64) -> Value {
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    let internal = match op {
        "session.list" => ("mobileList", payload),
        "terminal.output" => ("mobileRead", payload),
        "terminal.input" => {
            let data = payload.get("data").and_then(Value::as_str).unwrap_or("");
            if data.len() > MAX_INPUT {
                return json!({ "v": 1, "id": id, "error": "input batch is too large" });
            }
            ("mobileWrite", payload)
        }
        "terminal.resize" => ("mobileResize", payload),
        "session.close" => ("mobileClose", payload),
        _ => return json!({ "v": 1, "id": id, "error": "unsupported mobile operation" }),
    };
    let mut response =
        pty_server::dispatch(manager, &json!({ "op": internal.0, "payload": internal.1 }));
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        json!({ "v": 1, "id": id, "error": error })
    } else {
        if op == "session.list" {
            if let Some(sessions) = response.get_mut("sessions").and_then(Value::as_array_mut) {
                sessions.truncate(16);
                for session in sessions {
                    if let Some(agents) = session.get_mut("agents").and_then(Value::as_array_mut) {
                        agents.truncate(8);
                        for agent in agents {
                            if let Some(description) = agent
                                .get_mut("description")
                                .and_then(|value| value.as_str().map(str::to_owned))
                            {
                                let limited: String = description.chars().take(96).collect();
                                if let Some(field) = agent.get_mut("description") {
                                    *field = Value::String(limited);
                                }
                            }
                        }
                    }
                }
            }
        }
        json!({ "v": 1, "id": id, "result": response })
    }
}
