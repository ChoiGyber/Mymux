## 증거

| 변경 전 | 변경 후 |
| --- | --- |
| ![변경 전 — OSC 8 링크가 xterm 기본 confirm 창으로 새어 클릭이 사라진다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/42/evidence/before/link-click.webp) | ![변경 후 — OSC 8 링크도 Mymux 자체 브라우저로 열린다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/42/evidence/after/link-click.webp) |

| 클릭 대상 | 변경 전 | 변경 후 |
| --- | --- | --- |
| **OSC 8 하이퍼링크 + Ctrl+클릭** | **xterm 기본 `confirm` 창** (Tauri 에선 안 뜸 = 무반응) | **Mymux 자체 브라우저** |
| OSC 8 하이퍼링크 + 그냥 클릭 | xterm 기본 `confirm` 창 | 힌트 토스트만 (TUI 클릭 보존) |
| 평범한 URL 텍스트 + Ctrl+클릭 | Mymux 자체 브라우저 | Mymux 자체 브라우저 (회귀 없음) |

## 원인 — 링크 경로가 둘인데 한쪽에만 핸들러가 있었다

터미널에서 링크가 만들어지는 길은 두 개다.

| 경로 | 무엇인가 | 어떻게 라우팅되나 |
| --- | --- | --- |
| WebLinks 애드온 | 화면에 찍힌 맨 URL 텍스트를 **정규식으로 찾아낸다** | 애드온 생성자에 넘긴 콜백 |
| **OSC 8** | 프로그램이 "여기부터 여기까지가 링크" 라고 **직접 표시한다** | 터미널 옵션 `linkHandler` |

Mymux 는 **애드온 쪽에만** 핸들러를 달아 뒀고 `linkHandler` 는 비어 있었다(`grep -c linkHandler app.js` → 0).
그러면 xterm 이 자기 기본 동작을 쓴다.

```js
function h(e, t) {
  if (confirm(`Do you want to navigate to ${t}?...`)) {
    const w = window.open();
    if (w) { w.opener = null; w.location.href = t } else console.warn(...)
  }
}
```

`confirm()` 과 `window.open()` 은 **Tauri 웹뷰에서 뜨지 않는다.** 그래서 클릭이 통째로 사라졌다 — 토스트도, 화면 전환도, 오류도 없이.

**요즘 CLI 는 OSC 8 을 쓴다.** 그래서 AI CLI 세션에서 링크를 누를 때만 증상이 나타났다.

## 진단 과정에서 틀렸던 것

처음 이 이슈를 열 때는 **"마우스 트래킹을 켠 TUI 안에서 xterm 이 클릭을 삼킨다"** 고 적었다.
근거는 `vendor/xterm.min.js` 의 `mousedown` 가로채기와, 그 탈출구가 Windows 에서 `Shift` 인데 Mymux 는 `Ctrl` 을 요구한다는 불일치였다.

**실측으로 반증됐다.** 마우스 트래킹을 켜고 CDP 로 진짜 마우스 입력을 쏴도 Ctrl+클릭은 핸들러까지 정상 도달한다 — 가로채기는 `mousedown` 이고 링크 활성화는 `mouseup` 이라 서로 다른 이벤트였다.

프런트엔드 로직도, 백엔드도 정상이었다. 실기에서 `browser_pane_open` 이 실제로 자식 웹뷰를 띄우는 것까지 확인했다.
**"평범한 URL 은 되는데 OSC 8 은 안 된다"** 를 갈라낸 뒤에야 진짜 경로가 드러났다.

## 수정

`crates/mycli-desktop/frontend/app.js` — 프런트엔드 전용, +24 −4 줄.

1. 두 경로가 함께 쓰는 게이트 `handleTerminalLink(event, uri)` 를 만들었다.
2. WebLinks 애드온이 그 게이트를 쓰도록 바꿨다.
3. 터미널 옵션에 `linkHandler: { activate: handleTerminalLink }` 를 등록했다.

게이트가 하나라 두 경로가 어긋날 수 없다. 평범한 클릭은 여전히 실행 중인 TUI 의 몫이고(메뉴·버튼), Ctrl/Cmd+클릭이 링크를 열며, 로그인 URL 은 사용자가 하라고 안내받은 행동이므로 그대로 예외다.

## 검증 방법과 한계

cargo 빌드 없이 실제 `app.js` 를 그대로 부팅시키고(Tauri IPC 스텁 하네스), **변경 전 코드와 변경 후 코드를 각각 별도 포트**에 띄워 같은 스크립트로 측정했다. 클릭은 합성 `MouseEvent` 가 아니라 **CDP `Input.dispatchMouseEvent`** 로 진짜 마우스 입력을 만들었다(합성 이벤트로는 결과가 달랐다).

- 캡처 왼쪽의 탐색기 오류와 빈 패널은 하네스 스텁의 한계다. 이 이슈와 무관하다.
- `confirm`/`window.open` 은 후킹해서 잡았다. 실제로 띄우면 브라우저가 멈춰 계측이 불가능하다.
- **실기 확인은 남아 있다.** 실제 Claude Code·codex 세션에서 링크를 Ctrl+클릭했을 때 자체 브라우저로 열리는지는 사용자 환경에서 봐야 한다.

## 곁가지로 발견한 별개 결함 (이 PR 에서 고치지 않음)

`crates/mycli-desktop/src/browser.rs:593`

```rust
} else if let Err(e) = win.add_child(...) {
    eprintln!("browser_pane add_child failed: {e}");   // stderr 로만 찍고 Ok 반환
}
```

내장 브라우저 생성이 **실패해도 커맨드가 성공을 반환한다.** 프런트엔드는 성공으로 알고 토스트도 안 뜨며, GUI 앱이라 `eprintln!` 은 아무도 못 본다. 이번 이슈의 원인은 아니었지만(내 환경에선 성공했다) 실패하는 환경에서는 똑같이 "아무 반응 없음" 이 된다. 별도 이슈로 다룰 문제다.
