use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpUploadProgress {
    upload_id: String,
    bytes_transferred: u64,
    total_bytes: u64,
}

struct UploadProgress<'a> {
    app: Option<&'a tauri::AppHandle>,
    upload_id: &'a str,
    transferred: AtomicU64,
    total: u64,
}

impl UploadProgress<'_> {
    fn emit(&self) {
        if let Some(app) = self.app {
            let _ = app.emit(
                "sftp-upload-progress",
                SftpUploadProgress {
                    upload_id: self.upload_id.to_string(),
                    bytes_transferred: self.transferred.load(Ordering::Relaxed),
                    total_bytes: self.total,
                },
            );
        }
    }
}

// ── SSH client handler (TOFU host-key verification) ──
struct SshHandler {
    host: String,
    port: u16,
    known_hosts_path: Option<PathBuf>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let host = self.host.clone();
        let port = self.port;
        let known_hosts_path = self.known_hosts_path.clone();
        let key = server_public_key.to_openssh().unwrap_or_default();
        async move {
            Ok(
                verify_known_host_at(known_hosts_path.as_deref(), &host, port, &key)
                    .unwrap_or(false),
            )
        }
    }
}

/// Trust-on-first-use host-key check against ~/.mycli/known_hosts (public keys,
/// not secret). Unknown host → record the key and accept. Known host whose key
/// changed → refuse the connection (possible MITM).
fn verify_known_host_at(
    path: Option<&Path>,
    host: &str,
    port: u16,
    key: &str,
) -> Result<bool, String> {
    if key.is_empty() {
        return Ok(false);
    }
    let path = path.ok_or("Known-hosts path is unavailable")?;
    let id = format!("[{host}]:{port}");
    let parent = path
        .parent()
        .ok_or_else(|| format!("Known-hosts path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| format!("Cannot lock {}: {error}", path.display()))?;

    let result = (|| {
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("Cannot seek {}: {error}", path.display()))?;
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        for line in content.lines() {
            if let Some((known_id, known_key)) = line.split_once(' ')
                && known_id == id
            {
                return Ok(known_key.trim() == key.trim());
            }
        }

        file.seek(SeekFrom::End(0))
            .map_err(|error| format!("Cannot seek {}: {error}", path.display()))?;
        if !content.is_empty() && !content.ends_with('\n') {
            writeln!(file).map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
        }
        writeln!(file, "{id} {key}")
            .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
        file.flush()
            .map_err(|error| format!("Cannot flush {}: {error}", path.display()))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync {}: {error}", path.display()))?;
        Ok(true)
    })();
    let unlock_result = fs2::FileExt::unlock(&file)
        .map_err(|error| format!("Cannot unlock {}: {error}", path.display()));
    unlock_result?;
    result
}

struct SftpSessionInfo {
    sftp: SftpSession,
    _handle: client::Handle<SshHandler>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CreatedRemoteEntry {
    File(String),
    Directory(String),
}

struct LocalUploadManifest {
    name: String,
    total: u64,
    root_parent: cap_std::fs::Dir,
    entry: LocalUploadEntry,
}

struct LocalUploadChild {
    name: String,
    entry: LocalUploadEntry,
}

enum LocalUploadEntry {
    File {
        identity: LocalFileIdentity,
        length: u64,
    },
    Directory {
        identity: LocalFileIdentity,
        children: Vec<LocalUploadChild>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalFileIdentity {
    first: u64,
    second: u64,
}

struct ActiveUpload {
    session_id: u32,
    remote_dir: String,
    cancellation: Arc<AtomicBool>,
    in_flight: bool,
}

pub struct ExplorerManager {
    sftp_sessions: Mutex<HashMap<u32, Arc<SftpSessionInfo>>>,
    active_uploads: Mutex<HashMap<String, ActiveUpload>>,
    next_id: Mutex<u32>,
    runtime: tokio::runtime::Runtime,
}

impl ExplorerManager {
    pub fn new() -> Self {
        let runtime = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        Self {
            sftp_sessions: Mutex::new(HashMap::new()),
            active_uploads: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            runtime,
        }
    }
}

async fn get_sftp_session(
    manager: &ExplorerManager,
    session_id: u32,
) -> Result<Arc<SftpSessionInfo>, String> {
    let sessions = manager.sftp_sessions.lock().await;
    sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "SFTP session not found".to_string())
}

async fn resolve_remote_dir_path(session: &SftpSessionInfo, path: &str) -> Result<String, String> {
    let canonical = session
        .sftp
        .canonicalize(path)
        .await
        .map_err(|error| format!("Cannot resolve {path}: {error}"))?;
    let metadata = session
        .sftp
        .metadata(&canonical)
        .await
        .map_err(|error| format!("Cannot inspect {canonical}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("Not a directory: {canonical}"));
    }
    Ok(canonical)
}

async fn register_upload_state(
    uploads: &Mutex<HashMap<String, ActiveUpload>>,
    session_id: u32,
    remote_dir: String,
) -> String {
    let mut uploads = uploads.lock().await;
    loop {
        let upload_id = format!("upload-{}", uuid::Uuid::new_v4());
        if let std::collections::hash_map::Entry::Vacant(entry) = uploads.entry(upload_id.clone()) {
            entry.insert(ActiveUpload {
                session_id,
                remote_dir,
                cancellation: Arc::new(AtomicBool::new(false)),
                in_flight: false,
            });
            return upload_id;
        }
    }
}

async fn claim_upload_state(
    uploads: &Mutex<HashMap<String, ActiveUpload>>,
    upload_id: &str,
    session_id: u32,
    remote_dir: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut uploads = uploads.lock().await;
    let upload = uploads
        .get_mut(upload_id)
        .ok_or_else(|| "Upload id is not registered".to_string())?;
    if upload.session_id != session_id {
        return Err("Upload session does not match the registered session".to_string());
    }
    if upload.remote_dir != remote_dir {
        return Err("Upload destination does not match the registered directory".to_string());
    }
    if upload.in_flight {
        return Err("Another path is already in flight for this upload".to_string());
    }
    upload.in_flight = true;
    Ok(Arc::clone(&upload.cancellation))
}

async fn release_upload_state(uploads: &Mutex<HashMap<String, ActiveUpload>>, upload_id: &str) {
    if let Some(upload) = uploads.lock().await.get_mut(upload_id) {
        upload.in_flight = false;
    }
}

async fn cancel_upload_state(
    uploads: &Mutex<HashMap<String, ActiveUpload>>,
    upload_id: &str,
) -> Result<(), String> {
    let uploads = uploads.lock().await;
    let upload = uploads
        .get(upload_id)
        .ok_or_else(|| "Upload is no longer active".to_string())?;
    upload.cancellation.store(true, Ordering::Release);
    Ok(())
}

async fn finish_upload_state(
    uploads: &Mutex<HashMap<String, ActiveUpload>>,
    upload_id: &str,
) -> Result<(), String> {
    let mut uploads = uploads.lock().await;
    let upload = uploads
        .get(upload_id)
        .ok_or_else(|| "Upload is no longer active".to_string())?;
    if upload.in_flight {
        return Err("Cannot finish an upload while a path is in flight".to_string());
    }
    uploads.remove(upload_id);
    Ok(())
}

async fn cancel_session_uploads(uploads: &Mutex<HashMap<String, ActiveUpload>>, session_id: u32) {
    let uploads = uploads.lock().await;
    for upload in uploads
        .values()
        .filter(|upload| upload.session_id == session_id)
    {
        upload.cancellation.store(true, Ordering::Release);
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
        // Use the entry's file_type (readdir d_type) instead of a full stat.
        // On macOS, stat-ing the protected folders that live in the home dir
        // (Desktop / Documents / Downloads / Pictures / Music) triggers a TCC
        // privacy prompt for each one; with an ad-hoc code signature TCC cannot
        // persist the grant, so simply listing ~ spawns an endless run of
        // prompts. file_type avoids the stat for directories; size (needed only
        // for files) is fetched lazily and skipped for dirs/symlinks so we never
        // stat a protected directory just to list its parent.
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        let is_symlink = file_type.is_symlink();
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let size = if is_dir || is_symlink {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };

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

async fn connect_sftp_session(
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    key_path: Option<&str>,
    known_hosts_path: Option<PathBuf>,
    auto_key_dir: Option<PathBuf>,
) -> Result<SftpSessionInfo, String> {
    let config = Arc::new(client::Config::default());
    let handler = SshHandler {
        host: host.to_string(),
        port,
        known_hosts_path,
    };

    let mut handle = client::connect(config, (host, port), handler)
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    // Authenticate: explicit key > auto-detect keys > password
    let mut authenticated = false;

    if let Some(key_file) = key_path {
        if let Ok(key) = russh::keys::load_secret_key(key_file, None) {
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            if let Ok(result) = handle.authenticate_publickey(username, key_with_alg).await {
                authenticated = result.success();
            }
        }
    }

    if !authenticated {
        // id_dsa intentionally omitted because DSA is obsolete/weak.
        let key_names = ["id_ed25519", "id_ecdsa", "id_rsa"];
        if let Some(ssh_dir) = auto_key_dir {
            for name in &key_names {
                let path = ssh_dir.join(name);
                if !path.exists() {
                    continue;
                }
                if let Ok(key) = russh::keys::load_secret_key(&path, None) {
                    let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                    match handle.authenticate_publickey(username, key_with_alg).await {
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

    if !authenticated {
        if let Some(pass) = password {
            let result = handle
                .authenticate_password(username, pass)
                .await
                .map_err(|e| format!("Password auth failed: {e}"))?;
            authenticated = result.success();
        }
    }

    if !authenticated {
        return Err(
            "Authentication failed. No valid key found in ~/.ssh/ and no password provided."
                .to_string(),
        );
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Channel open failed: {e}"))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP_UNSUPPORTED: SFTP subsystem failed: {e}"))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP_UNSUPPORTED: SFTP session failed: {e}"))?;

    Ok(SftpSessionInfo {
        sftp,
        _handle: handle,
    })
}

#[tauri::command(async)]
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
        let home = dirs::home_dir();
        let session = connect_sftp_session(
            &host,
            port,
            &username,
            password.as_deref(),
            key_path.as_deref(),
            home.as_ref()
                .map(|path| path.join(".mycli").join("known_hosts")),
            home.map(|path| path.join(".ssh")),
        )
        .await?;
        let id = {
            let mut next = state_clone.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };

        {
            let mut sessions = state_clone.sftp_sessions.lock().await;
            sessions.insert(id, Arc::new(session));
        }

        Ok(id)
    })
}

#[tauri::command(async)]
pub fn sftp_list_dir(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;

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

#[tauri::command(async)]
pub fn sftp_home_dir(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
) -> Result<String, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;

        match session.sftp.canonicalize(".").await {
            Ok(path) => Ok(path),
            Err(_) => Ok("/".to_string()),
        }
    })
}

/// Canonicalize a remote path and verify that it is a directory. The frontend
/// uses this before accepting an Explorer-driven or typed SSH `cd`, so the
/// pane and Explorer only move after the server has confirmed the destination.
#[tauri::command(async)]
pub fn sftp_resolve_dir(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
) -> Result<String, String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;
        resolve_remote_dir_path(&session, &path).await
    })
}

/// Read a remote text/code file over SFTP for the in-app viewer. Mirrors
/// `read_text_file`: returns Err("BINARY") for non-text files and Err for files
/// larger than ~2 MB.
#[tauri::command(async)]
pub fn sftp_read_text_file(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;

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
#[tauri::command(async)]
pub fn sftp_write_text_file(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    path: String,
    content: String,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;

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

/// Upload a local file or directory tree into an existing SFTP directory.
///
/// The destination is never overwritten. This keeps a drag-and-drop upload
/// recoverable and matches the local Explorer copy behavior.
#[tauri::command(async)]
pub fn sftp_upload_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    local_path: String,
    remote_dir: String,
    upload_id: String,
) -> Result<(), String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;
        let canonical_remote_dir = resolve_remote_dir_path(&session, &remote_dir).await?;
        let cancellation = claim_upload_state(
            &state_clone.active_uploads,
            &upload_id,
            session_id,
            &canonical_remote_dir,
        )
        .await?;
        let result = async {
            let source = PathBuf::from(&local_path);
            let manifest = open_secure_local_manifest(&source)?;
            let remote_path = remote_join(&canonical_remote_dir, &manifest.name);
            let total = manifest.total;
            let progress = UploadProgress {
                app: Some(&app),
                upload_id: &upload_id,
                transferred: AtomicU64::new(0),
                total,
            };
            progress.emit();
            upload_and_publish_entry(
                &session.sftp,
                manifest,
                remote_path,
                &progress,
                &cancellation,
            )
            .await?;
            progress.emit();
            Ok(())
        }
        .await;
        release_upload_state(&state_clone.active_uploads, &upload_id).await;
        result
    })
}

/// Start one upload batch and bind it to the authenticated SFTP session and
/// canonical destination directory. The identifier is generated by the backend.
#[tauri::command(async)]
pub fn sftp_begin_upload(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
    remote_dir: String,
) -> Result<String, String> {
    let state_clone = Arc::clone(&*state);
    state.runtime.block_on(async {
        let session = get_sftp_session(&state_clone, session_id).await?;
        let canonical_remote_dir = resolve_remote_dir_path(&session, &remote_dir).await?;
        Ok(register_upload_state(
            &state_clone.active_uploads,
            session_id,
            canonical_remote_dir,
        )
        .await)
    })
}

#[tauri::command(async)]
pub fn sftp_cancel_upload(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    upload_id: String,
) -> Result<(), String> {
    let state_clone = Arc::clone(&*state);
    state
        .runtime
        .block_on(cancel_upload_state(&state_clone.active_uploads, &upload_id))
}

#[tauri::command(async)]
pub fn sftp_finish_upload(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    upload_id: String,
) -> Result<(), String> {
    let state_clone = Arc::clone(&*state);
    state
        .runtime
        .block_on(finish_upload_state(&state_clone.active_uploads, &upload_id))
}

/// Preflight size for one dropped file/directory. The frontend sums these
/// values so a multi-item drop displays one truthful aggregate progress bar.
#[tauri::command(async)]
pub fn sftp_upload_size(local_path: String) -> Result<u64, String> {
    local_upload_size(Path::new(&local_path))
}

fn local_upload_size(path: &Path) -> Result<u64, String> {
    Ok(open_secure_local_manifest(path)?.total)
}

fn secure_local_open_options() -> cap_std::fs::OpenOptions {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
    let mut options = cap_std::fs::OpenOptions::new();
    // Besides permitting directory handles, maybe_dir removes
    // FILE_SHARE_DELETE on Windows so a directory cannot be renamed while
    // it is the active capability anchor.
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    options
}

fn open_secure_local_manifest(path: &Path) -> Result<LocalUploadManifest, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("Invalid local upload path: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    validate_upload_name(&name)?;
    let parent_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = cap_std::fs::Dir::open_ambient_dir(parent_path, cap_std::ambient_authority())
        .map_err(|error| {
            format!(
                "Cannot open local parent {}: {error}",
                parent_path.display()
            )
        })?;
    let opened = parent
        .open_with(path.file_name().unwrap(), &secure_local_open_options())
        .map_err(|error| {
            format!(
                "Cannot securely open {} (symbolic links are rejected): {error}",
                path.display()
            )
        })?;
    let (entry, total) = secure_manifest_entry(name.clone(), opened)?;
    Ok(LocalUploadManifest {
        name,
        total,
        root_parent: parent,
        entry,
    })
}

#[cfg(unix)]
fn local_file_identity(
    _file: &std::fs::File,
    metadata: &std::fs::Metadata,
) -> Result<LocalFileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(LocalFileIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(windows)]
fn local_file_identity(
    file: &std::fs::File,
    _metadata: &std::fs::Metadata,
) -> Result<LocalFileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if result == 0 {
        return Err(format!(
            "Cannot query local file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(LocalFileIdentity {
        first: information.dwVolumeSerialNumber as u64,
        second: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

fn secure_manifest_entry(
    display_name: String,
    opened: cap_std::fs::File,
) -> Result<(LocalUploadEntry, u64), String> {
    let standard_file = opened.into_std();
    let metadata = standard_file
        .metadata()
        .map_err(|error| format!("Cannot inspect local item {display_name}: {error}"))?;
    let identity = local_file_identity(&standard_file, &metadata)?;
    if metadata.is_file() {
        let length = metadata.len();
        return Ok((LocalUploadEntry::File { identity, length }, length));
    }
    if !metadata.is_dir() {
        return Err(format!("Unsupported local item: {display_name}"));
    }

    let directory = cap_std::fs::Dir::from_std_file(standard_file);
    let mut children = Vec::new();
    let mut total = 0_u64;
    for child in directory
        .entries()
        .map_err(|error| format!("Cannot read directory {display_name}: {error}"))?
    {
        let child =
            child.map_err(|error| format!("Cannot read directory {display_name}: {error}"))?;
        let child_name = child.file_name().to_string_lossy().to_string();
        validate_upload_name(&child_name)?;
        let child_file = child
            .open_with(&secure_local_open_options())
            .map_err(|error| {
                format!(
                    "Cannot securely open {display_name}/{child_name} (symbolic links are rejected): {error}"
                )
            })?;
        let (entry, child_total) =
            secure_manifest_entry(format!("{display_name}/{child_name}"), child_file)?;
        total = total
            .checked_add(child_total)
            .ok_or("Upload size overflow")?;
        children.push(LocalUploadChild {
            name: child_name,
            entry,
        });
    }
    children.sort_by(|left, right| left.name.cmp(&right.name));
    Ok((LocalUploadEntry::Directory { identity, children }, total))
}

fn reopen_secured_local_file(
    parent: &cap_std::fs::Dir,
    name: &str,
    identity: LocalFileIdentity,
    length: u64,
) -> Result<std::fs::File, String> {
    let opened = parent
        .open_with(name, &secure_local_open_options())
        .map_err(|error| {
            format!("Cannot securely reopen {name} (symbolic links are rejected): {error}")
        })?;
    let standard_file = opened.into_std();
    let metadata = standard_file
        .metadata()
        .map_err(|error| format!("Cannot inspect reopened local file {name}: {error}"))?;
    if !metadata.is_file()
        || metadata.len() != length
        || local_file_identity(&standard_file, &metadata)? != identity
    {
        return Err(format!("Local file changed after secure preflight: {name}"));
    }
    Ok(standard_file)
}

fn reopen_secured_local_directory(
    parent: &cap_std::fs::Dir,
    name: &str,
    identity: LocalFileIdentity,
) -> Result<cap_std::fs::Dir, String> {
    let opened = parent
        .open_with(name, &secure_local_open_options())
        .map_err(|error| {
            format!("Cannot securely reopen {name} (symbolic links are rejected): {error}")
        })?;
    let standard_file = opened.into_std();
    let metadata = standard_file
        .metadata()
        .map_err(|error| format!("Cannot inspect reopened local directory {name}: {error}"))?;
    if !metadata.is_dir() || local_file_identity(&standard_file, &metadata)? != identity {
        return Err(format!(
            "Local directory changed after secure preflight: {name}"
        ));
    }
    Ok(cap_std::fs::Dir::from_std_file(standard_file))
}

fn bounded_local_reader(
    file: std::fs::File,
    expected_length: u64,
) -> tokio::io::Take<tokio::fs::File> {
    tokio::fs::File::from_std(file).take(expected_length)
}

fn ensure_streamed_local_length(
    remote: &str,
    expected_length: u64,
    actual_length: u64,
) -> Result<(), String> {
    if actual_length == expected_length {
        Ok(())
    } else {
        Err(format!(
            "Local file changed during secure upload: {remote} \
             (expected {expected_length} bytes, read {actual_length})"
        ))
    }
}

fn remote_join(dir: &str, name: &str) -> String {
    let base = if dir.is_empty() {
        "/"
    } else {
        dir.trim_end_matches('/')
    };
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn validate_upload_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("Unsafe upload name rejected: {name:?}"));
    }
    Ok(())
}

fn ensure_upload_not_cancelled(cancellation: &AtomicBool) -> Result<(), String> {
    if cancellation.load(Ordering::Acquire) {
        Err("UPLOAD_CANCELLED: Upload cancelled by user.".to_string())
    } else {
        Ok(())
    }
}

async fn remote_path_exists(sftp: &SftpSession, path: &str) -> Result<bool, String> {
    match sftp.metadata(path).await {
        Ok(_) => Ok(true),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            Ok(false)
        }
        Err(error) => Err(format!("Cannot inspect remote path {path}: {error}")),
    }
}

fn sibling_temp_path(target: &str) -> Result<String, String> {
    let target = target.trim_end_matches('/');
    let (parent, name) = target
        .rsplit_once('/')
        .ok_or_else(|| format!("Invalid remote target: {target}"))?;
    validate_upload_name(name)?;
    let parent = if parent.is_empty() { "/" } else { parent };
    Ok(remote_join(
        parent,
        &format!(".mymux-upload-{}.tmp", uuid::Uuid::new_v4().simple()),
    ))
}

/// Upload one top-level path under a CSPRNG sibling temp name, close every
/// remote handle, re-check the final target, then publish with SFTP v3 RENAME.
/// Standard v3 rename fails when `target` exists, preserving no-overwrite even
/// if another client creates it between our last check and publish.
async fn upload_and_publish_entry(
    sftp: &SftpSession,
    local: LocalUploadManifest,
    target: String,
    progress: &UploadProgress<'_>,
    cancellation: &AtomicBool,
) -> Result<(), String> {
    ensure_upload_not_cancelled(cancellation)?;
    if remote_path_exists(sftp, &target).await? {
        return Err(format!("Remote item already exists: {target}"));
    }
    let temporary = sibling_temp_path(&target)?;
    let mut created = Vec::new();
    let result = async {
        let LocalUploadManifest {
            name,
            root_parent,
            entry,
            ..
        } = local;
        upload_local_entry(
            sftp,
            LocalUploadChild { name, entry },
            &root_parent,
            temporary.clone(),
            progress,
            cancellation,
            &mut created,
        )
        .await?;
        ensure_upload_not_cancelled(cancellation)?;
        if remote_path_exists(sftp, &target).await? {
            return Err(format!("Remote item already exists: {target}"));
        }
        sftp.rename(&temporary, &target)
            .await
            .map_err(|error| format!("Cannot publish remote item {target}: {error}"))?;
        Ok(())
    }
    .await;

    if let Err(error) = result {
        let cleanup_errors = cleanup_created_entries(sftp, &created).await;
        if cleanup_errors.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error} Cleanup incomplete: {}",
            cleanup_errors.join("; ")
        ));
    }
    Ok(())
}

fn upload_local_entry<'a>(
    sftp: &'a SftpSession,
    local: LocalUploadChild,
    local_parent: &'a cap_std::fs::Dir,
    remote: String,
    progress: &'a UploadProgress<'a>,
    cancellation: &'a AtomicBool,
    created: &'a mut Vec<CreatedRemoteEntry>,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + 'a>> {
    Box::pin(async move {
        ensure_upload_not_cancelled(cancellation)?;
        if remote_path_exists(sftp, &remote).await? {
            return Err(format!("Remote item already exists: {remote}"));
        }

        let (local_file, expected_length) = match local.entry {
            LocalUploadEntry::Directory { identity, children } => {
                // Only the current recursion chain remains open. Sibling
                // directories are identity-checked and reopened on demand.
                let directory_handle =
                    reopen_secured_local_directory(local_parent, &local.name, identity)?;
                sftp.create_dir(&remote)
                    .await
                    .map_err(|e| format!("Cannot create remote directory {remote}: {e}"))?;
                created.push(CreatedRemoteEntry::Directory(remote.clone()));
                for child in children {
                    ensure_upload_not_cancelled(cancellation)?;
                    let child_remote = remote_join(&remote, &child.name);
                    upload_local_entry(
                        sftp,
                        child,
                        &directory_handle,
                        child_remote,
                        progress,
                        cancellation,
                        created,
                    )
                    .await?;
                }
                return Ok(());
            }
            LocalUploadEntry::File { identity, length } => (
                reopen_secured_local_file(local_parent, &local.name, identity, length)?,
                length,
            ),
        };

        // Bound the stream to the manifest snapshot. Appends after the secure
        // reopen are ignored; truncation is rejected before publication.
        let mut local_file = bounded_local_reader(local_file, expected_length);
        let mut remote_file = sftp
            .open_with_flags(
                &remote,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("Cannot create remote file {remote}: {e}"))?;
        created.push(CreatedRemoteEntry::File(remote.clone()));
        let transfer_result = async {
            let mut buffer = vec![0_u8; 64 * 1024];
            let mut file_bytes_transferred = 0_u64;
            loop {
                ensure_upload_not_cancelled(cancellation)?;
                let count = local_file
                    .read(&mut buffer)
                    .await
                    .map_err(|e| format!("Cannot read secured local handle for {remote}: {e}"))?;
                if count == 0 {
                    break;
                }
                remote_file
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|e| format!("Upload failed for {remote}: {e}"))?;
                progress
                    .transferred
                    .fetch_add(count as u64, Ordering::Relaxed);
                file_bytes_transferred += count as u64;
                progress.emit();
            }
            ensure_streamed_local_length(&remote, expected_length, file_bytes_transferred)?;
            ensure_upload_not_cancelled(cancellation)?;
            remote_file
                .flush()
                .await
                .map_err(|e| format!("Cannot flush remote file {remote}: {e}"))
        }
        .await;
        let close_result = remote_file
            .shutdown()
            .await
            .map_err(|e| format!("Cannot close remote file {remote}: {e}"));
        match transfer_result {
            Err(error) => Err(error),
            Ok(()) => close_result,
        }
    })
}

async fn cleanup_created_entries(
    sftp: &SftpSession,
    created: &[CreatedRemoteEntry],
) -> Vec<String> {
    let mut errors = Vec::new();
    for entry in created_entries_for_cleanup(created) {
        let result = match entry {
            CreatedRemoteEntry::File(path) => sftp.remove_file(path).await,
            CreatedRemoteEntry::Directory(path) => sftp.remove_dir(path).await,
        };
        if let Err(error) = result {
            let path = match entry {
                CreatedRemoteEntry::File(path) | CreatedRemoteEntry::Directory(path) => path,
            };
            errors.push(format!("{path}: {error}"));
        }
    }
    errors
}

fn created_entries_for_cleanup(
    created: &[CreatedRemoteEntry],
) -> impl Iterator<Item = &CreatedRemoteEntry> {
    created.iter().rev()
}

#[tauri::command(async)]
pub fn sftp_disconnect(
    state: tauri::State<'_, Arc<ExplorerManager>>,
    session_id: u32,
) -> Result<(), String> {
    let state_clone = Arc::clone(&*state);

    state.runtime.block_on(async {
        cancel_session_uploads(&state_clone.active_uploads, session_id).await;
        let mut sessions = state_clone.sftp_sessions.lock().await;
        sessions.remove(&session_id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ActiveUpload, CreatedRemoteEntry, LocalUploadEntry, SshHandler, UploadProgress,
        bounded_local_reader, cancel_session_uploads, cancel_upload_state, claim_upload_state,
        connect_sftp_session, created_entries_for_cleanup, ensure_streamed_local_length,
        ensure_upload_not_cancelled, finish_upload_state, local_upload_size,
        open_secure_local_manifest, register_upload_state, release_upload_state, remote_join,
        reopen_secured_local_directory, reopen_secured_local_file, upload_and_publish_entry,
        validate_upload_name, verify_known_host_at,
    };
    use russh::keys::key::PrivateKeyWithHashAlg;
    use russh::server::{Auth, Msg, Server as _, Session};
    use russh::{Channel, ChannelId};
    use russh_sftp::protocol::{
        Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
    };
    use std::collections::{HashMap, HashSet};
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{Mutex, oneshot};

    const TEST_USER: &str = "mymux-e2e";
    const TEST_PASSWORD: &str = "loopback-password-only";

    #[derive(Default)]
    struct TestServerState {
        files: HashMap<String, Vec<u8>>,
        dirs: HashSet<String>,
        handles: HashMap<String, String>,
        open_flags: Vec<OpenFlags>,
        rename_calls: Vec<(String, String)>,
        write_paths: Vec<String>,
        inject_target_before_rename: Option<(String, Vec<u8>)>,
        next_handle: u64,
        publickey_attempts: usize,
        password_attempts: usize,
        password_accepts: usize,
        fail_write_after: Option<usize>,
    }

    #[derive(Clone)]
    struct TestSshServer {
        state: Arc<Mutex<TestServerState>>,
    }

    impl russh::server::Server for TestSshServer {
        type Handler = TestSshSession;

        fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
            TestSshSession {
                state: Arc::clone(&self.state),
                channels: HashMap::new(),
            }
        }
    }

    struct TestSshSession {
        state: Arc<Mutex<TestServerState>>,
        channels: HashMap<ChannelId, Channel<Msg>>,
    }

    impl russh::server::Handler for TestSshSession {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            let accepted = user == TEST_USER && password == TEST_PASSWORD;
            let mut state = self.state.lock().await;
            state.password_attempts += 1;
            if accepted {
                state.password_accepts += 1;
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _public_key: &russh::keys::PublicKey,
        ) -> Result<Auth, Self::Error> {
            self.state.lock().await.publickey_attempts += 1;
            Ok(Auth::reject())
        }

        async fn channel_open_session(
            &mut self,
            channel: Channel<Msg>,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            self.channels.insert(channel.id(), channel);
            Ok(true)
        }

        async fn subsystem_request(
            &mut self,
            channel_id: ChannelId,
            name: &str,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            if name != "sftp" {
                session.channel_failure(channel_id)?;
                return Ok(());
            }
            let Some(channel) = self.channels.remove(&channel_id) else {
                session.channel_failure(channel_id)?;
                return Ok(());
            };
            session.channel_success(channel_id)?;
            russh_sftp::server::run(
                channel.into_stream(),
                TestSftpHandler {
                    state: Arc::clone(&self.state),
                },
            )
            .await;
            Ok(())
        }
    }

    struct TestSftpHandler {
        state: Arc<Mutex<TestServerState>>,
    }

    fn status_ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }

    fn file_attributes(bytes: &[u8]) -> FileAttributes {
        let mut attributes = FileAttributes::empty();
        attributes.size = Some(bytes.len() as u64);
        attributes.set_regular(true);
        attributes
    }

    fn directory_attributes() -> FileAttributes {
        let mut attributes = FileAttributes::empty();
        attributes.set_dir(true);
        attributes
    }

    fn safe_test_path(path: &str) -> bool {
        path.starts_with('/')
            && path.len() > 1
            && !path.contains('\\')
            && path
                .split('/')
                .skip(1)
                .all(|component| !component.is_empty() && component != "." && component != "..")
    }

    impl russh_sftp::server::Handler for TestSftpHandler {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn init(
            &mut self,
            _version: u32,
            _extensions: HashMap<String, String>,
        ) -> Result<Version, Self::Error> {
            Ok(Version::new())
        }

        async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, Self::Error> {
            Ok(Name {
                id,
                files: vec![File::dummy("/")],
            })
        }

        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            if path != "/" && !safe_test_path(&path) {
                return Err(StatusCode::PermissionDenied);
            }
            let state = self.state.lock().await;
            let attrs = if path == "/" || state.dirs.contains(&path) {
                directory_attributes()
            } else {
                let bytes = state.files.get(&path).ok_or(StatusCode::NoSuchFile)?;
                file_attributes(bytes)
            };
            Ok(Attrs { id, attrs })
        }

        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            self.stat(id, path).await
        }

        async fn open(
            &mut self,
            id: u32,
            filename: String,
            pflags: OpenFlags,
            _attrs: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            if !safe_test_path(&filename) {
                return Err(StatusCode::PermissionDenied);
            }
            let mut state = self.state.lock().await;
            state.open_flags.push(pflags);
            let exists = state.files.contains_key(&filename) || state.dirs.contains(&filename);
            if pflags.contains(OpenFlags::CREATE) && pflags.contains(OpenFlags::EXCLUDE) && exists {
                return Err(StatusCode::Failure);
            }
            if !exists && !pflags.contains(OpenFlags::CREATE) {
                return Err(StatusCode::NoSuchFile);
            }
            if !exists {
                state.files.insert(filename.clone(), Vec::new());
            } else if state.dirs.contains(&filename) {
                return Err(StatusCode::Failure);
            } else if pflags.contains(OpenFlags::TRUNCATE) {
                state.files.get_mut(&filename).unwrap().clear();
            }
            state.next_handle += 1;
            let handle = format!("handle-{}", state.next_handle);
            state.handles.insert(handle.clone(), filename);
            Ok(Handle { id, handle })
        }

        async fn write(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, Self::Error> {
            let mut state = self.state.lock().await;
            let path = state
                .handles
                .get(&handle)
                .cloned()
                .ok_or(StatusCode::Failure)?;
            state.write_paths.push(path.clone());
            if state.fail_write_after.is_some_and(|threshold| {
                state
                    .files
                    .get(&path)
                    .is_some_and(|file| file.len() >= threshold)
            }) {
                state.fail_write_after = None;
                return Err(StatusCode::Failure);
            }
            let file = state.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
            let offset = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
            let end = offset.checked_add(data.len()).ok_or(StatusCode::Failure)?;
            if file.len() < end {
                file.resize(end, 0);
            }
            file[offset..end].copy_from_slice(&data);
            Ok(status_ok(id))
        }

        async fn read(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, Self::Error> {
            let state = self.state.lock().await;
            let path = state.handles.get(&handle).ok_or(StatusCode::Failure)?;
            let file = state.files.get(path).ok_or(StatusCode::NoSuchFile)?;
            let offset = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
            if offset >= file.len() {
                return Err(StatusCode::Eof);
            }
            let end = offset.saturating_add(len as usize).min(file.len());
            Ok(Data {
                id,
                data: file[offset..end].to_vec(),
            })
        }

        async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
            if self.state.lock().await.handles.remove(&handle).is_none() {
                return Err(StatusCode::Failure);
            }
            Ok(status_ok(id))
        }

        async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
            if self.state.lock().await.files.remove(&filename).is_none() {
                return Err(StatusCode::NoSuchFile);
            }
            Ok(status_ok(id))
        }

        async fn mkdir(
            &mut self,
            id: u32,
            path: String,
            _attrs: FileAttributes,
        ) -> Result<Status, Self::Error> {
            if !safe_test_path(&path) {
                return Err(StatusCode::PermissionDenied);
            }
            let mut state = self.state.lock().await;
            if state.files.contains_key(&path) || !state.dirs.insert(path) {
                return Err(StatusCode::Failure);
            }
            Ok(status_ok(id))
        }

        async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
            let mut state = self.state.lock().await;
            let prefix = format!("{path}/");
            if state.files.keys().any(|item| item.starts_with(&prefix))
                || state
                    .dirs
                    .iter()
                    .any(|item| item != &path && item.starts_with(&prefix))
            {
                return Err(StatusCode::Failure);
            }
            if !state.dirs.remove(&path) {
                return Err(StatusCode::NoSuchFile);
            }
            Ok(status_ok(id))
        }

        async fn rename(
            &mut self,
            id: u32,
            oldpath: String,
            newpath: String,
        ) -> Result<Status, Self::Error> {
            if !safe_test_path(&oldpath) || !safe_test_path(&newpath) {
                return Err(StatusCode::PermissionDenied);
            }
            let mut state = self.state.lock().await;
            if state
                .inject_target_before_rename
                .as_ref()
                .is_some_and(|(path, _)| path == &newpath)
            {
                let (_, bytes) = state.inject_target_before_rename.take().unwrap();
                state.files.insert(newpath.clone(), bytes);
            }
            if state.files.contains_key(&newpath) || state.dirs.contains(&newpath) {
                return Err(StatusCode::Failure);
            }
            let old_prefix = format!("{oldpath}/");
            if state
                .handles
                .values()
                .any(|path| path == &oldpath || path.starts_with(&old_prefix))
            {
                return Err(StatusCode::Failure);
            }
            if let Some(bytes) = state.files.remove(&oldpath) {
                state.files.insert(newpath.clone(), bytes);
            } else if state.dirs.contains(&oldpath) {
                let new_prefix = format!("{newpath}/");
                let moved_files: Vec<_> = state
                    .files
                    .keys()
                    .filter(|path| path.starts_with(&old_prefix))
                    .cloned()
                    .collect();
                for old_file in moved_files {
                    let bytes = state.files.remove(&old_file).unwrap();
                    let new_file = format!("{new_prefix}{}", &old_file[old_prefix.len()..]);
                    state.files.insert(new_file, bytes);
                }
                let moved_dirs: Vec<_> = state
                    .dirs
                    .iter()
                    .filter(|path| *path == &oldpath || path.starts_with(&old_prefix))
                    .cloned()
                    .collect();
                for old_dir in moved_dirs {
                    state.dirs.remove(&old_dir);
                    let new_dir = if old_dir == oldpath {
                        newpath.clone()
                    } else {
                        format!("{new_prefix}{}", &old_dir[old_prefix.len()..])
                    };
                    state.dirs.insert(new_dir);
                }
            } else {
                return Err(StatusCode::NoSuchFile);
            }
            state.rename_calls.push((oldpath, newpath));
            Ok(status_ok(id))
        }
    }

    async fn start_test_server(
        state: Arc<Mutex<TestServerState>>,
    ) -> (
        u16,
        russh::server::RunningServerHandle,
        tokio::task::JoinHandle<std::io::Result<()>>,
    ) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: vec![
                russh::keys::PrivateKey::random(
                    &mut russh::keys::ssh_key::rand_core::OsRng,
                    russh::keys::Algorithm::Ed25519,
                )
                .unwrap(),
            ],
            ..Default::default()
        });
        let (ready_tx, ready_rx) = oneshot::channel();
        let server_task = tokio::spawn(async move {
            let mut server = TestSshServer { state };
            let running = server.run_on_socket(config, &listener);
            let _ = ready_tx.send(running.handle());
            running.await
        });
        let shutdown = ready_rx.await.unwrap();
        (port, shutdown, server_task)
    }

    fn unique_test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mymux-sftp-e2e-{}-{nonce}", std::process::id()))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sftp_upload_e2e_password_auth_no_overwrite_and_content() {
        let temp_dir = unique_test_dir();
        std::fs::create_dir_all(&temp_dir).unwrap();
        let local_path = temp_dir.join("payload.bin");
        let payload = b"Mymux loopback SFTP E2E\0with exact bytes".to_vec();
        std::fs::write(&local_path, &payload).unwrap();
        let known_hosts_path = temp_dir.join("known_hosts");

        let server_state = Arc::new(Mutex::new(TestServerState::default()));
        let (port, shutdown, server_task) = start_test_server(Arc::clone(&server_state)).await;

        let probe_handler = SshHandler {
            host: "127.0.0.1".to_string(),
            port,
            known_hosts_path: Some(known_hosts_path.clone()),
        };
        let mut probe = super::client::connect(
            Arc::new(super::client::Config::default()),
            ("127.0.0.1", port),
            probe_handler,
        )
        .await
        .unwrap();
        let probe_key = russh::keys::PrivateKey::random(
            &mut russh::keys::ssh_key::rand_core::OsRng,
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let rejected = probe
            .authenticate_publickey(
                TEST_USER,
                PrivateKeyWithHashAlg::new(Arc::new(probe_key), None),
            )
            .await
            .unwrap();
        assert!(!rejected.success(), "test server accepted a public key");
        drop(probe);

        let wrong_password = connect_sftp_session(
            "127.0.0.1",
            port,
            TEST_USER,
            Some("wrong-password"),
            None,
            Some(known_hosts_path.clone()),
            None,
        )
        .await;
        assert!(
            wrong_password.is_err(),
            "test server accepted a non-test password"
        );

        let session = connect_sftp_session(
            "127.0.0.1",
            port,
            TEST_USER,
            Some(TEST_PASSWORD),
            None,
            Some(known_hosts_path.clone()),
            None,
        )
        .await
        .unwrap();

        {
            let state = server_state.lock().await;
            assert_eq!(state.publickey_attempts, 1);
            assert_eq!(state.password_attempts, 2);
            assert_eq!(state.password_accepts, 1);
        }
        assert!(
            known_hosts_path.is_file(),
            "TOFU host key was not written to the isolated test path"
        );

        let progress = UploadProgress {
            app: None,
            upload_id: "loopback-e2e",
            transferred: AtomicU64::new(0),
            total: payload.len() as u64,
        };
        let cancellation = AtomicBool::new(false);
        upload_and_publish_entry(
            &session.sftp,
            open_secure_local_manifest(&local_path).unwrap(),
            "/payload.bin".to_string(),
            &progress,
            &cancellation,
        )
        .await
        .unwrap();

        assert_eq!(
            progress.transferred.load(Ordering::Relaxed),
            payload.len() as u64
        );
        {
            let state = server_state.lock().await;
            let flags = state.open_flags.first().expect("no SFTP open recorded");
            assert!(flags.contains(OpenFlags::CREATE));
            assert!(flags.contains(OpenFlags::EXCLUDE));
            assert!(flags.contains(OpenFlags::WRITE));
            assert!(
                state
                    .write_paths
                    .iter()
                    .all(|path| path.starts_with("/.mymux-upload-")),
                "the final path was exposed during write: {:?}",
                state.write_paths
            );
            assert_eq!(state.rename_calls.len(), 1);
            assert_eq!(state.rename_calls[0].1, "/payload.bin");
            assert!(state.rename_calls[0].0.starts_with("/.mymux-upload-"));
            assert!(
                state
                    .files
                    .keys()
                    .all(|path| !path.starts_with("/.mymux-upload-"))
            );
        }

        let duplicate_error = upload_and_publish_entry(
            &session.sftp,
            open_secure_local_manifest(&local_path).unwrap(),
            "/payload.bin".to_string(),
            &progress,
            &cancellation,
        )
        .await
        .unwrap_err();
        assert!(
            duplicate_error.contains("Remote item already exists: /payload.bin"),
            "unexpected duplicate error: {duplicate_error}"
        );

        let mut remote_file = session.sftp.open("/payload.bin").await.unwrap();
        let mut remote_bytes = Vec::new();
        remote_file.read_to_end(&mut remote_bytes).await.unwrap();
        remote_file.shutdown().await.unwrap();
        assert_eq!(remote_bytes, payload);

        let large_local_path = temp_dir.join("large.bin");
        let large_payload = vec![0x5a; 160 * 1024];
        std::fs::write(&large_local_path, &large_payload).unwrap();
        server_state.lock().await.fail_write_after = Some(64 * 1024);
        let failing_progress = UploadProgress {
            app: None,
            upload_id: "loopback-failure",
            transferred: AtomicU64::new(0),
            total: large_payload.len() as u64,
        };
        let failure = upload_and_publish_entry(
            &session.sftp,
            open_secure_local_manifest(&large_local_path).unwrap(),
            "/failing.bin".to_string(),
            &failing_progress,
            &cancellation,
        )
        .await
        .unwrap_err();
        assert!(failure.contains("Upload failed for"), "{failure}");
        {
            let state = server_state.lock().await;
            assert!(
                !state.files.contains_key("/failing.bin"),
                "failed upload exposed a final partial file"
            );
            assert!(
                state
                    .files
                    .keys()
                    .all(|path| !path.starts_with("/.mymux-upload-")),
                "failed upload left a temp file: {:?}",
                state.files.keys().collect::<Vec<_>>()
            );
        }

        let raced_bytes = b"created by another client".to_vec();
        server_state.lock().await.inject_target_before_rename =
            Some(("/raced.bin".to_string(), raced_bytes.clone()));
        let race_error = upload_and_publish_entry(
            &session.sftp,
            open_secure_local_manifest(&large_local_path).unwrap(),
            "/raced.bin".to_string(),
            &failing_progress,
            &cancellation,
        )
        .await
        .unwrap_err();
        assert!(
            race_error.contains("Cannot publish remote item"),
            "{race_error}"
        );
        {
            let state = server_state.lock().await;
            assert_eq!(state.files.get("/raced.bin"), Some(&raced_bytes));
            assert!(
                state
                    .files
                    .keys()
                    .all(|path| !path.starts_with("/.mymux-upload-"))
            );
        }

        let local_dir = temp_dir.join("tree");
        let local_nested = local_dir.join("nested");
        std::fs::create_dir_all(&local_nested).unwrap();
        std::fs::write(local_nested.join("child.txt"), b"directory publish").unwrap();
        let directory_progress = UploadProgress {
            app: None,
            upload_id: "loopback-directory",
            transferred: AtomicU64::new(0),
            total: 17,
        };
        upload_and_publish_entry(
            &session.sftp,
            open_secure_local_manifest(&local_dir).unwrap(),
            "/tree".to_string(),
            &directory_progress,
            &cancellation,
        )
        .await
        .unwrap();
        {
            let state = server_state.lock().await;
            assert!(state.dirs.contains("/tree"));
            assert!(state.dirs.contains("/tree/nested"));
            assert_eq!(
                state.files.get("/tree/nested/child.txt"),
                Some(&b"directory publish".to_vec())
            );
            assert!(
                state
                    .dirs
                    .iter()
                    .all(|path| !path.starts_with("/.mymux-upload-"))
            );
            assert_eq!(state.rename_calls.last().unwrap().1, "/tree");
        }

        session.sftp.close().await.unwrap();
        drop(session);
        shutdown.shutdown("test complete".to_string());
        server_task.await.unwrap().unwrap();
        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[tokio::test]
    async fn upload_state_binds_session_destination_and_in_flight_lifecycle() {
        let uploads: Mutex<HashMap<String, ActiveUpload>> = Mutex::new(HashMap::new());
        assert!(
            claim_upload_state(&uploads, "unregistered", 7, "/srv/uploads")
                .await
                .unwrap_err()
                .contains("not registered")
        );
        let upload_id = register_upload_state(&uploads, 7, "/srv/uploads".to_string()).await;

        assert!(
            claim_upload_state(&uploads, &upload_id, 8, "/srv/uploads")
                .await
                .unwrap_err()
                .contains("session")
        );
        assert!(
            claim_upload_state(&uploads, &upload_id, 7, "/srv/other")
                .await
                .unwrap_err()
                .contains("destination")
        );
        let cancellation = claim_upload_state(&uploads, &upload_id, 7, "/srv/uploads")
            .await
            .unwrap();
        assert!(finish_upload_state(&uploads, &upload_id).await.is_err());
        cancel_upload_state(&uploads, &upload_id).await.unwrap();
        assert!(cancellation.load(Ordering::Acquire));
        release_upload_state(&uploads, &upload_id).await;
        finish_upload_state(&uploads, &upload_id).await.unwrap();
        assert!(cancel_upload_state(&uploads, &upload_id).await.is_err());

        let first = register_upload_state(&uploads, 11, "/one".to_string()).await;
        let second = register_upload_state(&uploads, 12, "/two".to_string()).await;
        cancel_session_uploads(&uploads, 11).await;
        let states = uploads.lock().await;
        assert!(
            states
                .get(&first)
                .unwrap()
                .cancellation
                .load(Ordering::Acquire)
        );
        assert!(
            !states
                .get(&second)
                .unwrap()
                .cancellation
                .load(Ordering::Acquire)
        );
    }

    #[test]
    fn known_hosts_is_fail_closed_and_uses_only_isolated_test_paths() {
        assert!(verify_known_host_at(None, "host", 22, "ssh-ed25519 AAAA").is_err());

        let temp_dir = unique_test_dir();
        std::fs::create_dir_all(&temp_dir).unwrap();
        let known_hosts = temp_dir.join("nested").join("known_hosts");
        assert_eq!(
            verify_known_host_at(
                Some(&known_hosts),
                "example.test",
                2222,
                "ssh-ed25519 AAAATEST",
            ),
            Ok(true)
        );
        assert_eq!(
            verify_known_host_at(
                Some(&known_hosts),
                "example.test",
                2222,
                "ssh-ed25519 AAAATEST",
            ),
            Ok(true)
        );
        assert_eq!(
            verify_known_host_at(
                Some(&known_hosts),
                "example.test",
                2222,
                "ssh-ed25519 CHANGED",
            ),
            Ok(false)
        );

        let blocking_file = temp_dir.join("not-a-directory");
        std::fs::write(&blocking_file, b"block parent creation").unwrap();
        let impossible_path = blocking_file.join("known_hosts");
        assert!(
            verify_known_host_at(
                Some(&impossible_path),
                "failure.test",
                22,
                "ssh-ed25519 AAAAFAIL",
            )
            .is_err()
        );
        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    #[ignore = "launched by the cross-process known-hosts race test"]
    fn known_hosts_process_writer_helper() {
        let known_hosts = PathBuf::from(
            std::env::var("MYMUX_KNOWN_HOSTS_RACE_PATH")
                .expect("race helper requires known-hosts path"),
        );
        let ready_dir = PathBuf::from(
            std::env::var("MYMUX_KNOWN_HOSTS_RACE_READY")
                .expect("race helper requires ready directory"),
        );
        let gate = PathBuf::from(
            std::env::var("MYMUX_KNOWN_HOSTS_RACE_GATE").expect("race helper requires gate path"),
        );
        let result_dir = PathBuf::from(
            std::env::var("MYMUX_KNOWN_HOSTS_RACE_RESULT")
                .expect("race helper requires result directory"),
        );
        let index =
            std::env::var("MYMUX_KNOWN_HOSTS_RACE_INDEX").expect("race helper requires index");
        std::fs::write(ready_dir.join(&index), []).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !gate.is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.is_file(), "race helper gate timed out");
        let accepted = verify_known_host_at(
            Some(&known_hosts),
            "same-host.test",
            22,
            &format!("ssh-ed25519 KEY-{index}"),
        )
        .unwrap();
        std::fs::write(result_dir.join(index), accepted.to_string()).unwrap();
    }

    #[test]
    fn known_hosts_serializes_concurrent_first_connect_processes() {
        let temp_dir = unique_test_dir();
        std::fs::create_dir_all(&temp_dir).unwrap();
        let known_hosts = temp_dir.join("known_hosts");
        let ready_dir = temp_dir.join("ready");
        let result_dir = temp_dir.join("result");
        let gate = temp_dir.join("start");
        std::fs::create_dir_all(&ready_dir).unwrap();
        std::fs::create_dir_all(&result_dir).unwrap();
        let participant_count = 8;
        let current_test_binary = std::env::current_exe().unwrap();
        let mut children = Vec::new();

        for index in 0..participant_count {
            children.push(
                std::process::Command::new(&current_test_binary)
                    .args([
                        "--ignored",
                        "--exact",
                        "explorer::tests::known_hosts_process_writer_helper",
                        "--test-threads=1",
                    ])
                    .env("MYMUX_KNOWN_HOSTS_RACE_PATH", &known_hosts)
                    .env("MYMUX_KNOWN_HOSTS_RACE_READY", &ready_dir)
                    .env("MYMUX_KNOWN_HOSTS_RACE_GATE", &gate)
                    .env("MYMUX_KNOWN_HOSTS_RACE_RESULT", &result_dir)
                    .env("MYMUX_KNOWN_HOSTS_RACE_INDEX", index.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }

        let ready_deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::fs::read_dir(&ready_dir).unwrap().count() < participant_count
            && std::time::Instant::now() < ready_deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            std::fs::read_dir(&ready_dir).unwrap().count(),
            participant_count,
            "not all race helpers became ready"
        );
        std::fs::write(&gate, []).unwrap();

        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "known-hosts process helper failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let content = std::fs::read_to_string(&known_hosts).unwrap();
        let lines: Vec<_> = content.lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("[same-host.test]:22 ssh-ed25519 KEY-"));
        let mut accepted_count = 0;
        for index in 0..participant_count {
            let result = std::fs::read_to_string(result_dir.join(index.to_string())).unwrap();
            if result == "true" {
                accepted_count += 1;
                assert_eq!(
                    lines[0],
                    format!("[same-host.test]:22 ssh-ed25519 KEY-{index}")
                );
            } else {
                assert_eq!(result, "false");
            }
        }
        assert_eq!(accepted_count, 1);
        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn remote_join_handles_root_and_nested_paths() {
        assert_eq!(remote_join("/", "file.txt"), "/file.txt");
        assert_eq!(remote_join("/home/user/", "folder"), "/home/user/folder");
    }

    #[test]
    fn upload_names_reject_path_traversal() {
        assert!(validate_upload_name("safe.txt").is_ok());
        assert!(validate_upload_name("..").is_err());
        assert!(validate_upload_name("../escape").is_err());
        assert!(validate_upload_name(r"..\escape").is_err());
    }

    #[test]
    fn upload_cancellation_flag_is_sticky_and_identifiable() {
        let cancellation = AtomicBool::new(false);
        assert!(ensure_upload_not_cancelled(&cancellation).is_ok());
        cancellation.store(true, Ordering::Release);
        let error = ensure_upload_not_cancelled(&cancellation).unwrap_err();
        assert!(error.starts_with("UPLOAD_CANCELLED:"));
        assert!(ensure_upload_not_cancelled(&cancellation).is_err());
    }

    #[test]
    fn cleanup_journal_is_processed_in_reverse_creation_order() {
        let created = vec![
            CreatedRemoteEntry::Directory("/upload".to_string()),
            CreatedRemoteEntry::Directory("/upload/nested".to_string()),
            CreatedRemoteEntry::File("/upload/nested/file.bin".to_string()),
        ];
        let cleanup: Vec<_> = created_entries_for_cleanup(&created).cloned().collect();
        assert_eq!(
            cleanup,
            vec![
                CreatedRemoteEntry::File("/upload/nested/file.bin".to_string()),
                CreatedRemoteEntry::Directory("/upload/nested".to_string()),
                CreatedRemoteEntry::Directory("/upload".to_string()),
            ]
        );
    }

    #[test]
    fn upload_size_sums_directory_files() {
        let root = unique_test_dir();
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("a.bin"), [1_u8, 2, 3]).unwrap();
        std::fs::write(nested.join("b.bin"), [4_u8, 5]).unwrap();
        assert_eq!(local_upload_size(&root).unwrap(), 5);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn secure_manifest_rejects_symlinks_and_detects_file_replacement() {
        let temp_dir = unique_test_dir();
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source = temp_dir.join("payload.bin");
        let moved_source = temp_dir.join("payload-original.bin");
        std::fs::write(&source, b"original").unwrap();

        let manifest = open_secure_local_manifest(&source).unwrap();
        let super::LocalUploadManifest {
            name,
            root_parent,
            entry,
            ..
        } = manifest;
        let LocalUploadEntry::File { identity, length } = entry else {
            panic!("expected file manifest");
        };

        match std::fs::rename(&source, &moved_source) {
            Ok(()) => {
                std::fs::write(&source, b"replaced").unwrap();
                let error =
                    reopen_secured_local_file(&root_parent, &name, identity, length).unwrap_err();
                assert!(error.contains("changed after secure preflight"));
            }
            Err(error) => {
                // A platform may prevent replacement while the parent capability is open.
                // That is an equally safe outcome for this race.
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::Other
                            | std::io::ErrorKind::WouldBlock
                    ),
                    "unexpected replacement error: {error}"
                );
            }
        }
        drop(root_parent);

        let outside = temp_dir.join("outside.bin");
        let link = temp_dir.join("link.bin");
        std::fs::write(&outside, b"outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(open_secure_local_manifest(&link).is_err());
        }
        #[cfg(windows)]
        {
            match std::os::windows::fs::symlink_file(&outside, &link) {
                Ok(()) => assert!(open_secure_local_manifest(&link).is_err()),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                    ) || error.raw_os_error() == Some(1314) =>
                {
                    eprintln!("symlink creation unavailable; replacement assertion still ran");
                }
                Err(error) => panic!("cannot create test symlink: {error}"),
            }
        }

        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn secure_manifest_detects_directory_replacement_after_handles_are_released() {
        let temp_dir = unique_test_dir();
        let source = temp_dir.join("selected");
        let moved_source = temp_dir.join("selected-original");
        std::fs::create_dir_all(&source).unwrap();

        let manifest = open_secure_local_manifest(&source).unwrap();
        let super::LocalUploadManifest {
            name,
            root_parent,
            entry,
            ..
        } = manifest;
        let LocalUploadEntry::Directory { identity, .. } = entry else {
            panic!("expected directory manifest");
        };

        match std::fs::rename(&source, &moved_source) {
            Ok(()) => {
                std::fs::create_dir(&source).unwrap();
                let error =
                    reopen_secured_local_directory(&root_parent, &name, identity).unwrap_err();
                assert!(error.contains("changed after secure preflight"));
            }
            Err(error) => {
                // If the platform denies replacement, the race is prevented
                // before the identity check is needed.
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::Other
                            | std::io::ErrorKind::WouldBlock
                    ),
                    "unexpected directory replacement error: {error}"
                );
            }
        }

        drop(root_parent);
        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[tokio::test]
    async fn secure_local_stream_ignores_appends_and_rejects_early_eof() {
        let temp_dir = unique_test_dir();
        std::fs::create_dir_all(&temp_dir).unwrap();

        let appended_path = temp_dir.join("appended.bin");
        std::fs::write(&appended_path, b"abc").unwrap();
        let appended_manifest = open_secure_local_manifest(&appended_path).unwrap();
        let super::LocalUploadManifest {
            name,
            root_parent,
            entry,
            ..
        } = appended_manifest;
        let LocalUploadEntry::File { identity, length } = entry else {
            panic!("expected file manifest");
        };
        let appended_file =
            reopen_secured_local_file(&root_parent, &name, identity, length).unwrap();
        let mut appended_reader = bounded_local_reader(appended_file, length);
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&appended_path)
            .unwrap()
            .write_all(b"def")
            .unwrap();
        let mut appended_bytes = Vec::new();
        appended_reader
            .read_to_end(&mut appended_bytes)
            .await
            .unwrap();
        assert_eq!(appended_bytes, b"abc");
        assert!(ensure_streamed_local_length("appended.bin", length, 3).is_ok());
        drop(appended_reader);
        drop(root_parent);

        let truncated_path = temp_dir.join("truncated.bin");
        std::fs::write(&truncated_path, b"abcdef").unwrap();
        let truncated_manifest = open_secure_local_manifest(&truncated_path).unwrap();
        let super::LocalUploadManifest {
            name,
            root_parent,
            entry,
            ..
        } = truncated_manifest;
        let LocalUploadEntry::File { identity, length } = entry else {
            panic!("expected file manifest");
        };
        let truncated_file =
            reopen_secured_local_file(&root_parent, &name, identity, length).unwrap();
        let mut truncated_reader = bounded_local_reader(truncated_file, length);
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&truncated_path)
            .unwrap();
        let mut truncated_bytes = Vec::new();
        truncated_reader
            .read_to_end(&mut truncated_bytes)
            .await
            .unwrap();
        assert!(
            ensure_streamed_local_length("truncated.bin", length, truncated_bytes.len() as u64)
                .is_err()
        );
        drop(truncated_reader);
        drop(root_parent);

        std::fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn secure_manifest_scales_without_holding_every_directory_open() {
        let temp_dir = unique_test_dir();
        let root = temp_dir.join("many-directories");
        std::fs::create_dir_all(&root).unwrap();
        let directory_count = 1_500;
        for index in 0..directory_count {
            std::fs::create_dir(root.join(format!("{index:04}"))).unwrap();
        }

        let manifest = open_secure_local_manifest(&root).unwrap();
        assert_eq!(manifest.total, 0);
        let LocalUploadEntry::Directory { children, .. } = &manifest.entry else {
            panic!("expected directory manifest");
        };
        assert_eq!(children.len(), directory_count);

        drop(manifest);
        std::fs::remove_dir_all(temp_dir).unwrap();
    }
}
