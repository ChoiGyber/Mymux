# Mymux Roadmap

Planned work, in order. Shipped items move to [CHANGELOG.md](CHANGELOG.md).

## Next version — planned / 다음 버전 계획

_(empty — propose the next batch here)_

Ideas parked for later / 후보:
- **Command output blocks in a gutter** — clickable prompt marks in a left
  gutter (colored by exit code) instead of keyboard-only jump/copy.
- **Session/scrollback persistence** across restarts (tmux-resurrect style).
- **Quick-select overlay** — letter labels on panes for keyboard pane jump.

## Shipped recently / 최근 반영

- **Shell-integration command marks (OSC 133)** — bash `--rcfile` and the
  PowerShell prompt now emit `133;A/B/D` (prompt start / input start / exit).
  The frontend tracks them per pane with `registerMarker`:
  - **Prompt jump** — Ctrl+Shift+↑ / Ctrl+Shift+↓ between prompts.
  - **Command block copy** — copy a command + its output as one block.
  - **Current input line copy/cut** — Ctrl+A selects the typed command,
    Ctrl+X cuts it (Ctrl+C copies the selection); also in the palette.
- **Command palette (Ctrl+Shift+P)** — fuzzy launcher over every action
  (split/zoom/broadcast/search, prompt jump, input copy/cut, SSH, theme, font).
- **Scrollback search** (Ctrl+Shift+F), **Ctrl+Click links → in-app browser**,
  **pane zoom** (Ctrl+Shift+Z), **activity badges + taskbar attention flash**,
  **per-tab input broadcast** (Ctrl+Shift+B) — v0.1.17.
- v0.1.16: unix `open_external` zombie fix, tab-move scroll pin.
- v0.1.15: Hangul UTF-8 chunk fix, scroll pin on pane rearrange, macOS source
  build.
