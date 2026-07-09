# Changelog

All notable changes to **Mymux** are documented here.
Mymux의 주요 변경 사항을 기록합니다.

For installers, see the [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases).
설치 파일은 [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)에서 받으세요.

---

## v0.1.28 — 2026-07-09

### Fixed / 버그 수정
- **No more doubled Hangul input after returning to the window / 창 복귀 후 한글 중복 입력 수정.**
  Alt-Tabbing back and typing Korean could commit each syllable twice and pop a
  detached IME candidate window, because the focus restore blurred/refocused the
  input mid-composition. Mymux now leaves an actively-composing textarea alone and
  stops the post-return refocus retries as soon as IME composition begins.

  창에 돌아와 한글을 입력하면 음절이 두 번씩 입력되고 작은 IME 후보창이 분리돼
  뜨던 문제를 고쳤습니다. 포커스 복원이 조합 도중 입력창을 blur/refocus 하던 것이
  원인으로, 이제 조합 중인 입력창은 건드리지 않고 IME 조합이 시작되면 복귀
  재포커스 재시도를 중단합니다.

---

## v0.1.27 — 2026-07-09

### Added / 새 기능
- **Re-run last command over SSH without tmux / tmux 없는 SSH에서도 명령 재실행.**
  Command re-run on session restore previously needed Mymux shell-integration
  (OSC 133), which a plain remote server doesn't have. Mymux now also tracks the
  typed command line locally, so an SSH pane's last command (e.g. `htop`,
  `tail -f log`) can be re-run on reconnect even without tmux on the remote.
  Full-screen apps (vim/htop/tmux) are ignored via alt-screen detection, and the
  command fires once the remote prompt settles. Best-effort: line editing and
  history navigation aren't tracked — tmux still restores state most fully.

  세션 복원 시 명령 재실행이 기존엔 Mymux 셸 통합(OSC 133)에 의존해, 그것이 없는
  일반 원격 서버에선 동작하지 않았습니다. 이제 입력한 명령줄을 로컬에서도 추적해,
  원격에 tmux가 없어도 SSH 패인의 마지막 명령(`htop`, `tail -f log` 등)을 재접속
  시 재실행합니다. 전체화면 앱(vim/htop/tmux)은 alt-screen 감지로 무시하고, 원격
  프롬프트가 준비되면 실행합니다. best-effort(줄 편집·히스토리 추적은 제외) —
  가장 완전한 상태 복원은 여전히 tmux입니다.

### Fixed / 버그 수정
- **SSH tmux setting now restored for key-auth too / key 인증 SSH의 tmux 설정 복원.**
  Key/agent-auth SSH sessions now reattach their tmux session on restore, matching
  password-auth behavior.

  키·에이전트 인증 SSH 세션도 복원 시 tmux 세션에 다시 붙습니다(비밀번호 인증과 동일).

---

## v0.1.26 — 2026-07-09

### Fixed / 버그 수정
- **Completion buddy no longer repeats on stopped sessions / 멈춘 세션 알림 반복 완전 제거.**
  A stopped/idle program that keeps ringing the bell or re-emitting an OSC
  desktop-notification (some TUIs, pollers, shells) could re-flash the pane/fox
  over and over. All notify paths (bell, OSC 9/777, OSC 133;D, output-silence)
  now share one "notify once until you type again" guard.

  멈춘 프로그램이 계속 bell을 울리거나 OSC 알림을 반복 발생시키면 패인/여우가
  계속 번쩍이던 문제를 완전히 고쳤습니다. 모든 알림 경로(bell·OSC 9/777·OSC
  133;D·출력 침묵)가 "다시 입력 전까지 1회만" 규칙을 공유합니다.

- **No more scroll bounce while reading scrollback / 스크롤백 보는 중 화면 튕김 제거.**
  When you had scrolled up to read history, an automatic focus restore (Alt-Tab
  return, or a background app stealing focus) snapped the view to the bottom,
  then you scrolled up again, over and over — an intermittent up/down bounce. The
  scroll position is now preserved across focus restores.

  스크롤을 올려 기록을 보는 동안 자동 포커스 복원(Alt-Tab 복귀나 다른 앱의 포커스
  가로채기)이 화면을 맨 아래로 끌어내려, 다시 올리면 또 내려가던 간헐적 위아래
  튕김을 고쳤습니다. 포커스 복원 시 스크롤 위치를 유지합니다.

---

## v0.1.25 — 2026-07-09

### Added / 새 기능
- **Buddy character picker with a mascot fox / 마스코트 여우 + 캐릭터 선택기.**
  The completion buddy can now be the original fox or a rounder mascot fox that
  cheers when a task finishes. Pick it from preview cards in the bell (🔔) modal —
  Off / Fox / Mascot — so the two characters are easy to tell apart.

  작업 완료 캐릭터로 기존 여우 외에 둥근 **마스코트 여우**(완료 시 환호 모션)를
  고를 수 있습니다. 종(🔔) 모달의 **미리보기 카드**(끄기 / 여우 / 마스코트)로
  선택해 두 캐릭터를 한눈에 구별합니다.

- **Re-run last commands after restore / 세션 복원 시 명령 재실행.**
  Mymux remembers the last command each pane ran and, after restoring a session,
  offers to re-run them (e.g. relaunch `claude`/`codex`) from a single checklist.
  Toggle with "don't ask again".

  각 패인에서 마지막으로 실행한 명령을 기억했다가, 세션 복원 후 **일괄 확인
  목록**으로 다시 실행할지 물어봅니다(예: `claude`/`codex` 재실행). "앞으로 묻지
  않기"로 끌 수 있습니다.

### Fixed / 버그 수정
- **Completion buddy no longer repeats on idle sessions / 멈춘 세션 알림 반복 제거.**
  A finished-but-idle pane whose prompt re-emitted shell-integration marks could
  re-trigger the fox/flash repeatedly. It now notifies once until you type again.

  프롬프트가 셸 통합 마크를 다시 내보내던 멈춘 패인에서 여우/번쩍임이 반복
  발생하던 문제를 고쳐, 다시 입력하기 전까지 **한 번만** 알립니다.

- **Snappier typing when returning to a session / 세션 복귀 시 입력 지연 완화.**
  Coming back from another window no longer leaves typed characters buffered for a
  beat; visible panes are force-repainted on return so echo shows immediately.

  다른 창에서 돌아올 때 입력한 글자가 잠시 멈췄다 몰려 표시되던 현상을 줄였습니다.
  복귀 시 보이는 패인을 강제로 다시 그려 에코가 즉시 나타납니다.

- **More visible scrollback scrollbar / 스크롤바 가시성 개선.**
  The terminal's scrollback scrollbar is wider and higher-contrast so it's easy to
  see when content scrolls above the command line.

  터미널 스크롤백 스크롤바를 더 굵고 대비 높게 바꿔, 명령줄 위로 내용이 스크롤될
  때 잘 보이도록 했습니다.

---

## v0.1.24 — 2026-07-07

### Added / 새 기능
- **Fox buddy on task completion / 작업 완료 여우 캐릭터.**
  An optional cute fox pops up at the bottom-right inside the pane whose
  task just finished, swaying its head and blinking for 10 seconds. If it's
  already out it glides over to the newly finished pane. Drag it anywhere,
  click to dismiss. Toggle in the bell (🔔) settings modal.

  작업이 끝난 패인 우측 하단에 귀여운 여우가 나타나 머리를 흔들며 눈을
  껌뻑입니다(10초). 이미 떠 있으면 새로 끝난 패인으로 미끄러져 이동합니다.
  드래그로 옮기고 클릭하면 사라지며, 종(🔔) 설정에서 켜고 끕니다.

- **Directory-bound command combos + aliases / 디렉토리·약어 명령 콤보.**
  Saved commands can carry a directory and a short alias. Type the alias at a
  prompt and press Enter to run "cd &lt;dir&gt; then command" as one line
  (PowerShell-safe). Autocomplete previews the full line it will run.

  저장 명령에 디렉토리와 약어를 지정할 수 있습니다. 프롬프트에서 약어를 치고
  Enter를 누르면 "cd &lt;디렉토리&gt; → 명령"이 한 줄로 실행되고,
  자동완성이 실행될 전체 라인을 미리 보여줍니다.

- **SSH favorites / SSH 즐겨찾기.**
  Star a live SSH session (or the SSH modal) to save it; one click in the
  session panel reconnects — key auth goes straight in, password auth asks
  only for the password. tmux settings are remembered too.

  실행 중인 SSH 세션(또는 SSH 모달)에 별표를 눌러 저장하면, 세션 패널에서
  한 번 클릭으로 재접속합니다 — 키 인증은 바로 접속, 비밀번호 인증은
  비밀번호만 물어봅니다. tmux 설정도 함께 기억합니다.

- **Right-click a folder's cd button / 폴더 cd 버튼 우클릭.**
  Opens a session at that folder AND runs a chosen saved command there.

  해당 폴더에서 세션을 열고 선택한 저장 명령을 바로 실행합니다.

- **Ubuntu/Linux installers / 우분투·리눅스 설치본.**
  Releases now include a `.deb` and an AppImage for Linux, alongside the
  Windows and macOS builds.

  이제 릴리즈에 Windows·macOS와 함께 리눅스용 `.deb`와 AppImage가 포함됩니다.

## v0.1.23 — 2026-07-06

### Added / 새 기능
- **Remote explorer shortcuts / SSH 탐색기 바로가기.**
  In SFTP mode the drive-button row now shows remote shortcuts instead of
  being empty: root (/) and home (~), plus one button per mounted volume when
  the server has /Volumes (macOS — USB sticks and external drives mount
  there). Symlinks that point at directories (e.g. /Volumes/"Macintosh HD")
  now open as folders too.

  SSH(SFTP) 모드에서 비어 있던 드라이브 버튼 줄에 원격 바로가기가 표시됩니다:
  루트(/)·홈(~), 그리고 서버에 /Volumes가 있으면(macOS) 마운트된 볼륨마다
  버튼 하나씩 — USB·외장장치를 원클릭으로 진입합니다. 디렉토리를 가리키는
  심볼릭 링크("Macintosh HD" 등)도 폴더로 열립니다.

- **Task-done flash settings / 작업 완료 알림 설정.**
  A new bell button in the toolbar opens a settings modal to choose where the
  completion pulse shows: the pane border, the session-list row, either, both,
  or neither. The choice persists across restarts.

  툴바의 종(🔔) 버튼으로 알림 설정 모달을 열어 작업 완료 번쩍임을 어디에
  표시할지 선택합니다: 창 틀(패인 테두리)·세션 목록 이름 중 하나, 둘 다,
  또는 모두 해제. 설정은 재시작 후에도 유지됩니다.

## v0.1.22 — 2026-07-06

### Added / 새 기능
- **Click the explorer path to copy it / 탐색기 경로 클릭 복사.**
  Clicking the current-directory label in the explorer header copies the full
  path to the clipboard, with a confirmation toast. Hovering shows a pointer
  cursor and underline so it reads as clickable.

  탐색기 상단의 현재 디렉토리 경로를 클릭하면 전체 경로가 클립보드에
  복사되고 확인 토스트가 뜹니다. 마우스를 올리면 포인터 커서와 밑줄로
  클릭 가능함을 표시합니다.

### Changed / 변경
- **Toasts auto-hide after 2 seconds / 토스트 2초로 단축.**
  Notification toasts (Copied, Updated, …) now disappear after 2 seconds
  instead of 2.5.

  안내 토스트(복사됨, 갱신됨 등)가 2.5초 대신 2초 후에 사라집니다.

## v0.1.21 — 2026-07-06

### Added / 새 기능
- **Update confirmation with open sessions / 업데이트 확인 모달.**
  Clicking the Update button while sessions are open now shows a confirmation
  modal warning that updating closes every session and restarts the app.
  Confirm to update; Cancel (or Esc / clicking outside) keeps Mymux running
  as-is. With no sessions open the update starts immediately, as before.

  세션이 열려 있는 상태에서 업데이트 버튼을 누르면, 모든 세션(창)이 닫히고
  앱이 재시작된다는 확인 모달을 먼저 보여줍니다. 확인하면 업데이트가
  진행되고, 취소(또는 Esc·바깥 클릭)하면 Mymux가 그대로 유지됩니다. 열린
  세션이 없으면 기존처럼 바로 업데이트합니다.

### Fixed / 버그 수정
- **Task-done flash for sporadic-output tasks / 띄엄띄엄 출력 작업도 완료 알림.**
  Tasks that print in bursts with quiet gaps in between (plugin updates,
  downloads) never triggered the task-done pane flash, because each burst had
  to stream continuously for 5 seconds on its own. The work window now
  accumulates across quiet gaps since the last keystroke, and flashes at most
  once per keystroke cycle so periodic-output programs (watch, pollers) don't
  re-flash every few seconds.

  중간중간 조용해지며 띄엄띄엄 출력하는 작업(플러그인 업데이트, 다운로드)은
  각 출력 구간이 단독으로 5초를 채워야 해서 완료 반짝임이 전혀 뜨지
  않았습니다. 이제 작업 시간이 마지막 키 입력 이후로 조용한 틈을 넘어
  누적되며, 키 입력 사이에 최대 1회만 반짝여 주기적 출력 프로그램(watch 등)이
  몇 초마다 반복해서 반짝이는 일도 없습니다.

## v0.1.20 — 2026-07-06

### Added / 새 기능
- **Hover dismisses the task-done flash / 알림 깜빡임 hover 해제.**
  Moving the mouse over a flashing pane (or its session-list row) acknowledges
  the notification and stops the pulse on both immediately, instead of waiting
  out the 10-second animation.

  깜빡이는 패인(또는 세션 목록 행)에 마우스를 올리면 알림을 확인한 것으로
  간주해 두 곳의 펄스를 즉시 멈춥니다. 10초 애니메이션이 끝나길 기다릴
  필요가 없습니다.

### Fixed / 버그 수정
- **Mouse wheel works over Claude Code (and similar CLIs) / 휠 스크롤 정상화.**
  Programs that turn on mouse tracking without switching to the full-screen
  buffer (e.g. Claude Code) used to swallow the mouse wheel — the view only
  moved by dragging the scrollbar, and wheel-triggered redraws could leave
  blank, half-painted regions. The wheel now always scrolls the scrollback on
  the normal screen; full-screen apps (vim, htop, less) still receive wheel
  events as before.

  전체 화면 버퍼 없이 마우스 트래킹만 켜는 프로그램(예: Claude Code)이 휠
  이벤트를 삼켜서 스크롤바를 드래그해야만 화면이 움직이고, 휠에 반응한
  리드로우가 화면 중간을 비워 놓는 문제를 수정했습니다. 이제 일반 화면에서는
  휠이 항상 스크롤백을 움직이며, 전체 화면 앱(vim·htop·less)은 기존대로 휠
  이벤트를 받습니다.

## v0.1.19 — 2026-07-06

### Added / 새 기능
- **Per-session task-done notification / 세션별 작업 완료 알림.**
  When a command that ran 5+ seconds finishes (OSC 133 shell integration), or a
  program streams output for 5+ seconds and then goes quiet, the pane border and
  its session-list row pulse for 10 seconds. The base color is scarlet, shifted
  per session so several finishing panes are tellable apart at a glance. Short
  commands and plain typing never trigger it.

  5초 이상 걸린 명령이 끝나거나(OSC 133 셸 통합), 프로그램이 5초 이상 출력을
  이어가다 멈추면 패인 외곽선과 세션 목록 행이 10초간 펄스합니다. 기본색은
  다홍색이며 세션마다 색조가 조금씩 달라 여러 패인이 동시에 끝나도 한눈에
  구분됩니다. 짧은 명령이나 단순 타이핑에는 반응하지 않습니다.

## v0.1.18 — 2026-07-04

### Added / 새 기능
- **Shell prompt jump & command blocks (OSC 133) / 프롬프트 점프·명령 블록.**
  The shells Mymux launches (Git Bash, PowerShell) now mark each prompt.
  **Ctrl+Shift+↑ / ↓** jumps between prompts, and the command palette can copy a
  whole command + its output as one block — no manual drag-selecting.

  Mymux가 실행하는 셸(Git Bash·PowerShell)이 각 프롬프트를 표시합니다.
  **Ctrl+Shift+↑ / ↓** 로 프롬프트 사이를 이동하고, 커맨드 팔레트로 명령과 그
  출력을 블록째 복사할 수 있습니다(드래그 선택 불필요).
- **Copy / cut the current command line / 현재 명령줄 복사·잘라내기.**
  At a shell prompt, **Ctrl+A** selects the whole command you're editing,
  **Ctrl+C** copies it, and **Ctrl+X** cuts it (clearing the line in the shell).
  Use **Home** to jump to the line start. In a full-screen app (vim, etc.)
  Ctrl+A passes through to the app.

  셸 프롬프트에서 **Ctrl+A** 로 편집 중인 명령 전체를 선택하고, **Ctrl+C** 복사,
  **Ctrl+X** 잘라내기(셸 입력줄도 비움). 줄 맨 앞으로는 **Home**. 전체화면 앱
  (vim 등)에서는 Ctrl+A가 그 앱으로 전달됩니다.
- **Command palette / 커맨드 팔레트 (Ctrl+Shift+P).**
  A fuzzy launcher for every action — split, zoom, broadcast, search, prompt
  jump, input copy/cut, SSH, theme, font — findable by typing.

  모든 동작(분할·줌·브로드캐스트·검색·프롬프트 점프·입력 복사/잘라내기·SSH·
  테마·글꼴)을 타이핑으로 찾아 실행하는 퍼지 런처.
- **Keyboard shortcuts help / 단축키 안내.**
  A **⌨ Keys** button in the toolbar opens a modal listing every shortcut,
  grouped and bilingual.

  툴바의 **⌨ Keys** 버튼으로 모든 단축키를 그룹별·한영 병기로 보는 창을 엽니다.

### Fixed / 버그 수정
- **Text selection is now clearly visible / 텍스트 선택이 또렷하게 보이도록 수정.**
  The selection colour was almost identical to the terminal background, so a
  selection (drag, or Ctrl+A) was barely visible. It's now an accent-tinted
  highlight.

  선택 색이 터미널 배경과 거의 같아 드래그·Ctrl+A 선택이 잘 안 보이던 문제를,
  강조색 하이라이트로 수정했습니다.

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
