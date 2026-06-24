//! Session persistence: the frontend serializes the open tabs/panes/SSH
//! targets to JSON and we store it at `~/.mycli/session.json`, to optionally
//! restore on the next launch. No secrets are written (SSH passwords are never
//! persisted — see the frontend's restore flow).

use std::path::PathBuf;

use serde_json::Value;

fn session_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("홈 디렉토리를 찾을 수 없습니다")?;
    let dir = home.join(".mycli");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub fn session_save(data: Value) -> Result<(), String> {
    let path = session_path()?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_load() -> Result<Option<Value>, String> {
    let path = session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(value))
}

#[tauri::command]
pub fn session_clear() -> Result<(), String> {
    let path = session_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
