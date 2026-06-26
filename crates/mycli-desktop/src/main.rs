#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod commands;
mod explorer;
mod session;
mod terminal;
mod tools;
mod update;

use std::sync::Arc;
use browser::BrowserManager;
use explorer::ExplorerManager;
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
            commands::open_external,
            commands::pick_key_file,
            commands::fs_copy_path,
            commands::fs_move_path,
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
        .run(tauri::generate_context!())
        .expect("error while running Mymux");
}
