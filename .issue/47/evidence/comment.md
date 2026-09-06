## 변경 전후

| 전 | 후 |
| --- | --- |
| ![변경 전 - 왼쪽 Claude Code 재현 패인은 우클릭 한 번에 두 번 붙는다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/47/evidence/before/rclick-paste.webp) | ![변경 후 - 두 패인 모두 우클릭 한 번에 한 번만 붙는다](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/47/evidence/after/rclick-paste.webp) |

빨간 박스가 우클릭한 프롬프트입니다. 왼쪽이 Claude Code 재현 패인(마우스 트래킹 ON), 오른쪽이 Codex 재현 패인(트래킹 OFF)이고, 두 패인에 완전히 같은 우클릭을 한 직후입니다. 변경 전에는 왼쪽만 두 번 붙었습니다.

## 원인 — 붙여넣는 주체가 둘이었습니다

Claude Code 2.1.258 은 우클릭을 받으면 **스스로 OS 클립보드를 읽어 프롬프트에 넣습니다**. Windows·WSL·Linux 에서는 `powershell Get-Clipboard` 를 실행하는 경로가 실행 파일 안에 그대로 들어 있습니다. Mymux 의 우클릭 핸들러도 붙여넣기 때문에 한 번의 우클릭에 같은 내용이 두 번 들어갔습니다.

Claude Code 에는 이런 겹침을 막는 가드가 있습니다. 터미널에 이름을 물어보고(XTVERSION) 답이 `xterm.js` 로 시작하면 자기 붙여넣기를 건너뜁니다. 그런데 Mymux 가 쓰는 xterm.js 5.5.0 은 그 질문에 아예 답하지 않아서 가드가 켜지지 않았습니다.

실제로 그런지 실행 중인 Claude Code 로 확인했습니다. `claude.exe` 를 ConPTY 에 단독으로 띄우고, 클립보드에 표식을 넣은 뒤 우클릭 리포트 한 줄만 보냈더니 표식이 입력창에 붙었습니다. 이어서 Mymux 가 보내는 붙여넣기를 보내니 표식이 두 번 찍혔습니다.

```
[14000ms] SEND right-button PRESS report ESC[<2;40;20M
[20000ms] RESULT-A (Claude Code alone, right-click report only): marker pasted = true
[25003ms] final input line: "...MYMUX_RCLICK_MARKER_7731MYMUX_RCLICK_MARKER_7731_BP"
```

## 덤으로 고쳐진 것 — 선택 후 우클릭이 복사가 아니라 붙여넣기였습니다

측정하다 알게 된 것인데, 트래킹이 켜진 패인에서는 **드래그로 선택해 둔 상태로 우클릭해도 복사가 안 되고 붙여넣기가 됐습니다.** xterm 이 프로그램에 버튼을 넘기는 순간 선택을 지우기 때문에, 뒤이어 도는 Mymux 핸들러가 복사할 것을 잃고 붙여넣기 쪽으로 갔던 것입니다. 우클릭을 프로그램에 넘기지 않게 되면서 이 경로도 함께 정상으로 돌아왔습니다.

## 수정

우클릭을 되찾되 **클릭 전용 트래킹 모드에서만** 합니다. 이 모드의 프로그램은 누름과 뗌만 요청했고, Claude Code 는 우클릭으로 붙여넣기 말고는 하는 일이 없으니 잃는 것이 없습니다. 반대로 모션까지 요청한 프로그램(vim 의 마우스 모드, htop)은 우클릭 제스처가 있을 수 있어 그대로 두었습니다. 수식키를 누른 우클릭도 프로그램에 그대로 전달됩니다. 화면 버퍼가 아니라 모드로 가르는 이유는 [#45](https://github.com/ChoiGyber/Mymux/issues/45) 와 같습니다 — Claude Code 는 일반 화면과 대체 화면 양쪽에서 트래킹을 켭니다.

## 검증

프런트엔드 검증 하네스로 실제 `frontend/` 를 띄우고 Playwright 의 실제 마우스 입력으로 측정했습니다. 전후 동일한 스크립트입니다. `실제 붙는 횟수` 는 Mymux 붙여넣기에, 프로그램에 리포트가 나갔으면 Claude Code 의 붙여넣기 한 번을 더한 값입니다.

| 시나리오 | 전 | 후 |
| --- | --- | --- |
| **트래킹 ON 패인 우클릭** (이 이슈) | 리포트 2건 · **붙는 횟수 2회** | 리포트 0건 · **붙는 횟수 1회** |
| **트래킹 ON 패인 선택 후 우클릭** | 복사 안 됨 · 붙여넣기 됨 | **복사됨 · 붙여넣기 안 함** |
| 트래킹 OFF 패인 우클릭 | 붙는 횟수 1회 | 동일 |
| 트래킹 OFF 패인 선택 후 우클릭 | 복사됨 | 동일 |
| 트래킹 ON 패인 왼쪽 클릭 | 리포트 2건 전달 | 동일 (바이트 일치) |
| 트래킹 ON 패인 왼쪽 드래그 ([#45](https://github.com/ChoiGyber/Mymux/issues/45)) | 선택됨 · 자동 복사됨 | 동일 |
| 모션 트래킹 TUI 우클릭 (대체 화면) | 리포트 2건 · 붙는 횟수 2회 | 동일 (제스처 보존) |

마지막 줄은 **일부러 그대로 둔 것**이라 적어 둡니다. vim 같은 모션 트래킹 프로그램에서는 우클릭이 여전히 프로그램에도 가고 Mymux 도 붙여넣습니다. 변경 전과 똑같은 동작이며, 이 이슈의 범위(클릭 전용 트래킹) 밖입니다.

측정 원본은 `.issue/47/evidence/{before,after}/results.json` 입니다. 정적 가드도 통과했습니다 — `scripts/check-macos-gotchas.mjs` 13/13, `scripts/check-vendored-tao.mjs` 6/6.

## 변경 파일

- `crates/mycli-desktop/frontend/app.js` — 패인 마우스 처리에 우클릭 분기 추가 (20줄)

## 남은 이슈

Windows 실기 확인은 아직입니다. 하네스는 실제 프런트엔드를 그대로 띄우지만 브라우저 위에서 돕니다.
