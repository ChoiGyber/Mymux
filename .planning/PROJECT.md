# MyCli

## What This Is

A lightweight, cross-platform command manager that lets users save, organize, and quickly execute frequently used terminal commands. Available as both a Tauri 2 desktop app (with top menu bar and clickable command lists) and a TUI (terminal UI) mode for SSH/tmux sessions. Built to be small, fast, and simple.

## Core Value

Instantly access and execute your saved commands from anywhere — desktop or remote terminal — with minimal friction.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Save frequently used commands with name and short description
- [ ] Top menu bar with clickable dropdown showing command list
- [ ] Each command shows name, command text, and short description
- [ ] Edit button to modify saved commands
- [ ] Copy button to copy command to clipboard
- [ ] Execute button to run command in built-in terminal
- [ ] Flat list display (no category hierarchy)
- [ ] Settings mode for managing saved commands
- [ ] JSON file storage (~/.mycli/commands.json)
- [ ] Tauri 2 desktop app (small bundle ~5-10MB)
- [ ] TUI mode for SSH/tmux terminal sessions
- [ ] Cross-platform support (Windows, Mac, Linux)

### Out of Scope

- Session/daemon management (previous MyCli feature) — rebuilding from scratch with different focus
- SSH server connection management — out of scope for v1, focus on command management
- Profile/project-based configuration — keep it simple, single global command list
- Category/folder hierarchy — user chose flat list for simplicity
- Cloud sync — local-only for v1

## Context

- Rebuilding from an existing Electron-based MyCli (session manager) into a completely different tool
- Previous codebase will be deleted; starting from scratch with Tauri 2
- User wants small binary size (Tauri ~5-10MB vs Electron ~100MB+)
- Must work over SSH (tmux compatible) via TUI mode using ratatui (Rust)
- Desktop frontend will use vanilla HTML/CSS/JS (no heavy framework)
- Data shared between desktop and TUI via same JSON file
- tmux integration is desired — commands usable within tmux sessions

## Constraints

- **Tech Stack**: Tauri 2 (desktop) + ratatui (TUI), Rust backend, vanilla JS frontend
- **Bundle Size**: Must be significantly smaller than Electron (~5-10MB target)
- **Simplicity**: UI must be simple and intuitive, no complex workflows
- **Compatibility**: Must work on Windows, Mac, Linux; TUI must work in SSH/tmux

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri 2 over Electron | ~90% smaller bundle, system WebView, Rust backend | — Pending |
| ratatui for TUI | Mature Rust TUI library, cross-platform, tmux compatible | — Pending |
| JSON file storage | Simple, human-readable, shared between desktop and TUI | — Pending |
| Flat list (no categories) | User preference for simplicity | — Pending |
| Both copy and execute | User wants clipboard copy + direct execution options | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-26 after initialization*
