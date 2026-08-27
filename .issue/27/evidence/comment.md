## 작업 요약

main 창을 닫아도 `buddy-overlay` 창이 살아 있어 `Mymux.exe` 가 백그라운드에 남던 것을 고쳤습니다.
창이 파괴되는 시점에 창 크기를 저장한 뒤 앱 종료를 요청합니다. 동작 변경은 `handle.exit(0);` 한 줄입니다.

## 원인

`tauri-runtime-wry-2.11.4/src/lib.rs:4310-4318` 은 창 맵이 **빌 때만** `ExitRequested` 를 내고
`ControlFlow::Exit` 로 갑니다. 그런데 `buddy-overlay` 는 `tauri.conf.json` 에서 앱 시작 시
생성되고(`visible: false`) Rust 쪽은 show/hide 만 합니다 — `commands.rs:900` 의
`buddy_overlay_show` 는 기존 창을 `get` 할 뿐 만들지도 없애지도 않습니다. 그래서 맵이 영원히
비지 않고, 프로세스가 종료되지 않습니다.

## 왜 `overlay.destroy()` 가 아니라 `app.exit(0)` 인가

[PR #26 리뷰](https://github.com/ChoiGyber/Mymux/pull/26)에서는 오버레이를 함께 destroy 하자는
제안이 나왔습니다. 결과는 같지만 **호출 경로의 재진입 안전성이 다릅니다.**

| | 경로 | 이벤트 루프 콜백 안에서 |
| --- | --- | --- |
| `overlay.destroy()` | `send_user_message` | 메인 스레드면 즉시 처리 → `windows` RefCell 재진입 위험 |
| `handle.exit(0)` | `proxy.send_event` → `Event::UserEvent` | **안전** — 큐에 들어가 다음 루프에서 처리 |

근거는 상류 소스에 명시돼 있습니다. `request_exit` 에는 "cannot use the `send_user_message`
function because it accesses the event loop callback" 이라는 주석이 달려 있고(`:2748`),
메인 스레드 직접 처리 경로는 `panic!("cannot handle RequestExit on the main thread")` 로
막혀 있습니다(`:3342`). proxy 로만 도달하도록 설계된 API 입니다.

## 변경 전후

### 창을 닫은 뒤 프로세스

| | 전 | 후 |
| --- | --- | --- |
| 테스트 인스턴스 | **남음** (PID 2656 그대로) | **사라짐** (개수 0) |
| CDP 페이지 타겟 | `overlay.html` 만 남아 프로세스 유지 | 연결 끊김 |

후자는 **오버레이를 띄운 채로 닫는** 더 엄격한 조건에서 확인했습니다.

### 연속 실행 — 낡은 값이 되살아나지 않는다

```text
실행 A: 1400×900 으로 닫음  → 저장 {width:1732, height:1078, x:63,  y:50}
실행 B: 1200×760 으로 닫음  → 저장 {width:1482, height:903,  x:125, y:88, prev_x:63, prev_y:50}
```

B 가 그대로 남습니다. 낡은 캐시를 들고 있는 프로세스 자체가 존재하지 않으므로, 로그오프로
좀비를 깨워 덮어쓰는 원래 시나리오가 성립하지 않습니다.

## 회귀 확인

| 항목 | 결과 |
| --- | --- |
| 데스크톱 캐릭터 오버레이 | 정상 — `{"cls":"show","char":"mascot","text":"'테스트 세션' 작업 다 끝났슈! 🎉"}`, hide 도 정상 |
| 창 크기 저장·복원 (#25) | 정상 — 1400×900 으로 닫고 재실행하니 1387×863 @ 71,50 으로 복원 |

## 증거

- [before — 창을 닫아도 프로세스가 남는다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/27/evidence/before/process-lifecycle.md)
- [after — 창을 닫으면 프로세스도 끝난다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/27/evidence/after/process-lifecycle.md)

**스크린샷은 넣지 않았습니다.** 이 이슈의 대상은 화면이 아니라 프로세스 수명이라 캡처로
증명되지 않습니다. 유일하게 그림이 될 만한 오버레이 창은 `transparent: true` 라 뒤의 사용자
화면이 함께 담기므로, 대신 그 창의 DOM 을 직접 읽어 텍스트로 남겼습니다.

## 변경 파일

- `crates/mycli-desktop/src/main.rs` — `Destroyed` 훅에 `handle.exit(0)` 추가 (+24/-6, 대부분 주석)

## 검증

`cargo build -p mycli-desktop` / `cargo clippy -p mycli-desktop --all-targets` 통과.

## 남은 이슈

- 좀비를 로그오프로 깨우는 원래 시나리오는 재현하지 않았습니다. 좀비가 생기지 않는 것이
  확인되면 그 시나리오는 성립할 수 없다고 판단했습니다.
- macOS·Linux 실기 검증은 없습니다(장비 없음). `AppHandle::exit` 는 플랫폼 공통 API 입니다.
