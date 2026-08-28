## 작업 리포트 — #36

브랜치 `fix/36-vendor-tao-keyboard-deadlock`, 커밋 `15653f1` + `9a2b0bd`.

화면이 바뀌는 이슈가 아니라 네이티브 데드락이라 스크린샷 대신 **멈춘 프로세스의 실측
데이터**와 **회귀 테스트 전후**를 증거로 남긴다.

---

### before — 실제로 멈춘 프로세스

`Mymux.exe` v0.1.59 (PID 21236) 을 끄기 전에 전체 메모리 덤프를 떠서 확인했다.

```
Responding        : False
CPU delta over 4s : 0 ms          ← 무한 루프가 아니다. 아무도 안 돌고 있다
Threads           : 42, 전부 Wait
```

메인 스레드만 다르고 나머지는 전부 정상 유휴다(PTY 리더 5, 자식 대기 5, tokio 워커 park,
WebView2 UI/IPC).

```
TID 20120  RIP = ntdll!ZwWaitForAlertByThreadId+0x14
                 ← ntdll!RtlWaitOnAddress+0x213
                 ← KERNELBASE!WaitOnAddress+0x38        ← parking_lot futex 경로

기다리는 대상 : Mymux.exe+0x1685e40  (바이너리 안의 전역 static)
그 자리의 값  : 0x03 = parking_lot RawMutex 의 LOCKED_BIT | PARKED_BIT
파킹된 스레드 : 메인 스레드 하나뿐    ← 자기가 쥔 락을 자기가 기다린다
```

콜스택(바깥 → 안쪽). `+0x71xxxx`, `+0x660dd4`, `+0xc43xxx` 가 **두 번** 나온다.

```
tao 이벤트 루프 → GetMessageW / DispatchMessageW
  user32!CallWindowProcW
    msctf!TF_Notify → CtfImeDispatchDefImeMessage        ← 한글 IME (TSF)
      Mymux+0x7160f5 / +0x660dd4 / +0x71575a            ← tao wndproc #1
        Mymux+0xc43034                                   ← 전역 락 획득 (성공)
          textinputframework!InputFocusChanged           ← 포커스 전환
            user32!PeekMessageW                          ← 중첩 메시지 펌프
              user32!SendMessageW → CallWindowProcW
                Mymux+0x717630 / +0x660dd4 / +0x716529   ← tao wndproc #2 (재진입)
                  Mymux+0xc43303                          ← 같은 락 재획득 시도
                    KERNELBASE!WaitOnAddress → 영구 park
```

시각도 맞는다. 앱의 마지막 정상 동작은 `~/.mycli/session.json` 의 **08-28 00:49:45**,
시스템은 **01:49:45 대기모드 진입 / 03:06:06 복귀** — 복귀하며 창이 다시 전경이 되는
시점에 포커스 전환이 몰린다.

### 원인

`tao 0.35.3` 의 Windows 백엔드가 전역 `parking_lot::Mutex` 두 개를 `PeekMessageW`
호출을 건너 쥐고 있었다.

```rust
// keyboard.rs:34-38 — 포커스 메시지도 "키보드 메시지" 다
pub fn is_msg_keyboard_related(msg: u32) -> bool {
  (WM_KEYFIRST..=WM_KEYLAST).contains(&msg) || msg == WM_SETFOCUS || msg == WM_KILLFOCUS
}

// event_loop.rs:975-983 — 그 락을 쥔 채 process_message() → 그 안에서 PeekMessageW
let events = {
  let mut key_event_builders = KEY_EVENT_BUILDERS.lock();
  if let Some(b) = key_event_builders.get_mut(&WindowId(..)) {
    b.process_message(window, msg, wparam, lparam, &mut result)
  } else { Vec::new() }
};

// keyboard.rs:116-129, 276-288 — LAYOUT_CACHE 가드도 PeekMessageW 를 건너 살아있다
```

`PeekMessageW` 는 `PM_NOREMOVE` 여도 대기 중인 **sent 메시지**를 창 프로시저로 배달한다.
`WM_SETFOCUS` / `WM_KILLFOCUS` 가 바로 sent 메시지다. 그래서 IME 입력 도중 포커스가
바뀌면 창 프로시저가 재진입해 같은 전역 락을 다시 잠그려 하고, `parking_lot::Mutex` 는
재진입 불가라 UI 스레드가 영원히 park 된다.

업스트림도 이 위험을 인정했다 — 최신 tao 소스 주석:
> *WARNING: Due to using PeekMessage, the event handler function may get called during
> this function. (Re-entrance to the event handler) This can cause a deadlock ...*

tao 0.36/0.37 에서 전역 `KEY_EVENT_BUILDERS` 를 없애 고쳤지만,
`tauri-runtime-wry 2.11.4` 가 `tao = "0.35.0"` (`^0.35`) 을 요구해 버전으로는 못 끌어온다.

---

### after — 수정

`tao 0.35.3` 을 `vendor/tao` 로 벤더링하고 `[patch.crates-io]` 로 연결한 뒤 최소 패치.

- 빌더를 전역 맵에서 **꺼내고 락을 놓은 뒤** `process_message` 를 돌린다.
  재진입한 호출은 맵에서 못 찾아 `None` 을 받고 빠진다 — 원래 있던 "맵에 없는 창"
  갈래와 같은 동작이다. `PeekMessageW` 는 sent 메시지만 배달하고 진짜 키 입력은
  posted 라서, 재진입 호출이 실제 키 입력인 경우는 없다.
- 빌리는 쪽이 패닉해도 빌더를 되돌려 놓는다(`BorrowedBuilder` 의 `Drop`).
- `WM_KEYDOWN` / `WM_KEYUP` 에서 `LAYOUT_CACHE` 가드를 `PeekMessageW` 앞에서 놓는다.

```
$ cargo tree -p tao --depth 0
tao v0.35.3 (D:\...\vendor\tao)     ← 레지스트리가 아니라 벤더 경로
```

### after — 이 테스트가 정말 회귀를 잡는가

전후 모두 통과하는 테스트는 아무것도 못 지키므로, 헬퍼를 **옛 형태(락 보유)로 되돌려**
같은 테스트를 돌려 봤다.

```
$ timeout 90 cargo test -p tao --lib reentrant_lookup        # 옛 형태
test ...::reentrant_lookup_returns_instead_of_blocking has been running for over 60 seconds
error: test failed  ...  (exit code: 143)                    ← 멈춘다
```

```
$ cargo test -p tao --lib                                    # 패치 형태
test ...::reentrant_lookup_returns_instead_of_blocking ... ok
test ...::unknown_window_yields_none ... ok
test ...::builder_is_restored_when_the_borrower_panics ... ok
test result: ok. 3 passed; 0 failed
```

```
$ cargo test --workspace
합계 82 passed / 0 failed / 2 ignored, 경고 0
```

`vendor/tao` 를 워크스페이스 멤버로 넣었기 때문에 CI 의 `cargo test --workspace` 가
이 테스트를 그대로 돌린다. 의존성으로만 쓰는 사본이라 예제와 dev-dependencies 는 걷어냈다.

### after — 패치가 사라지는 것을 막는 가드

`vendor/tao` 는 crates.io 사본이라 버전을 올리려고 통째로 다시 복사하면 패치가 흔적 없이
사라진다. 그러면 앱은 멀쩡히 빌드되고 **IME 포커스 전환에만** 죽어서 CI 가 절대 못 잡는다.

```
$ node scripts/check-vendored-tao.mjs
✔ [patch.crates-io] 가 vendor/tao 를 가리킨다
✔ 벤더 사본이 tao 0.35.3 이다
✔ KEY_EVENT_BUILDERS 를 빌려 쓰는 헬퍼가 있다
✔ event_loop.rs 가 전역 맵 락을 직접 잡지 않는다
✔ LAYOUT_CACHE 가드가 PeekMessageW 를 건너 살아있지 않다
✔ 재진입 회귀 테스트가 남아있다

벤더 tao 가드 전부 통과 (6/6).
```

`ci.yml` 의 새 `vendored-tao` job 과 `release.yml` 의 게시 전 단계에 걸었다.
걷어내는 시점과 방법은 `vendor/tao/MYMUX-PATCH.md` 에 적었다.

---

### 완료 기준 대조

- [x] `KEY_EVENT_BUILDERS` 를 `PeekMessageW` 호출 구간에서 보유하지 않는다
- [x] `LAYOUT_CACHE` 를 `PeekMessageW` 호출 구간에서 보유하지 않는다
- [x] 재진입해도 데드락하지 않음을 재현 테스트로 고정 (옛 형태로 되돌리면 멈추는 것 확인)
- [x] 기존 키보드/IME 동작 회귀 없음 — 워크스페이스 82개 테스트 통과, 경고 0
- [ ] **3-OS CI 통과 — PR 올린 뒤 확인 필요**
- [x] 전후 증거

### 남은 것

- **Windows 실기 확인은 아직이다.** 한글 입력 중 Alt-Tab 을 반복해도 안 멈추는지는
  빌드된 앱으로 직접 봐야 한다. 이 데드락은 타이밍에 걸리는 것이라 자동화로 재현하기 어렵다.
- 작업 중 **별건**을 하나 발견했다. `vendor/tao` 의 `update_theme()` 이 `window_state`
  락을 쥔 채 `try_window_theme()`(Dwm 호출)을 부른다 — 업스트림
  [tao#1294](https://github.com/tauri-apps/tao/issues/1294) 와 같은 모양이고 0.36+ 에서만
  고쳐졌다. 이번 데드락과 원인 계통은 같지만 경로가 달라 이 PR 에는 넣지 않았다.
  별도 이슈로 다루는 게 맞다.
