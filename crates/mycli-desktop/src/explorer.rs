use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub is_symlink: bool,
}

// ── SSH client handler (TOFU host-key verification) ──
struct SshHandler {
    host: String,
    port: u16,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let host = self.host.clone();
        let port = self.port;
        let key = server_public_key.to_openssh().unwrap_or_default();
        async move { Ok(verify_known_host(&host, port, &key)) }
    }
}

/// Trust-on-first-use host-key check against ~/.mycli/known_hosts (public keys,
/// not secret). Unknown host → record the key and accept. Known host whose key
/// changed → refuse the connection (possible MITM).
fn verify_known_host(host: &str, port: u16, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let Some(path) = dirs::home_dir().map(|h| h.join(".mycli").join("known_hosts")) else {
        return true; // no home dir → can't persist; don't hard-fail connections
    };
    let id = format!("[{host}]:{port}");

    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            if let Some((h, k)) = line.split_once(' ')
                && h == id
            {
                return k.trim() == key.trim();
            }
        }
    }

    // Unknown host: persist the key and accept (trust-on-first-use).
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{id} {key}");
    }
    true
}

struct SftpSessionInfo {
    sftp: SftpSession,
    _handle: client::Handle<SshHandler>,
}

pub struct ExplorerManager {
    sftp_sessions: Mutex<HashMap<u32, SftpSessionInfo>>,
    next_id: Mutex<u32>,
    runtime: tokio::runtime::Runtime,
}

impl ExplorerManager {
    pub fn new() -> Self {
        let runtime = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        Self {
            sftp_sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            runtime,
        }
    }
}

// ── Local filesystem ──

#[tauri::command]
pub fn explorer_list_local(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = if path.is_empty() {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(&path)
    };

    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();

        result.push(FileEntry {
            name,
            path: full_path,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            is_symlink: metadata.is_symlink(),
        });
    }

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn explorer_home_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn explorer_parent_dir(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
}

/// List available local drive roots (Windows: C:\, D:\, …; Unix: /).
#[tauri::command]
pub fn explorer_list_drives() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut drives = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                drives.push(root);
            }
        }
        drives
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["/".to_string()]
    }
}

// ── SFTP remote filesystem ──

#[tauri::command]
pub fn sftp_connect(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<u32, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let config = Arc::new(client::Config::default());
        let handler = SshHandler {
            host: host.clone(),
            port,
        };

        let mut handle = client::connect(config, (host.as_str(), port), handler)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        // Authenticate: explicit key > auto-detect keys > password
        let mut authenticated = false;

        // 1. Explicit key file
        if let Some(ref key_file) = key_path {
            if let Ok(key) = russh::keys::load_secret_key(key_file, None) {
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                if let Ok(result) = handle.authenticate_publickey(&username, key_with_alg).await {
                    authenticated = result.success();
                }
            }
        }

        // 2. Auto-detect SSH keys from ~/.ssh/
        if !authenticated {
            // id_dsa intentionally omitted — DSA is obsolete/weak.
            let key_names = ["id_ed25519", "id_ecdsa", "id_rsa"];
            if let Some(home) = dirs::home_dir() {
                let ssh_dir = home.join(".ssh");
                for name in &key_names {
                    let path = ssh_dir.join(name);
                    if !path.exists() {
                        continue;
                    }
                    if let Ok(key) = russh::keys::load_secret_key(&path, None) {
                        let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                        match handle.authenticate_publickey(&username, key_with_alg).await {
                            Ok(result) if result.success() => {
                                authenticated = true;
                                break;
                            }
                            _ => continue,
                        }
                    }
                }
            }
        }

        // 3. Password auth
        if !authenticated {
            if let Some(ref pass) = password {
                let result = handle
                    .authenticate_password(&username, pass)
                    .await
                    .map_err(|e| format!("Password auth failed: {}", e))?;
                authenticated = result.success();
            }
        }

        if !authenticated {
            return Err("Authentication failed. No valid key found in ~/.ssh/ and no password provided.".to_string());
        }

        // Open SFTP channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {}", e))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP session failed: {}", e))?;

        let id = {
            let mut next = state_clone.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };

        {
            let mut sessions = state_clone.sftp_sessions.lock().await;
            sessions.insert(
                id,
                SftpSessionInfo {
                    sftp,
                    _handle: handle,
                },
            );
        }

        Ok(id)
    })
}

#[tauri::command]
pub fn sftp_list_dir(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let sessions = state_clone.sftp_sessions.lock().await;
        let session = sessions.get(&session_id).ok_or("SFTP session not found")?;

        let read_dir = session
            .sftp
            .read_dir(&path)
            .await
            .map_err(|e| format!("Cannot read {}: {}", path, e))?;

        let mut result: Vec<FileEntry> = Vec::new();

        for entry in read_dir {
            let name = entry.file_name();
            // Skip . and ..
            if name == "." || name == ".." {
                continue;
            }
            let full_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            let mut is_dir = entry.file_type().is_dir();
            let is_symlink = entry.file_type().is_symlink();
            // read_dir lstats entries, so a symlink to a directory (e.g. macOS
            // /Volumes/"Macintosh HD" -> /) reports as a plain link. Stat the
            // target so such links open as folders in the explorer.
            if is_symlink && !is_dir {
                if let Ok(meta) = session.sftp.metadata(full_path.as_str()).await {
                    if meta.is_dir() {
                        is_dir = true;
                    }
                }
            }
            let size = entry.metadata().size.unwrap_or(0);

            result.push(FileEntry {
                name,
                path: full_path,
                is_dir,
                size,
                is_symlink,
            });
        }

        result.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    })
}

#[tauri::command]
pub fn sftp_home_dir(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
) -> Result<String, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let sessions = state_clone.sftp_sessions.lock().await;
        let session = sessions.get(&session_id).ok_or("SFTP session not found")?;

        match session.sftp.canonicalize(".").await {
            Ok(path) => Ok(path),
            Err(_) => Ok("/".to_string()),
        }
    })
}

/// Read a remote text/code file over SFTP for the in-app viewer. Mirrors
/// `read_text_file`: returns Err("BINARY") for non-text files and Err for files
/// larger than ~2 MB.
#[tauri::command]
pub fn sftp_read_text_file(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let sessions = state_clone.sftp_sessions.lock().await;
        let session = sessions.get(&session_id).ok_or("SFTP session not found")?;

        // Size guard (~2 MB) when the server reports it.
        if let Ok(meta) = session.sftp.metadata(&path).await {
            if let Some(sz) = meta.size {
                if sz > 2_000_000 {
                    return Err("File is too large (over 2 MB)".to_string());
                }
            }
        }

        let mut file = session
            .sftp
            .open(&path)
            .await
            .map_err(|e| format!("Cannot open {}: {}", path, e))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| e.to_string())?;

        let sample = &buf[..buf.len().min(8000)];
        if sample.contains(&0u8) {
            return Err("BINARY".into());
        }
        Ok(String::from_utf8_lossy(&buf).to_string())
    })
}

/// Save text back to a remote file over SFTP (creates/truncates). In-app editor.
#[tauri::command]
pub fn sftp_write_text_file(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
    content: String,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let sessions = state_clone.sftp_sessions.lock().await;
        let session = sessions.get(&session_id).ok_or("SFTP session not found")?;

        let mut file = session
            .sftp
            .create(&path)
            .await
            .map_err(|e| format!("Cannot write {}: {}", path, e))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.flush().await.ok();
        file.shutdown().await.ok();
        Ok(())
    })
}

#[tauri::command]
pub fn sftp_disconnect(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
) -> Result<(), String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let mut sessions = state_clone.sftp_sessions.lock().await;
        sessions.remove(&session_id);
        Ok(())
    })
}
