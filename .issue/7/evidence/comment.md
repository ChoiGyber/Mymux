## 작업 요약

패인에 직접 입력한 `ssh` 를 감지해 `+ SSH` 로 접속했을 때와 같은 경로를 타게 했습니다.
명령줄 파싱과 `~/.ssh/config` 별칭 해석은 Rust 커맨드 `ssh_resolve_command` 하나로 두고,
흩어져 있던 `t.type === "ssh"` 검사는 `isRemotePane(t)` 로 모아 감지된 접속도 같은 경로를
타게 했습니다.

## 변경 전후

`cd D:\Project\Mymux` 로 로컬 디렉토리를 옮긴 뒤 그 자리에서 `ssh clp` 를 직접 입력했습니다.
두 화면의 터미널은 같은 상태(서버에 접속 완료)이고, 빨간 박스 안의 탐색기만 다릅니다.

| 전 | 후 |
| --- | --- |
| ![타이핑한 ssh - 전](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/7/evidence/before/typed-ssh.webp) | ![타이핑한 ssh - 후](https://raw.githubusercontent.com/ChoiGyber/Mymux/main/.issue/7/evidence/after/typed-ssh.webp) |

전에는 SSH 프롬프트(`root@myaflat-303392:~#`)가 떠 있는데도 탐색기가 `Local PC` ·
`D:\Project\Mymux` 를 그대로 보여주고 세션 이름도 `powershell` 이었습니다. 후에는 탐색기
소스가 `SSH: root@49.247.202.200` 으로 바뀌고 서버의 `root/` 가 표시되며, 세션 목록에도
지구본 아이콘과 `SSH: root@…` 라벨이 붙습니다.

## 완료 기준 확인

CDP 로 실제 앱을 조작해 4단계 시나리오를 돌린 결과입니다.

| 단계 | 탐색기 | 판정 |
| --- | --- | --- |
| 1. 로컬에서 `cd D:\Project\Mymux` | `D:\Project\Mymux` (Local PC) | 로컬 동작 회귀 없음 |
| 2. `ssh clp` 직접 입력 | `/root` (SSH: root@49.247.202.200) | 서버 디렉토리를 잡음 |
| 3. 원격에서 `cd /var/log` | `/var/log` — apt·nginx·postgresql… | `cd` 추종 |
| 4. `exit` | `D:\Project\Mymux` 로 복귀, 라벨도 `powershell` | 로컬 복귀 |

- `ssh user@host` / `-p` / `-i` / `~/.ssh/config` 별칭 — Rust 테스트 10개로 커버
- 비밀번호 인증이면 탐색기에 `비밀번호 필요` 와 `<host> 열기` 버튼이 뜨고, 모달이 새 탭 대신
  현재 패인에 SFTP 만 붙입니다 (실기 미확인 — 이 PC 의 등록 서버가 모두 키 인증입니다)
- `+ SSH` 기존 경로는 `adoptedSsh` 가 없으므로 `releaseTypedSsh` 가 아무 일도 하지 않습니다

## 계획서에서 바로잡은 것

`docs/superpowers/plans/2026-08-12-adopt-typed-ssh-explorer.md` 를 현재 main 과 대조하며
아래를 고쳤습니다.

1. **`resolveRemotePaneDir` 의 가드 누락** — 계획서는 교체 대상 6곳만 열거했지만, 여기를
   빼면 `syncExplorerOnCd` 가 원격으로 라우팅한 뒤 이 함수가 `null` 을 반환하고 호출부가
   `.catch(() => {})` 로 삼켜 **오류 없이 조용히** `cd` 추종이 실패합니다.
2. **ACL 등록 누락** — 이 프로젝트는 커맨드를 `build.rs` 의 `APP_COMMANDS` 와
   `capabilities/default.json` 에 명시 등록해야 합니다. `main.rs` 만 고쳤다면 런타임에
   차단되어 기능이 통째로 동작하지 않습니다.
3. **교체 대상은 6곳이 아니라 11곳** — 드롭 업로드 판정과 Codex 로컬 폴백 3곳이 빠져 있었습니다.
   SSH 즐겨찾기 별(`app.js:8087`)만 의도적으로 남겼습니다.
4. **세션 목록 갱신 없음** — 지구본 아이콘과 라벨이 즉시 반영되지 않습니다.

추가로 넣은 것: 자동 채택이 실패하면 탐색기를 차단 화면에 두지 않고 로컬로 되돌리기,
`exit` 후 원래 로컬 경로 복원(`localCwdBeforeSsh`), 사용자가 요청하지 않은 자동 경로에서
모달·토스트 억제, `~/.ssh/config` 를 UTF-8 이 아니어도 읽도록 lossy 디코딩.

## 변경 파일

- `crates/mycli-desktop/src/explorer.rs` — `parse_ssh_command` · `resolve_ssh_alias` ·
  `resolve_target` · `ssh_resolve_command` + 테스트 10개
- `crates/mycli-desktop/src/main.rs` — 커맨드 등록
- `crates/mycli-desktop/build.rs`, `capabilities/default.json` — ACL 등록
- `crates/mycli-desktop/frontend/app.js` — `isRemotePane` · `adoptTypedSsh` ·
  `releaseTypedSsh` · 모달 sftpOnly 모드 · 가드 11곳 교체
- `crates/mycli-desktop/frontend/style.css` — 연결 버튼

## 검증

- `cargo test --workspace` — 64개 통과 (ssh 관련 10개 신규)
- `node --check crates/mycli-desktop/frontend/app.js` 통과
- `grep 'type === "ssh"'` → 헬퍼 자신과 즐겨찾기 별 2곳만 남음
- 실기: 디버그 빌드 + CDP 로 위 4단계 시나리오

## 남은 이슈

이 검증은 [#11](https://github.com/ChoiGyber/Mymux/issues/11) 수정을 함께 적용해야 성립합니다.
SFTP 커맨드가 런타임 중첩으로 패닉해 **모든 SFTP 연결이 "연결 중" 에서 멈춰 있었고**, 그
상태로는 이 이슈를 고쳐도 화면이 그대로입니다. 두 브랜치는 충돌 없이 자동 병합됨을
확인했습니다. **merge 순서는 #11 이 먼저입니다.**
