# Architecture Research

**Domain:** Dual-mode CLI command manager (Tauri 2 desktop + ratatui TUI)
**Researched:** 2026-03-26
**Confidence:** HIGH

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                         │
│                                                                 │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │   Tauri Desktop App  │      │   ratatui TUI App    │        │
│  │  (HTML/CSS/JS in     │      │  (Rust binary,       │        │
│  │   system WebView)    │      │   crossterm backend)  │        │
│  └──────────┬───────────┘      └──────────┬───────────┘        │
│             │ IPC commands                 │ direct fn calls    │
├─────────────┴──────────────────────────────┴────────────────────┤
│                      BACKEND LAYER                              │
│                                                                 │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │  Tauri Command        │      │  TUI App Logic       │        │
│  │  Handlers (thin)     │      │  (thin)              │        │
│  └──────────┬───────────┘      └──────────┬───────────┘        │
│             │                              │                    │
│  ┌──────────┴──────────────────────────────┴───────────┐       │
│  │              mycli-core (shared library)             │       │
│  │                                                     │       │
│  │  ┌─────────────┐ ┌────────────┐ ┌───────────────┐  │       │
│  │  │  Commands   │ │  Storage   │ │  Executor     │  │       │
│  │  │  (CRUD)     │ │  (JSON)    │ │  (run cmds)   │  │       │
│  │  └─────────────┘ └────────────┘ └───────────────┘  │       │
│  └─────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────┤
│                      DATA LAYER                                 │
│                                                                 │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  ~/.mycli/commands.json                              │      │
│  │  (shared file, both apps read/write)                 │      │
│  └──────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **mycli-core** | All business logic: command CRUD, JSON storage, command execution | Rust library crate, no UI dependencies |
| **mycli-desktop** | Tauri 2 desktop app, WebView frontend, IPC command handlers | Tauri app crate depending on mycli-core |
| **mycli-tui** | Terminal UI for SSH/tmux, keyboard navigation, terminal rendering | Binary crate using ratatui + crossterm, depending on mycli-core |
| **Frontend (HTML/JS)** | Desktop UI rendering, user interaction, invoke Tauri commands | Vanilla HTML/CSS/JS in project root |
| **commands.json** | Persistent storage of saved commands | JSON file at ~/.mycli/commands.json |

## Recommended Project Structure

```
mycli/
├── Cargo.toml                  # Workspace manifest
├── package.json                # Frontend dev dependencies (optional, for tooling)
├── crates/
│   ├── mycli-core/             # Shared library crate
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs          # Public API: re-exports
│   │       ├── models.rs       # Command struct, serde types
│   │       ├── storage.rs      # JSON read/write with file locking
│   │       ├── executor.rs     # Run commands via std::process::Command
│   │       └── error.rs        # Error types
│   │
│   └── mycli-tui/              # TUI binary crate
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs         # Entry point, terminal setup/teardown
│           ├── app.rs          # App state, main event loop
│           ├── ui.rs           # Render functions (view layer)
│           ├── input.rs        # Key event handling
│           └── components/     # UI components (command list, editor, etc.)
│               ├── mod.rs
│               ├── command_list.rs
│               └── command_editor.rs
│
├── src-tauri/                  # Tauri 2 desktop app
│   ├── Cargo.toml              # Depends on mycli-core
│   ├── tauri.conf.json         # Tauri configuration
│   ├── build.rs                # Tauri build hook
│   ├── capabilities/
│   │   └── default.json        # Permission definitions
│   ├── icons/                  # App icons
│   └── src/
│       ├── main.rs             # Desktop entry point (calls lib::run)
│       ├── lib.rs              # Tauri app builder, plugin/command registration
│       └── commands.rs         # #[tauri::command] handlers (thin wrappers)
│
└── frontend/                   # Desktop UI (vanilla HTML/CSS/JS)
    ├── index.html              # Main HTML
    ├── styles.css              # Styles
    └── main.js                 # JS: invoke Tauri commands, render UI
```

### Structure Rationale

- **crates/ directory:** Keeps core library and TUI binary as standard Cargo workspace members, cleanly separated from the Tauri-specific structure.
- **mycli-core as library crate:** The critical architectural decision. All business logic lives here so both Tauri commands and TUI code call the same functions. Zero UI dependencies in this crate.
- **src-tauri/ at root level:** Tauri 2 expects this location by convention. It is also a workspace member but follows Tauri's standard layout.
- **frontend/ separate from src-tauri/:** Keeps vanilla HTML/CSS/JS clearly separated from Rust code. Tauri's `tauri.conf.json` points to this directory as the frontend source.
- **TUI components/ directory:** Mirrors ratatui's component architecture pattern for organizing UI pieces.

### Workspace Cargo.toml

```toml
[workspace]
members = [
    "crates/mycli-core",
    "crates/mycli-tui",
    "src-tauri",
]
resolver = "2"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
```

## Architectural Patterns

### Pattern 1: Shared Core Library (The Backbone)

**What:** All business logic (command CRUD, storage, execution) lives in `mycli-core`. Both the Tauri desktop app and the TUI binary depend on it as a path dependency. Neither UI layer contains business logic.

**When to use:** Always -- this is the fundamental pattern for dual-mode apps.

**Trade-offs:** Slightly more initial setup (workspace config), but prevents logic duplication and ensures both modes behave identically.

**Example:**

```rust
// crates/mycli-core/src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
}

// crates/mycli-core/src/storage.rs
use crate::models::SavedCommand;
use crate::error::CoreError;

pub struct CommandStore {
    path: std::path::PathBuf,
}

impl CommandStore {
    pub fn new() -> Result<Self, CoreError> { /* ~/.mycli/commands.json */ }
    pub fn list(&self) -> Result<Vec<SavedCommand>, CoreError> { /* read JSON */ }
    pub fn add(&self, cmd: SavedCommand) -> Result<(), CoreError> { /* write JSON */ }
    pub fn update(&self, cmd: SavedCommand) -> Result<(), CoreError> { /* ... */ }
    pub fn remove(&self, id: &str) -> Result<(), CoreError> { /* ... */ }
}
```

### Pattern 2: Thin Tauri Command Wrappers

**What:** Tauri `#[tauri::command]` handlers do nothing except call into `mycli-core` and return the result. They are pure glue code.

**When to use:** Every Tauri command handler.

**Trade-offs:** Feels boilerplate-y, but keeps Tauri-specific concerns (serde for IPC, State extraction) out of core logic.

**Example:**

```rust
// src-tauri/src/commands.rs
use mycli_core::{CommandStore, SavedCommand};
use tauri::State;
use std::sync::Mutex;

#[tauri::command]
pub fn list_commands(store: State<'_, Mutex<CommandStore>>) -> Result<Vec<SavedCommand>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_command(store: State<'_, Mutex<CommandStore>>, cmd: SavedCommand) -> Result<(), String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store.add(cmd).map_err(|e| e.to_string())
}
```

### Pattern 3: Ratatui Component Architecture for TUI

**What:** Each TUI screen/widget is a component that owns its state, handles its events, and renders itself. Components implement a `Component` trait with `handle_event`, `update`, and `render` methods.

**When to use:** For the TUI binary -- keeps the terminal UI modular and testable.

**Trade-offs:** More structured than a single monolithic `App::render()`, but for a small app with 2-3 views this is proportionate.

**Example:**

```rust
// crates/mycli-tui/src/app.rs
use mycli_core::CommandStore;

pub enum AppMode {
    List,       // Browsing commands
    Edit,       // Editing a command
    Execute,    // Viewing execution output
}

pub struct App {
    pub store: CommandStore,
    pub mode: AppMode,
    pub command_list: CommandListComponent,
    pub command_editor: CommandEditorComponent,
    pub should_quit: bool,
}
```

### Pattern 4: Tauri Managed State with Mutex

**What:** The `CommandStore` is wrapped in `Mutex<CommandStore>` and registered via `app.manage()`. Tauri commands extract it via `State<'_, Mutex<CommandStore>>`. No need for `Arc` -- Tauri wraps managed state in `Arc` internally.

**When to use:** For any shared state in Tauri commands.

**Trade-offs:** Mutex adds locking overhead, but for a command manager with infrequent writes this is negligible.

## Data Flow

### Desktop: User Saves a Command

```
User clicks "Save" in WebView
    |
    v
main.js: invoke("add_command", { cmd: {...} })
    |
    v (Tauri IPC - serialized JSON via webview message passing)
    |
commands.rs: add_command(store: State<Mutex<CommandStore>>, cmd)
    |
    v (lock mutex, call core)
    |
mycli-core storage.rs: store.add(cmd)
    |
    v (read JSON, append, write JSON with file lock)
    |
~/.mycli/commands.json updated
    |
    v (return Ok(()) up the chain)
    |
main.js: receives success, refreshes UI
```

### TUI: User Executes a Command

```
User presses Enter on selected command
    |
    v
input.rs: KeyCode::Enter => Action::Execute(selected_id)
    |
    v
app.rs: match Action::Execute(id) => {
    let cmd = self.store.get(id);
    executor::run(&cmd.command)
}
    |
    v
mycli-core executor.rs: std::process::Command::new(shell)
    .arg("-c").arg(command_text)  // Unix
    .arg("/C").arg(command_text)  // Windows
    .spawn() / .output()
    |
    v
Output displayed in TUI or terminal restored for interactive command
```

### Shared Data Access (Desktop + TUI)

```
Desktop App                          TUI App
    |                                    |
    v                                    v
CommandStore::add()                 CommandStore::list()
    |                                    |
    v                                    v
fs2::lock_exclusive()               fs2::lock_shared()
    |                                    |
    v                                    v
Write commands.json                 Read commands.json
    |                                    |
    v                                    v
fs2::unlock()                       fs2::unlock()
```

Both apps operate on `~/.mycli/commands.json`. Since they are separate processes, file-level locking (via `fs2` crate) prevents corruption. In practice, simultaneous access is rare for a personal tool, but the locking is cheap insurance.

### Key Data Flows

1. **Command CRUD (both modes):** UI action -> core store method -> JSON file read/modify/write -> UI refresh.
2. **Command Execution (TUI):** User selects command -> `std::process::Command` spawns shell process -> output captured or terminal handed over.
3. **Command Execution (Desktop):** User clicks execute -> Tauri shell plugin or custom command spawns process -> output streamed back to WebView.
4. **Clipboard Copy (Desktop):** User clicks copy -> JS `navigator.clipboard.writeText()` or Tauri clipboard plugin -> done.
5. **Clipboard Copy (TUI):** User presses copy key -> output command text to stdout (tmux-compatible) or use OSC 52 escape sequence for terminal clipboard.

## Build Order (Dependency Chain)

This is critical for roadmap phasing:

```
Phase 1: mycli-core (zero UI dependencies)
    |
    +---> Phase 2a: mycli-tui (depends on core)
    |
    +---> Phase 2b: src-tauri + frontend (depends on core)
    |
    v
Phase 3: Polish, cross-platform testing, packaging
```

**mycli-core MUST be built first.** Both UI layers depend on it. Building core first also allows testing business logic in isolation before any UI work begins.

Phases 2a and 2b are independent and can be built in parallel or in either order. The TUI is simpler (pure Rust, no frontend tooling) and may be faster to stand up. The desktop app requires Tauri setup, frontend HTML/JS, and IPC wiring.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Personal use (1 user) | Current architecture is perfect. JSON file, no server, no sync. |
| Power user (100s of commands) | JSON is fine up to thousands of entries. Add search/filter in core. |
| Multi-machine | Out of scope for v1. Future: could add file sync via Git, Syncthing, or cloud backend. Would require replacing `CommandStore` impl behind a trait. |

### Scaling Priorities

1. **First bottleneck:** UI responsiveness with large command lists. Solution: add search/filter to core, lazy rendering in TUI.
2. **Second bottleneck:** JSON parsing time with very large files. Unlikely to matter -- 1000 commands is ~50KB of JSON.

## Anti-Patterns

### Anti-Pattern 1: Business Logic in Tauri Commands

**What people do:** Put command validation, storage logic, or execution logic directly in `#[tauri::command]` handlers.
**Why it's wrong:** The TUI cannot reuse any of that logic. You end up duplicating or diverging behavior between modes.
**Do this instead:** Tauri commands are 3-5 line functions that extract state, call core, and return the result. Nothing more.

### Anti-Pattern 2: Business Logic in TUI Event Handlers

**What people do:** Put storage operations directly in key event match arms.
**Why it's wrong:** Same problem -- creates TUI-specific behavior paths that diverge from desktop.
**Do this instead:** Event handlers produce Actions. The app update loop dispatches Actions to core library calls.

### Anti-Pattern 3: Sharing State via Global Mutable Static

**What people do:** Use `lazy_static!` or `once_cell` with `Mutex<CommandStore>` as a global.
**Why it's wrong:** Hard to test, hard to configure (different paths for tests), hidden dependency.
**Do this instead:** Pass `CommandStore` explicitly. Tauri has `manage()` for this. TUI has `App` struct ownership.

### Anti-Pattern 4: Async Where Not Needed

**What people do:** Make everything async because Tauri supports async commands.
**Why it's wrong:** JSON file I/O is fast enough to be synchronous. Adding tokio/async-std for file reads adds complexity without benefit for this use case.
**Do this instead:** Keep core synchronous. Only use async for long-running command execution if streaming output to the UI.

### Anti-Pattern 5: Over-Engineering the Data Layer

**What people do:** Reach for SQLite, sled, or a database for what is fundamentally a list of 10-200 commands.
**Why it's wrong:** Adds dependencies, complexity, and migration concerns for zero benefit at this scale.
**Do this instead:** JSON file with serde. Human-readable, editable, debuggable. Revisit only if proven insufficient.

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Frontend JS <-> Tauri Rust | Tauri IPC (`invoke()` / `#[tauri::command]`) | All data serialized via serde JSON. Commands must be registered in `generate_handler![]` macro. |
| TUI App <-> mycli-core | Direct Rust function calls | No serialization overhead. TUI owns a `CommandStore` instance. |
| mycli-core <-> File System | `std::fs` + `serde_json` + `fs2` for locking | Both processes can safely access the same file. |
| Command Execution <-> OS | `std::process::Command` | Cross-platform: use `sh -c` on Unix, `cmd /C` on Windows. |

### Platform-Specific Concerns

| Concern | Unix/macOS | Windows |
|---------|------------|---------|
| Shell for execution | `/bin/sh -c "command"` | `cmd.exe /C "command"` |
| Config directory | `~/.mycli/` | `%APPDATA%\mycli\` or `~/.mycli/` |
| Clipboard (TUI) | OSC 52, xclip, or pbcopy | OSC 52 or `clip.exe` |
| Terminal backend | crossterm (works everywhere) | crossterm (ConPTY support) |

Use the `dirs` crate for cross-platform config directory resolution, or hard-code `~/.mycli/` since the project targets developer users who expect Unix-like paths (and `~` expansion works on Windows in most contexts).

## Technology Decisions Embedded in Architecture

| Decision | Rationale |
|----------|-----------|
| Cargo workspace with 3 members | Clean separation, shared dependencies, single `cargo build` |
| `mycli-core` as library crate | Enables code sharing without duplication between desktop and TUI |
| Synchronous core, no async runtime | JSON file I/O doesn't need async. Keeps core simple and dependency-light. |
| `serde` + `serde_json` for storage | Standard Rust serialization. Human-readable output. |
| `fs2` for file locking | Cross-platform advisory file locks. Prevents corruption from concurrent access. |
| crossterm backend for ratatui | Best Windows support among ratatui backends. Works in SSH/tmux. |
| `std::process::Command` for execution | Standard library, no extra dependencies. Sufficient for "run this shell command." |
| Vanilla HTML/CSS/JS for frontend | Project requirement. No build step needed. Tauri serves it directly. |

## Sources

- [Tauri 2 Project Structure](https://v2.tauri.app/start/project-structure/) - Official Tauri v2 docs
- [Tauri 2 Architecture](https://v2.tauri.app/concept/architecture/) - IPC and security model
- [Tauri 2 Calling Rust from Frontend](https://v2.tauri.app/develop/calling-rust/) - Command system
- [Tauri 2 State Management](https://v2.tauri.app/develop/state-management/) - Managed state with Mutex
- [Tauri 2 Shell Plugin](https://v2.tauri.app/plugin/shell/) - Command execution from desktop
- [Ratatui Component Architecture](https://ratatui.rs/concepts/application-patterns/component-architecture/) - TUI app patterns
- [Ratatui Application Patterns](https://ratatui.rs/concepts/application-patterns/) - TEA, Flux, Component
- [Cargo Workspaces](https://doc.rust-lang.org/book/ch14-03-cargo-workspaces.html) - Rust workspace setup
- [fs2 crate](https://docs.rs/fs2/latest/fs2/trait.FileExt.html) - Cross-platform file locking
- [crossterm](https://github.com/crossterm-rs/crossterm) - Cross-platform terminal library

---
*Architecture research for: MyCli dual-mode command manager*
*Researched: 2026-03-26*
