## 작업 요약

창 크기·위치·최대화 상태가 저장되지 않아 매 실행 설정 기본값(800×560)으로 돌아가던 것을 고쳤습니다.
`tauri-plugin-window-state` 를 붙이고, 저장된 상태가 없는 첫 실행의 기본 창을 1280×800 으로 키웠습니다.
작은 창에서 사이드바가 폭을 차지해 터미널 패인이 18 컬럼까지 좁아지던 것이 증상의 원인이었습니다.

## 변경 전후

**첫 실행 — 저장된 상태가 없을 때**

| 전 (800×560, 패인당 18 cols) | 후 (1280×800, 패인당 51 cols) |
| --- | --- |
| ![첫 실행 - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/before/window-firstrun.webp) | ![첫 실행 - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/after/window-firstrun.webp) |

**창을 1600×1000 으로 키운 뒤 종료하고 다시 실행했을 때** — 이 이슈의 핵심입니다.

| 전 (800×560 으로 되돌아감) | 후 (1600×1000 유지, 패인당 72 cols) |
| --- | --- |
| ![재실행 - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/before/window-relaunch.webp) | ![재실행 - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/after/window-relaunch.webp) |

빨간 박스가 터미널 영역입니다. 전에는 사이드바 사이에 끼여 프롬프트 한 줄이 겨우 들어갈 폭이었고,
그 폭으로 출력된 스크롤백은 나중에 창을 키워도 되돌아오지 않습니다.

<details>
<summary>참고 — 창을 키운 직후 (전후 모두 동일하게 동작)</summary>

리사이즈 자체는 원래도 정상이었습니다. `refitAllPanes()` 가 PTY 그리드를 즉시 재동기화해
18 → 72 cols 로 회복합니다. 문제는 그 크기가 종료와 함께 사라진다는 것이었습니다.

| 전 | 후 |
| --- | --- |
| ![창 확대 - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/before/window-enlarged.webp) | ![창 확대 - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/25/evidence/after/window-enlarged.webp) |

</details>

## 계측

| | before | after |
| --- | ---: | ---: |
| 첫 실행 창 (CSS px) | 800 × 560 | **1280 × 800** |
| 첫 실행 패인 cols | 18 | **51** |
| 키운 뒤 재실행 | 800 × 560 (상실) | **1586 × 963 (유지)** |
| 재실행 후 패인 cols | 18 | **72** |

CDP `Runtime.evaluate` 로 `outerWidth`/`term.cols` 를, Win32 `DwmGetWindowAttribute` 로 실제 창 경계를 읽었습니다.
조건은 전후 동일 — 매번 새 WebView2 프로필, 사이드바 둘 다 열린 기본 배치, 터미널 좌우 분할.
원본은 `.issue/25/evidence/{before,after}/measurements.md`.

## 변경 파일

- `crates/mycli-desktop/Cargo.toml` — `tauri-plugin-window-state = "2"`
- `crates/mycli-desktop/src/main.rs` — 플러그인 등록(`SIZE | POSITION | MAXIMIZED`, `buddy-overlay` denylist) + main 창 `Destroyed` 에서 명시 저장
- `crates/mycli-desktop/capabilities/default.json` — `window-state:default` 권한
- `crates/mycli-desktop/tauri.conf.json` — 기본 창 800×560 → 1280×800
- `Cargo.lock`, `gen/schemas/*` — 의존성·ACL 자동 생성물

`frontend/app.js` 는 건드리지 않았습니다. `refitAllPanes()` 는 정상 동작합니다.

## 검증

| 완료 기준 | 결과 |
| --- | --- |
| 크기·위치·최대화 복원 | 통과 — 1600×1000 @ 40,20 종료 → 재실행 동일. 최대화도 `maximized: true` 저장·복원 |
| 첫 실행 1280×800 | 통과 |
| 모니터 밖 좌표 보정 | 통과 — 상태 파일에 `x: 9000, y: 6000` 을 심고 실행하니 창이 77,77 로 들어옴 |
| 복원 창에서 정상 cols | 통과 — 72 cols |

`cargo build -p mycli-desktop` / `cargo clippy -p mycli-desktop --all-targets` 통과(새 경고 없음).

## 검증에서 드러난 것

플러그인은 파일을 **`RunEvent::Exit` 에서만** 씁니다. 그런데 이 앱은 거기 도달하지 않습니다 —
main 창을 닫아도 `buddy-overlay` 창이 살아 있어 프로세스가 남습니다. 플러그인만 등록한 빌드에서는
창을 닫아도 `.window-state.json` 이 생기지 않는 것을 확인했고, 그래서 main 창의 `Destroyed` 에서
`save_window_state()` 를 직접 부르도록 했습니다.

**앱을 닫아도 프로세스가 종료되지 않는 것 자체는 이 이슈와 별개인 결함입니다.** 여기서는 고치지 않았습니다.

## 남은 이슈

- 터미널 최소 폭 보호(창이 좁을 때 사이드바 자동 축소 또는 PTY cols 하한)는 이번 범위에서 제외했습니다.
  창이 커져도 사이드바 624px 고정 잠식은 그대로라, 최소 창(520px)까지 줄이면 여전히 패인이 매우 좁아집니다.
- 위에 적은 프로세스 미종료 결함.
