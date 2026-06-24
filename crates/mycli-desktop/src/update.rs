//! Auto-update commands backed by tauri-plugin-updater.
//!
//! The frontend calls `update_check` on startup; if it returns a version
//! string, an "Update" button is revealed. Clicking it calls `update_install`,
//! which downloads + installs the signed update and relaunches the app.

use tauri_plugin_updater::UpdaterExt;

/// Check the configured updater endpoint for a newer release.
///
/// Returns `Some(version)` when an update is available, `None` when the app is
/// already up to date.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update.version)),
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
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // restart() diverges (`-> !`); coerces to the Result return type.
    app.restart()
}
