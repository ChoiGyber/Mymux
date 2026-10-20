---
id: 003
date: 2026-10-20
title: 세션 패널 접기 복구 + Windows 패인 첫 출력에서 포커스 리포팅 해제 (codex 입력창 [I 누적) · v0.3.3 릴리즈
type: fix
tags: [session-panel, focus-reporting, decset-1004, conpty, codex, windows, release]
commits:
  - 19c3a89
  - 3621b0c
  - 77daca9
version: 0.3.3
---

# 세션 패널 접기 복구와 포커스 리포팅 해제

사용자가 스크린샷 3장과 함께 두 가지를 신고했다. 하나는 세션 패널의 접기 버튼이 동작하지 않는다는 것이고, 다른 하나는 세션을 추가할 때마다 GPT(Codex) 입력창에 `[I` 가 하나씩 붙는다는 것이다. 이슈는 만들지 않았다(`issue.createMode=direct`).

## 1. 세션 패널이 접히지 않음

### 원인

`setupSessionResizer` 가 폭을 `panel.style.width` 인라인 스타일로 넣었다. 인라인 값은 `#session-panel.collapsed { width: 34px }` 보다 우선하므로, 폭을 드래그했거나 `mymux.sessionWidth` 가 저장된 사용자는 접어도 폭이 그대로였다. 기본 폭 220px 에서는 정상으로 접혀서 개발 중에는 드러나지 않았다. 증상은 목록만 사라지고, 아이콘이 넓은 헤더 가운데에 남는 모양이다.

### 수정

폭을 CSS 변수 `--session-panel-width` 로 옮겼다(`#session-panel { width: var(--session-panel-width, 220px) }`). `setupSessionResizer` 의 읽기·쓰기 세 곳을 `setProperty`/`getPropertyValue` 로 바꿨다.

## 2. Codex 입력창에 `[I` 누적

### 원인

v0.2.2 의 #38 수정이 남긴 빈틈이다. ConPTY 는 패인을 만들 때마다 `?9001h?1004h` 를 내보낸다. #38 의 정리(`clearStaleFocusReporting`)는 OSC 133;D(셸 프롬프트 복귀)와 대체 화면 이탈에서만 호출된다.

- OSC 133 을 보내는 셸(PowerShell, Git Bash, 기본 셸)은 정리가 돈다.
- CMD, ssh, WSL, 임의 실행 파일 패인은 133 이 없어서 1004 가 계속 켜져 있다.
- Codex 0.162 는 대체 화면(`?1049h`)을 쓰므로 실행 중에는 이탈 정리도 없다.

그래서 포커스가 움직일 때마다 `ESC[I`/`ESC[O` 가 Codex 로 가고, Codex 가 ESC 를 취소로 처리해서 `[I` 가 입력창에 글자로 남는다.

### 수정

`pumpTerminals` 에서 패인의 첫 출력을 파싱한 직후 `clearStaleFocusReporting` 을 한 번 호출한다(Windows 한정). 정리 시점은 하네스 실측으로 PowerShell 첫 프롬프트 뒤 0.3~0.55초에서 약 3ms 로 앞당겨졌다.

### ConPTY 성질(실측)

- 자식 프로세스가 쓴 `?1004h` 는 ConPTY 가 버린다(`?2004h` 는 통과한다).
- 리사이즈, 자식 기동, Codex 실행으로 `?1004h` 가 다시 나오지 않는다.
- 따라서 Windows 패인에서 1004 의 출처는 탄생 초기화 하나뿐이고, 탄생 직후에 끄더라도 프로그램의 정당한 요청을 막지 않는다.

## 검증

실제 ConPTY 를 쓰는 하네스(node-pty + 헤드리스 Edge)에서 확인했다. 실제 Tauri 앱 빌드는 돌리지 않았다.

| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| 저장 폭 400px 에서 접기 | 400px 유지 | 34px, 재펼침 시 400px 복원 |
| 폭 150px 드래그 | - | 370px 로 반영·저장, 이후에도 접힘 |
| CMD 패인 Codex, 세션 추가·복귀 | codex 로 간 리포트 수백 건 | 0건 |
| PowerShell 패인 같은 시나리오 | 0건 | 0건 |
| 탄생 뒤 늦게 도착한 `?1004h` | - | 유지되고 리포트도 정상 전송 |

macOS 정적 가드 13/13, `node --check` 통과.

## 확정하지 못한 것

- 사용자의 Codex 패인이 어떤 셸인지 모른다. PowerShell 패인은 재현되지 않았고, 수정은 셸 종류와 무관하게 적용했다.
- 방송(Ctrl+Shift+B)이 켜져 있으면 패인이 만든 포커스 리포트가 같은 탭의 모든 패인으로 전달되는 경로가 따로 있다. 사용자 상태를 몰라서 손대지 않았다.
- 부작용: 콘솔 포커스 이벤트를 기다리는 앱은 CMD, ssh, WSL 패인에서도 그 이벤트를 받지 못한다. PowerShell 패인은 v0.2.2 부터 이미 그렇다.

## 릴리즈 (v0.3.3)

- 작업은 `origin/main` 기준 워크트리에서 했다. 주 체크아웃(`fix/mac-term-env`)이 12커밋 뒤처져 있고 무관한 미커밋 WIP 가 있어서다.
- 커밋: `19c3a89` 수정, `3621b0c` 릴리즈(버전 3곳 + CHANGELOG), 태그 `v0.3.3`, 이어서 홈페이지 커밋.
- 태그 푸시로 `release.yml` 이 자동 시작(run 39359202976, ubuntu + windows 모두 성공, 약 11분).
- 서명 5개 항목이 `.sig` 와 문자열로 일치했고 키 ID 는 `667B1FD960DD1F9A`. `latest.json` 의 안내 문구를 한/영 한 문장으로 교체해 `--clobber` 로 올린 뒤 공개했다.
- 공개 `latest.json` 은 0.3.3 이고 업로드본과 같다. `Mymux_0.3.3_x64-setup.exe` 는 HTTP 200, 8,792,269 B.
- macOS 자산은 없다. `latest.json` 에 darwin 키가 없어서 맥은 "업데이트 없음"으로 보이며, 맥에서 빌드해 올릴 때까지 맥 사용자는 이번 수정을 받지 못한다. Linux 자산은 실행 검증을 하지 않았다.
- 남은 일: Windows 실기에서 CMD 패인 Codex 입력창에 `[I` 가 더 쌓이지 않는지, 폭을 조절한 세션 패널이 접히는지 사용자 확인.
