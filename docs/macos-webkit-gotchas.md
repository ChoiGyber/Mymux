# macOS(WKWebView) 주의점 — Windows에서 개발할 때 꼭 볼 것

> Mymux는 **Windows에서 개발**하지만 **macOS에서도 동작**해야 한다.
> 그런데 두 OS의 웹뷰 엔진이 다르다:
>
> | OS | 웹뷰 엔진 | 렌더링/입력 계열 |
> |----|-----------|------------------|
> | Windows | **WebView2** | Chromium(Edge) |
> | macOS | **WKWebView** | WebKit(Safari) |
>
> **Windows에서 잘 되던 게 macOS에서 깨지는 일이 반복**된다. 원인은 거의 항상
> "WebKit의 입력/포커스/자격증명 처리가 Chromium과 다르다"는 것. 이 문서는 지금까지
> 실제로 터진 함정과 그 해결책을 모아, 같은 지뢰를 다시 밟지 않게 한다.

---

## 0. 절대 원칙

1. **타입체크·유닛테스트로는 이 부류 버그를 절대 못 잡는다.** WKWebView에서 사람이
   실제로 눌러봐야만 드러난다. → **릴리즈 전 macOS 실빌드 스모크 테스트가 유일한 관문**
   (아래 §5 체크리스트).
2. **입력/포커스/클립보드/IME를 건드리는 변경은 전부 "macOS 고위험"**으로 취급.
   커밋 전에 반드시 mac에서 확인.
3. Windows 기준으로만 짜고 "mac도 되겠지" 하고 릴리즈하지 말 것. 매번 그래서 터졌다.

---

## 1. 한글/CJK IME 입력 (xterm 터미널) — 가장 자주 터지는 곳

### 증상
- **shell·Claude·Codex에서 한글이 자모로 분리**되어 입력됨 (`ㅈ ㅏ 도행전`).
- 또는 첫 글자만 분리되고 나머지는 정상.
- Windows(WebView2)에서는 멀쩡함 → **macOS 전용**.

### 근본 원인
macOS WebKit(WKWebView)은 xterm의 hidden textarea에 대해:
- **타이핑 시작 첫 글자**를 `compositionstart` 없이 **`input`(inputType `insertText`,
  `isComposing:false`)** 로 먼저 커밋해버린다.
- 그 이후 글자들만 정상 composition 이벤트(`insertCompositionText`, `isComposing:true`)로 온다.
- 심하면 아예 composition 이벤트가 안 뜨고 전부 `insertReplacementText`로만 온다.

xterm.js는 composition 이벤트에 의존하므로, composition 없이 온 조각을 그대로 PTY에
흘려 **음절이 쪼개진다**. 업스트림 미해결 이슈:
[xterm.js#5887](https://github.com/xtermjs/xterm.js/issues/5887),
[#5894](https://github.com/xtermjs/xterm.js/issues/5894). **WKWebView 전용, Chrome/Electron/WebView2는 정상.**

### 해결 (현재 코드)
`crates/mycli-desktop/frontend/app.js`, `createPane()` 안 `if (IS_MAC)` 블록
(`macOS WKWebView Korean/CJK IME fix`):
1. **첫 글자 `insertText`를 가로채** PTY로 단독 전송하지 않고 **textarea에 seed**만 한다
   → 뒤따르는 composition이 그 자모를 흡수해 완성 음절을 만들고, xterm이 조합해 emit.
2. 혹시 남는 `insertReplacementText`는 **xterm 자체 데이터 경로**
   (`coreService.triggerDataEvent → onData`)로 되돌려보낸다.

### ⚠️ 하지 말 것 (이미 실패한 방식)
- **raw `pty_write`로 직접 쏘지 말 것.** 앱의 명령 추적·약어 자동완성(`onData` →
  `trackTypedInput` / `handleTerminalInput`)을 우회해서 **Backspace가 깨지고 약어가
  제멋대로 자동입력**된다. (v1 심의 실패 원인)
- **모든 패인에 무조건 backspace(`\x7f`) 재전송하는 방식 금지.** shell(zsh)처럼 원래
  잘 되던 곳까지 깨뜨린다.
- 입력은 반드시 **xterm의 입력 파이프라인을 통해** 흘려보낼 것.

---

## 2. 계정 사용량 배지 (Claude OAuth 자격증명)

### 증상
제목 옆 `CL 5h/wk` 사용량이 macOS에서만 안 뜸.

### 원인
macOS의 Claude Code는 OAuth 자격증명을 **`~/.claude/.credentials.json` 파일이 아니라
로그인 Keychain**(generic password, 서비스명 `Claude Code-credentials`)에 저장한다.
파일만 읽으면 mac에선 항상 "no credentials".

### 해결 (현재 코드)
`crates/mycli-desktop/src/commands.rs` `read_claude_credentials()`:
파일 먼저 → 없으면 **`security find-generic-password -s "Claude Code-credentials" -w`**
(읽기 전용)으로 Keychain에서 읽음. Windows/Linux는 `#[cfg(target_os="macos")]`로 무변경.

---

## 3. 포커스 / IME 조합 유지 (이미 처리됨)

- **focus keeper는 macOS에서 skip**해야 한다. WebView2용 blur+refocus 루프를 mac에서
  돌리면 **한글 조합이 자모 단위로 커밋**되고 후보창이 떨어져 나간다.
  → `app.js` `startFocusKeeper()` 맨 앞 `if (IS_MAC) return;` 유지.
- `imeComposing` 플래그(조합 중이면 refocus 억제)도 같은 맥락. 조합 중 textarea를
  blur/refocus하면 IME가 깨진다.

---

## 4. 렌더링 / 폰트 / 클립보드 (macOS 특이점 모음)

- **letter-spacing:** WebKit은 CSS `letter-spacing`을 셀 폭 측정에 안 접어서 글자가
  셀을 밀고 커서가 어긋난다 → macOS는 `effectiveLetterSpacing()`로 0 강제.
- **폰트:** macOS는 `SF Mono`/`Menlo` 우선(D2Coding은 너무 넓어 보임).
- **클립보드:** `withGlobalTauri:true` + `capabilities/default.json`에
  `clipboard-manager:allow-read/write-text` 필요. 전역은
  `window.__TAURI_PLUGIN_CLIPBOARD_MANAGER__`. (드래그복사/우클릭 붙여넣기 검증 대상)
- **DMG 빌드 flaky:** `bundle_dmg.sh` 실패는 대개 **이전 DMG 볼륨이 마운트된 채** 남아서다.
  `hdiutil detach /Volumes/Mymux*`, `/Volumes/dmg.*` 후 재빌드.

---

## 5. 릴리즈 전 macOS 입력 스모크 테스트 (필수 관문)

`cargo tauri dev` 또는 실제 `.dmg`로 **mac에서** 아래를 전부 확인. 하나라도 깨지면
**publish 중단.**

- [ ] **shell(zsh)**: 한글 "사도행전"(받침 포함) **첫 글자부터** 정상 조합
- [ ] shell: **Backspace**로 지울 때 공백/이상문자 없이 정상 삭제
- [ ] shell: 약어(`cl` 등) 입력 시 **자동입력 안 되고 선택 대기**
- [ ] **Claude Code(TUI)**: 한글 조합 + Backspace
- [ ] **Codex(TUI)**: 한글 조합 + Backspace
- [ ] 드래그 복사 → 다른 곳 붙여넣기 / 우클릭 복사·붙여넣기
- [ ] 사용량 배지: 제목 옆 CL(5h/wk), 패인 ctx%
- [ ] 창 최소화 후 복귀(Alt-Tab) 시 커서/포커스 정상, 조합 안 깨짐

---

## 6. 진단 방법 (막혔을 때)

입력이 이상하면 **추측하지 말고 이벤트를 찍어라.** `app.js`의 textarea에 임시로
`beforeinput`/`input`/`compositionstart|update|end` 리스너를 달아 `inputType`, `data`,
`isComposing`을 파일(`write_text_file`)로 남기고 읽으면, shell/TUI 각각에서 무엇이
오는지 즉시 보인다. (이 문서의 §1 근본 원인도 그렇게 확정했다.) 확정 후 진단 코드는 제거.

---

## 요약 한 줄

> **WebView2(Win) ≠ WKWebView(mac).** 입력·포커스·IME·자격증명은 mac에서 반드시
> 다르게 동작한다고 가정하고, **릴리즈 전 mac 실기 스모크 테스트(§5)를 관문으로** 둘 것.
