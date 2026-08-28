# after — vendor/tao (0.35.3 + 이슈 #36 패치)

## 1) event_loop.rs — 전역 맵 락을 직접 잡지 않는다
```rust
974-    }
975-    // `process_message` calls `PeekMessageW`, which delivers pending *sent* messages —
976-    // and `WM_SETFOCUS` / `WM_KILLFOCUS` are sent messages that `is_msg_keyboard_related`
977-    // accepts. So this window procedure re-enters while `process_message` is running. The
978-    // builder is therefore borrowed out of the map instead of held under the global lock:
979-    // a reentrant call gets `None` and returns no events, rather than parking this thread
980-    // on a lock it already owns. See issue #36.
981:    let events = crate::platform_impl::platform::keyboard::with_key_event_builder(
982-      WindowId(window.0 as _),
983-      |key_event_builder| key_event_builder.process_message(window, msg, wparam, lparam, &mut result),
984-    )
985-    .unwrap_or_default();
986-    for event in events {
```

## 2) keyboard.rs — 빌더를 빌려 쓰는 헬퍼 (락 구간은 조회 한 번뿐)
```rust
pub(crate) fn with_key_event_builder<R>(
  window_id: WindowId,
  f: impl FnOnce(&mut KeyEventBuilder) -> R,
) -> Option<R> {
  let builder = KEY_EVENT_BUILDERS.lock().remove(&window_id)?;
  let mut borrowed = BorrowedBuilder {
    window_id,
    builder: Some(builder),
  };
  let builder = borrowed
    .builder
    .as_mut()
    .expect("builder was just stored in the slot");
  Some(f(builder))
}
```

## 3) keyboard.rs WM_KEYDOWN — LAYOUT_CACHE 가드를 PeekMessageW 앞에서 놓는다
```rust
        // The LAYOUT_CACHE guard must not be alive across PeekMessageW below: that call
        // delivers pending sent messages, which re-enters this window procedure and locks
        // LAYOUT_CACHE again. parking_lot mutexes are not reentrant, so the UI thread
        // would park on a lock it already owns and never wake. See issue #36.
        let event_info = {
          let mut layouts = LAYOUT_CACHE.lock();
          PartialKeyEventInfo::from_message(wparam, lparam, ElementState::Pressed, &mut layouts)
        };

        let mut next_msg = MaybeUninit::uninit();
        let peek_retval = unsafe {
          PeekMessageW(
            next_msg.as_mut_ptr(),
            Some(hwnd),
            WM_KEYFIRST,
            WM_KEYLAST,
            PM_NOREMOVE,
          )
        };
        let has_next_key_message = peek_retval.as_bool();
```

## 4) 정적 가드 (scripts/check-vendored-tao.mjs)
```
✔ [patch.crates-io] 가 vendor/tao 를 가리킨다
✔ 벤더 사본이 tao 0.35.3 이다
✔ KEY_EVENT_BUILDERS 를 빌려 쓰는 헬퍼가 있다
✔ event_loop.rs 가 전역 맵 락을 직접 잡지 않는다
✔ LAYOUT_CACHE 가드가 PeekMessageW 를 건너 살아있지 않다
✔ 재진입 회귀 테스트가 남아있다

벤더 tao 가드 전부 통과 (6/6).
```
