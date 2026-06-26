use mycli_core::{CommandStore, SavedCommand};
use serde::Serialize;

#[derive(Serialize)]
pub struct CommandDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    pub favorite: bool,
}

impl From<SavedCommand> for CommandDto {
    fn from(c: SavedCommand) -> Self {
        Self {
            id: c.id,
            name: c.name,
            command: c.command,
            description: c.description,
            favorite: c.favorite,
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
    ("cl", "claude --dangerously-skip-permissions", "Claude Code (권한 확인 스킵)"),
    ("cc", "claude --continue", "Claude Code 이어서 진행"),
    ("cr", "claude --resume", "Claude Code 세션 재개"),
    ("cp", "claude update", "Claude Code 업데이트"),
    ("cy", "codex --yolo", "Codex (yolo 모드)"),
    ("co", "codex", "Codex 실행"),
    ("cor", "codex resume", "Codex 세션 재개"),
    ("cle", "clear", "화면 지우기"),
    ("c&p", "git add -A && git commit -m \"update\" && git push", "커밋 후 푸시"),
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
pub fn add_command(name: String, command: String, description: String) -> Result<CommandDto, String> {
    let s = store()?;
    let cmd = SavedCommand::new(name, command, description);
    let dto = CommandDto::from(cmd.clone());
    s.add(cmd).map_err(|e| e.to_string())?;
    Ok(dto)
}

#[tauri::command]
pub fn update_command(id: String, name: String, command: String, description: String) -> Result<(), String> {
    let s = store()?;
    // Preserve the existing favorite flag (the edit form doesn't carry it).
    let favorite = s
        .list()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.favorite)
        .unwrap_or(false);
    let cmd = SavedCommand { id, name, command, description, favorite };
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
        return Err("파일이 너무 큽니다 (2MB 초과)".into());
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
#[tauri::command]
pub fn open_external(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer.exe with the path as a single structured argument is not
        // subject to `cmd` metacharacter parsing (avoids command injection).
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
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
    let name = s.file_name().ok_or("잘못된 경로")?;
    let d = std::path::Path::new(&dest_dir).join(name);
    if d == s {
        return Err("같은 위치입니다.".into());
    }
    if d.exists() {
        return Err("같은 이름의 항목이 이미 있습니다.".into());
    }
    copy_recursive(&s, &d).map_err(|e| e.to_string())
}

/// Move `src` (file or folder) into `dest_dir`. Falls back to copy+delete across
/// volumes. Refuses to overwrite an existing item.
#[tauri::command]
pub fn fs_move_path(src: String, dest_dir: String) -> Result<(), String> {
    let s = std::path::PathBuf::from(&src);
    let name = s.file_name().ok_or("잘못된 경로")?;
    let d = std::path::Path::new(&dest_dir).join(name);
    if d == s {
        return Err("같은 위치입니다.".into());
    }
    if d.exists() {
        return Err("같은 이름의 항목이 이미 있습니다.".into());
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
