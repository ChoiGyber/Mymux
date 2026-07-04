# Changelog

All notable changes to **Mymux** are documented here.
Mymux의 주요 변경 사항을 기록합니다.

For installers, see the [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases).
설치 파일은 [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)에서 받으세요.

---

## Unreleased

### Added / 새 기능
- **Shell prompt jump & command blocks (OSC 133) / 프롬프트 점프·명령 블록.**
  The shells Mymux launches (Git Bash, PowerShell) now mark each prompt.
  **Ctrl+Shift+↑ / ↓** jumps between prompts, and the command palette can copy a
  whole command + its output as one block — no manual drag-selecting.

  Mymux가 실행하는 셸(Git Bash·PowerShell)이 각 프롬프트를 표시합니다.
  **Ctrl+Shift+↑ / ↓** 로 프롬프트 사이를 이동하고, 커맨드 팔레트로 명령과 그
  출력을 블록째 복사할 수 있습니다(드래그 선택 불필요).
- **Copy / cut the current command line / 현재 명령줄 복사·잘라내기.**
  While typing, **Ctrl+A** selects the whole command you're editing,
  **Ctrl+C** copies it, and **Ctrl+X** cuts it (clearing the line in the shell).
  On an empty line Ctrl+A still passes through to the shell (readline
  beginning-of-line); use Home to jump to the start regardless.

  명령을 입력하는 중 **Ctrl+A** 로 편집 중인 명령 전체를 선택하고, **Ctrl+C**
  복사, **Ctrl+X** 잘라내기(셸 입력줄도 비움). 빈 줄에서는 Ctrl+A가 셸로
  전달되어 줄 시작 이동으로 동작합니다(줄 시작 이동은 Home 사용).
- **Command palette / 커맨드 팔레트 (Ctrl+Shift+P).**
  A fuzzy launcher for every action — split, zoom, broadcast, search, prompt
  jump, input copy/cut, SSH, theme, font — findable by typing.

  모든 동작(분할·줌·브로드캐스트·검색·프롬프트 점프·입력 복사/잘라내기·SSH·
  테마·글꼴)을 타이핑으로 찾아 실행하는 퍼지 런처.

---

## v0.1.17 — 2026-07-04

### Added / 새 기능
- **Scrollback search / 스크롤백 검색 (Ctrl+Shift+F).**
  A search bar over the terminal finds text in the focused pane's scrollback —
  Enter/Shift+Enter steps through matches, Esc closes and returns focus.

  터미널 위 검색바로 현재 패인의 스크롤백을 검색합니다. Enter/Shift+Enter로
  이동, Esc로 닫고 터미널로 복귀.
- **Ctrl+Click opens links / Ctrl+클릭으로 링크 열기.**
  URLs in terminal output are underlined on hover; Ctrl+Click opens them in
  the in-app browser tab (or the OS browser when the Browser feature is off).
  A plain click still selects text.

  터미널 출력의 URL에 마우스를 올리면 밑줄, Ctrl+클릭 시 내장 브라우저 탭에서
  열립니다(브라우저 기능이 꺼져 있으면 기본 브라우저). 일반 클릭은 그대로 선택.
- **Pane zoom / 패인 최대화 (Ctrl+Shift+Z).**
  Temporarily maximize the focused pane over its tab, tmux-style; press again
  to restore. Any split/close/move restores the layout automatically.

  tmux처럼 현재 패인을 탭 전체로 임시 확대, 다시 누르면 복원. 분할·닫기·이동
  시 자동 복원.
- **Activity badges & taskbar alerts / 활동 배지·작업표시줄 알림.**
  Output or a completion bell in a hidden pane marks its session row and tab
  with a dot until viewed; when the whole window is in the background, the
  taskbar icon flashes (no focus steal) — so a finished Claude/Codex run is
  noticeable from another app.

  보이지 않는 패인에 출력/완료 벨이 오면 세션 목록과 탭에 점 배지가 남고,
  창이 백그라운드면 작업표시줄 아이콘이 깜빡입니다(포커스는 안 뺏음) — 다른
  앱을 쓰다가도 Claude/Codex 작업 종료를 알 수 있습니다.
- **Input broadcast / 입력 브로드캐스트 (Ctrl+Shift+B).**
  tmux synchronize-panes: toggle per tab to type into every pane at once
  (e.g. the same command on several SSH servers). Red pane borders warn while
  it's on.

  tmux synchronize-panes처럼 탭 단위로 켜면 입력이 그 탭의 모든 패인에 동시
  전달됩니다(여러 SSH 서버에 같은 명령 등). 켜진 동안 패인 테두리가 붉게 표시.

### Fixed / 버그 수정
- **Panes whose shell exited are cleaned up / 셸이 종료된 패인이 정리되도록 수정.**
  When a shell exited (`exit`, an SSH drop, a crash) the pane used to linger
  frozen on screen — the cleanup routine was called but had never been defined,
  so the error was silently swallowed. Exited panes now close automatically.

  셸이 종료(`exit`·SSH 끊김·크래시)되면 해당 패인이 얼어붙은 채 남던 문제를
  수정했습니다(정리 함수가 호출되지만 정의돼 있지 않아 조용히 무시되던 버그).
  이제 종료된 패인은 자동으로 닫힙니다.

---

## v0.1.16 — 2026-07-03

### Fixed / 버그 수정
- **No more zombie processes when opening files on macOS/Linux / macOS·Linux에서
  파일 열기 시 좀비 프로세스가 남던 문제 수정.**
  `open`/`xdg-open` were spawned and their handles dropped without being reaped,
  leaving one defunct process per "open" for the app's lifetime. The launcher
  child is now reaped on a detached thread. (Windows unaffected.)

  파일을 열 때 실행한 `open`/`xdg-open` 프로세스를 회수하지 않아 열 때마다
  좀비 프로세스가 하나씩 쌓이던 문제를, 별도 스레드에서 자식을 회수하도록
  수정했습니다. (Windows는 영향 없음.)
- **No scroll flicker when dragging a session into another tab / 세션을 다른 탭으로
  드래그할 때 스크롤이 잠깐 튀던 현상 제거.**
  Moving a pane to another tab re-asserted its bottom-scroll pin only on the
  next animation frame, so the pane briefly painted old scrollback before
  snapping to the bottom. The pin is now applied synchronously, matching the
  split/close/retile paths.

  패인을 다른 탭으로 옮길 때 하단 스크롤 고정을 다음 프레임에서야 적용해
  옛 출력이 한 프레임 보였다 맨 아래로 튀던 현상을, 분할·닫기·재배치 경로와
  동일하게 즉시 적용하도록 수정했습니다.

---

## v0.1.15 — 2026-07-03

### Fixed / 버그 수정
- **Korean text no longer breaks intermittently in the terminal / 터미널에서
  한글이 간헐적으로 깨져 보이던 문제 수정.**
  Terminal output is read from the PTY in fixed-size chunks, and a Korean
  character (3 bytes in UTF-8) that straddled a chunk boundary was decoded as
  the broken-character symbol (`�`). Incomplete byte sequences are now carried
  over to the next read, so characters always arrive whole.

  터미널 출력을 일정 크기 단위로 읽는 과정에서 한글 한 글자(UTF-8 3바이트)가
  경계에 걸리면 깨진 문자(`�`)로 표시되던 문제를 수정했습니다. 이제 잘린
  바이트를 다음 읽기로 이월해 글자가 항상 온전하게 표시됩니다.
- **Panes stay scrolled to the bottom when splitting/closing/moving panes /
  패인 분할·닫기·이동 후에도 스크롤이 맨 아래에 유지.**
  Rearranging a live pane (split, close, drag-retile, move to another tab)
  made the browser reset its scroll position, so a long session would freeze
  on older output with the prompt hidden below. The bottom-follow state is now
  preserved across all pane rearrangements.

  세션이 길게 쌓인 패인을 분할·닫기·드래그 재배치·탭 이동하면 스크롤이 위로
  튀어 프롬프트가 화면 아래에 숨던 문제를 수정했습니다. 재배치 후에도 맨 아래
  따라가기 상태가 유지됩니다.

### Added / 새 기능
- **macOS is now buildable from source / macOS 소스 빌드 지원.**
  Windows-only pieces (ConPTY sideload, NSIS hooks) moved to a platform-scoped
  config; on macOS/Linux terminals now launch the user's `$SHELL` as a login
  shell and the shell picker's Windows ids resolve sensibly. See the README
  for build steps. (No macOS installer is published yet.)

  Windows 전용 구성 요소를 플랫폼별 설정으로 분리해 macOS에서도 소스 빌드가
  가능해졌습니다. macOS/Linux에서는 사용자의 `$SHELL`이 로그인 셸로 실행됩니다.
  빌드 방법은 README 참고. (macOS 설치 파일 배포는 아직 없습니다.)

## v0.1.14 — 2026-07-03

### Changed / 변경
- **PowerShell is the initial default shell / 초기 기본 쉘이 PowerShell로 변경.**
  New installs open PowerShell for new terminals (pwsh if installed, otherwise
  the built-in Windows PowerShell). Git Bash and CMD remain one click away in
  the toolbar dropdown, and an explicit choice you already made is kept.

  새로 설치하면 새 터미널이 PowerShell로 열립니다(pwsh가 있으면 pwsh, 없으면
  Windows 내장 PowerShell). Git Bash/CMD는 툴바 드롭다운에서 바로 선택할 수
  있고, 이미 직접 고른 쉘 설정은 그대로 유지됩니다.
- **Publisher is now "ChoiGyber" / 게시자 표기를 "ChoiGyber"로 변경.**
  The installer and the Windows installed-apps list showed "mycli" as the
  publisher; both now show "ChoiGyber".

  설치기와 Windows 앱 목록의 게시자가 "mycli"로 표시되던 것을 "ChoiGyber"로
  바꿨습니다.

### Added / 새 기능
- **App version shown in the session panel / 세션 패널에 앱 버전 표시.**
  The GitHub button at the bottom right now shows the running version
  (e.g. `v0.1.14`), so you can tell at a glance which build you're on.

  오른쪽 하단 깃허브 버튼 안에 실행 중인 버전이 표시됩니다(예: `v0.1.14`).
  어떤 빌드를 쓰고 있는지 한눈에 확인할 수 있습니다.

### Fixed / 버그 수정
- **Typing no longer lands at the wrong spot in PowerShell panes / PowerShell
  터미널에서 입력 커서가 엉뚱한 곳에 찍히던 문제 수정.**
  In a narrow pane the stock `PS <full path>>` prompt wrapped onto a second
  row; the resize that always follows startup then reflowed that line, and
  PSReadLine kept rendering keystrokes at its stale coordinates — a torn
  prompt with a gap in the middle and a misplaced cursor. PowerShell panes now
  get a prompt that abbreviates the path fish-style whenever it wouldn't fit,
  so the prompt always stays on one row at any pane width.

  좁은 화면에서 PowerShell 기본 프롬프트(`PS <전체 경로>>`)가 두 줄로 감긴 뒤
  창 크기가 바뀌면(시작 직후 항상 발생) 프롬프트가 중간이 벌어진 채 찢어지고
  입력 커서가 엉뚱한 위치에 찍히던 문제를 수정했습니다. 이제 폭이 부족하면
  경로를 fish 스타일로 축약해 프롬프트가 어떤 폭에서도 항상 한 줄을 유지합니다.
- **Installer no longer fails with "Error opening file for writing:
  OpenConsole.exe" / 설치 중 OpenConsole.exe 쓰기 오류 팝업 수정.**
  Every open terminal session keeps the bundled ConPTY host running, which
  locked the file and made installs/updates fail with an Abort/Retry popup.
  The installer now moves the locked binaries aside and writes fresh copies —
  no terminal windows are killed in the process.

  터미널 세션이 열려 있으면 번들된 ConPTY 호스트(OpenConsole.exe)가 파일을
  잠가 설치/업데이트가 Abort/Retry 팝업으로 실패하던 문제를 수정했습니다.
  이제 설치기가 잠긴 파일을 옆으로 치워두고 새 파일을 기록하며, 실행 중인
  터미널은 종료되지 않습니다.

## v0.1.13 — 2026-07-02

### Added / 새 기능
- **Drag-select copies automatically / 드래그 선택 자동 복사.**
  Finishing a mouse selection in a terminal pane copies it to the clipboard
  (PuTTY-style) — no Ctrl+C or right-click needed.

  터미널에서 마우스로 텍스트를 드래그해 선택하면 자동으로 클립보드에 복사됩니다
  (PuTTY 방식). Ctrl+C나 우클릭이 필요 없습니다.

### Fixed / 버그 수정
- **Ctrl+C / Ctrl+V work with the Korean IME / 한글 입력 상태에서 Ctrl+C/V 동작.**
  With the Korean IME active the shortcuts arrived as "ㅊ"/"ㅍ" and never fired;
  they now match the physical key. Paste also goes through xterm's
  bracketed-paste path, so multi-line pastes no longer execute line by line.

  한글 IME가 켜져 있으면 단축키가 "ㅊ"/"ㅍ"로 들어와 무시되던 문제를 물리 키 기준
  매칭으로 수정했습니다. 붙여넣기가 bracketed-paste 경로를 타므로 여러 줄
  붙여넣기가 줄마다 실행되지 않습니다.
- **TUI "copied" actions reach the Windows clipboard (OSC 52) / TUI 복사가 실제
  클립보드에 반영.** Claude Code, tmux, vim 등이 OSC 52로 보내는 복사 요청을
  터미널이 무시해 "복사됨"이라고 떠도 클립보드가 비어 있던 문제를 수정했습니다.
  (클립보드 읽기 질의에는 보안상 응답하지 않습니다.)
- **One click to focus a split pane / 분할 패인 한 번 클릭 포커스.**
  Clicking another pane could bounce focus back to the old one, needing a
  second click. Focus state now tracks the mousedown and xterm's own focus.

  다른 패인을 클릭해도 포커스가 이전 패인으로 튕겨 두 번 클릭해야 하던 문제를
  수정했습니다.
- **Resize no longer corrupts the bash prompt / 창 크기 변경 시 프롬프트 깨짐 수정.**
  Widening a window whose prompt had wrapped left stale prompt rows and parked
  the cursor left of the `$` until Enter. The prompt now always stays on one
  row — when the pane is too narrow, leading directories abbreviate fish-style
  (`/d/P/ChurchLivePro-Bulletin`).

  프롬프트가 줄바꿈된 상태에서 창을 넓히면 잔해 줄이 남고 커서가 `$` 왼쪽에
  박히던 문제를 수정했습니다. 프롬프트는 항상 한 줄을 유지하며, 패인이 좁으면
  앞 디렉토리를 fish 스타일로 한 글자씩 축약합니다(`/d/P/ChurchLivePro-Bulletin`).

## v0.1.12 — 2026-07-02

### Added / 새 기능
- **Terminal text controls: font zoom & letter spacing / 터미널 글자 크기·자간 조절.**
  A toolbar adds A−/A+ (= Ctrl −/+) to zoom the terminal font and 자−/자+ to
  tune letter spacing (persisted as a ratio of the font size, since CJK glyphs
  look cramped at zero).

  툴바에 A−/A+(= Ctrl −/+)로 터미널 글자 크기를, 자−/자+로 자간을 조절합니다.
  자간은 글자 크기 대비 비율로 저장되며(한글/CJK가 0에서 답답해 보이는 문제 완화),
  크기를 바꿔도 비율이 유지됩니다.
- **Paste a clipboard image with Ctrl+V / Ctrl+V로 클립보드 이미지 붙여넣기.**
  A screenshot on the clipboard is saved to a temp PNG and its path is typed
  in, so the running tool (Claude Code / Codex) can attach it. Falls back to
  text paste when there's no image.

  클립보드에 이미지(스크린샷)가 있으면 임시 PNG로 저장하고 그 경로를 입력해 줘서
  실행 중인 도구(Claude Code / Codex)가 첨부할 수 있습니다. 이미지가 없으면 텍스트
  붙여넣기로 동작합니다.

### Fixed / 버그 수정
- **Long lines no longer truncated in narrow / split panes / 좁은·분할 패널에서 긴 줄 잘림 수정.**
  The PTY was forced to at least 80 columns, so in a narrow split the program
  laid out to 80 and its long lines and header rules overflowed the visible
  grid until a manual session switch. The PTY now spawns at the pane's real
  width and a per-pane observer reconciles the grid as the layout settles.

  PTY를 최소 80칸으로 강제해서, 좁은 분할 패널에서는 프로그램이 80칸 기준으로
  그려 긴 줄·헤더가 화면 밖으로 잘리던 문제(세션을 수동 전환해야 고쳐짐)를
  수정했습니다. 이제 PTY가 패널 실제 폭으로 시작하고, 패널별 옵저버가 레이아웃이
  안정될 때 그리드를 맞춥니다.
- **Snappy typing after Alt-Tab; faster paste / Alt-Tab 후 입력 버벅임·붙여넣기 지연 수정.**
  Returning via Alt-Tab could make typed characters repeat in place or drop
  (the focus-restore fired far too many times), and pasting crawled (the output
  poll piled up under bursts). Focus restore is now coalesced and yields to
  live typing, and the terminal output loop is single-flight, parallel, and
  batched.

  Alt-Tab으로 복귀한 뒤 글자가 제자리에서 반복되거나 씹히고(포커스 복원이 과도하게
  반복됨), 붙여넣기가 느리던(출력 폴링이 몰릴 때 중첩됨) 문제를 수정했습니다. 포커스
  복원을 합치고 타이핑 중에는 양보하도록 했으며, 터미널 출력 루프를 중복 없이 병렬·
  일괄 처리하도록 바꿨습니다.

---

## v0.1.11 — 2026-06-29

### Fixed / 버그 수정
- **Terminal cursor stays active after Alt-Tab / Alt-Tab 후 터미널 커서 유지.**
  Returning to Mymux with Alt-Tab left the terminal cursor hollow until you
  clicked. The active session's cursor now revives automatically on return.
- **Alt-Tab으로 복귀하면 커서가 풀려 클릭해야 입력되던 문제 수정.** 작업하던 세션의
  커서가 복귀 즉시 다시 활성화됩니다.

---

## v0.1.10 — 2026-06-29

### Added / 새 기능
- **Drag to reorder & move sessions; resizable session panel / 세션 리스트 드래그 + 패널 너비 조절.**
  Drag a session in the list to reorder it within its tab, or drop it onto
  another tab (or its header) to move the pane there. Drag the session panel's
  left edge to resize it; the width is remembered.

  세션 목록에서 세션을 끌어 같은 탭 안에서 순서를 바꾸거나, 다른 탭(또는 탭
  헤더)에 놓아 그 탭으로 옮길 수 있습니다. 세션 패널 왼쪽 가장자리를 끌어 너비를
  조절할 수 있고, 너비는 저장됩니다.

### Fixed / 버그 수정
- **No ghost console flash when closing a pane / 세션 종료 시 검은 콘솔 깜빡임 제거.**
  Closing a terminal pane briefly flashed a black console window (Windows 11's
  default-terminal handoff). Mymux now bundles a headless ConPTY host
  (`conpty.dll` + `OpenConsole.exe`) next to the executable to bypass it.

  터미널 세션을 닫을 때 검은 콘솔 창이 잠깐 깜빡이던 문제(Windows 11 기본 터미널
  handoff)를 헤드리스 ConPTY 호스트를 실행 파일 옆에 번들해 해결했습니다.

- **Plain-drag selection + Ctrl+C/V in the terminal / 터미널 드래그 선택 + Ctrl+C·V.**
  A plain mouse drag now selects terminal text (no modifier needed). Ctrl+C
  copies the selection (and still sends SIGINT when nothing is selected);
  Ctrl+V pastes.

  이제 마우스로 그냥 끌면 터미널 텍스트가 선택됩니다(키 조합 불필요). Ctrl+C로
  선택 영역을 복사하고(선택이 없으면 기존대로 SIGINT 전송), Ctrl+V로 붙여넣습니다.

---

## v0.1.9 — 2026-06-28

### Fixed / 버그 수정
- **First-session prompt cursor misalignment / 시작 직후 첫 세션의 프롬프트 커서 정렬 오류.**
  앱을 켜고 **처음 생성되는 터미널**에서 깜빡이는 커서가 `$` 프롬프트 끝이 아니라
  그 왼쪽에 그려지던 문제. (앱 실행 중 새로 연 세션은 정상이었습니다.)

  The very first terminal opened at startup drew its blinking cursor a few
  columns **left of the `$`** instead of after it. Sessions opened later were
  fine.

  - **원인 / Root cause:** 첫 세션은 `document.fonts.ready` 보정 패스가 끝난
    *뒤*에 만들어져 폰트 재측정을 받지 못했고, 그 세션에 유일하게 적용되던
    `refitAllPanes()`(=`fit()`)는 열·행만 다시 잡을 뿐 xterm이 캐싱한 **문자 셀
    크기(char-cell metric)를 재측정하지 않습니다.** 그래서 임베드 폰트(D2Coding)와
    레이아웃이 안정되기 전에 측정된 stale 셀 메트릭으로 첫 프롬프트를 그려 커서가
    몇 칸 어긋났습니다.

    The first session is created *after* the `document.fonts.ready` pass runs, so
    it never got a font re-measure. Its only correction — `refitAllPanes()` —
    calls `fit()`, which re-grids cols/rows but does **not** re-measure xterm's
    cached character cell. The pane kept a stale metric (taken before the
    embedded font and layout settled) and rendered the cursor off by a few cells.

  - **수정 / Fix:** `remeasureFontCells()`를 추가했습니다. 각 터미널의 `fontSize`를
    토글(Ctrl +/- 와 동일 경로)해 xterm이 문자 셀을 **강제로 재측정**하게 하고,
    texture atlas를 갱신한 뒤 refit 합니다. 이 보정은 `document.fonts.ready`
    시점과 **세션 복원 직후**(레이아웃 안정 시) 모두 실행되어, 시작 시 첫 세션도
    올바른 셀 크기로 그려집니다.

    Added `remeasureFontCells()`, which toggles each terminal's `fontSize` (the
    same path Ctrl +/- uses) to force xterm to re-measure the cell, then clears
    the texture atlas and refits. It now runs on `document.fonts.ready` **and**
    again after session restore settles, so the startup session is corrected.

- **Pane status-bar name shown twice / 패인 상태바 이름 중복.** 폴더명으로 연 세션은
  라벨과 작업폴더 칩이 같은 이름이라 두 번 표시됐습니다(`Mymux   Mymux`). 칩이 라벨과
  같으면 비워서 숨기되(`.pane-cwd:empty`), `cd`로 다른 폴더에 가면 다시 나타나 위치
  추적은 유지합니다.

  The pane status bar repeated the folder name (label + cwd chip) for
  folder-named sessions; the chip is now blanked/hidden when it equals the label,
  and reappears after you `cd` somewhere with a different name.

- **Terminal focus stolen by background apps / 백그라운드 앱에 터미널 포커스 뺏김.** 일부
  보안 프로그램(예: WIZVERA Veraport)이 수 초마다 핸들러 창을 띄워 OS 포커스를 가로채면
  터미널 커서가 비활성(hollow)이 됐습니다. 창이 포커스를 되찾는 즉시 활성 패인을 복원하고,
  xterm이 포커스를 다시 인식하도록 textarea를 bounce 합니다. (다른 입력/패인으로 의도
  이동한 경우는 존중. 근본 원인이 외부 앱이면 그 앱을 끄는 것이 정석.)

  When a background app (e.g. WIZVERA Veraport's handler, popping every ~7s)
  briefly steals OS focus, the terminal cursor went hollow. Focus is now restored
  on window refocus, bouncing the textarea so xterm re-registers it; deliberate
  moves to another input/pane are respected.

### Notes / 참고
- v0.1.8에서 시도한 불필요한 `ESC[1;1R` 커서 위치 보고 제거는 **실제 원인이 아니었습니다**
  (헛다리). 0.1.7·0.1.8에서 동일한 증상이 났던 이유가 바로 위의 stale 셀 메트릭이며,
  이번 릴리즈에서 근본 원인을 수정했습니다.

  The v0.1.8 change (removing an unsolicited `ESC[1;1R` cursor report) addressed a
  red herring — the misalignment persisted on both 0.1.7 and 0.1.8 because the
  real cause was the stale cell metric above, now fixed.

---

## Earlier releases / 이전 릴리즈
See the commit history and [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)
for v0.1.8 and earlier.
v0.1.8 이하의 변경 내역은 커밋 기록과 GitHub Releases를 참고하세요.
