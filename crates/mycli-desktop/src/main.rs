#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod commands;
mod explorer;
mod session;
mod statusline;
mod terminal;
mod tools;
mod update;
mod voice;

use browser::BrowserManager;
use explorer::ExplorerManager;
use std::sync::Arc;
use terminal::TerminalManager;

fn main() {
    // Claude Code runs its statusline command on every render. Answer that and
    // exit before Tauri starts, so no window is ever created for it.
    if std::env::args().any(|a| a == statusline::STATUSLINE_ARG) {
        statusline::run_statusline();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(TerminalManager::new()))
        .manage(Arc::new(ExplorerManager::new()))
        .manage(Arc::new(BrowserManager::new()))
        .invoke_handler(tauri::generate_handler![
            commands::list_commands,
            commands::add_command,
            commands::update_command,
            commands::delete_command,
            commands::set_favorite,
            commands::read_text_file,
            commands::write_text_file,
            commands::codex_rollout_tail,
            commands::codex_reset_credits,
            commands::codex_consume_reset_credit,
            commands::claude_account_usage,
            statusline::claude_statusline_status,
            statusline::claude_statusline_install,
            statusline::claude_statusline_remove,
            commands::open_external,
            commands::window_attention,
            commands::buddy_overlay_show,
            commands::buddy_overlay_hide,
            commands::buddy_overlay_focus_main,
            commands::pick_key_file,
            commands::fs_copy_path,
            commands::fs_move_path,
            commands::fs_create_dir,
            commands::paste_clipboard_image,
            session::session_save,
            session::session_load,
            session::session_clear,
            terminal::pty_spawn,
            terminal::pty_read,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_close,
            explorer::explorer_list_local,
            explorer::explorer_home_dir,
            explorer::explorer_parent_dir,
            explorer::explorer_list_drives,
            explorer::sftp_connect,
            explorer::sftp_list_dir,
            explorer::sftp_home_dir,
            explorer::sftp_resolve_dir,
            explorer::sftp_read_text_file,
            explorer::sftp_write_text_file,
            explorer::sftp_upload_size,
            explorer::sftp_begin_upload,
            explorer::sftp_cancel_upload,
            explorer::sftp_finish_upload,
            explorer::sftp_upload_path,
            explorer::sftp_disconnect,
            explorer::ssh_resolve_command,
            browser::browser_launch,
            browser::browser_profiles,
            browser::browser_import_profile,
            browser::browser_status,
            browser::browser_close,
            browser::browser_page_target,
            browser::browser_page_targets,
            browser::browser_new_tab,
            browser::browser_close_tab,
            browser::browser_pane_open,
            browser::browser_pane_set_bounds,
            browser::browser_pane_navigate,
            browser::browser_pane_back,
            browser::browser_pane_forward,
            browser::browser_pane_reload,
            browser::browser_pane_show,
            browser::browser_pane_hide,
            browser::browser_pane_close,
            browser::browser_pane_url,
            update::update_check,
            update::update_install,
            tools::tool_installed,
            voice::voice_store_deepgram_key,
            voice::voice_deepgram_token,
            voice::voice_transcribe_local,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(win) = _app.get_webview_window("main") {
                    let title = format!(
                        "Mymux v{} [최신 테스트] — Command Manager",
                        env!("CARGO_PKG_VERSION")
                    );
                    let _ = win.set_title(&title);
                }
            }

            // WebView2 fires no DOM focus / hasFocus / visibility / focus=true
            // event when the window is re-activated via Alt-Tab, so the frontend
            // cannot tell it regained focus and the terminal cursor stays hollow.
            // Poll the OS foreground window here (authoritative) and emit when our
            // window becomes foreground again; the frontend then restores focus.
            #[cfg(windows)]
            {
                use tauri::{Emitter, Manager};
                let app = _app;
                let app_handle = app.handle().clone();
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(h) = win.hwnd() {
                        let target = h.0 as isize;
                        std::thread::spawn(move || {
                            let mut was_fg = true;
                            loop {
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                let fg = unsafe {
                                    windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow()
                                } as isize;
                                let is_fg = fg == target;
                                if is_fg && !was_fg {
                                    // WebView2 keeps the DOM unfocused on Alt-Tab
                                    // return (a focus event never fires — MS won't
                                    // fix it), so JS focus() only sets activeElement
                                    // and the cursor stays hollow. Focusing the
                                    // *webview* (not the top-level window) drives
                                    // WebView2's MoveFocus and revives input focus;
                                    // it must run on the main thread.
                                    let ah = app_handle.clone();
                                    let _ = app_handle.run_on_main_thread(move || {
                                        if let Some(wv) = ah.get_webview("main") {
                                            let _ = wv.set_focus();
                                        }
                                    });
                                    let _ = win.emit("mymux-refocus", ());
                                }
                                was_fg = is_fg;
                            }
                        });
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mymux");
}

#[cfg(test)]
mod security_regression_tests {
    use std::collections::BTreeSet;

    fn registered_commands() -> BTreeSet<String> {
        let source = include_str!("main.rs");
        let body = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .expect("invoke handler must exist")
            .1
            .split_once("])")
            .expect("invoke handler must terminate")
            .0;
        body.lines()
            .filter_map(|line| {
                let command = line.trim().trim_end_matches(',');
                command.rsplit_once("::").map(|(_, name)| name.to_string())
            })
            .collect()
    }

    fn manifest_commands() -> BTreeSet<String> {
        let source = include_str!("../build.rs");
        let body = source
            .split_once("const APP_COMMANDS: &[&str] = &[")
            .expect("AppManifest command list must exist")
            .1
            .split_once("];")
            .expect("AppManifest command list must terminate")
            .0;
        body.lines()
            .map(|line| line.trim().trim_matches(&['"', ','][..]))
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn app_manifest_covers_every_registered_custom_command() {
        let registered = registered_commands();
        let manifest = manifest_commands();
        assert_eq!(manifest, registered);
        assert!(!registered.contains("execute_command"));
    }

    #[test]
    fn main_capability_is_local_and_excludes_remote_browser_pane() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["local"], true);
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability.get("windows").is_none());
        assert!(capability.get("remote").is_none());

        let permissions: BTreeSet<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|permission| permission.as_str())
            .collect();
        for command in manifest_commands() {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(
                permissions.contains(permission.as_str()),
                "missing {permission}"
            );
        }
        assert!(!permissions.contains("allow-execute-command"));
    }

    #[test]
    fn buddy_overlay_capability_stays_least_privilege() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/buddy-overlay.json")).unwrap();
        assert_eq!(capability["local"], true);
        assert_eq!(
            capability["webviews"],
            serde_json::json!(["buddy-overlay"])
        );
        assert!(capability.get("windows").is_none());
        assert!(capability.get("remote").is_none());
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "core:event:allow-listen",
                "allow-buddy-overlay-hide",
                "allow-buddy-overlay-focus-main"
            ])
        );
    }

    #[test]
    fn dynamic_tooltips_are_not_interpolated_into_html_attributes() {
        let frontend = include_str!("../frontend/app.js");
        assert!(!frontend.contains("title=\"${esc("));
    }

    #[test]
    fn focus_restore_does_not_interrupt_ime_input() {
        let frontend = include_str!("../frontend/app.js");
        for signal in [
            "compositionstart",
            "compositionupdate",
            "beforeinput",
            "input",
            "compositionend",
        ] {
            assert!(
                frontend.contains(signal),
                "missing IME signal guard: {signal}"
            );
        }
        assert!(frontend.contains("composingAtBlur || !document.hasFocus()"));
        assert!(frontend.contains("imeRestoreBlockedUntil"));
        for delay in [80, 220, 500] {
            assert!(frontend.contains(&format!("setTimeout(() => restore(false), {delay})")));
        }
        assert!(!frontend.contains("setTimeout(() => restore(true)"));
    }

    /// The vendored xterm build is pinned deliberately: 5.5.0 + the Canvas
    /// renderer is the combination that keeps macOS input from drifting. Guard
    /// the pin so a routine "update the vendor files" never silently undoes it.
    ///
    /// Two of the addons ship without the jsdelivr version banner, so they are
    /// matched on their export name instead — enough to catch a wrong or
    /// truncated asset, which is what this guard is really for.
    #[test]
    fn bundled_xterm_assets_are_the_pinned_release() {
        let assets = [
            (
                include_str!("../frontend/vendor/xterm.min.js"),
                "@xterm/xterm@5.5.0",
            ),
            (
                include_str!("../frontend/vendor/xterm.min.css"),
                "@xterm/xterm@5.5.0",
            ),
            (
                include_str!("../frontend/vendor/addon-fit.min.js"),
                "@xterm/addon-fit@0.10.0",
            ),
            (
                include_str!("../frontend/vendor/addon-canvas.min.js"),
                "@xterm/addon-canvas@0.7.0",
            ),
            (
                include_str!("../frontend/vendor/addon-search.min.js"),
                "exports.SearchAddon",
            ),
            (
                include_str!("../frontend/vendor/addon-web-links.min.js"),
                "exports.WebLinksAddon",
            ),
        ];
        for (asset, marker) in assets {
            assert!(asset.contains(marker), "vendor asset does not contain {marker}");
        }
    }
}
