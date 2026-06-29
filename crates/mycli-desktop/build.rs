fn main() {
    copy_conpty_sideload();
    tauri_build::build();
}

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
