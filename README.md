# Mymux

> A Windows desktop terminal multiplexer — multiple shells, SSH/SFTP, a file
> explorer, a file viewer, and an in‑app browser in one window.
>
> 하나의 창에서 여러 셸·SSH/SFTP·파일 탐색기·파일 뷰어·내장 브라우저를 함께 쓰는
> Windows 데스크톱 터미널 멀티플렉서입니다.

Built with **Tauri 2 + Rust** (WebView2 frontend). Made by **ChoiGyber**.

- Repository / 저장소: <https://github.com/ChoiGyber/Mymux>
- Contact / 연락처: **racji92@gmail.com**

---

## Features / 주요 기능

### Terminals / 터미널
- Tabbed sessions with **split panes** (horizontal/vertical), drag‑to‑retile, and
  per‑pane working‑directory labels.
- Shells: **Git Bash** (default), **PowerShell**, **CMD** — pick the default per
  new terminal.
- 탭 + **분할 패인**(가로/세로), 드래그로 재배치, 패인별 작업 디렉터리 표시.
  기본 셸은 Git Bash / PowerShell / CMD 중 선택.

### SSH / SFTP
- Connect over SSH (password or key) and browse the remote filesystem through the
  built‑in SFTP explorer.
- SSH(비밀번호·키) 접속과 원격 파일 탐색(SFTP)을 지원합니다.

### File Explorer / 파일 탐색기
- Drives, favorites, a path box, and a folder list in the sidebar.
- **Back / Forward history + parent‑folder** buttons, and the mouse’s
  back/forward side buttons work just like in Chrome.
- The **`cd`** action opens a terminal already in that folder.
- 사이드바에 드라이브·즐겨찾기·경로 입력·폴더 목록. **뒤로/앞으로 히스토리 +
  상위 폴더** 버튼과 **마우스 옆 버튼**(크롬식 앞/뒤) 지원. **`cd`**를 누르면 그
  폴더에서 터미널이 열립니다.

### File Viewer / 파일 뷰어
- Click a file to open it in a tab. Renders **Markdown**, plain **text/code**, and
  previews **HTML** in a sandboxed in‑app frame.
- **Multiple files open as tabs**; close each tab or the whole viewer.
- **Right‑click a selection** to **copy** it or **send it to the active terminal**.
- In‑app links route smartly: web links open in the embedded browser, local
  file/folder links open in the Explorer/viewer.
- 파일을 클릭하면 탭으로 열립니다. **마크다운/텍스트/코드** 렌더링, **HTML**은
  샌드박스 프레임으로 미리보기. **여러 파일을 탭으로** 열고 개별/전체 닫기 가능.
  **선택 영역 우클릭 → 복사 / 열린 세션으로 보내기**. 문서 내 링크는 웹은 내장
  브라우저, 로컬 경로는 탐색기/뷰어로 열립니다.

### In‑app Browser / 내장 브라우저
- **Native** mode embeds a real browser (address bar, back/forward/reload).
- **AI control** mode exposes a CDP endpoint so Playwright/MCP can drive it.
- **Native** 모드는 주소창·앞/뒤·새로고침이 있는 내장 브라우저, **AI 제어** 모드는
  CDP 엔드포인트로 Playwright/MCP가 조종할 수 있게 합니다.

### Quality of life / 편의 기능
- Saved commands, session save & restore on exit, light/dark themes with accent
  colors, and an auto‑updater (GitHub Releases).
- A **Github – Mymux** shortcut in the session panel opens the repo in your OS
  default browser.
- 저장 명령, 종료 시 세션 저장·복원, 라이트/다크 테마 + 강조색, 자동 업데이트
  (GitHub Releases). 세션 패널 하단의 **Github – Mymux** 버튼은 기본 브라우저로
  저장소를 엽니다.

---

## Build / 빌드

### Prerequisites / 사전 준비
- **Rust** (stable, MSVC toolchain) and **Cargo**.
- **WebView2 Runtime** (preinstalled on Windows 11).
- **NASM** assembler on `PATH` — required to compile `aws-lc-sys` (the SSH crypto
  backend) on a clean build. Install it and add it to `PATH`:
  ```powershell
  winget install NASM.NASM   # or: choco install nasm
  $env:PATH = "C:\Program Files\NASM;$env:PATH"
  ```
- **Rust**(MSVC) + **Cargo**, **WebView2 런타임**, 그리고 클린 빌드 시 `aws-lc-sys`
  컴파일에 필요한 **NASM**을 `PATH`에 추가하세요. (증분 빌드는 캐시 덕에 NASM 없이도
  통과하지만, `cargo clean` 후 첫 빌드에서 필요합니다.)

### Build the desktop app / 데스크톱 앱 빌드
```powershell
cargo build -p mycli-desktop --release
```
The binary is produced at `target\release\Mymux.exe`.
산출물은 `target\release\Mymux.exe` 입니다.

> The frontend lives in `crates/mycli-desktop/frontend` (static HTML/CSS/JS) and is
> embedded into the binary at build time — no separate frontend bundler step.
>
> 프론트엔드는 `crates/mycli-desktop/frontend`(정적 HTML/CSS/JS)에 있고 빌드 시
> 바이너리에 임베드됩니다(별도 번들러 단계 없음).

### Frontend changes not showing? / 프론트엔드 변경이 안 보일 때
WebView2 caches the embedded assets. After rebuilding, clear the HTTP cache so the
new frontend loads (user settings in *Local Storage* are preserved):
```powershell
Remove-Item "$env:LOCALAPPDATA\com.mycli.desktop\EBWebView\Default\Cache","$env:LOCALAPPDATA\com.mycli.desktop\EBWebView\Default\Code Cache" -Recurse -Force
```
재빌드 후에도 옛 화면이 보이면 위처럼 EBWebView의 `Cache`/`Code Cache`만 비우세요
(설정이 든 *Local Storage*는 유지됩니다).

---

## Release / 릴리즈
Local build → sign → upload to GitHub Releases. See [`RELEASING.md`](RELEASING.md).
로컬에서 빌드·서명 후 GitHub Releases에 업로드합니다. 자세한 절차는
[`RELEASING.md`](RELEASING.md) 참고.

---

## Project layout / 프로젝트 구조
```
crates/
  mycli-core/            # shared core
  mycli-desktop/         # the Tauri desktop app (Mymux.exe)
    src/                 # Rust commands: terminal/pty, explorer, ssh/sftp, browser, session
    frontend/            # app.js / style.css / index.html (WebView2 UI)
    tauri.conf.json      # product config + auto‑updater
```
