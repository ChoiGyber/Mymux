//! Auto-update commands backed by tauri-plugin-updater.
//!
//! The frontend calls `update_check` on startup; if it returns a version
//! string, an "Update" button is revealed. Clicking it calls `update_install`,
//! which downloads + installs the signed update and relaunches the app.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_updater::UpdaterExt;

/// Set while `update_install` is downloading and installing.
///
/// The main window's `Destroyed` hook checks this before quitting the app.
/// Killing the process mid-install is not merely a wasted download: on Linux
/// the updater renames the running AppImage out of the way *before* writing
/// the new bytes, so a death in that window leaves the install path with no
/// executable at all. Nothing in the UI blocks the close button during a
/// multi-second download, so the user can reach that state by simply getting
/// impatient.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Whether an update install is in flight — the exit hook must not quit now.
pub fn installing() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
}

/// Check the configured updater endpoint for a newer release.
///
/// Returns `Some(version)` when an update is available, `None` when the app is
/// already up to date.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo { version: update.version, body: update.body })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download and install the pending update, then restart into the new version.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    // Hold the exit hook off until the install finishes or fails.
    INSTALLING.store(true, Ordering::SeqCst);
    let installed = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await;
    if let Err(e) = installed {
        INSTALLING.store(false, Ordering::SeqCst);
        // If the user closed the window while this was running, the exit hook
        // already declined to quit — nothing else will. Finish the job here so
        // we do not leave a windowless process behind.
        use tauri::Manager;
        if app.get_webview_window("main").is_none() {
            app.exit(0);
        }
        return Err(e.to_string());
    }
    // Success never returns: on Windows the updater spawns the installer and
    // exits the process itself, and otherwise restart() diverges (`-> !`).
    app.restart()
}
