# Domain Pitfalls

**Domain:** Cross-platform command manager with dual UI (Tauri 2 desktop + ratatui TUI)
**Researched:** 2026-03-26

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: Shell Plugin Cannot Execute Arbitrary Commands

**What goes wrong:** Tauri 2's shell plugin uses a strict scope-based permission model where every executable and its allowed arguments must be pre-configured in `capabilities/default.json`. Developers discover mid-build that they cannot let users run arbitrary saved commands through the shell plugin's JavaScript API -- the plugin rejects any program not in the allowlist with "program not allowed on the configured shell scope."

**Why it happens:** Tauri's security model is designed to prevent arbitrary code execution from the WebView. The shell plugin requires whitelisting each command name, executable path, and argument pattern via regex validators. This is fundamentally at odds with a "run any saved command" feature.

**Consequences:** Either the core "execute" feature doesn't work, or developers resort to overly permissive regex patterns that defeat the security model, or they have to restructure the entire command execution approach.

**Prevention:** Do NOT use the shell plugin's JavaScript API for command execution. Instead, define a custom Tauri command in Rust (`#[tauri::command]`) that handles command execution server-side. The Rust backend has full system access and can spawn processes via `std::process::Command` or `tokio::process::Command` without scope restrictions. Route all execution through IPC: frontend sends the command string to Rust, Rust executes it and streams output back via Tauri channels.

**Detection:** You'll hit this immediately when trying to implement the execute button. If you find yourself writing increasingly permissive regex patterns in shell scope config, you're on the wrong path.

**Phase relevance:** Phase 1 (core architecture). Must be decided before any command execution code is written.

**Confidence:** HIGH -- verified via official Tauri shell plugin docs and GitHub issues #4575, #5910.

---

### Pitfall 2: Shared JSON File Race Condition / Corruption

**What goes wrong:** Both the desktop app and TUI read/write to `~/.mycli/commands.json`. If both are open simultaneously (e.g., desktop app open while user edits via TUI in a tmux pane), concurrent writes corrupt the JSON file -- truncated content, partial writes, or invalid JSON. This is the exact bug that has plagued tools like Claude Code with `.claude.json` corruption.

**Why it happens:** Standard file writes are not atomic. A process reads the file, modifies in memory, writes back. If another process reads between the write starting and completing, it gets partial data. On Windows, file locking semantics differ from Unix (mandatory vs advisory locks), making cross-platform solutions harder.

**Consequences:** Lost commands, corrupted data file requiring manual recovery, user trust destroyed. Data loss in a tool whose entire purpose is saving commands is fatal.

**Prevention:**
1. Use atomic writes: write to a temp file, fsync, then rename over the original. The `atomic-write-file` crate handles this cross-platform.
2. Use advisory file locking via `fs2` or `fd-lock` crate before read-modify-write cycles.
3. Pattern: acquire lock -> read -> modify -> atomic write -> release lock.
4. Both desktop (Rust backend) and TUI must share the same locking/writing code -- extract into a shared Rust library crate.

**Detection:** Test by opening both desktop and TUI simultaneously and rapidly saving commands from both. If you don't have a locking strategy, corruption will appear within minutes of concurrent use.

**Phase relevance:** Phase 1 (data layer). The shared data access pattern must be correct from the start since both UIs depend on it.

**Confidence:** HIGH -- well-documented class of bug with real-world examples (Claude Code issue #28806).

---

### Pitfall 3: Terminal Left in Broken State After TUI Panic/Crash

**What goes wrong:** ratatui puts the terminal into raw mode and switches to the alternate screen buffer. If the TUI panics or crashes without cleanup, the user's terminal is left in raw mode -- no line editing, no visible cursor, garbled output. Users must run `reset` or `tput reset` to recover, which is a terrible experience especially over SSH where they may not know the fix.

**Why it happens:** Rust panics unwind the stack but don't guarantee Drop runs on all resources. If the terminal restoration code isn't in a panic hook, the terminal stays in raw mode with the alternate screen active.

**Consequences:** User's SSH session becomes unusable. In tmux, the pane is corrupted. Users may think the tool broke their terminal.

**Prevention:** Use `ratatui::init()` which automatically sets up panic hooks (available since ratatui 0.28.1). This calls `ratatui::restore()` before the panic message prints, ensuring the terminal returns to normal state. For custom initialization, install a panic hook that calls `ratatui::restore()` before the default handler. Additionally, wrap the main TUI loop in a catch-unwind or use `color_eyre` with ratatui's panic hook integration.

**Detection:** Test by deliberately panicking (e.g., `panic!("test")`) inside the TUI render loop and verify the terminal recovers cleanly.

**Phase relevance:** Phase 1 (TUI scaffolding). Must be the first thing set up when initializing the TUI.

**Confidence:** HIGH -- documented in official ratatui recipes and issue #2087.

---

### Pitfall 4: Tauri Shell Plugin Scope for "Execute in Terminal" Is Not a Built-in Terminal

**What goes wrong:** Developers assume Tauri provides a built-in terminal emulator widget. It does not. The requirement "execute command in built-in terminal" requires either embedding a terminal emulator in the WebView (e.g., xterm.js) connected to a PTY, or opening the user's system terminal. Developers spend weeks trying to build terminal emulation only to realize the complexity is enormous.

**Why it happens:** "Built-in terminal" sounds simple but requires: PTY allocation, terminal escape sequence parsing, shell session management, resize handling, and cross-platform PTY APIs (ConPTY on Windows, forkpty on Unix).

**Consequences:** Massive scope creep. The "execute" feature becomes 70% of development effort instead of being a simple button click.

**Prevention:** For v1, redefine "execute" as one of these simpler alternatives:
- **Option A (recommended):** Execute command via Rust backend's `std::process::Command`, capture stdout/stderr, display output in a simple scrollable text area in the frontend. No interactive shell needed.
- **Option B:** Open the user's default terminal application with the command pre-filled (platform-specific: `cmd /c` on Windows, `open -a Terminal` on macOS, `x-terminal-emulator` on Linux).
- **Option C (complex, defer):** Embed xterm.js + a PTY backend. Only attempt this if interactive commands are truly needed.

**Detection:** If you find yourself researching PTY crates (`portable-pty`, `conpty`) in Phase 1, scope is creeping.

**Phase relevance:** Phase 1 (feature scoping). Must decide execution model before building.

**Confidence:** HIGH -- architectural decision with well-understood tradeoffs.

## Moderate Pitfalls

### Pitfall 5: Windows Crossterm Double Key Events

**What goes wrong:** On Windows, crossterm fires both `KeyEventKind::Press` and `KeyEventKind::Release` events for each keystroke. On macOS/Linux only `Press` is fired. If the TUI event handler doesn't filter by event kind, every action happens twice on Windows -- double character input, double navigation, double command execution.

**Prevention:** Always filter key events: `if key_event.kind == KeyEventKind::Press { /* handle */ }`. This is documented in the ratatui FAQ but easy to miss. Apply this filter in the central event loop, not per-handler.

**Detection:** First test on Windows will show doubled inputs. Add Windows to your test matrix from day one.

**Phase relevance:** Phase 1 (TUI event handling). Trivial fix if caught early, but confusing to debug if discovered later.

**Confidence:** HIGH -- documented in ratatui FAQ and crossterm docs.

---

### Pitfall 6: WebView Rendering Differences Across Platforms

**What goes wrong:** Tauri uses different WebView engines per platform: WebView2 (Chromium-based) on Windows, WKWebView (WebKit/Safari) on macOS, WebKitGTK on Linux. CSS/JS that works on Windows may break on macOS or Linux. Fonts render differently, flexbox edge cases differ, and Linux WebKitGTK versions vary wildly by distro.

**Prevention:**
- Use vanilla HTML/CSS (already planned) -- simpler CSS has fewer cross-platform issues than framework-generated styles.
- Target WebKit as the lowest common denominator: test in Safari or use `-webkit-` prefixes where needed.
- Use `normalize.css` for consistent baseline.
- Avoid bleeding-edge CSS features (container queries, CSS nesting) -- WebKitGTK on older distros may not support them.
- Test on all three platforms during development, not just before release.

**Detection:** Build looks different on macOS vs Windows vs Linux. Fonts are wrong, layouts shift, scrolling behavior differs.

**Phase relevance:** Phase 2 (desktop UI implementation). Affects all frontend development.

**Confidence:** HIGH -- documented in Tauri discussion #12311 and webview-versions reference.

---

### Pitfall 7: Monolithic Binary vs Workspace Structure

**What goes wrong:** Developers put all code in a single Rust crate. The Tauri desktop app and TUI binary need to share data access logic (JSON reading/writing, locking, command model types) but are fundamentally different binaries. A monolithic structure means the TUI binary pulls in Tauri dependencies (WebView, etc.) or the desktop app pulls in ratatui/crossterm, bloating both.

**Prevention:** Use a Cargo workspace with three crates:
- `mycli-core`: Shared library -- data models, JSON I/O, file locking, command execution logic.
- `mycli-desktop`: Tauri application, depends on `mycli-core`.
- `mycli-tui`: ratatui terminal UI, depends on `mycli-core`.

This keeps binaries lean (TUI binary stays small for SSH/server use) and ensures data handling logic is identical between both UIs.

**Detection:** If `cargo build` for the TUI target starts pulling in WebView/Tauri dependencies, or the TUI binary exceeds 10MB, the structure is wrong.

**Phase relevance:** Phase 1 (project scaffolding). Must be set up at project creation.

**Confidence:** HIGH -- standard Rust workspace pattern for multi-binary projects.

---

### Pitfall 8: Rust Compile Times Stalling Development

**What goes wrong:** A clean Tauri 2 + ratatui build can take 5-10 minutes. Every code change triggers a long recompile cycle, destroying development velocity. Developers get frustrated and make larger, less-tested changes to avoid waiting.

**Prevention:**
- Set `rust-analyzer.cargo.targetDir` to a separate directory to avoid lock conflicts with `cargo tauri dev`.
- Enable incremental compilation (default in debug, verify it's not disabled).
- Use `sccache` for shared compilation cache.
- Use `cargo tauri dev` for hot-reload of the frontend (Tauri reloads WebView without Rust recompile when only JS/HTML/CSS changes).
- Consider `cargo-watch` for the TUI crate during development.
- In `Cargo.toml` dev profile, do NOT set `opt-level`, `lto`, or `codegen-units = 1` -- those are release-only optimizations that destroy incremental compilation.

**Detection:** If a single-line Rust change takes more than 30 seconds to recompile in dev mode, investigate.

**Phase relevance:** Phase 1 (developer experience setup). Configure at project creation.

**Confidence:** MEDIUM -- varies by machine specs, but well-documented concern.

---

### Pitfall 9: TUI Not Properly Handling Terminal Resize in tmux

**What goes wrong:** When a tmux pane is resized, the TUI doesn't reflow its layout. Content gets clipped, wraps incorrectly, or the UI becomes garbled. This is especially bad in tmux where users frequently resize panes.

**Prevention:** ratatui's layout system is declarative and recalculates on each render frame. The key is to handle the `crossterm::event::Event::Resize(cols, rows)` event in your event loop and trigger a redraw. Additionally, use ratatui's `Constraint` system with percentages and `Min`/`Max` rather than fixed sizes so layouts adapt to any terminal size.

**Detection:** Run TUI in tmux, resize the pane. If the UI doesn't immediately adapt, the resize event handling is missing.

**Phase relevance:** Phase 2 (TUI UI implementation). Must be part of the event loop from the start.

**Confidence:** HIGH -- standard ratatui pattern.

## Minor Pitfalls

### Pitfall 10: Forgetting to Strip Debug Symbols in Release Builds

**What goes wrong:** Release binaries are 3-5x larger than necessary because debug symbols are included. The 5-10MB bundle size target is missed.

**Prevention:** In `Cargo.toml` under `[profile.release]`: set `strip = true`, `lto = true`, `codegen-units = 1`, `opt-level = "z"` (or `"s"` for slightly faster code). UPX can further compress the binary.

**Phase relevance:** Pre-release (build configuration). Set up once.

**Confidence:** HIGH -- documented in Tauri size optimization guide.

---

### Pitfall 11: Hardcoding Config Path Instead of Using Platform Conventions

**What goes wrong:** Using `~/.mycli/` works on Linux/macOS but `~` expansion behaves differently on Windows. Hardcoded Unix paths break on Windows.

**Prevention:** Use the `dirs` or `directories` crate to get platform-appropriate paths. On Windows this resolves to `%APPDATA%\mycli`, on macOS `~/Library/Application Support/mycli`, on Linux `~/.config/mycli` (XDG). Alternatively, keep `~/.mycli` but use `dirs::home_dir()` for the tilde expansion rather than string manipulation.

**Detection:** App fails to find/create config directory on Windows.

**Phase relevance:** Phase 1 (data layer). Affects where `commands.json` is stored.

**Confidence:** HIGH -- standard cross-platform Rust pattern.

---

### Pitfall 12: Clipboard Access Differences Between Desktop and TUI

**What goes wrong:** The "copy to clipboard" feature works differently in desktop (WebView clipboard API or Tauri clipboard plugin) vs TUI (requires system clipboard access via `xclip`/`xsel` on Linux, `pbcopy` on macOS, or Windows clipboard API). Over SSH, system clipboard is typically not available at all.

**Prevention:** In desktop mode, use Tauri's clipboard plugin (straightforward). In TUI mode, use the `arboard` or `cli-clipboard` crate which handles platform differences. For SSH sessions, accept that clipboard may not work and provide a visual "command text selected -- copy from your terminal" fallback. Document this limitation.

**Detection:** Clipboard works on desktop but fails in TUI over SSH.

**Phase relevance:** Phase 2 (feature implementation). Plan the fallback early.

**Confidence:** MEDIUM -- depends on SSH configuration (X11 forwarding, OSC 52 support).

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Project scaffolding | Monolithic crate (#7) | Set up Cargo workspace with 3 crates from day one |
| Data layer | Race condition (#2), path hardcoding (#11) | Atomic writes + file locking in shared core crate; use `dirs` crate |
| TUI scaffolding | Panic cleanup (#3), double key events (#5) | Use `ratatui::init()`, filter `KeyEventKind::Press` |
| Command execution | Shell plugin limitations (#1), terminal emulation scope (#4) | Custom Rust IPC command, not shell plugin; simple output display for v1 |
| Desktop UI | WebView differences (#6) | Target WebKit as baseline, test all 3 platforms |
| TUI UI | Resize handling (#9), clipboard (#12) | Handle Resize event, provide SSH clipboard fallback |
| Release builds | Bundle size (#10), compile times (#8) | Strip + LTO in release profile; sccache for dev |

## Sources

- [Tauri 2 Shell Plugin docs](https://v2.tauri.app/plugin/shell/) -- scope-based permission model
- [Tauri Shell scope feature request #4575](https://github.com/tauri-apps/tauri/issues/4575) -- arbitrary command execution limitation
- [Tauri 2 Permissions](https://v2.tauri.app/security/permissions/) -- security model overview
- [Tauri 2 WebView Versions](https://v2.tauri.app/reference/webview-versions/) -- platform WebView differences
- [Tauri cross-platform rendering discussion #12311](https://github.com/tauri-apps/tauri/discussions/12311)
- [Tauri App Size optimization](https://v2.tauri.app/concept/size/)
- [Ratatui FAQ](https://ratatui.rs/faq/) -- Windows key event doubling
- [Ratatui Panic Hooks recipe](https://ratatui.rs/recipes/apps/panic-hooks/) -- terminal restoration
- [Ratatui init/restore docs](https://docs.rs/ratatui/latest/ratatui/) -- modern panic handling
- [Claude Code JSON corruption #28806](https://github.com/anthropics/claude-code/issues/28806) -- real-world shared file race condition
- [atomic-write-file crate](https://crates.io/crates/atomic-write-file) -- cross-platform atomic writes
- [fs2 crate](https://docs.rs/fs2/latest/fs2/trait.FileExt.html) -- cross-platform file locking
- [Tauri shell plugin security advisory GHSA-c9pr-q8gx-3mgp](https://github.com/tauri-apps/plugins-workspace/security/advisories/GHSA-c9pr-q8gx-3mgp) -- open endpoint vulnerability
