# Changelog

All notable changes to **Mymux** are documented here.
Mymux의 주요 변경 사항을 기록합니다.

For installers, see the [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases).
설치 파일은 [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)에서 받으세요.

---

## v0.1.14 — 2026-07-03

### Added / 새 기능
- **App version shown in the session panel / 세션 패널에 앱 버전 표시.**
  The GitHub button at the bottom right now shows the running version
  (e.g. `v0.1.14`), so you can tell at a glance which build you're on.

  오른쪽 하단 깃허브 버튼 안에 실행 중인 버전이 표시됩니다(예: `v0.1.14`).
  어떤 빌드를 쓰고 있는지 한눈에 확인할 수 있습니다.

### Fixed / 버그 수정
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
