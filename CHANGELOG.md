# Changelog

All notable changes to **Mymux** are documented here.
Mymux의 주요 변경 사항을 기록합니다.

For installers, see the [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases).
설치 파일은 [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)에서 받으세요.

---

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
