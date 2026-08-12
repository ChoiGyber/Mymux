# 터미널에 직접 입력한 ssh를 탐색기가 따라가게 하기

## 목적

Mymux는 자기가 띄운 SSH 세션만 원격으로 인식한다. 툴바 `+ SSH`/즐겨찾기로 접속하면
`createPane(..., "ssh", ...)` 로 패인 타입이 `ssh` 가 되고 곧바로 `attachSftpToPane` 이
SFTP를 붙이지만(`app.js` `doSshConnect`), 사용자가 패인에서 `ssh user@host` 를 **직접 타이핑**하면
앱 입장에선 그냥 로컬 셸이라 SFTP 연결 시도 자체가 없다. 그래서 탐색기 소스 드롭다운에
`SSH: <host>` 항목이 생기지 않고 서버 디렉토리를 볼 수 없다.

직접 입력한 `ssh` 도 감지해서, `+ SSH` 로 접속했을 때와 같은 경험을 준다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 감지 후 동작 | **자동 연결 시도.** 키 인증이면 조용히 붙고, 비번이 필요하면 탐색기에 버튼만 노출 |
| 지원 형태 | `ssh [-p N] [-i key] [user@]host` **와** `~/.ssh/config` 별칭 둘 다 |
| 종료 처리 | `exit`·Ctrl+D 감지 시 SFTP 해제하고 탐색기를 로컬로 되돌림 |
| 원격 판정 | 흩어진 `t.type === "ssh"` 검사를 `isRemotePane(t)` 헬퍼로 모음 |

## 감지 (프런트엔드)

`handleTerminalInput` 의 Enter 처리 지점 — 이미 `syncExplorerOnCd(typed, ptyId)` 와
alias 처리가 있는 그 자리 — 에 `ssh` 파싱을 추가한다. 새 입력 추적 장치는 필요 없다.

```js
// typed 예: "ssh me@10.0.0.5 -p 2222", "ssh -i ~/.ssh/id_ed25519 me@host", "ssh 미니맥"
parseSshCommand(typed) -> { alias } | { user, host, port, keyPath } | null
```

파싱 규칙:

- 첫 토큰이 정확히 `ssh` 일 때만 대상으로 본다. `sshpass`, `ssh-keygen` 등은 제외.
- `-p <N>` → port, `-i <path>` → keyPath, `[user@]host` → user/host.
- 그 외 옵션(`-t`, `-L` 등)은 무시하고 넘어간다.
- 호스트 뒤에 원격 명령이 붙은 형태(`ssh host uptime`)는 셸이 열리지 않으므로 **제외한다.**
- `@` 도 `.` 도 없는 단일 토큰은 별칭 후보로 보고 해석 단계로 넘긴다.

## 해석 (백엔드, 신규)

`~/.ssh/config` 파서는 현재 저장소에 없다. `crates/mycli-desktop/src/explorer.rs` 에 추가한다.

```rust
#[tauri::command]
pub fn ssh_resolve_target(alias: String) -> Result<SshTarget, String>
// SshTarget { host, port, user, key_path }
```

- `Host <이름>` 블록에서 `HostName`·`User`·`Port`·`IdentityFile` 네 키만 읽는다.
- 키 이름은 대소문자를 가리지 않는다(ssh 자체 동작과 동일).
- `~` 는 홈 디렉터리로 펼친다.
- **범위 밖:** `Include`, 와일드카드 `Host *`, `ProxyJump`, `Match`. 해당 블록에 걸리면
  해석 실패로 반환하고 호출부는 조용히 포기한다.

## 연결

기존 `attachSftpToPane(ptyId, credentials, announce)` 를 그대로 쓴다. 다만 지금은
`t.type !== "ssh"` 면 즉시 return 하므로(`app.js:5954`) 가드를 `isRemotePane` 기준으로 바꾼다.

- **키 인증**(명령에 `-i` 가 있거나 config 에 `IdentityFile` 이 있음) → 자동 연결, `announce=false`.
- **비밀번호 인증** → SFTP는 별개 연결이라 터미널의 인증을 재사용할 수 없다. 자동 연결하지 않고
  기존 `showExplorerBlockedForSession` 의 안내 영역에 "이 서버 열기" 버튼을 얹는다(차단 화면을
  그리는 함수가 이미 있으므로 새 UI를 만들지 않는다). 누르면 기존 SSH 모달의 비번 입력 경로를 재사용한다.

터미널 접속의 성공 여부는 기다리지 않는다. SFTP는 같은 호스트에 같은 자격증명으로 붙으므로,
터미널이 실패할 상황이면 SFTP도 실패해서 조용히 포기하는 쪽으로 수렴한다. 반대로 SFTP가 붙었다면
그 호스트는 살아 있고 인증도 통과한 것이다.
- 자동 시도가 실패하면 **토스트를 띄우지 않는다.** 사용자가 요청한 적 없는 동작이므로 조용히 넘어가고,
  드롭다운에 항목이 안 생기는 것으로 충분하다. 버튼을 눌러 명시적으로 시도했을 때만 실패 사유를 보여준다.

## 원격 판정 일원화

```js
function isRemotePane(t) {
  return t?.type === "ssh" || t?.adoptedSsh != null;
}
```

감지 성공 시 `t.adoptedSsh = { host, port, user, keyPath }`, 종료 시 `null`.

교체하는 곳:

| 위치 | 하는 일 | 교체 |
|---|---|---|
| `app.js:5954` | `attachSftpToPane` 가드 | O |
| `app.js:8017` | `showExplorerForSession` — 탐색기 진입 분기 | O |
| `app.js:9108` | `syncExplorerOnCd` — 원격 `cd` 동기화 | O |
| `app.js:7279` | `paneShellKind` — 원격은 posix 문법 | O |
| `app.js:4262` | codex 스냅샷에서 원격 패인 제외 | O |
| `app.js:7880` | 세션 목록 지구본 아이콘 | O |
| `app.js:7925` | SSH 즐겨찾기 별 버튼 | **X** |

`7925` 를 제외하는 이유: 즐겨찾기는 재접속용인데 감지된 접속은 인증 수단이 확실하지 않다.
비번 인증을 즐겨찾기로 저장하면 원클릭 재접속이 실패한다.

## 종료 처리

같은 Enter 지점에서 `exit`/`logout` 을, `handleTerminalInput` 의 제어문자 경로에서 Ctrl+D(`\x04`)를
본다. `adoptedSsh` 가 있는 패인에서 감지되면 `detachPaneSftp(ptyId)` + `t.adoptedSsh = null` +
탐색기를 로컬로 되돌린다.

서버 쪽에서 끊긴 경우 등은 놓칠 수 있다. 그 상태로 남아도 탐색기 드롭다운에서 로컬을 직접
고를 수 있으므로 치명적이지 않다. 완전한 감지를 위해 프롬프트를 추적하거나 프로세스 트리를
조회하지는 않는다.

## 테스트

- `parseSshCommand` — 형태별 파싱(user@host, `-p`, `-i`, 별칭, 원격 명령 붙은 형태 제외,
  `ssh-keygen` 같은 오탐 제외)
- `ssh_resolve_target` — Rust 단위 테스트. 별칭 해석, 대소문자 무시, `~` 펼침,
  와일드카드/Include 블록은 실패 반환
- `isRemotePane` — 세 상태(로컬 / `type==="ssh"` / `adoptedSsh`)

실제 SFTP 연결은 `explorer.rs` 의 기존 e2e 테스트가 덮는다.

## 범위 밖

- 중첩 ssh (원격 셸에서 또 `ssh`)
- `ProxyJump`, `Include`, 와일드카드 `Host` 패턴
- 비밀번호 저장
- 감지된 접속을 SSH 즐겨찾기로 저장
