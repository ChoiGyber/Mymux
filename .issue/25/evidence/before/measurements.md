# before 계측 — 현재 main (수정 전)

빌드: 워크트리 pure 상태(`fix/25-window-state-restore` 분기 직후), `cargo build -p mycli-desktop`
실행: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=..."` + 매번 새 프로필
계측: CDP `Runtime.evaluate` (창 크기·터미널 cols) + Win32 `GetWindowRect` (프레임 포함 실크기)

| 시점 | 창 크기(CSS px) | 실제 창(프레임 포함) | 패인 | 패인당 cols | 터미널 폭 |
| --- | --- | --- | --- | --- | --- |
| 1. 첫 실행 | 800 × 560 | 814 × 598 | 2 (좌우 분할) | **18** | 142px |
| 2. 창을 키움 | 1586 × 963 | 1600 × 1000 | 2 (좌우 분할) | 72 | — |
| 3. 종료 후 재실행 | **800 × 560** | 814 × 598 | — | — | — |

## 읽는 법

- 3번이 이 이슈의 전부다. 2번에서 키워 둔 크기가 종료와 함께 사라지고 1번으로 되돌아간다.
- 1번의 18 cols 가 증상의 원인이다. 800px 창의 내부 배분은 `#sidebar` 280px +
  `#terminal-area` 300px + `#session-panel` 220px 로, 터미널 몫이 300px 뿐이다.
  좌우로 나누면 패인당 142px = 18 cols 이고, 셸과 AI CLI 는 그 폭에 맞춰 줄바꿈한 출력을 뱉는다.
- 2번은 `refitAllPanes()` 가 정상임을 보여준다. 창이 커지면 18 → 72 cols 로 즉시 재동기화된다.
  고칠 곳은 프론트엔드 리사이즈 로직이 아니라 **창 크기가 보존되지 않는다는 사실**이다.
- 한 번 좁은 폭으로 출력된 스크롤백은 창을 키워도 복구되지 않는다(xterm 리플로우 한계).
