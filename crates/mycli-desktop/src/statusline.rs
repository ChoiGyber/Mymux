//! Claude Code statusline bridge.
//!
//! The per-pane usage badge and the session-list `%` are scraped out of what a
//! pane prints — specifically `ctx:NN%`. Claude Code hands the context-window
//! numbers to exactly one place, its **statusline command**: they are not in the
//! session transcript (which records token counts but never the window size),
//! and the OAuth usage endpoint behind the toolbar's CL readout is account-wide,
//! not per session. So on a PC with no statusline configured the toolbar usage
//! appears while the per-session badge stays empty forever.
//!
//! This module lets Mymux be that statusline. `Mymux --statusline` reads Claude
//! Code's JSON payload from stdin and prints the single line Mymux already knows
//! how to parse back (`Model: … | ctx:NN%`), and the commands below install or
//! remove the `statusLine` entry in the user's Claude settings.

use std::io::Read;
use std::path::PathBuf;

/// Argument that switches the app into statusline mode instead of opening a
/// window. Also the marker that identifies an installed entry as ours.
pub const STATUSLINE_ARG: &str = "--statusline";

const BACKUP_SUFFIX: &str = ".mymux-bak";

// ── statusline rendering ────────────────────────────────────────────────────

/// Render one statusline from the payload Claude Code writes to stdin.
///
/// Never fails loudly: whatever this prints is shown to the user in place of
/// their prompt line, so a malformed payload prints nothing rather than an
/// error. Called before Tauri starts, so no window is ever created.
pub fn run_statusline() {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return;
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    println!("{}", render(&payload));
}

/// `Model: Opus 5 | ctx:37%` — the exact shape Mymux's own CTX_MODEL_RE /
/// CTX_RE scanners expect. The model name is kept ahead of the `|` because the
/// model regex stops at that separator.
fn render(payload: &serde_json::Value) -> String {
    let model = payload
        .pointer("/model/display_name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| payload.pointer("/model/id").and_then(serde_json::Value::as_str))
        .unwrap_or("Claude");
    let mut line = format!("Model: {model}");
    // Account limits ride along when Claude Code sends them. The toolbar's CL
    // readout normally comes straight from the OAuth usage API, but that path
    // deliberately gives up on an expired token — this keeps the readout alive
    // in that case, and it costs nothing when the API is answering.
    let limits = [("5h", "/rate_limits/five_hour"), ("wk", "/rate_limits/seven_day")]
        .into_iter()
        .filter_map(|(label, ptr)| {
            let pct = payload.pointer(&format!("{ptr}/used_percentage"))?.as_f64()?;
            Some(format!("{label}:{}%", pct.clamp(0.0, 100.0).round() as u32))
        })
        .collect::<Vec<_>>();
    if !limits.is_empty() {
        line.push_str(&format!(" | {}", limits.join(" ")));
    }
    // No context numbers in this payload — the model name alone still tells the
    // pane badge which tool owns the session.
    if let Some(pct) = context_percent(payload) {
        line.push_str(&format!(" | ctx:{pct}%"));
    }
    line
}

/// Percent of the context window in use. Prefers the number Claude Code
/// computes itself; falls back to the raw counters (the same arithmetic the OMC
/// HUD uses) for payloads that carry only those.
fn context_percent(payload: &serde_json::Value) -> Option<u32> {
    let window = payload.get("context_window")?;
    let pct = window
        .get("used_percentage")
        .and_then(serde_json::Value::as_f64)
        .filter(|p| p.is_finite())
        .or_else(|| manual_percent(window))?;
    Some(pct.clamp(0.0, 100.0).round() as u32)
}

fn manual_percent(window: &serde_json::Value) -> Option<f64> {
    let size = window.get("context_window_size")?.as_f64()?;
    if size <= 0.0 {
        return None;
    }
    let usage = window.get("current_usage")?;
    let field = |key: &str| usage.get(key).and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let used = field("input_tokens")
        + field("cache_creation_input_tokens")
        + field("cache_read_input_tokens");
    Some(used / size * 100.0)
}

// ── settings.json install / remove ──────────────────────────────────────────

/// Claude's config directory, honoring `CLAUDE_CONFIG_DIR` the same way Claude
/// Code and OMC do (custom profiles).
fn claude_config_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(dirs::home_dir()
        .ok_or("Home directory not found")?
        .join(".claude"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(claude_config_dir()?.join("settings.json"))
}

/// The command Claude Code should run. Quoted because the install directory
/// routinely contains spaces, and resolved at call time so each PC gets its own
/// path — a settings.json copied between machines with different user names is
/// a common way for the statusline to silently stop working.
fn statusline_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(format!("\"{}\" {STATUSLINE_ARG}", exe.display()))
}

fn is_ours(command: &str) -> bool {
    command.contains(STATUSLINE_ARG) && command.to_lowercase().contains("mymux")
}

#[derive(serde::Serialize)]
pub struct StatuslineStatus {
    /// `"mymux"` (ours), `"other"` (someone else's — never touched),
    /// `"none"`, or `"unreadable"` (settings.json exists but is not valid JSON).
    pub state: String,
    /// The currently configured command, when there is one.
    pub command: Option<String>,
    /// Where the settings file lives, so the UI can name it.
    pub path: String,
}

fn read_settings(path: &PathBuf) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Some(serde_json::json!({}))),
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Some(serde_json::json!({}))),
        Err(e) => Err(e.to_string()),
    }
}

fn current_command(settings: &serde_json::Value) -> Option<String> {
    settings
        .pointer("/statusLine/command")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn status_from(path: &PathBuf, settings: Option<&serde_json::Value>) -> StatuslineStatus {
    let path_str = path.display().to_string();
    let Some(settings) = settings else {
        return StatuslineStatus { state: "unreadable".into(), command: None, path: path_str };
    };
    match current_command(settings) {
        Some(cmd) if is_ours(&cmd) => {
            StatuslineStatus { state: "mymux".into(), command: Some(cmd), path: path_str }
        }
        Some(cmd) => StatuslineStatus { state: "other".into(), command: Some(cmd), path: path_str },
        None => StatuslineStatus { state: "none".into(), command: None, path: path_str },
    }
}

#[tauri::command]
pub fn claude_statusline_status() -> Result<StatuslineStatus, String> {
    let path = settings_path()?;
    let settings = read_settings(&path)?;
    Ok(status_from(&path, settings.as_ref()))
}

#[tauri::command]
pub fn claude_statusline_install() -> Result<StatuslineStatus, String> {
    install_into(&settings_path()?, &statusline_command()?)
}

#[tauri::command]
pub fn claude_statusline_remove() -> Result<StatuslineStatus, String> {
    remove_from(&settings_path()?)
}

/// Add Mymux's statusline to Claude's settings. Refuses to replace someone
/// else's statusline, and keeps a `.mymux-bak` copy of whatever was there.
fn install_into(path: &PathBuf, command: &str) -> Result<StatuslineStatus, String> {
    let mut settings = read_settings(path)?.ok_or(
        "settings.json 을 JSON 으로 읽을 수 없습니다 — 파일을 먼저 고쳐주세요. \
         / settings.json is not valid JSON.",
    )?;
    if let Some(existing) = current_command(&settings) {
        if !is_ours(&existing) {
            return Err(format!(
                "이미 다른 statusline 이 설정되어 있어 건드리지 않았습니다: {existing} \
                 / A different statusline is already configured; left untouched."
            ));
        }
    }
    settings["statusLine"] = serde_json::json!({ "type": "command", "command": command });
    write_settings(path, &settings)?;
    Ok(status_from(path, Some(&settings)))
}

/// Take Mymux's statusline back out. Only ever removes our own entry.
fn remove_from(path: &PathBuf) -> Result<StatuslineStatus, String> {
    let mut settings = read_settings(path)?.ok_or(
        "settings.json 을 JSON 으로 읽을 수 없습니다. / settings.json is not valid JSON.",
    )?;
    match current_command(&settings) {
        Some(cmd) if is_ours(&cmd) => {}
        Some(cmd) => {
            return Err(format!(
                "Mymux 가 설정한 statusline 이 아니라 그대로 두었습니다: {cmd} \
                 / Not installed by Mymux; left untouched."
            ));
        }
        None => return Ok(status_from(path, Some(&settings))),
    }
    if let Some(obj) = settings.as_object_mut() {
        obj.remove("statusLine");
    }
    write_settings(path, &settings)?;
    Ok(status_from(path, Some(&settings)))
}

/// Back the file up before the first edit, then write it back out. Key order is
/// preserved (serde_json's `preserve_order`) so the user's settings file comes
/// back looking like the one they wrote.
fn write_settings(path: &PathBuf, settings: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let backup = path.with_file_name(format!(
            "{}{BACKUP_SUFFIX}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::copy(path, &backup).map_err(|e| e.to_string())?;
    }
    let mut text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_shape_mymux_parses_back() {
        let payload = serde_json::json!({
            "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
            "context_window": { "used_percentage": 37.4 }
        });
        assert_eq!(render(&payload), "Model: Opus 5 | ctx:37%");
    }

    #[test]
    fn falls_back_to_raw_counters_when_percentage_is_absent() {
        // 250,000 of a 1,000,000-token window = 25%.
        let payload = serde_json::json!({
            "model": { "display_name": "Opus 5" },
            "context_window": {
                "context_window_size": 1_000_000,
                "current_usage": {
                    "input_tokens": 1_000,
                    "cache_creation_input_tokens": 4_000,
                    "cache_read_input_tokens": 245_000
                }
            }
        });
        assert_eq!(render(&payload), "Model: Opus 5 | ctx:25%");
    }

    #[test]
    fn names_the_model_even_without_context_numbers() {
        let payload = serde_json::json!({ "model": { "display_name": "Sonnet 5" } });
        assert_eq!(render(&payload), "Model: Sonnet 5");
    }

    #[test]
    fn clamps_out_of_range_percentages() {
        let payload = serde_json::json!({ "context_window": { "used_percentage": 143.0 } });
        assert_eq!(render(&payload), "Model: Claude | ctx:100%");
    }

    #[test]
    fn passes_account_limits_through_when_present() {
        let payload = serde_json::json!({
            "model": { "display_name": "Opus 5" },
            "rate_limits": {
                "five_hour": { "used_percentage": 34.2 },
                "seven_day": { "used_percentage": 12.0 }
            },
            "context_window": { "used_percentage": 63.0 }
        });
        assert_eq!(render(&payload), "Model: Opus 5 | 5h:34% wk:12% | ctx:63%");
    }

    #[test]
    fn only_recognizes_our_own_command() {
        assert!(is_ours("\"C:\\Users\\me\\AppData\\Local\\Mymux\\Mymux.exe\" --statusline"));
        assert!(!is_ours("node /home/me/.claude/hud/omc-hud.mjs"));
        // Another tool that merely takes a --statusline flag is not ours.
        assert!(!is_ours("some-other-tool --statusline"));
    }

    #[test]
    fn reports_a_foreign_statusline_as_other() {
        let path = PathBuf::from("settings.json");
        let settings = serde_json::json!({
            "statusLine": { "type": "command", "command": "node omc-hud.mjs" }
        });
        assert_eq!(status_from(&path, Some(&settings)).state, "other");
    }

    fn temp_settings(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mymux-statusline-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        if !body.is_empty() {
            std::fs::write(&path, body).unwrap();
        }
        path
    }

    const OUR_COMMAND: &str = "\"C:\\Mymux\\Mymux.exe\" --statusline";

    #[test]
    fn install_keeps_existing_settings_and_their_order() {
        // `theme` first, `language` last — the user's own ordering must survive.
        let path = temp_settings("order", "{\n \"theme\": \"dark\",\n \"language\": \"ko\"\n}\n");
        assert_eq!(install_into(&path, OUR_COMMAND).unwrap().state, "mymux");

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.find("\"theme\"").unwrap() < written.find("\"language\"").unwrap());
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["language"], "ko");
        assert_eq!(parsed["statusLine"]["command"], OUR_COMMAND);
        // The pre-edit file is kept next to it.
        assert!(path.with_file_name("settings.json.mymux-bak").exists());
    }

    #[test]
    fn install_creates_the_file_when_there_is_none() {
        let path = temp_settings("fresh", "");
        assert_eq!(install_into(&path, OUR_COMMAND).unwrap().state, "mymux");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["statusLine"]["type"], "command");
    }

    #[test]
    fn install_never_replaces_someone_elses_statusline() {
        let body = "{\"statusLine\":{\"type\":\"command\",\"command\":\"node omc-hud.mjs\"}}";
        let path = temp_settings("foreign", body);
        assert!(install_into(&path, OUR_COMMAND).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body); // untouched
    }

    #[test]
    fn remove_takes_out_only_our_own_entry() {
        let path = temp_settings("remove", "{\"theme\":\"dark\"}");
        install_into(&path, OUR_COMMAND).unwrap();
        assert_eq!(remove_from(&path).unwrap().state, "none");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed.get("statusLine").is_none());
        assert_eq!(parsed["theme"], "dark"); // the rest of the file survives

        let foreign = temp_settings("remove-foreign", "{\"statusLine\":{\"command\":\"x\"}}");
        assert!(remove_from(&foreign).is_err());
    }
}
