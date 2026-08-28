# after — 회귀 테스트가 실제로 이 데드락을 잡는다

테스트가 수정 전후 모두 통과하면 아무것도 지키지 못한다. 그래서 헬퍼를 **옛 형태로
되돌려** 같은 테스트가 정말 멈추는지 확인했다.

## 1) 옛 형태 — 전역 맵 락을 클로저 실행 내내 보유

```rust
pub(crate) fn with_key_event_builder<R>(
  window_id: WindowId,
  f: impl FnOnce(&mut KeyEventBuilder) -> R,
) -> Option<R> {
  let mut map = KEY_EVENT_BUILDERS.lock();   // ← 락을 쥔 채
  let builder = map.get_mut(&window_id)?;
  Some(f(builder))                            // ← f 안에서 재진입하면 끝
}
```

```
$ timeout 90 cargo test -p tao --lib reentrant_lookup

running 1 test
test platform_impl::platform::keyboard::reentrancy_tests::reentrant_lookup_returns_instead_of_blocking
  has been running for over 60 seconds
error: test failed, to rerun pass `-p tao --lib`

Caused by:
  process didn't exit successfully: `...\tao-6b63eb34e8c075f0.exe reentrant_lookup` (exit code: 143)
```

**멈춘다.** 90초 타임아웃에 강제 종료(143 = SIGTERM). 실제 앱에서 일어난 것과 같은 일이다.

## 2) 패치 형태 — 빌더를 꺼내고 락을 놓는다

```rust
pub(crate) fn with_key_event_builder<R>(
  window_id: WindowId,
  f: impl FnOnce(&mut KeyEventBuilder) -> R,
) -> Option<R> {
  let builder = KEY_EVENT_BUILDERS.lock().remove(&window_id)?;  // ← 락은 조회 동안만
  let mut borrowed = BorrowedBuilder { window_id, builder: Some(builder) };
  let builder = borrowed.builder.as_mut().expect("builder was just stored in the slot");
  Some(f(builder))                                               // ← 락 없이 실행
}
```

```
$ cargo test -p tao --lib

running 3 tests
test platform_impl::platform::keyboard::reentrancy_tests::reentrant_lookup_returns_instead_of_blocking ... ok
test platform_impl::platform::keyboard::reentrancy_tests::unknown_window_yields_none ... ok
test platform_impl::platform::keyboard::reentrancy_tests::builder_is_restored_when_the_borrower_panics ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
EXIT=0
```

## 테스트가 지키는 것

| 테스트 | 지키는 불변조건 |
| --- | --- |
| `reentrant_lookup_returns_instead_of_blocking` | 재진입한 조회가 블록하지 않고 `None` 으로 돌아온다 |
| `builder_is_restored_when_the_borrower_panics` | 빌리는 쪽이 패닉해도 빌더가 맵으로 돌아온다 (안 그러면 그 창은 키 입력이 영영 죽는다) |
| `unknown_window_yields_none` | 맵에 없는 창은 원래대로 `None` |

`vendor/tao` 를 워크스페이스 멤버로 넣었기 때문에 CI 의 `cargo test --workspace` 가
3개 OS 에서 이 테스트를 그대로 돌린다(Windows 에서만 컴파일되는 코드라 실제 실행은 Windows).
