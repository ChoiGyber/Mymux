# 터미널에 직접 입력한 ssh를 탐색기가 따라가게 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 패인에서 `ssh user@host` 를 직접 입력해 접속해도 탐색기가 서버 디렉토리를 잡게 한다.

**Architecture:** 명령줄 파싱과 `~/.ssh/config` 별칭 해석을 Rust 커맨드 `ssh_resolve_command`
하나로 두고, `app.js` 는 Enter 시점의 값싼 정규식으로 거른 뒤에만 그것을 부른다. 해석에
성공하면 기존 `attachSftpToPane` 을 그대로 재사용한다. 흩어져 있던 `t.type === "ssh"`
검사는 `isRemotePane(t)` 헬퍼로 모아 감지된 접속도 같은 경로를 타게 한다.

**Tech Stack:** Rust (tauri command, `serde`), 바닐라 JS (`app.js`), `cargo test`

**설계 문서:** `docs/superpowers/specs/2026-08-12-adopt-typed-ssh-explorer-design.md`
**이슈:** [#7](https://github.com/ChoiGyber/Mymux/issues/7)

## Global Constraints

- 프런트엔드는 빌드 단계가 없는 바닐라 JS다. 모듈 시스템·번들러·npm 패키지를 도입하지 않는다.
- JS 테스트 러너가 없다. JS 변경의 검증은 `node --check` 와 실기 확인이다. 새로 만들지 않는다.
- Rust 테스트는 `#[cfg(test)] mod ...` 로 같은 파일 안에 둔다(`explorer.rs`, `terminal.rs` 의 기존 방식).
- 새 tauri 커맨드는 `src/main.rs` 의 `invoke_handler` 목록에 등록해야 호출된다.
- 사용자가 요청하지 않은 자동 동작이므로 실패는 조용히 넘어간다. 자동 경로에서 토스트를 띄우지 않는다.
- 기존 `+ SSH` 접속 경로(`doSshConnect`)의 동작을 바꾸지 않는다.

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/mycli-desktop/src/explorer.rs` | ssh 명령 파싱 + `~/.ssh/config` 해석 + 기존 SFTP | 추가 |
| `crates/mycli-desktop/src/main.rs` | 커맨드 등록 | 1줄 추가 |
| `crates/mycli-desktop/frontend/app.js` | 감지·연결·해제·원격 판정 | 수정 |

---

### Task 1: `ssh_resolve_command` — 명령줄 파싱

**Files:**
- Modify: `crates/mycli-desktop/src/explorer.rs` (파일 끝의 `#[cfg(test)] mod tests` 앞)

**Interfaces:**
- Produces: `pub struct SshTarget { host: String, port: u16, user: String, key_path: Option<String> }`
  (serde 로 `keyPath` 로 직렬화), `fn parse_ssh_command(command: &str) -> Option<ParsedSsh>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`explorer.rs` 의 기존 `#[cfg(test)] mod tests` 안이 아니라, 그 **앞에** 새 모듈을 만든다.

```rust
#[cfg(test)]
mod ssh_command_tests {
    use super::*;

    #[test]
    fn parses_the_common_shapes() {
        let p = parse_ssh_command("ssh me@10.0.0.5").unwrap();
        assert_eq!(p.host.as_deref(), Some("10.0.0.5"));
        assert_eq!(p.user.as_deref(), Some("me"));
        assert_eq!(p.port, None);

        let p = parse_ssh_command("ssh -p 2222 me@host").unwrap();
        assert_eq!(p.port, Some(2222));

        let p = parse_ssh_command("ssh me@host -p 2222").unwrap();
        assert_eq!(p.port, Some(2222));

        let p = parse_ssh_command("ssh -i ~/.ssh/id_ed25519 me@host").unwrap();
        assert_eq!(p.key_path.as_deref(), Some("~/.ssh/id_ed25519"));

        // -l 로 준 사용자명도 받는다.
        let p = parse_ssh_command("ssh -l me host.example.com").unwrap();
        assert_eq!(p.user.as_deref(), Some("me"));

        // 인자 없는 플래그는 그냥 지나간다.
        let p = parse_ssh_command("ssh -t -C me@host").unwrap();
        assert_eq!(p.host.as_deref(), Some("host"));
    }

    #[test]
    fn treats_a_bare_token_as_an_alias() {
        let p = parse_ssh_command("ssh 미니맥").unwrap();
        assert_eq!(p.alias.as_deref(), Some("미니맥"));
        assert_eq!(p.host, None);
    }

    #[test]
    fn rejects_what_is_not_an_interactive_login() {
        // 원격 명령이 붙으면 셸이 열리지 않는다.
        assert!(parse_ssh_command("ssh host uptime").is_none());
        // 우리가 다루는 명령이 아니다.
        assert!(parse_ssh_command("ssh-keygen -t ed25519").is_none());
        assert!(parse_ssh_command("sshpass -p x ssh me@host").is_none());
        assert!(parse_ssh_command("echo ssh me@host").is_none());
        // 대상이 없다.
        assert!(parse_ssh_command("ssh").is_none());
        assert!(parse_ssh_command("ssh -p 22").is_none());
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test -p mycli-desktop ssh_command_tests`
Expected: FAIL — `cannot find function parse_ssh_command`

- [ ] **Step 3: 파서를 구현한다**

`explorer.rs` 에 추가한다.

```rust
/// A pane's `ssh` command, split into what we need to open an SFTP session
/// beside it. `alias` is set when the target was a bare name that has to be
/// looked up in `~/.ssh/config`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedSsh {
    pub alias: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub key_path: Option<String>,
}

/// ssh options that consume the next argument. Everything else starting with
/// `-` is a flag we can skip. From ssh(1).
const SSH_OPTS_WITH_VALUE: &[char] = &[
    'B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'Q', 'R', 'S',
    'W', 'w',
];

/// Parse a command line the user typed at the prompt. Returns `None` for
/// anything that is not an interactive `ssh` login — a different program, a
/// remote command (no shell opens), or no target at all.
pub fn parse_ssh_command(command: &str) -> Option<ParsedSsh> {
    let mut tokens = command.split_whitespace();
    if tokens.next()? != "ssh" {
        return None;
    }

    let mut parsed = ParsedSsh::default();
    let mut target: Option<String> = None;
    let mut tokens = tokens.peekable();

    while let Some(token) = tokens.next() {
        if let Some(rest) = token.strip_prefix('-') {
            let Some(flag) = rest.chars().next() else {
                return None; // a lone "-"
            };
            if !SSH_OPTS_WITH_VALUE.contains(&flag) {
                continue; // -t, -C, -4 …
            }
            // The value is either glued on (-p2222) or the next token.
            let value = if rest.len() > 1 {
                rest[flag.len_utf8()..].to_string()
            } else {
                tokens.next()?.to_string()
            };
            match flag {
                'p' => parsed.port = value.parse().ok(),
                'i' => parsed.key_path = Some(value),
                'l' => parsed.user = Some(value),
                _ => {}
            }
            continue;
        }
        if target.is_some() {
            return None; // a remote command follows — no interactive shell
        }
        target = Some(token.to_string());
    }

    let target = target?;
    if let Some((user, host)) = target.split_once('@') {
        if user.is_empty() || host.is_empty() {
            return None;
        }
        parsed.user = Some(user.to_string());
        parsed.host = Some(host.to_string());
    } else if target.contains('.') || target.contains(':') {
        parsed.host = Some(target); // looks like a hostname or an address
    } else {
        parsed.alias = Some(target); // a name to look up in ~/.ssh/config
    }
    Some(parsed)
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test -p mycli-desktop ssh_command_tests`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/src/explorer.rs
git commit -m "feat(desktop): parse an ssh command line typed at the prompt"
```

---

### Task 2: `~/.ssh/config` 별칭 해석

**Files:**
- Modify: `crates/mycli-desktop/src/explorer.rs`

**Interfaces:**
- Consumes: `ParsedSsh` (Task 1)
- Produces: `fn resolve_ssh_alias(alias: &str, config: &str) -> Option<SshConfigEntry>`,
  `pub struct SshConfigEntry { host_name: Option<String>, user: Option<String>, port: Option<u16>, identity_file: Option<String> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`ssh_command_tests` 모듈 뒤에 새 모듈을 추가한다.

```rust
#[cfg(test)]
mod ssh_config_tests {
    use super::*;

    const CONFIG: &str = "\
Host 미니맥
  HostName 192.168.0.21
  User gyber
  Port 2222
  IdentityFile ~/.ssh/minimac

host BOX
  hostname box.internal

Host wild*
  HostName nope.example.com

Host jump
  HostName jump.example.com
  ProxyJump bastion
";

    #[test]
    fn reads_the_four_keys_we_support() {
        let e = resolve_ssh_alias("미니맥", CONFIG).unwrap();
        assert_eq!(e.host_name.as_deref(), Some("192.168.0.21"));
        assert_eq!(e.user.as_deref(), Some("gyber"));
        assert_eq!(e.port, Some(2222));
        assert_eq!(e.identity_file.as_deref(), Some("~/.ssh/minimac"));
    }

    #[test]
    fn keywords_are_case_insensitive() {
        // ssh itself does not care about the case of Host/HostName.
        let e = resolve_ssh_alias("BOX", CONFIG).unwrap();
        assert_eq!(e.host_name.as_deref(), Some("box.internal"));
    }

    #[test]
    fn gives_up_on_what_we_do_not_model() {
        // Not present at all.
        assert!(resolve_ssh_alias("missing", CONFIG).is_none());
        // A wildcard block is out of scope — we do not pattern-match.
        assert!(resolve_ssh_alias("wildcard", CONFIG).is_none());
        // ProxyJump means the real connection is not the one we would open.
        assert!(resolve_ssh_alias("jump", CONFIG).is_none());
        // An Include we cannot follow makes the whole file unreliable.
        assert!(resolve_ssh_alias("미니맥", "Include other\nHost 미니맥\n  HostName x\n").is_none());
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test -p mycli-desktop ssh_config_tests`
Expected: FAIL — `cannot find function resolve_ssh_alias`

- [ ] **Step 3: 해석기를 구현한다**

```rust
/// The subset of `~/.ssh/config` we model. Anything else in the file is
/// ignored; anything we cannot model correctly makes us give up entirely.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SshConfigEntry {
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Look `alias` up in the contents of an ssh config file.
///
/// Only an exact `Host <alias>` block counts — we deliberately do not
/// implement ssh's pattern matching, so a wildcard block never applies. An
/// `Include` anywhere means the file we were given is incomplete, and a
/// `ProxyJump` in the matched block means the connection we would open is not
/// the one the terminal made. Both return `None` so the caller stays quiet.
pub fn resolve_ssh_alias(alias: &str, config: &str) -> Option<SshConfigEntry> {
    let mut entry: Option<SshConfigEntry> = None;
    let mut in_block = false;

    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A keyword with no value is malformed; skip that line rather than
        // abandoning the whole file.
        let Some((keyword, value)) = line.split_once(|c: char| c.is_whitespace() || c == '=')
        else {
            continue;
        };
        let keyword = keyword.to_ascii_lowercase();
        let value = value.trim_start_matches(['=', ' ', '\t']).trim();

        if keyword == "include" {
            return None; // we cannot see the rest of the configuration
        }
        if keyword == "host" {
            in_block = value.split_whitespace().any(|pattern| pattern == alias);
            if in_block {
                entry = Some(SshConfigEntry::default());
            }
            continue;
        }
        if keyword == "match" {
            in_block = false;
            continue;
        }
        if !in_block {
            continue;
        }
        let Some(current) = entry.as_mut() else { continue };
        match keyword.as_str() {
            "hostname" => current.host_name = Some(value.to_string()),
            "user" => current.user = Some(value.to_string()),
            "port" => current.port = value.parse().ok(),
            "identityfile" => current.identity_file = Some(value.to_string()),
            "proxyjump" => return None, // not the connection we would open
            _ => {}
        }
    }
    entry
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test -p mycli-desktop ssh_config_tests`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/src/explorer.rs
git commit -m "feat(desktop): resolve an ssh config alias to a host, port and key"
```

---

### Task 3: 커맨드로 노출하고 등록

**Files:**
- Modify: `crates/mycli-desktop/src/explorer.rs`
- Modify: `crates/mycli-desktop/src/main.rs:82` 부근 (`explorer::sftp_disconnect,` 다음 줄)

**Interfaces:**
- Consumes: `parse_ssh_command` (Task 1), `resolve_ssh_alias` (Task 2)
- Produces: tauri 커맨드 `ssh_resolve_command(command: String) -> Option<SshTarget>`.
  JS 에서 `{ host, port, user, keyPath }` 로 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[cfg(test)]
mod ssh_target_tests {
    use super::*;

    #[test]
    fn fills_defaults_and_prefers_the_command_line() {
        let config = "Host box\n  HostName box.internal\n  User configuser\n  Port 2222\n";

        // 별칭은 config 에서 전부 가져온다.
        let t = resolve_target(parse_ssh_command("ssh box").unwrap(), config, "osuser").unwrap();
        assert_eq!(t.host, "box.internal");
        assert_eq!(t.user, "configuser");
        assert_eq!(t.port, 2222);

        // 명령줄이 config 를 이긴다.
        let parsed = parse_ssh_command("ssh -p 2200 me@box").unwrap();
        let t = resolve_target(parsed, config, "osuser").unwrap();
        assert_eq!(t.host, "box");
        assert_eq!(t.user, "me");
        assert_eq!(t.port, 2200);

        // 아무 데도 없으면 포트 22, OS 사용자명.
        let t = resolve_target(parse_ssh_command("ssh host.example.com").unwrap(), "", "osuser")
            .unwrap();
        assert_eq!(t.port, 22);
        assert_eq!(t.user, "osuser");
    }

    #[test]
    fn an_unresolvable_alias_yields_nothing() {
        let parsed = parse_ssh_command("ssh unknown").unwrap();
        assert!(resolve_target(parsed, "", "osuser").is_none());
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test -p mycli-desktop ssh_target_tests`
Expected: FAIL — `cannot find function resolve_target`

- [ ] **Step 3: 구현하고 커맨드로 노출한다**

```rust
/// Everything `sftp_connect` needs, derived from a typed ssh command.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: Option<String>,
}

/// Merge a parsed command line with `~/.ssh/config`. The command line wins —
/// that is what ssh itself does — and anything still missing falls back to
/// ssh's defaults (port 22, the current OS user).
fn resolve_target(parsed: ParsedSsh, config: &str, os_user: &str) -> Option<SshTarget> {
    let entry = match parsed.alias.as_deref() {
        Some(alias) => Some(resolve_ssh_alias(alias, config)?),
        None => None,
    };
    let from_config = |pick: fn(&SshConfigEntry) -> Option<String>| {
        entry.as_ref().and_then(pick)
    };

    let host = parsed
        .host
        .or_else(|| from_config(|e| e.host_name.clone()))
        // `Host box` with no HostName means the alias IS the hostname.
        .or_else(|| parsed.alias.clone())?;
    let port = parsed
        .port
        .or_else(|| entry.as_ref().and_then(|e| e.port))
        .unwrap_or(22);
    let user = parsed
        .user
        .or_else(|| from_config(|e| e.user.clone()))
        .unwrap_or_else(|| os_user.to_string());
    let key_path = parsed
        .key_path
        .or_else(|| from_config(|e| e.identity_file.clone()))
        .map(|path| expand_home(&path));

    Some(SshTarget { host, port, user, key_path })
}

/// `~/x` → `<home>/x`. Left alone when the home directory is unknown.
fn expand_home(path: &str) -> String {
    let Some(rest) = path.strip_prefix("~/") else {
        return path.to_string();
    };
    match dirs::home_dir() {
        Some(home) => home.join(rest).to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

/// Work out what a pane's typed `ssh` command connects to, so the Explorer can
/// open an SFTP session beside it. Returns `None` for anything we do not
/// model — the caller then stays quiet, because the user never asked for this.
#[tauri::command]
pub fn ssh_resolve_command(command: String) -> Option<SshTarget> {
    let parsed = parse_ssh_command(&command)?;
    let config = dirs::home_dir()
        .map(|home| home.join(".ssh").join("config"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let os_user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    resolve_target(parsed, &config, &os_user)
}
```

`src/main.rs` 의 `invoke_handler` 목록에서 `explorer::sftp_disconnect,` 다음 줄에 추가한다.

```rust
            explorer::ssh_resolve_command,
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test -p mycli-desktop ssh_` — Task 1·2·3 의 8개 테스트가 모두 돈다
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/src/explorer.rs crates/mycli-desktop/src/main.rs
git commit -m "feat(desktop): expose ssh_resolve_command to the front end"
```

---

### Task 4: `isRemotePane` 로 원격 판정 모으기

동작을 바꾸지 않는 정리 단계다. `adoptedSsh` 는 아직 아무도 설정하지 않으므로
이 태스크만 적용하면 기존과 완전히 동일하게 동작해야 한다. 그래야 다음 태스크에서
문제가 생겼을 때 원인이 이 정리인지 아닌지 가릴 수 있다.

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` (6곳 + 헬퍼 1개)

**Interfaces:**
- Produces: `isRemotePane(t)` — `app.js` 안에서만 쓰는 헬퍼

- [ ] **Step 1: 헬퍼를 추가한다**

`attachSftpToPane` (약 5952행) 바로 앞에 둔다.

```js
// A pane is "remote" when its shell lives on another machine — either because
// Mymux opened the SSH session itself (type "ssh") or because the user typed
// `ssh …` at the prompt and we adopted it (adoptedSsh). The Explorer, the cd
// sync and the shell-syntax choice all key off this.
function isRemotePane(t) {
  return t?.type === "ssh" || t?.adoptedSsh != null;
}
```

- [ ] **Step 2: 여섯 곳을 교체한다**

각각 아래 왼쪽을 오른쪽으로 바꾼다. `7925`(SSH 즐겨찾기 별)는 **건드리지 않는다** —
감지된 접속은 인증 수단이 확실하지 않아 즐겨찾기로 저장하면 재접속이 실패한다.

| 위치 | 지금 | 바꾼 뒤 |
|---|---|---|
| `attachSftpToPane` | `if (!t \|\| t.type !== "ssh") return null;` | `if (!t \|\| !isRemotePane(t)) return null;` |
| `showExplorerForSession` | `if (t.type === "ssh") {` | `if (isRemotePane(t)) {` |
| `syncExplorerOnCd` | `if (t && t.type === "ssh") {` | `if (t && isRemotePane(t)) {` |
| `paneShellKind` | `if (t.type === "ssh") return "posix";` | `if (isRemotePane(t)) return "posix";` |
| `applyCodexSessionSnapshot` | `if (tt.type === "ssh" \|\| pid !== codexSnapshotPaneId) continue;` | `if (isRemotePane(tt) \|\| pid !== codexSnapshotPaneId) continue;` |
| 세션 목록 아이콘 | `const dot = t.type === "ssh" ? ICON.globe : "▸";` | `const dot = isRemotePane(t) ? ICON.globe : "▸";` |

- [ ] **Step 3: 문법과 누락을 확인한다**

```bash
node --check crates/mycli-desktop/frontend/app.js
grep -n 'type === "ssh"\|type !== "ssh"' crates/mycli-desktop/frontend/app.js
```

Expected: `node --check` 무출력(통과). grep 결과는 **`7925` 근처 한 줄만** 남는다
(SSH 즐겨찾기 별 — 의도적으로 남긴 것).

- [ ] **Step 4: 기존 경로가 그대로인지 확인한다**

디버그 빌드를 띄워 툴바 **+ SSH** 로 접속하고 확인한다.

```bash
cargo run -p mycli-desktop
```

- 탐색기 드롭다운에 `SSH: <host>` 가 뜨고 서버 디렉토리가 보인다
- 원격 패인에서 `cd /tmp` 를 치면 탐색기가 따라간다
- 세션 목록에 지구본 아이콘이 그대로 보인다

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/frontend/app.js
git commit -m "refactor(desktop): decide 'is this pane remote' in one place"
```

---

### Task 5: 타이핑한 ssh 를 감지해 SFTP 를 붙인다

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` — `handleTerminalInput` 의 Enter 처리(약 8863행)와
  새 함수 하나

**Interfaces:**
- Consumes: `ssh_resolve_command` (Task 3), `isRemotePane` (Task 4), 기존 `attachSftpToPane`
- Produces: `adoptTypedSsh(typed, ptyId)`, 패인 상태 `t.adoptedSsh = { host, port, user, keyPath }`

- [ ] **Step 1: 감지 함수를 추가한다**

`isRemotePane` 헬퍼 아래에 둔다.

```js
// The user typed `ssh …` at a local prompt. Mymux did not open that session,
// so nothing has attached SFTP to it and the Explorer is still showing the
// local disk. Work out what the command connects to and open an SFTP session
// beside it, exactly as `+ SSH` would have.
//
// This is not something the user asked for, so it stays quiet: a command we
// cannot resolve, or a connection we cannot make, simply leaves the pane local.
async function adoptTypedSsh(typed, ptyId) {
  const t = terminals.get(ptyId);
  if (!t || isRemotePane(t)) return; // already remote — nothing to adopt
  let target = null;
  try {
    target = await invoke("ssh_resolve_command", { command: typed });
  } catch {
    return;
  }
  if (!target) return;
  const live = terminals.get(ptyId);
  if (!live || isRemotePane(live)) return; // the pane changed while we asked
  live.adoptedSsh = target;
  live.sshTarget = `${target.user}@${target.host}`;
  if (!target.keyPath) {
    // Password auth: SFTP is a separate connection and cannot reuse whatever
    // the terminal just authenticated with. Offer the connection instead.
    live.sftpStatus = "needs-password";
    if (focusedPaneId === ptyId) showExplorerBlockedForSession(ptyId, live);
    return;
  }
  await attachSftpToPane(
    ptyId,
    { host: target.host, port: target.port, username: target.user, keyPath: target.keyPath },
    false, // announce=false — the user did not ask for this
  );
  if (focusedPaneId === ptyId) showExplorerForSession(ptyId);
}
```

- [ ] **Step 2: Enter 처리에 연결한다**

`handleTerminalInput` 의 `syncExplorerOnCd(typed, ptyId);` 바로 아래에 넣는다.

```js
    // `ssh …` typed at a local prompt — adopt it so the Explorer follows.
    if (/^ssh\s/.test(typed)) adoptTypedSsh(typed, ptyId);
```

- [ ] **Step 3: 문법을 확인한다**

```bash
node --check crates/mycli-desktop/frontend/app.js
```

Expected: 무출력

- [ ] **Step 4: 실기로 확인한다**

```bash
cargo run -p mycli-desktop
```

키 인증이 되는 서버에 패인에서 직접 접속해 확인한다.

- `ssh user@host` → 탐색기 드롭다운에 `SSH: <host>` 가 생기고 서버 디렉토리가 보인다
- `ssh -p <포트> user@host` 도 같다
- `~/.ssh/config` 별칭으로도 같다
- `ssh host uptime` 은 아무 일도 일어나지 않는다
- 없는 호스트로 접속을 시도해도 토스트가 뜨지 않는다

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/frontend/app.js
git commit -m "feat(desktop): adopt an ssh session the user typed at the prompt"
```

---

### Task 6: 비밀번호 인증일 때 연결 버튼

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` — `showExplorerBlockedForSession` (8053행)

**Interfaces:**
- Consumes: `t.sftpStatus === "needs-password"`, `t.adoptedSsh` (Task 5)
- Produces: 없음 (UI 만)

- [ ] **Step 1: 차단 화면에 상태와 버튼을 더한다**

`showExplorerBlockedForSession` 의 `status` 삼항 연산에 한 갈래를 넣고,

```js
  const status = terminal?.sftpStatus === "connecting"
    ? "SFTP 연결 중…"
    : terminal?.sftpStatus === "unsupported"
      ? "SFTP 미지원"
      : terminal?.sftpStatus === "needs-password"
        ? "비밀번호 필요"
        : "SFTP 연결 안 됨";
```

`fileListEl.appendChild(item);` 다음에 버튼을 추가한다.

```js
    // A pane whose ssh command we adopted, but which authenticates with a
    // password we do not have. One click opens the existing SSH modal so the
    // user can type it once.
    if (terminal?.sftpStatus === "needs-password" && terminal.adoptedSsh) {
      const { host, port, user } = terminal.adoptedSsh;
      const connect = document.createElement("li");
      const button = document.createElement("button");
      button.className = "explorer-connect-remote";
      button.textContent = `${host} 열기`;
      button.title = "이 서버의 파일을 보려면 비밀번호가 한 번 필요합니다";
      button.addEventListener("click", () => {
        openSshModal({ host, port, username: user, forPaneId: ptyId });
      });
      connect.appendChild(button);
      fileListEl.appendChild(connect);
    }
```

`style.css` 의 `.explorer-blocked-message` 규칙 옆에 버튼 스타일을 둔다.

```css
.explorer-connect-remote {
  margin: 8px 12px;
  padding: 4px 10px;
  font: inherit;
  cursor: pointer;
}
```

- [ ] **Step 2: 모달이 새 탭 대신 이 패인에 붙도록 한다**

`openSshModal()` 은 지금 인자를 받지 않고(5692행), 제출은 항상 `connectSshFields` →
`doSshConnect` 로 이어져 **새 탭을 연다**(5712행). 이미 접속된 패인에는 SFTP 만 필요하므로
모달에 한 가지 모드를 더한다.

**함정:** `openSshModal` 은 `app.js:448` 에서 클릭 리스너로 **직접** 등록되어 있다
(`btnSsh.addEventListener("click", openSshModal)`). 인자를 추가하면 첫 인자로 클릭
이벤트가 들어오므로, 그 등록을 먼저 `() => openSshModal()` 로 바꾼다.

```js
// app.js:448 — 이벤트 객체가 prefill 로 새어 들어오지 않게 감싼다
if (btnSsh) btnSsh.addEventListener("click", () => openSshModal());
```

모달 상태를 하나 둔다. `openSshModal` 위에 선언한다.

```js
// When set, the SSH modal is not opening a new session — it is collecting the
// password for a pane whose ssh command we already adopted.
let sshModalSftpOnlyPaneId = null;
```

`openSshModal` 을 prefill 을 받도록 고친다.

```js
function openSshModal(prefill = null) {
  const m = document.getElementById("ssh-modal");
  if (!m) return;
  // The native browser overlay floats above all HTML; hide it so the modal shows.
  if (browserTabActive && browserMode === "native") invoke("browser_pane_hide").catch(() => {});
  sshModalSftpOnlyPaneId = prefill?.forPaneId ?? null;
  if (prefill) {
    const addr = document.getElementById("ssh-modal-input");
    const port = document.getElementById("ssh-modal-port");
    if (addr) addr.value = `${prefill.username}@${prefill.host}`;
    if (port) port.value = String(prefill.port);
  }
  m.classList.remove("hidden");
  const pw = document.getElementById("ssh-modal-password");
  const inp = prefill ? pw : document.getElementById("ssh-modal-input");
  if (inp) inp.focus(); // password first when we already know the address
}
```

`closeSshModal` 의 끝에 초기화를 넣는다.

```js
  sshModalSftpOnlyPaneId = null;
```

`submitSshModal` 의 맨 앞에 분기를 넣는다.

```js
async function submitSshModal() {
  const password = document.getElementById("ssh-modal-password").value;
  // Adopted pane: the shell is already connected, so attach SFTP to it
  // instead of opening another session in a new tab.
  if (sshModalSftpOnlyPaneId != null) {
    const paneId = sshModalSftpOnlyPaneId;
    const target = terminals.get(paneId)?.adoptedSsh;
    if (!target) { closeSshModal(); return; }
    const sftpId = await attachSftpToPane(
      paneId,
      { host: target.host, port: target.port, username: target.user, password, keyPath: target.keyPath },
      true,
    );
    if (sftpId != null) {
      if (focusedPaneId === paneId) showExplorerForSession(paneId);
      closeSshModal();
    }
    return;
  }
  const target = document.getElementById("ssh-modal-input").value;
  // …기존 경로 그대로…
```

기존 경로의 `const password = …` 선언은 위로 올라갔으므로 중복 선언을 지운다.

- [ ] **Step 3: 문법을 확인한다**

```bash
node --check crates/mycli-desktop/frontend/app.js
```

- [ ] **Step 4: 실기로 확인한다**

비밀번호 인증 서버에 패인에서 직접 접속한다.

- 탐색기에 `비밀번호 필요` 와 `<host> 열기` 버튼이 보인다
- 버튼을 누르면 SSH 모달이 뜨고, 호스트·포트·사용자가 채워져 있다
- 비번을 넣으면 **새 탭이 열리지 않고** 현재 패인의 탐색기가 서버를 보여준다

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/frontend/app.js
git commit -m "feat(desktop): offer a one-click SFTP connect when ssh used a password"
```

---

### Task 7: 서버에서 나오면 로컬로 되돌리기

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` — `handleTerminalInput`

**Interfaces:**
- Consumes: `t.adoptedSsh` (Task 5), 기존 `detachPaneSftp`

- [ ] **Step 1: 해제 함수를 추가한다**

`adoptTypedSsh` 아래에 둔다.

```js
// The adopted session ended. Drop the SFTP connection with it so the Explorer
// goes back to the local disk instead of showing a server the shell already
// left. A disconnect we miss (the server hanging up, say) is not fatal — the
// Explorer's source dropdown still switches back by hand.
function releaseTypedSsh(ptyId) {
  const t = terminals.get(ptyId);
  if (!t?.adoptedSsh) return;
  t.adoptedSsh = null;
  t.sshTarget = null;
  t.sftpStatus = null;
  t.remotePath = null;
  detachPaneSftp(ptyId);
  if (focusedPaneId === ptyId) showExplorerForSession(ptyId);
}
```

- [ ] **Step 2: `exit` 과 Ctrl+D 에 연결한다**

Enter 처리에서 Task 5 의 감지 바로 아래에 둔다.

```js
    if (/^(exit|logout)$/i.test(typed)) releaseTypedSsh(ptyId);
```

`handleTerminalInput` 이 원시 데이터를 받는 지점(함수 앞부분, Enter 분기보다 위)에서
Ctrl+D 를 본다.

```js
  // Ctrl+D at an empty prompt ends the shell — for an adopted pane that means
  // the ssh session is over.
  if (data === "\x04" && !getInput()) releaseTypedSsh(ptyId);
```

- [ ] **Step 3: 문법을 확인한다**

```bash
node --check crates/mycli-desktop/frontend/app.js
```

- [ ] **Step 4: 실기로 확인한다**

- `ssh user@host` 로 붙은 뒤 `exit` → 탐색기가 로컬로 돌아온다
- 다시 `ssh user@host` → 다시 서버가 보인다
- Ctrl+D 로 나와도 같다
- **+ SSH 로 연 세션에서 `exit` 을 쳐도 그 세션의 SFTP 는 그대로다**
  (`adoptedSsh` 가 없으므로 `releaseTypedSsh` 는 아무것도 하지 않는다)

- [ ] **Step 5: 커밋**

```bash
git add crates/mycli-desktop/frontend/app.js
git commit -m "feat(desktop): drop the adopted SFTP session when the shell leaves"
```

---

### Task 8: 전체 검증과 이슈 완료 기준 대조

**Files:** 없음 (검증만)

- [ ] **Step 1: 워크스페이스 전체 테스트**

```bash
cargo test --workspace
node --check crates/mycli-desktop/frontend/app.js
```

Expected: 전부 통과. ssh 관련 8개 테스트가 목록에 보인다.

- [ ] **Step 2: 이슈 #7 의 완료 기준을 하나씩 확인한다**

디버그 빌드에서 7개 항목을 직접 확인하고, 각각 되는지 기록한다.
`+ SSH` 경로가 그대로인지(마지막 항목)를 반드시 포함한다.

- [ ] **Step 3: 회귀 확인**

- 로컬 패인에서 `cd` 를 치면 탐색기가 따라간다(원격 아님)
- 로컬 패인에서 명령 재실행·별칭 콤보가 그대로 동작한다
- codex 패인의 사용량 배지가 그대로 보인다

- [ ] **Step 4: 커밋 (필요한 경우)**

검증 중 고친 것이 있으면 그 태스크의 커밋 메시지 규칙을 따른다.
