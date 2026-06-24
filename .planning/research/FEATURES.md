# Feature Landscape

**Domain:** CLI command manager / snippet manager
**Researched:** 2026-03-26

## Table Stakes

Features users expect from any command manager. Missing any of these and users will switch to pet, navi, or just keep using shell history.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Save command with name + description | Core purpose of the tool. Every competitor does this (pet, navi, IntelliShell, cmdCompass). | Low | Already in PROJECT.md requirements |
| Fuzzy search / filter commands | Users have 50-200+ saved commands. Linear scan is unusable. pet uses fzf, navi uses skim, Warp has built-in fuzzy. | Medium | Use fuzzy matching library. Critical for both desktop and TUI. |
| Copy command to clipboard | Minimum viable action. Every tool supports this. Users often want to review before executing. | Low | Already in PROJECT.md requirements |
| Execute command directly | pet exec, navi direct execution, Warp workflows run inline. Users want one-click/keystroke run. | Medium | Needs embedded terminal or shell spawning. Already in PROJECT.md. |
| Edit saved commands | Commands evolve. Every tool allows editing (pet edit opens TOML, cmdCompass has inline edit). | Low | Already in PROJECT.md requirements |
| Delete saved commands | Basic CRUD. All tools support removal (pet rm, etc.). | Low | Implied by "settings mode" in PROJECT.md |
| Persistent storage across sessions | Commands must survive restarts. pet uses TOML, cmdCompass uses local DB, MyCli plans JSON. | Low | Already decided: JSON at ~/.mycli/commands.json |
| Cross-platform (Win/Mac/Linux) | pet (Go), navi (Rust), IntelliShell (Rust) all cross-platform. Single-platform tools lose users. | Medium | Tauri + Rust covers this. Already a constraint. |
| Keyboard-driven navigation | Power users live on the keyboard. All TUI tools are keyboard-first. Desktop apps need hotkeys too. | Medium | TUI is inherently keyboard-driven; desktop needs shortcut support |

## Differentiators

Features that set MyCli apart. Not expected, but create real competitive advantage when present.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dual-mode: desktop GUI + TUI from same data | No competitor does this well. pet/navi are CLI-only. cmdCompass is GUI-only. Warp is terminal-only. Having both with shared data is unique. | High | Core architectural differentiator. Shared JSON file between Tauri app and ratatui TUI. |
| Parameterized commands (variables/templates) | pet uses `<param>`, navi uses `<branch>`, IntelliShell uses `{{var}}`, Warp uses `{{arg}}`. Turns static commands into reusable templates. Saves significant time. | Medium | Not in current PROJECT.md but strongly recommended. e.g., `docker exec -it {{container}} bash` prompts user for container name at execution time. |
| Quick global hotkey launch | Warp's Command Palette opens with Cmd-P / Ctrl-Shift-P. Alfred/Raycast pattern. Instant access without switching windows. | Medium | Desktop-only. Register system-wide hotkey to pop open MyCli search overlay. |
| Import from shell history | IntelliShell can extract commands from bash history. Lowers barrier to building your command library. Users already have useful commands in history. | Medium | Parse ~/.bash_history, ~/.zsh_history. Let user pick which to save. |
| Tags / labels for organization | cmdCompass has colored tags. pet has tags. the-way has tags. Enables filtering without rigid hierarchy. Still compatible with flat list philosophy. | Low | Lightweight alternative to categories. User adds optional tags like "docker", "git", "deploy". Filter by tag in search. |
| Command output preview / dry run | Show what a command would do before executing. Reduces fear of running destructive commands. | Medium | Print mode (like navi --print). Show command after variable substitution but before execution. |
| tmux integration | Send command directly to a tmux pane. Power users in SSH sessions work in tmux. Avoids copy-paste dance. | Medium | Already desired per PROJECT.md context. Use tmux send-keys. |

## Anti-Features

Features to explicitly NOT build. These add complexity without proportional value for MyCli's target users.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Cloud sync / remote backup | Adds auth complexity, privacy concerns, server costs. pet syncs via Gist but it's fragile and rarely used. v1 should be local-only. | Export/import to JSON file. Users can put the JSON in their own cloud storage or git repo. |
| AI command generation | IntelliShell and Warp added AI copilots. Requires API keys, network dependency, ongoing cost. Distracts from core value. | Keep it manual. Users save commands they already know and trust. |
| Community/shared cheatsheet repository | tldr-pages and cheat.sh are community cheatsheet aggregators. Different problem space. MyCli is for personal commands, not reference docs. | Link out to tldr/cheat.sh for discovery. MyCli stores your curated, personalized commands. |
| Category/folder hierarchy | User explicitly chose flat list. Nested navigation adds complexity. cmdCompass has collections but the UX is heavier. | Use tags for lightweight grouping. Flat list with fuzzy search is faster than folder drilling. |
| Shell integration (autocomplete hook) | IntelliShell and Fig hook into shell completion. Requires per-shell setup (bash, zsh, fish, PowerShell), daemon processes, and shell-specific code. High maintenance. | Keep MyCli as a standalone app. User launches it, picks a command, and it copies/executes. No shell hook needed. |
| Multi-command workflows / chaining | Warp supports multi-step workflows. Adds significant complexity (sequencing, error handling, conditionals). | Save each command individually. Users can chain in their own scripts. |
| Man page integration | cmdCompass shows man pages inline. Niche feature, heavy to implement, only useful on Linux/Mac. | Out of scope. Users know where to find man pages. |
| Per-project/profile scoping | PROJECT.md explicitly marks this out of scope. Single global list is simpler. | One global commands.json. Users can use tags like "project-x" if they want soft grouping. |

## Feature Dependencies

```
Persistent storage (JSON) ─── required by everything
    |
    ├── Save/Edit/Delete commands (basic CRUD)
    |       |
    |       └── Fuzzy search (needs command list to search)
    |               |
    |               ├── Copy to clipboard (action on search result)
    |               └── Execute command (action on search result)
    |                       |
    |                       └── Parameterized commands (variable substitution before execution)
    |
    ├── Tags (stored as array in command JSON)
    |       |
    |       └── Filter by tag (enhances fuzzy search)
    |
    └── Import from history (creates commands into storage)

Desktop-specific:
    Global hotkey → opens search overlay → fuzzy search flow

TUI-specific:
    tmux detection → send-keys integration (alternative to execute-in-terminal)
```

## MVP Recommendation

Prioritize for v1 (in build order):

1. **JSON storage with CRUD** - Foundation everything else depends on
2. **Fuzzy search** - Useless without it once you have more than 10 commands
3. **Copy to clipboard** - Lowest friction action, works everywhere
4. **Execute command** - Direct execution in embedded terminal (desktop) or shell spawn (TUI)
5. **Keyboard navigation** - Essential for TUI, important for desktop power users
6. **Parameterized commands** - Strongly recommended even for v1. Transforms the tool from "clipboard manager for commands" to "command template engine". Low-medium complexity, high value. Use `{{variable}}` syntax with prompt-on-execute.

Defer to v1.1+:
- **Tags**: Nice-to-have but fuzzy search on name+description covers most use cases initially
- **Global hotkey**: Desktop polish feature, not core functionality
- **Import from history**: Onboarding improvement, not needed when command list is small
- **tmux send-keys**: Optimization for SSH power users, basic execute covers the need
- **Command output preview / dry run**: Safety feature, add after execution is solid

## Sources

- [pet - GitHub](https://github.com/knqyf263/pet) - Simple command-line snippet manager (Go)
- [navi - GitHub](https://github.com/denisidoro/navi) - Interactive cheatsheet tool (Rust)
- [IntelliShell - GitHub](https://github.com/lasantosr/intelli-shell) - Command template manager (Rust)
- [cmdCompass - GitHub](https://github.com/johnwangwyx/cmdCompass) - Cross-platform command manager GUI
- [Warp Workflows](https://docs.warp.dev/knowledge-and-collaboration/warp-drive/workflows) - Parameterized saved commands
- [Warp Command Palette](https://docs.warp.dev/terminal/command-palette) - Global search for commands
- [cheat.sh - GitHub](https://github.com/chubin/cheat.sh) - Community cheatsheet aggregator
- [tldr-pages - GitHub](https://github.com/tldr-pages/tldr) - Collaborative command cheatsheets
- [rsnip - GitHub](https://github.com/sysid/rsnip) - Rust snippet manager with fuzzy search
- [the-way - Lib.rs](https://lib.rs/crates/the-way) - Snippet manager with tags and fuzzy search
- [Command line snippet managers comparison](https://medium.com/@vaisakhkm2625/command-line-snippets-managers-3a2f3e5bfcc5)
- [CLI Man Pages, tldr, and cheat.sh comparison](https://dev.to/randazraik/the-ultimate-cheat-sheet-cli-man-pages-tldr-and-cheatsh-19bc)
