# vendor/tao — Mymux 가 손댄 부분

`tao 0.35.3` 의 crates.io 사본에 **딱 하나의 결함**을 고쳐 넣은 것이다.
[Mymux 이슈 #36](https://github.com/ChoiGyber/Mymux/issues/36).

## 왜 벤더링했나

tao 의 Windows 백엔드는 프로세스 전역 `parking_lot::Mutex` 두 개를
`PeekMessageW` 호출을 건너 쥐고 있었다. `PeekMessageW` 는 `PM_NOREMOVE` 여도
대기 중인 **sent 메시지**를 창 프로시저로 배달한다. 그리고

```rust
pub fn is_msg_keyboard_related(msg: u32) -> bool {
  (WM_KEYFIRST..=WM_KEYLAST).contains(&msg) || msg == WM_SETFOCUS || msg == WM_KILLFOCUS
}
```

`WM_SETFOCUS` / `WM_KILLFOCUS` 는 sent 메시지이면서 키보드 메시지로 분류된다.
그래서 한글 IME 로 입력하는 도중 포커스가 바뀌면 창 프로시저가 재진입해
**자기가 이미 쥔 락을 다시 잠그려 한다.** `parking_lot::Mutex` 는 재진입 불가라
UI 스레드가 영구히 park 된다 — CPU 도 안 쓰고, 에러도 없고, 회복도 없다.

업스트림은 tao 0.36 / 0.37 에서 전역 `KEY_EVENT_BUILDERS` 를 없애 이미 고쳤다.
그런데 `tauri-runtime-wry 2.11.4` 가 `tao = "0.35.0"` (`^0.35`) 을 요구해서
`cargo update` 로도 `[patch.crates-io]` 로도 0.36+ 를 끌어올 수 없다.
그래서 0.35.3 을 벤더링하고 같은 취지의 최소 패치를 얹었다.

## 업스트림 0.35.3 대비 변경점

### 1. `src/platform_impl/windows/keyboard.rs` — 빌더를 빌려 쓰는 헬퍼 추가

`with_key_event_builder()` 와 `BorrowedBuilder` 를 새로 넣었다. 전역 맵에서
빌더를 **꺼내고 락을 놓은 뒤** 클로저를 돌리고, 스코프가 끝날 때(패닉 포함)
다시 넣는다. 재진입한 호출은 맵에서 못 찾아 `None` 을 받고 그냥 빠진다.

### 2. `src/platform_impl/windows/event_loop.rs` — 헬퍼 사용

`KEY_EVENT_BUILDERS.lock()` 을 직접 잡고 `process_message()` 를 부르던 자리를
`with_key_event_builder(...)` 호출로 바꿨다.

### 3. `src/platform_impl/windows/keyboard.rs` — `LAYOUT_CACHE` 스코프 축소

`WM_KEYDOWN` / `WM_KEYUP` 두 갈래에서 `LAYOUT_CACHE` 가드가 `PeekMessageW` 를
건너 살아 있었다. 가드를 블록으로 감싸 `PeekMessageW` 앞에서 놓고, 이후
필요한 지점에서 다시 잠근다.

### 4. `src/platform_impl/windows/keyboard.rs` — 회귀 테스트 추가

`reentrancy_tests` 모듈 3개. `cargo test --workspace` 가 돌린다.
헬퍼를 옛 형태(락 보유)로 되돌리면 첫 테스트가 영원히 멈추는 것으로
실제 회귀를 잡는다는 걸 확인했다.

### 5. `Cargo.toml` — 예제와 dev-dependencies 제거

의존성으로만 쓰는 사본이라 `[[example]]` 32개 항목과 `examples/` 디렉터리,
`[dev-dependencies]`(`image`, `env_logger`) 를 걷어냈다. 그래야 워크스페이스
멤버로 넣어도 `cargo test --workspace` 가 쓰지도 않는 예제 의존성을
3개 OS 에서 빌드하지 않는다. 라이브러리 코드에는 영향이 없다.

## 걷어내는 방법

`tauri` 가 `tao 0.36` 이상에 올라탄 릴리즈를 내면 이 벤더링은 필요 없다.

1. `tauri` / `tauri-runtime-wry` 를 올리고 `cargo tree -p tao` 로 0.36+ 인지 확인
2. 루트 `Cargo.toml` 에서 `[patch.crates-io]` 와 `members` 의 `"vendor/tao"` 삭제
3. `vendor/tao/` 삭제
4. `scripts/check-vendored-tao.mjs` 와 `.github/workflows/ci.yml` 의
   `vendored-tao` job 삭제

## 버전을 올려야 한다면

tao 0.35.x 안에서 패치 버전만 올리는 경우, 새 사본을 받은 뒤 위 5개 변경을
다시 얹어야 한다. `node scripts/check-vendored-tao.mjs` 가 빠뜨린 항목을 잡아 준다.
