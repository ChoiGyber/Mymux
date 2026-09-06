관련 이슈: [#47 Claude Code 패인에서 우클릭 붙여넣기가 두 번 된다](https://github.com/ChoiGyber/Mymux/issues/47) (통합 테스트 뒤 close)

Claude Code 패인에서 우클릭 한 번에 클립보드가 두 번 붙던 문제입니다. 붙여넣는 주체가 둘이었습니다. Claude Code 2.1.258 이 우클릭 리포트를 받으면 스스로 `powershell Get-Clipboard` 로 클립보드를 읽어 프롬프트에 넣고, Mymux 의 우클릭 핸들러도 붙여넣었습니다. Claude Code 에는 터미널이 xterm.js 면 자기 붙여넣기를 건너뛰는 가드가 있지만, xterm.js 5.5.0 이 XTVERSION 질의에 응답하지 않아 그 가드가 꺼져 있습니다.

[#45](https://github.com/ChoiGyber/Mymux/issues/45) 와 같은 원칙으로 모드로 가릅니다. 클릭 전용 트래킹(`x10`/`vt200`)에서만 우클릭 press 를 삼켜 프로그램에 리포트가 가지 않게 하고, `contextmenu` 의 복사·붙여넣기만 남깁니다. 모션 트래킹(`?1002`/`?1003`) 프로그램은 우클릭 제스처가 있을 수 있어 그대로 두고, 수식키를 누른 우클릭도 통과시킵니다.

선택한 상태의 우클릭이 복사 대신 붙여넣던 것도 함께 사라집니다. 프로그램에 press 를 넘기는 순간 xterm 이 선택을 지워, 뒤이어 도는 핸들러가 복사할 것을 잃었기 때문이었습니다.

## 변경 내용

- `crates/mycli-desktop/frontend/app.js` — 패인 `termWrap` mousedown capture 에 우클릭 분기 추가 (20줄). 클릭 전용 트래킹 모드에서만 우클릭 press 를 삼킨다.

## 검증

프런트엔드 검증 하네스로 실제 `frontend/` 를 띄우고 Playwright 의 실제 마우스 입력으로 측정했습니다. 전후 동일한 스크립트입니다.

| 시나리오 | 전 | 후 |
| --- | --- | --- |
| **트래킹 ON 패인 우클릭** (이 이슈) | 리포트 2건 · 붙는 횟수 2회 | 리포트 0건 · **붙는 횟수 1회** |
| **트래킹 ON 패인 선택 후 우클릭** | 복사 안 됨 · 붙여넣기 됨 | **복사됨 · 붙여넣기 안 함** |
| 트래킹 OFF 패인 우클릭 / 선택 후 우클릭 | 1회 / 복사됨 | 동일 |
| 트래킹 ON 패인 왼쪽 클릭 · 드래그 ([#45](https://github.com/ChoiGyber/Mymux/issues/45)) | 리포트 2건 · 선택+자동 복사 | 동일 |
| 모션 트래킹 TUI 우클릭 (대체 화면) | 리포트 2건 · 2회 | 동일 (제스처 보존, 의도적 미변경) |

원인은 실행 중인 Claude Code 로도 확인했습니다. `claude.exe` 를 ConPTY 에 단독으로 띄우고 클립보드에 표식을 넣은 뒤 우클릭 리포트 한 줄만 보냈더니 표식이 입력창에 붙었고, 이어서 Mymux 경로의 붙여넣기를 보내니 두 번 찍혔습니다.

정적 가드도 통과했습니다 — `scripts/check-macos-gotchas.mjs` 13/13, `scripts/check-vendored-tao.mjs` 6/6.

Windows 실기 확인은 아직입니다. 하네스는 실제 프런트엔드를 그대로 띄우지만 브라우저 위에서 돕니다.

## 증거

[전후 리포트 보기](https://github.com/ChoiGyber/Mymux/issues/47#issuecomment-5557830001)

측정 원본은 `.issue/47/evidence/{before,after}/results.json` 입니다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01VjXoiydpuJt6kgP8WZqvep
