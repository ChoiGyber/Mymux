## 작업 요약

Commands 패널의 제안 토글이 히스토리 소스만 막고 있어서 저장된 명령(내장 시드 포함)은 끌 수가 없었습니다.
저장 명령 전용 토글을 하나 더 넣어 두 소스를 각각 끄게 했고, 둘 다 끄면 `showAutocomplete` 의
기존 "매치 0건 → 숨김" 분기가 그대로 작동해 팝업 자체가 뜨지 않습니다. 라벨과 툴팁은 영어로 통일했습니다.

## 변경 전후

| 전 | 후 |
| --- | --- |
| ![제안 토글 - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/20/evidence/before/toggles.webp) | ![제안 토글 - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/20/evidence/after/toggles.webp) |
| ![제안 끄고 cl 입력 - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/20/evidence/before/popup-all-off.webp) | ![제안 끄고 cl 입력 - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/20/evidence/after/popup-all-off.webp) |

빨간 박스가 변경 구간입니다.

- 위: 체크박스가 1개(한/영 혼용) → 2개(영어만)로 바뀌었습니다.
- 아래: **전** 은 있는 토글을 다 껐는데도 `cl` 을 치면 저장 명령 5개가 그대로 떴습니다.
  **후** 는 둘 다 끄면 팝업이 아예 뜨지 않습니다(점선이 팝업이 뜨던 자리).

새 토글만 끈 중간 상태 — 저장 명령은 빠지고 히스토리(`cls`, `cloc crates/`)만 남습니다.
이 상태는 변경 전에는 만들 수 없어 후 캡처만 있습니다.

![저장 명령만 끈 상태](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/20/evidence/after/popup-saved-off.webp)

## 변경 파일

- `crates/mycli-desktop/frontend/index.html` — 라벨 1줄 → `.cmd-suggest-toggles` + 체크박스 2개, 문구·툴팁 영어화
- `crates/mycli-desktop/frontend/app.js` — `savedCommandSuggestionsEnabled` 상태·setter, 토글 배선, `showAutocomplete` 의 `savedCmds` 게이트
- `crates/mycli-desktop/frontend/style.css` — `.cmd-history-toggle` → `.cmd-suggest-toggle` + 세로 컨테이너

## 검증

정적 검사

- `node --check crates/mycli-desktop/frontend/app.js` 통과
- `node scripts/check-macos-gotchas.mjs` 13/13 통과

기능 검증 — Tauri IPC 를 스텁한 하네스로 실제 `index.html`·`style.css`·`app.js`·vendor xterm 을 띄우고,
터미널에 `term.input()` 으로 글자당 30ms 간격으로 실제 타이핑해서 확인했습니다(1280x800).

| 상태 | `cl` 입력 결과 |
| --- | --- |
| 둘 다 켬 (기본값) | 저장 5건 + 히스토리 2건 |
| 저장 명령만 끔 | 히스토리 2건만 |
| 둘 다 끔 | 팝업 안 뜸 (`hidden`) |
| 재시작 후 | 체크 상태 유지, 팝업 안 뜸 |

회귀 확인

- 토글이 꺼져 있어도 `#command-list` 는 10건 그대로 렌더됩니다.
- 둘 다 끈 상태에서 `LOG` + Enter → `작업기록 남기고 마무리해줘\r` 이 그대로 실행됩니다(alias 동작 유지).

## 남은 이슈

- 실제 Tauri(WebView2) 빌드에서의 육안 확인은 하지 않았습니다. 검증은 동일한 프런트엔드 소스를
  Chromium 에서 띄운 하네스 기준입니다.
