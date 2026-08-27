## 작업 요약

[PR #26 리뷰](https://github.com/ChoiGyber/Mymux/pull/26)에서 나온 두 지적을 정리했습니다.
불필요한 ACL 권한을 빼고, 첫 실행 창이 화면을 넘으면 작업영역에 맞춰 줄이도록 했습니다.

## 1. `window-state:default` 권한 제거

capability 는 webview → Rust IPC 만 게이팅하는데, 이 플러그인이 쓰이는 경로는 전부 Rust 내부입니다 —
복원은 `on_window_ready`, 저장은 `AppHandleExt` 트레이트 메서드로 둘 다 ACL 을 거치지 않습니다.
프런트엔드는 이 API 를 **전혀 쓰지 않습니다**(`app.js` 에서 `windowState` / `restoreState` /
`saveWindowState` / `window-state` 검색 **0건**). 미사용 IPC 커맨드 셋을 main webview 에 노출하고
있었을 뿐입니다.

## 2. 첫 실행 창을 모니터 작업영역에 맞춘다

`tauri.conf.json` 의 크기는 **논리 픽셀**이라, 1920×1080 @150% 처럼 논리 해상도가 1280×720 이 되는
흔한 조합에서 기본 높이 800 이 화면보다 커집니다. Tauri 는 최초 창 생성 시 클램프하지 않고,
창 상태 플러그인의 모니터 교차 검사는 **복원된 상태에만** 적용되므로 첫 실행이 무방비입니다.

기본값을 낮추면 큰 화면 사용자가 손해를 보므로 **1280×800 은 그대로 두고 넘칠 때만 줄입니다.**
늘리는 일은 없고, 저장된 상태가 있으면 건드리지 않습니다 — 플러그인이 이미 검사를 마친 뒤라
덧칠하면 사용자가 고른 크기를 빼앗게 됩니다.

작업영역은 Windows 에서 `GetMonitorInfoW` 의 `rcWork` 로 작업표시줄까지 제외해 정확히 구하고,
다른 플랫폼은 `commands.rs` 가 버디 오버레이 배치에 쓰는 것과 같은 reserve 를 뺍니다.

## 변경 전후

이 PC 모니터가 2048×1280 이라 실제 기본값 1280×800 은 넘치지 않습니다. 클램프 유무를 보이기 위해
기본 창 크기를 **일시적으로** 4000×3000 으로 두고 계측했습니다. (임시 변경은 되돌렸고 커밋에는
원래 값만 들어갑니다.)

| | 전 | 후 |
| --- | --- | --- |
| 요청한 기본 크기 | 4000 × 3000 (논리) | 4000 × 3000 (논리) |
| 실제 창 (물리) | 2566 × 1614 | **2544 × 1532** |
| 논리 환산 | 2053 × 1291 | **2035 × 1226** |
| 작업영역 (논리) | 2048 × 1232 | 2048 × 1232 |
| 판정 | 폭 +5, 높이 +59 **초과** | **안에 들어감** |

## 구현 중 잡은 실제 결함 — 프레임 보정

첫 구현은 클램프가 걸렸는데도 작업영역을 39px 넘었습니다. 원인은 **두 API 의 기준이 다른 것**이었습니다.

```text
win.outer_size()   창 전체 (프레임 포함)
win.set_size(..)   → tauri-runtime-wry:3527 에서 window.set_inner_size(..)
                     즉 inner (프레임 제외)
```

outer 로 재서 그대로 `set_size` 에 넘기면 프레임만큼 초과합니다. 판정은 outer 기준으로 하되 설정값은
`outer - inner` 를 빼서 환산하도록 고쳤습니다. **과대 기본값으로 실측하지 않았다면 넘어갔을 결함입니다.**

## 검증

| 항목 | 결과 |
| --- | --- |
| 과대 기본값 클램프 | 통과 — 논리 2035×1226, 작업영역 안 |
| 기본값(1280×800)에서 무동작 | 통과 — 그대로 뜸 |
| ACL 제거 후 저장 | 통과 — 1350×880 으로 닫으니 `{width:1670, height:1053, x:88, y:56}` 기록 |
| ACL 제거 후 복원 | 통과 — 재실행 시 1337×843 @ 96,56 그대로 |
| 클램프가 복원을 침범하지 않는가 | 통과 — 복원된 크기 유지 |
| 단위 테스트 | **66 passed / 0 failed** (최소권한 회귀 테스트 포함) |

종료는 X 버튼 경로(WM_CLOSE → 모달 → '저장하고 종료')로 했습니다.
계측 원본은 `main` 브랜치에 함께 커밋했습니다.

```text
.issue/28/evidence/before/window-clamp.md
.issue/28/evidence/after/window-clamp.md
```

## 변경 파일

- `crates/mycli-desktop/src/main.rs` — 작업영역 클램프(첫 실행 한정)
- `crates/mycli-desktop/Cargo.toml` — `windows-sys` 에 `Win32_Graphics_Gdi`
- `crates/mycli-desktop/capabilities/default.json` — `window-state:default` 제거
- `crates/mycli-desktop/gen/schemas/*` — `tauri-build` 자동 생성물

`tauri.conf.json` 은 건드리지 않았습니다. 기본값은 1280×800 그대로입니다.

## 남은 이슈

- **스크린샷은 넣지 않았습니다.** 요점이 창 치수라 표의 수치가 그림보다 정확합니다. 클램프된 창을
  한 장 찍어 화면 안에 들어오는 것은 눈으로 확인했습니다.
- macOS·Linux 실기 검증은 없습니다(장비 없음). 그쪽은 `monitor.size()` 에서 reserve 를 빼는 경로라
  Windows 만큼 정확하지 않습니다.
