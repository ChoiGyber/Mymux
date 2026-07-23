#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod commands;
mod explorer;
mod session;
mod terminal;
mod tools;
mod update;

use browser::BrowserManager;
use explorer::ExplorerManager;
use std::sync::Arc;
use terminal::TerminalManager;

fn main() {
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
            commands::execute_command,
            commands::set_favorite,
            commands::read_text_file,
            commands::write_text_file,
            commands::codex_rollout_tail,
            commands::claude_account_usage,
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
            explorer::sftp_read_text_file,
            explorer::sftp_write_text_file,
            explorer::sftp_disconnect,
            browser::browser_launch,
            browser::browser_status,
            browser::browser_close,
            browser::browser_page_target,
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
