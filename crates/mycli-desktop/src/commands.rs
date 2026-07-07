use mycli_core::{CommandStore, SavedCommand};
use serde::Serialize;

#[derive(Serialize)]
pub struct CommandDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    pub favorite: bool,
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

/// Seed built-in shortcuts once (tracked by a marker file so deletions stick).
fn seed_default_commands(s: &CommandStore) {
    let marker = match dirs::home_dir() {
        Some(h) => h.join(".mycli").join(".defaults_seeded"),
        None => return,
    };
    if marker.exists() {
        return;
    }
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
    // Preserve the existing favorite flag (the edit form doesn't carry it).
    let favorite = s
        .list()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.favorite)
        .unwrap_or(false);
    let cmd = SavedCommand {
        id,
        name,
        command,
        description,
        favorite,
        cwd: cwd.unwrap_or_default(),
        alias: alias.unwrap_or_default(),
    };
    s.update(cmd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_favorite(id: String, favorite: bool) -> Result<(), String> {
    let s = store()?;
    let mut cmds = s.list().map_err(|e| e.to_string())?;
    if let Some(c) = cmds.iter_mut().find(|c| c.id == id) {
        c.favorite = favorite;
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
