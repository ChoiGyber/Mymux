# before — tao 0.35.3 (crates.io 원본, 패치 없음)

## 1) event_loop.rs:968-985 — KEY_EVENT_BUILDERS 를 쥔 채 process_message() 호출
```rust
    use crate::event::WindowEvent::KeyboardInput;
    let is_keyboard_related = is_msg_keyboard_related(msg);
    if !is_keyboard_related {
      // We return early to avoid a deadlock from locking the window state
      // when not appropriate.
      return;
    }
    let events = {
      let mut key_event_builders =
        crate::platform_impl::platform::keyboard::KEY_EVENT_BUILDERS.lock();
      if let Some(key_event_builder) = key_event_builders.get_mut(&WindowId(window.0 as _)) {
        key_event_builder.process_message(window, msg, wparam, lparam, &mut result)
      } else {
        Vec::new()
      }
    };
    for event in events {
      subclass_input.send_event(Event::WindowEvent {
```

## 2) keyboard.rs:34-38 — WM_SETFOCUS / WM_KILLFOCUS 도 키보드 메시지로 분류
```rust
pub fn is_msg_keyboard_related(msg: u32) -> bool {
  let is_keyboard_msg = (WM_KEYFIRST..=WM_KEYLAST).contains(&msg);

  is_keyboard_msg || msg == WM_SETFOCUS || msg == WM_KILLFOCUS
}
```

## 3) keyboard.rs:116-131 — LAYOUT_CACHE 가드를 쥔 채 PeekMessageW (WM_KEYDOWN)
```rust
        let mut layouts = LAYOUT_CACHE.lock();
        let event_info =
          PartialKeyEventInfo::from_message(wparam, lparam, ElementState::Pressed, &mut layouts);

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
        self.event_info = None;
```

## 4) keyboard.rs:276,289 — LAYOUT_CACHE 가드를 쥔 채 PeekMessageW (WM_KEYUP)
```rust
        let mut layouts = LAYOUT_CACHE.lock();
        let event_info =
          PartialKeyEventInfo::from_message(wparam, lparam, ElementState::Released, &mut layouts);
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
        let mut valid_event_info = Some(event_info);
```
