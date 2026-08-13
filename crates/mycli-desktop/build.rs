fn main() {
    copy_conpty_sideload();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Mymux");
}

// Keep custom commands behind Tauri's ACL. The explicit manifest lets
// capabilities grant them only to trusted local webviews; the remote
// `browser-pane` gets no privileged IPC.
const APP_COMMANDS: &[&str] = &[
    "list_commands",
    "add_command",
    "update_command",
    "delete_command",
    "set_favorite",
    "read_text_file",
    "write_text_file",
    "codex_rollout_tail",
    "codex_reset_credits",
    "codex_consume_reset_credit",
    "claude_account_usage",
    "claude_statusline_status",
    "claude_statusline_install",
    "claude_statusline_remove",
    "open_external",
    "window_attention",
    "buddy_overlay_show",
    "buddy_overlay_hide",
    "buddy_overlay_focus_main",
    "pick_key_file",
    "fs_copy_path",
    "fs_move_path",
    "fs_create_dir",
    "paste_clipboard_image",
    "session_save",
    "session_load",
    "session_clear",
    "pty_spawn",
    "pty_read",
    "pty_write",
    "pty_resize",
    "pty_close",
    "explorer_list_local",
    "explorer_home_dir",
    "explorer_parent_dir",
    "explorer_list_drives",
    "sftp_connect",
    "sftp_list_dir",
    "sftp_home_dir",
    "sftp_resolve_dir",
    "sftp_read_text_file",
    "sftp_write_text_file",
    "sftp_upload_size",
    "sftp_begin_upload",
    "sftp_cancel_upload",
    "sftp_finish_upload",
    "sftp_upload_path",
    "sftp_disconnect",
    "ssh_resolve_command",
    "browser_launch",
    "browser_profiles",
    "browser_import_profile",
    "browser_status",
    "browser_close",
    "browser_page_target",
    "browser_page_targets",
    "browser_new_tab",
    "browser_close_tab",
    "browser_pane_open",
    "browser_pane_set_bounds",
    "browser_pane_navigate",
    "browser_pane_back",
    "browser_pane_forward",
    "browser_pane_reload",
    "browser_pane_show",
    "browser_pane_hide",
    "browser_pane_close",
    "browser_pane_url",
    "update_check",
    "update_install",
    "tool_installed",
    "voice_store_deepgram_key",
    "voice_deepgram_token",
    "voice_transcribe_local",
];

/// Copy the sideloaded ConPTY host (`conpty.dll` + `OpenConsole.exe`) next to
/// the freshly built executable.
///
/// portable-pty's `load_conpty()` prefers a `conpty.dll` found via the normal
/// DLL search path (i.e. the exe's directory) over the system one in
/// kernel32. Using the bundled host bypasses the Windows 11 "default terminal
/// app" handoff that otherwise flashes a black console window whenever a pane's
/// pseudo-console is created or closed.
///
/// The NSIS installer gets these files via `bundle.resources` in
/// `tauri.conf.json`; this step covers the raw `cargo build`/`cargo run`
/// output under `target/<profile>/` so local dev builds behave the same.
#[cfg(windows)]
fn copy_conpty_sideload() {
    use std::{env, fs, path::PathBuf};

    let src_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");

    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out → up 3 = <target>/<profile>
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };

    for name in ["conpty.dll", "OpenConsole.exe"] {
        let src = src_dir.join(name);
        let dst = profile_dir.join(name);
        println!("cargo:rerun-if-changed={}", src.display());

        // Skip when the destination already matches: re-copying a DLL that a
        // running instance has loaded would fail with a sharing violation.
        let same = matches!(
            (fs::metadata(&src), fs::metadata(&dst)),
            (Ok(a), Ok(b)) if a.len() == b.len()
        );
        if same {
            continue;
        }
        if let Err(e) = fs::copy(&src, &dst) {
            println!("cargo:warning=could not copy {name} next to the exe: {e}");
        }
    }
}

#[cfg(not(windows))]
fn copy_conpty_sideload() {}
