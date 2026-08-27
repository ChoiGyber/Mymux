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

/// Window geometry we persist across runs.
///
/// Not `StateFlags::all()` (the plugin default): VISIBLE would persist the
/// hidden state of `buddy-overlay`, and DECORATIONS / FULLSCREEN are not
/// user-adjustable here. Both the plugin registration and the explicit save on
/// main-window destroy read this, so the two can never drift apart.
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// The usable desktop area of the monitor a window sits on, in physical pixels.
///
/// `Monitor::size()` is the whole panel; the taskbar (or Dock, or a panel) eats
/// into that, and a window sized to the full panel has its bottom edge — and on
/// Windows its resize grip — under the bar. Windows can report the real work
/// area per monitor, so use it there and fall back to a margin elsewhere. The
/// fallback mirrors what `commands.rs` already reserves when placing the buddy
/// overlay, so the two agree about how much room the system furniture takes.
/// Work area as (left, top, width, height) in physical pixels.
///
/// The origin matters as much as the size: a window sized to exactly the work
/// area only fits if its top-left *is* the work area's top-left. Clamping the
/// position against 0 instead would still leave it hanging off the right and
/// bottom whenever the window opened at an offset — which is what Windows does
/// by default (CW_USEDEFAULT cascades new windows) — and would shove it under a
/// taskbar docked at the top or left.
#[cfg(windows)]
fn monitor_work_area<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> Option<(i32, i32, u32, u32)> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let hwnd = win.hwnd().ok()?;
    let monitor = unsafe { MonitorFromWindow(hwnd.0 as _, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    let work = info.rcWork;
    let w = work.right - work.left;
    let h = work.bottom - work.top;
    (w > 0 && h > 0).then_some((work.left, work.top, w as u32, h as u32))
}

/// Elsewhere there is no per-monitor work area to ask for, so reserve a margin.
///
/// This is weaker than the Windows path in two ways, and deliberately so rather
/// than by oversight: it only reserves height, so a Dock parked on the left or
/// right is not accounted for, and 56 is thin for macOS once the menu bar and a
/// visible Dock are both counted. It still only ever shrinks a window, so the
/// worst case is less protection than Windows gets — never a regression.
/// `NSScreen::visibleFrame` is the exact counterpart if this becomes a problem.
#[cfg(not(windows))]
fn monitor_work_area<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> Option<(i32, i32, u32, u32)> {
    let monitor = win.current_monitor().ok().flatten()?;
    let size = monitor.size();
    let origin = monitor.position();
    // Mirrors the reserve `commands.rs` keeps when placing the buddy overlay,
    // scaled with DPI the same way — a fixed logical margin is more physical
    // pixels at high scale.
    let reserve = (56.0 * monitor.scale_factor()) as u32;
    Some((
        origin.x,
        origin.y,
        size.width,
        size.height.saturating_sub(reserve),
    ))
}

/// Shrink a freshly created window that does not fit on its monitor.
///
/// Tauri does not clamp the configured default size at creation, so on a small
/// or heavily scaled display the window can open larger than the screen — its
/// title bar reachable but its lower edge, and the controls there, off-screen.
///
/// Only ever shrinks, and only when no saved state exists. That second limit is
/// a scope decision, not a claim that restored geometry is already safe: the
/// window-state plugin applies a restored *size* with no monitor check at all
/// (its bounds test covers position only, and even that asks whether the window
/// intersects a monitor, not whether it fits). Carrying a size from a large
/// display to a small one therefore still reopens too big. Overriding that here
/// would mean overruling a size the user picked, so it is left alone; making
/// restored geometry fit is its own decision to take deliberately.
fn clamp_new_window_to_work_area<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    let Some((work_x, work_y, max_w, max_h)) = monitor_work_area(win) else {
        return;
    };
    let (Ok(outer), Ok(inner)) = (win.outer_size(), win.inner_size()) else {
        return;
    };
    if outer.width <= max_w && outer.height <= max_h {
        return;
    }
    // The fit is judged on the outer size (frame included) but `set_size` sets
    // the *inner* size, so subtract the frame or the window lands that much
    // over the edge.
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);
    let _ = win.set_size(tauri::PhysicalSize::new(
        inner.width.min(max_w.saturating_sub(frame_w)),
        inner.height.min(max_h.saturating_sub(frame_h)),
    ));

    // Then re-seat it. Resizing does not move a window (tao passes SWP_NOMOVE),
    // so one that opened at an offset is still hanging off the far edge by that
    // much — and a window now sized to the whole work area only fits at the work
    // area's own origin. Clamp both ends: `max(work_x)` keeps it out from under
    // a taskbar docked left or top, `min(right edge)` pulls it back from off the
    // screen. Re-read the size instead of assuming the set above took.
    let Ok(placed) = win.outer_size() else { return };
    if let Ok(pos) = win.outer_position() {
        let far_x = work_x + max_w as i32 - placed.width as i32;
        let far_y = work_y + max_h as i32 - placed.height as i32;
        let _ = win.set_position(tauri::PhysicalPosition::new(
            pos.x.clamp(work_x, far_x.max(work_x)),
            pos.y.clamp(work_y, far_y.max(work_y)),
        ));
    }
}

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
        // Restore the main window's last size/position/maximized state. Without
        // this the window reopens at the config default every run, and that
        // default is small enough that the two 280px side panels leave the
        // terminal ~300px — a split pane lands at 18 columns, so the shell wraps
        // its output into a vertical sliver that survives in the scrollback even
        // after the window is enlarged again.
        //
        // Only SIZE | POSITION | MAXIMIZED. The default is StateFlags::all(),
        // whose VISIBLE flag would persist the hidden state of `buddy-overlay`;
        // DECORATIONS and FULLSCREEN are not user-adjustable here.
        //
        // `buddy-overlay` is denied outright: it is a fixed-size, undecorated
        // companion window whose position the app computes on every show, so a
        // restored geometry would fight that. The browser pane is not affected
        // either way — it is a child webview (browser.rs `add_child`), not a
        // window, so the plugin never sees it.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .with_denylist(&["buddy-overlay"])
                .build(),
        )
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
            commands::save_text_file_as,
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
            voice::voice_check_local,
            voice::voice_pick_runner,
        ])
        .setup(|_app| {
            // Save the window geometry the moment the main window is
            // destroyed, then quit. The plugin only writes its file on
            // `RunEvent::Exit`; saving here keeps that from being the single
            // point of failure, and the plugin keeps its cache current from
            // Moved/Resized/CloseRequested, so writing after the window is gone
            // still records the last real geometry. Exit now fires too (see the
            // `handle.exit` note below), which makes the plugin's own save a
            // second, redundant write of the same values rather than the only one.
            //
            // The frontend takes the same path on a normal quit: its
            // `onCloseRequested` handler calls `preventDefault()` to ask about
            // saving the session and then destroys the window itself, so
            // `Destroyed` is the one event guaranteed to fire on every exit.
            {
                use tauri::{Manager, WindowEvent};
                use tauri_plugin_window_state::AppHandleExt;
                if let Some(win) = _app.get_webview_window("main") {
                    // Clamp only when there is no saved state to restore.
                    // This probes for the file rather than asking the plugin,
                    // so a present-but-unusable state file (corrupt, or holding
                    // no entry for this window) reads as "restored" and skips
                    // the clamp. That leaves the window at its configured size,
                    // which is the same place it would have been without the
                    // plugin — not worth reading the file twice to tighten.
                    let restored = _app
                        .path()
                        .app_config_dir()
                        .map(|dir| {
                            dir.join(tauri_plugin_window_state::DEFAULT_FILENAME)
                                .exists()
                        })
                        .unwrap_or(false);
                    if !restored {
                        clamp_new_window_to_work_area(&win);
                    }

                    let handle = _app.handle().clone();
                    win.on_window_event(move |event| {
                        if matches!(event, WindowEvent::Destroyed) {
                            let _ = handle.save_window_state(window_state_flags());
                            // Then quit. Closing the main window does not end the
                            // app on its own: wry raises ExitRequested when its
                            // window map empties, and `buddy-overlay` is created
                            // at startup and only ever shown/hidden, so the map
                            // never empties. The process would linger with no
                            // visible window, still holding a RunEvent::Exit
                            // handler and its own geometry cache — a later
                            // graceful exit (logoff, say) would then overwrite a
                            // newer run's saved size.
                            //
                            // Quitting outright rather than destroying the
                            // overlay: destroying it only empties the map while
                            // no other window happens to exist, so adding a third
                            // window later would silently bring this bug back.
                            // Asking the app to exit says what we mean.
                            //
                            // Not during an update install — that path renames
                            // the running binary out of the way before writing
                            // the new one, so dying mid-write can leave nothing
                            // to launch. update_install clears the flag and, if
                            // the window is already gone by then, exits itself.
                            if !update::installing() {
                                handle.exit(0);
                            }
                        }
                    });
                }
            }

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
