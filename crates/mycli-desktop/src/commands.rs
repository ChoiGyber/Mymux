use mycli_core::{CommandStore, SavedCommand};
use serde::Serialize;

#[derive(Serialize)]
pub struct CommandDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    pub favorite: bool,
    #[serde(rename = "favoriteTarget")]
    pub favorite_target: String,
    pub cwd: String,
    pub alias: String,
}

impl From<SavedCommand> for CommandDto {
    fn from(c: SavedCommand) -> Self {
        Self {
            id: c.id,
            name: c.name,
            command: c.command,
            description: c.description,
            favorite: c.favorite,
            favorite_target: c.favorite_target,
            cwd: c.cwd,
            alias: c.alias,
        }
    }
}

fn store() -> Result<CommandStore, String> {
    CommandStore::new().map_err(|e| e.to_string())
}

/// Built-in shortcut commands, seeded once. The autocomplete matches these by
/// name in any shell (PowerShell / Git Bash / CMD), so typing e.g. `cl` offers
/// `claude --dangerously-skip-permissions`.
const DEFAULT_COMMANDS: &[(&str, &str, &str)] = &[
    ("cl", "claude --dangerously-skip-permissions", "Claude Code (skip permission prompts)"),
    ("cc", "claude --continue", "Claude Code: continue"),
    ("cr", "claude --resume", "Claude Code: resume session"),
    ("cp", "claude update", "Update Claude Code"),
    ("cy", "codex --yolo", "Codex (yolo mode)"),
    ("co", "codex", "Run Codex"),
    ("cor", "codex resume", "Codex: resume session"),
    ("cle", "clear", "Clear the screen"),
    ("c&p", "git add -A && git commit -m \"update\" && git push", "Commit and push"),
];

const DEFAULT_WORKLOG_COMMAND: (&str, &str, &str, &str) = (
    "작업기록 남기고 마무리",
    "작업기록 남기고 마무리해줘",
    "AI session: record completed work and finish the task.",
    "LOG",
);

/// Seed built-in shortcuts once (tracked by a marker file so deletions stick).
fn seed_default_commands(s: &CommandStore) {
    let marker = match dirs::home_dir() {
        Some(h) => h.join(".mycli").join(".defaults_seeded"),
        None => return,
    };
    if !marker.exists() {
        let existing = s.list().unwrap_or_default();
        for (name, command, desc) in DEFAULT_COMMANDS {
            if !existing.iter().any(|c| c.name == *name) {
                let _ = s.add(SavedCommand::new(
                    name.to_string(),
                    command.to_string(),
                    desc.to_string(),
                ));
            }
        }
        let _ = std::fs::write(&marker, b"1");
    }

    // This was added after the original defaults marker existed. Seed it with
    // its own one-time marker so existing installs receive it without making a
    // command the user deliberately deleted reappear on every launch.
    let worklog_marker = marker.with_file_name(".worklog_command_seeded_v1");
    if worklog_marker.exists() {
        return;
    }
    let existing = s.list().unwrap_or_default();
    if !existing
        .iter()
        .any(|c| c.command == DEFAULT_WORKLOG_COMMAND.1)
    {
        let mut cmd = SavedCommand::new(
            DEFAULT_WORKLOG_COMMAND.0.to_string(),
            DEFAULT_WORKLOG_COMMAND.1.to_string(),
            DEFAULT_WORKLOG_COMMAND.2.to_string(),
        );
        cmd.alias = DEFAULT_WORKLOG_COMMAND.3.to_string();
        cmd.favorite = true;
        cmd.favorite_target = "ai".to_string();
        let _ = s.add(cmd);
    }
    let _ = std::fs::write(&worklog_marker, b"1");
}

#[tauri::command]
pub fn list_commands() -> Result<Vec<CommandDto>, String> {
    let s = store()?;
    seed_default_commands(&s);
    let cmds = s.list().map_err(|e| e.to_string())?;
    Ok(cmds.into_iter().map(CommandDto::from).collect())
}

#[tauri::command]
pub fn add_command(
    name: String,
    command: String,
    description: String,
    cwd: Option<String>,
    alias: Option<String>,
) -> Result<CommandDto, String> {
    let s = store()?;
    let mut cmd = SavedCommand::new(name, command, description);
    cmd.cwd = cwd.unwrap_or_default();
    cmd.alias = alias.unwrap_or_default();
    let dto = CommandDto::from(cmd.clone());
    s.add(cmd).map_err(|e| e.to_string())?;
    Ok(dto)
}

#[tauri::command]
pub fn update_command(
    id: String,
    name: String,
    command: String,
    description: String,
    cwd: Option<String>,
    alias: Option<String>,
) -> Result<(), String> {
    let s = store()?;
    // Preserve shortcut settings; the edit form does not carry either field.
    let existing = s
        .list()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|c| c.id == id)
        .cloned();
    let favorite = existing.as_ref().map(|c| c.favorite).unwrap_or(false);
    let favorite_target = existing
        .as_ref()
        .map(|c| c.favorite_target.clone())
        .unwrap_or_else(|| "shell".to_string());
    let cmd = SavedCommand {
        id,
        name,
        command,
        description,
        favorite,
        favorite_target,
        cwd: cwd.unwrap_or_default(),
        alias: alias.unwrap_or_default(),
    };
    s.update(cmd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_favorite(
    id: String,
    favorite: bool,
    favorite_target: Option<String>,
) -> Result<(), String> {
    let s = store()?;
    let mut cmds = s.list().map_err(|e| e.to_string())?;
    if let Some(c) = cmds.iter_mut().find(|c| c.id == id) {
        c.favorite = favorite;
        if favorite {
            if let Some(target) = favorite_target {
                if matches!(target.as_str(), "shell" | "ai") {
                    c.favorite_target = target;
                }
            }
        }
        s.update(c.clone()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_command(id: String) -> Result<(), String> {
    let s = store()?;
    s.remove(&id).map_err(|e| e.to_string())
}

/// Read a text/code file for the in-app viewer. Returns Err("BINARY") for
/// non-text files (so the frontend can open them with the OS default app),
/// and Err on files larger than ~2 MB.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    use std::io::Read;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err("File is too large (over 2 MB)".into());
    }
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let sample = &buf[..buf.len().min(8000)];
    if sample.contains(&0u8) {
        return Err("BINARY".into());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Save text back to a local file (overwrites). Used by the in-app editor.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Tail of the newest Codex CLI session rollout (~/.codex/sessions/Y/M/D/*.jsonl).
/// The frontend mines it for the last `rate_limits` snapshot so the toolbar can
/// show account-wide Codex usage. Rollouts easily exceed the read_text_file cap,
/// hence a dedicated tail reader. Directory names are zero-padded dates, so the
/// lexicographically largest entry is the newest — only the newest day dir that
/// actually contains a rollout is scanned (by mtime) instead of walking them all.
#[tauri::command]
pub fn codex_rollout_tail(max_bytes: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let max_bytes = max_bytes.unwrap_or(65536).min(1_000_000);
    let sessions = dirs::home_dir()
        .ok_or("Home directory not found")?
        .join(".codex")
        .join("sessions");

    fn sorted_dirs_desc(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        v.sort();
        v.reverse();
        v
    }

    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    'search: for year in sorted_dirs_desc(&sessions) {
        for month in sorted_dirs_desc(&year) {
            for day in sorted_dirs_desc(&month) {
                if let Ok(rd) = std::fs::read_dir(&day) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.extension().is_some_and(|x| x == "jsonl") {
                            if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                                if newest.as_ref().map_or(true, |(t, _)| m > *t) {
                                    newest = Some((m, p));
                                }
                            }
                        }
                    }
                }
                if newest.is_some() {
                    break 'search; // newest day with any rollout is enough
                }
            }
        }
    }

    let (_, path) = newest.ok_or("No codex rollout found")?;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Account-wide Claude usage (5-hour + weekly rate-limit utilization) fetched
/// straight from Anthropic's OAuth usage endpoint, using the token Claude Code
/// already stored in `~/.claude/.credentials.json`. This lets the toolbar's CL
/// readout work WITHOUT oh-my-claudecode's HUD statusline and WITHOUT a Claude
/// session running inside a Mymux pane — a valid stored login is all it needs.
///
/// SAFE MODE — strictly read-only: if the stored token is missing or expired we
/// return an error and the CL segment simply hides. We NEVER refresh the token
/// or rewrite the credentials file, so there is zero chance of racing Claude
/// Code's own token rotation and logging the user out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    five_h: Option<u8>,
    five_h_resets_at: Option<String>,
    wk: Option<u8>,
    wk_resets_at: Option<String>,
}

/// Read Claude Code's stored OAuth credentials blob (JSON string).
///
/// Windows/Linux keep it at `<config>/.credentials.json`. macOS keeps it in the
/// login **Keychain** (generic password, service `Claude Code-credentials`) and
/// writes NO file — so on a Mac the file read always misses and the CL usage
/// readout silently hid. Fall back to reading the Keychain via the `security`
/// CLI (read-only: `find-generic-password -w` only reads, never writes), which
/// returns the very same JSON shape the file would have.
fn read_claude_credentials(config_dir: &std::path::Path) -> Result<String, String> {
    if let Ok(raw) = std::fs::read_to_string(config_dir.join(".credentials.json")) {
        return Ok(raw);
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Ok(s);
            }
        }
    }
    Err("no credentials".to_string())
}

#[tauri::command]
pub async fn claude_account_usage() -> Result<ClaudeUsage, String> {
    // Honor CLAUDE_CONFIG_DIR (custom profiles) the same way Claude Code / OMC do.
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
    let raw = read_claude_credentials(&config_dir)?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // The token lives under `claudeAiOauth` (nested), with a flat-root fallback.
    let oauth = v.get("claudeAiOauth").unwrap_or(&v);
    let token = oauth
        .get("accessToken")
        .and_then(|x| x.as_str())
        .ok_or("no accessToken")?;
    // Expiry gate — no refresh in safe mode. `expiresAt` is epoch milliseconds.
    if let Some(exp) = oauth.get("expiresAt").and_then(|x| x.as_i64()) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if exp <= now_ms {
            return Err("token expired".into());
        }
    }
    // builder().build() surfaces a TLS/backend init failure as an Err instead of
    // panicking the way Client::new() would inside this async command.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("usage api http {}", resp.status().as_u16()));
    }
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // `five_hour.utilization` / `seven_day.utilization` are 0-100 percentages.
    let pct = |bucket: &str| {
        j.get(bucket)
            .and_then(|b| b.get("utilization"))
            .and_then(|u| u.as_f64())
            .map(|f| f.clamp(0.0, 100.0).round() as u8)
    };
    let reset = |bucket: &str| {
        j.get(bucket)
            .and_then(|b| b.get("resets_at"))
            .and_then(|r| r.as_str())
            .map(|s| s.to_string())
    };
    Ok(ClaudeUsage {
        five_h: pct("five_hour"),
        five_h_resets_at: reset("five_hour"),
        wk: pct("seven_day"),
        wk_resets_at: reset("seven_day"),
    })
}

/// Open a path with the OS default application (used for binary/exe files).
/// The path is always passed as a single structured argument — never through a
/// shell — so metacharacters in file names can't inject commands.
#[tauri::command]
pub fn open_external(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW (0x0800_0000) → no flashing console window.
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    // On Unix, dropping a Child does NOT reap it — `open`/`xdg-open` fork the
    // real handler and exit within milliseconds, so spawn-and-drop would leave a
    // defunct (zombie) PID per call for the app's whole lifetime. Reap on a
    // detached thread: non-blocking for the caller, no zombie left behind.
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut child = std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

/// Flash the taskbar icon without stealing focus — called when a terminal
/// bell / completion notification arrives while the window is in the
/// background, so a finished long task is noticeable from another app.
#[tauri::command]
pub fn window_attention(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .request_user_attention(Some(tauri::UserAttentionType::Informational))
        .map_err(|e| e.to_string())
}

/// Show the desktop buddy overlay at the active monitor's bottom-right and hand
/// the finished session's details to its webview. Called when a task completes
/// while the main window is in the background, so the notice is visible even
/// with Mymux minimized or covered by another app. (macOS positions native
/// windows freely too; the OS just tends to be watched top-right — either way
/// the overlay owns its own coordinates.)
#[tauri::command]
pub fn buddy_overlay_show(
    app: tauri::AppHandle,
    session_id: i64,
    title: String,
    character: String,
    dialect: String,
    long_task: bool,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let overlay = app
        .get_webview_window("buddy-overlay")
        .ok_or_else(|| "buddy-overlay window missing".to_string())?;
    // Bottom-right of the current monitor (fall back to the primary monitor).
    let monitor = overlay
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| overlay.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let ms = m.size();
        let mp = m.position();
        if let Ok(os) = overlay.outer_size() {
            // Reserve scales with DPI: a fixed logical margin is more physical
            // pixels at high scale, so multiply by the monitor's scale factor.
            let margin = (24.0 * m.scale_factor()) as i32;
            let reserve = (56.0 * m.scale_factor()) as i32; // clear taskbar / Dock
            let x = mp.x + ms.width as i32 - os.width as i32 - margin;
            let y = mp.y + ms.height as i32 - os.height as i32 - reserve;
            let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    overlay.show().map_err(|e| e.to_string())?;
    let _ = overlay.set_always_on_top(true);
    // Target the overlay explicitly — Tauri v2 emit() broadcasts app-wide.
    app.emit_to(
        "buddy-overlay",
        "buddy:show",
        serde_json::json!({
            "sessionId": session_id,
            "title": title,
            "character": character,
            "dialect": dialect,
            "longTask": long_task,
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide the buddy overlay — its 15s fade-out timer fired, or the app regained
/// focus and no longer needs the desktop notice.
#[tauri::command]
pub fn buddy_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(overlay) = app.get_webview_window("buddy-overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Buddy clicked: bring the main window forward (un-minimize + focus) and tell
/// the frontend which session to jump to.
#[tauri::command]
pub fn buddy_overlay_focus_main(
    app: tauri::AppHandle,
    session_id: Option<i64>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if let Some(overlay) = app.get_webview_window("buddy-overlay") {
        let _ = overlay.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        // Bring the app forward regardless; only the session jump needs an id.
        if let Some(sid) = session_id {
            let _ = app.emit_to("main", "buddy:goto", sid);
        }
    }
    Ok(())
}

/// Open a native file picker and return the chosen path (e.g. an SSH key file).
/// Returns None if the user cancels. Runs on a worker thread (sync command) so
/// the blocking dialog dispatches to the main thread without deadlocking.
#[tauri::command]
pub fn pick_key_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_file()
        .map(|f| f.to_string())
}

/// If the clipboard holds an image, save it as a temp PNG and return its path;
/// otherwise return None. The terminal paste path calls this first so Ctrl+V of
/// a screenshot drops a file path the running tool (Claude Code / Codex) can
/// attach, instead of pasting nothing. Falls back to text paste when None.
#[tauri::command]
pub fn paste_clipboard_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use image::ImageEncoder;
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let img = match app.clipboard().read_image() {
        Ok(img) => img,
        Err(_) => return Ok(None), // no image on the clipboard
    };
    let (width, height) = (img.width(), img.height());

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("mymux-clip-{nanos}.png"));

    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    image::codecs::png::PngEncoder::new(std::io::BufWriter::new(file))
        .write_image(img.rgba(), width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Recursively copy a file or directory tree.
fn copy_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dest)?;
    }
    Ok(())
}

/// Copy `src` (file or folder) into `dest_dir`, keeping its name. Refuses to
/// overwrite an existing item.
#[tauri::command]
pub fn fs_copy_path(src: String, dest_dir: String) -> Result<(), String> {
    let s = std::path::PathBuf::from(&src);
    let name = s.file_name().ok_or("Invalid path")?;
    let d = std::path::Path::new(&dest_dir).join(name);
    if d == s {
        return Err("Same location.".into());
    }
    if d.exists() {
        return Err("An item with the same name already exists.".into());
    }
    copy_recursive(&s, &d).map_err(|e| e.to_string())
}

/// Move `src` (file or folder) into `dest_dir`. Falls back to copy+delete across
/// volumes. Refuses to overwrite an existing item.
#[tauri::command]
pub fn fs_move_path(src: String, dest_dir: String) -> Result<(), String> {
    let s = std::path::PathBuf::from(&src);
    let name = s.file_name().ok_or("Invalid path")?;
    let d = std::path::Path::new(&dest_dir).join(name);
    if d == s {
        return Err("Same location.".into());
    }
    if d.exists() {
        return Err("An item with the same name already exists.".into());
    }
    if std::fs::rename(&s, &d).is_ok() {
        return Ok(());
    }
    // Cross-volume rename fails → copy then remove the source.
    copy_recursive(&s, &d).map_err(|e| e.to_string())?;
    if s.is_dir() {
        std::fs::remove_dir_all(&s).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&s).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create a new folder named `name` inside `dir`. Refuses empty names, names
/// containing path separators, and names that already exist.
#[tauri::command]
pub fn fs_create_dir(dir: String, name: String) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Folder name cannot contain / or \\.".into());
    }
    let target = std::path::Path::new(&dir).join(trimmed);
    if target.exists() {
        return Err("An item with the same name already exists.".into());
    }
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn execute_command(command_text: String) -> Result<String, String> {
    let output = mycli_core::executor::run(&command_text).map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !stderr.is_empty() && !output.status.success() {
        return Err(stderr);
    }

    let mut result = stdout;
    if !stderr.is_empty() {
        result.push_str(&stderr);
    }
    Ok(result)
}
