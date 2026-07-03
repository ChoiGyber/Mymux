# Mymux Roadmap

Planned work, in order. Shipped items move to [CHANGELOG.md](CHANGELOG.md).

## Next version — planned / 다음 버전 계획

### 1. Shell-integration command marks (OSC 133) / 셸 통합 커맨드 마크
Emit `OSC 133;A/B/C/D` prompt/command/output markers from the shells Mymux
launches, then use them in the terminal UI:

- **Prompt jump** — Ctrl+↑ / Ctrl+↓ moves the viewport between prompts.
- **Command blocks** — select / copy / save one command's entire output with a
  click (gutter mark or context menu), no manual drag-selection.
- Integration points (all already Mymux-injected, so no user setup):
  - Git Bash: the generated `--rcfile` (`mymux_bashrc`) adds the markers via
    `PS0`/`PROMPT_COMMAND` — see `terminal.rs`.
  - PowerShell: the injected `-EncodedCommand` prompt function prepends the
    markers (`terminal.rs`).
  - Frontend: `term.parser.registerOscHandler(133, …)` records marker rows per
    pane (the OSC 9/777/52 handlers in `app.js` are the pattern to follow).
- Why: reviewing long AI-CLI sessions (Claude Code / Codex) currently means
  scrolling and hand-selecting output; marks make that one keystroke.

프롬프트 사이 점프(Ctrl+↑/↓), 명령 단위 출력 블록 선택·복사·저장. Mymux가 이미
주입하는 bash rcfile/PS 프롬프트에 마커만 추가하면 되므로 사용자 설정 불필요.

### 2. Command palette (Ctrl+Shift+P) / 커맨드 팔레트
One fuzzy-searchable entry point for every action: split/zoom/broadcast,
tab & session switching, saved Commands, theme/font toggles, SSH connect.

- Reuse the existing modal + autocomplete-popup styles; actions come from a
  small registry (`{ name, hint, run() }` list) so features register
  themselves.
- Why: the toolbar is dense and shortcuts are hard to discover; the palette
  makes every feature findable by typing.

기능이 많아진 만큼(분할·줌·브로드캐스트·저장명령·SSH…) 타이핑 한 번으로 모든
동작을 찾는 진입점. 기존 모달/자동완성 스타일 재사용.

## Shipped recently / 최근 반영

- **Scrollback search** (Ctrl+Shift+F), **Ctrl+Click links → in-app browser**,
  **pane zoom** (Ctrl+Shift+Z), **activity badges + taskbar attention flash**,
  **per-tab input broadcast** (Ctrl+Shift+B) — see CHANGELOG "Unreleased".
- v0.1.16: unix `open_external` zombie fix, tab-move scroll pin.
- v0.1.15: Hangul UTF-8 chunk fix, scroll pin on pane rearrange, macOS source
  build.
