## 작업 요약

SFTP 커맨드 9개를 `async fn` 으로 바꾸고 자체 tokio 런타임의 `block_on` 을 `.await` 로
내렸습니다. Tauri 가 이미 런타임을 제공하므로 `ExplorerManager` 가 런타임을 따로 들고
`block_on` 할 이유가 없었고, 그 중첩이 워커 스레드 패닉의 원인이었습니다.

## 무엇이 잘못돼 있었나

| 지표 | 전 | 후 |
| --- | ---: | ---: |
| `sftp_connect` 응답 | 180초 타임아웃까지 **무응답** | **914ms** |
| 사용자에게 전달되는 오류 | 없음 (영구 "SFTP 연결 중…") | 실패 사유가 그대로 전달됨 |
| 영향받은 커맨드 | 9개 전부 | 0개 |

패닉한 Tauri 커맨드의 Promise 는 resolve 도 reject 도 되지 않습니다. 그래서 프런트엔드는
실패를 알아챌 방법이 없었고, 증상이 "느리다" 로 보였지만 실제로는 이미 죽어 있었습니다.

```
thread 'tokio-rt-worker' panicked at tokio-1.50.0/src/runtime/scheduler/multi_thread/mod.rs:88:9:
Cannot start a runtime from within a runtime. This happens because a function
(like `block_on`) attempted to block the current thread while the thread is
being used to drive asynchronous tasks.
```

원본: `.issue/11/evidence/before/panic.txt`, `before/timing.txt`

## 서버·russh 는 문제가 아니었다

같은 서버·같은 키로 러시아 raw 단계를 그대로 밟는 프로브(`examples/sftp_probe.rs`)를 만들어
확인했습니다. 전 단계가 1초 안에 끝납니다.

```
1 client::connect           ok       0.06s
2 load_secret_key           ok       0.00s
3 authenticate_publickey    ok       0.12s
   authenticated
4 channel_open_session      ok       0.65s
5 request_subsystem(sftp)   ok       0.00s
6 SftpSession::new          ok       0.03s
7 canonicalize(.)           ok       0.01s

원격 홈: /root
```

OpenSSH 클라이언트로도 즉시 붙습니다 (`sftp` → `Remote working directory: /root`).
이 프로브는 다음에 같은 증상이 나왔을 때 "앱이 문제인가 서버가 문제인가" 를 한 번에
가르려고 남겨 둡니다.

## 수정 후 실측

```
invoke("sftp_connect")  →  invoke("sftp_home_dir")  →  invoke("sftp_list_dir")
{"ok":true,"id":1,"home":"/root","fileCount":30,"ms":914}
목록: [D] .bun  [D] .cache  [D] .claude  [D] .codex  [D] .config  [D] .local
```

원본: `.issue/11/evidence/after/timing.txt`, `after/probe.txt`

## 함께 고친 것

인증 실패 사유를 삼키지 않고 전달하게 했습니다. 전에는 키 파일이 없든, 암호가 걸렸든,
서버가 거부했든 똑같이 `"No valid key found in ~/.ssh/ and no password provided"` 만
나왔습니다. 실제로 이 수정 덕분에 검증 중 경로가 깨져 전달된 것을 즉시 발견했습니다.

```
Authentication failed. C:\…\id_ed25519_clp: cannot read key (지정된 파일을 찾을 수 없습니다);
id_ed25519: server rejected the key
```

`upload_local_entry` 의 박싱된 재귀 future 에 `Send` 바운드를 더했습니다. 업로드 커맨드가
async 커맨드가 되면서 future 전체가 스레드를 넘나들어야 하는데, 이 바운드가 없으면
호출부가 조용히 non-`Send` 가 되어 컴파일이 막힙니다.

## 변경 파일

- `crates/mycli-desktop/src/explorer.rs` — 커맨드 9개 async 화, 인증 사유 수집, `Send` 바운드
- `crates/mycli-desktop/examples/sftp_probe.rs` — 단계별 계측 프로브 (신규)

## 검증

- `cargo test --workspace` — 54개 통과
- `cargo clippy -p mycli-desktop` — 경고 19 → 18 (늘지 않음)
- 실기: 디버그 빌드에서 connect → home → list 왕복, 앱 로그에 패닉 없음

## 남은 이슈

[#7](https://github.com/ChoiGyber/Mymux/issues/7) 이 이 수정에 의존합니다. 두 브랜치는 충돌
없이 자동 병합됨을 확인했고, **merge 순서는 이 이슈가 먼저입니다.**
