# Bundled ConPTY host

These files are sideloaded next to `Mymux.exe` so portable-pty uses a bundled
pseudo-console host instead of the system one. This bypasses the Windows 11
"default terminal app" handoff, which otherwise flashes a black console window
whenever a terminal pane's pseudo-console is created or closed.

- `conpty.dll`
- `OpenConsole.exe`

`portable-pty`'s `load_conpty()` prefers a `conpty.dll` found on the DLL search
path (the executable's directory) over `kernel32`'s built-in one; `conpty.dll`
in turn launches `OpenConsole.exe` from the same directory as its headless host.

## How they ship

- **Installer (NSIS):** declared in `tauri.conf.json` under
  `bundle.resources` with an empty destination so they land in the install
  directory next to `Mymux.exe`.
- **Raw `cargo build` / `cargo run`:** `build.rs` copies them into
  `target/<profile>/` next to the built exe.

## Source & license

Both binaries come from the **Microsoft Terminal / ConPTY** project, obtained
from the `node-pty` prebuilt package (`node-pty/build/Release/conpty/`). They
are distributed under the **MIT License** (© Microsoft Corporation).

To refresh, copy `conpty.dll` and `OpenConsole.exe` from a current
`node-pty` install (e.g. VS Code's `resources/app/node_modules/node-pty/
build/Release/conpty/`) or from the Microsoft.Windows.Console.ConPTY package.
