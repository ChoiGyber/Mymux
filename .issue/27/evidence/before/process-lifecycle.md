# before — 창을 닫아도 프로세스가 남는다

빌드: `bf3408d` (main, #25 merge 직후 = 이 이슈 수정 전)
실행: 새 WebView2 프로필 + `--remote-debugging-port=9360`
종료: CDP 로 `closeAppWindow.destroy()` — 앱의 종료 모달에서 사용자가 고른 뒤 실행되는 것과 같은 경로

## 창을 닫기 전

```text
   Id Path
   -- ----
 2656 D:\Project\Mymux\target\debug\Mymux.exe          ← 테스트 인스턴스
21236 C:\Users\ChoiGyber\AppData\Local\Mymux\Mymux.exe  ← 사용자가 쓰던 설치본 (건드리지 않음)
```

## 창을 닫은 뒤 (5초 대기)

```text
   Id Path
   -- ----
 2656 D:\Project\Mymux\target\debug\Mymux.exe          ← 그대로 살아 있다
21236 C:\Users\ChoiGyber\AppData\Local\Mymux\Mymux.exe
```

**PID 2656 이 사라지지 않았다.** 사용자 눈에는 창이 없어져 종료된 것처럼 보이지만 프로세스는 계속 돈다.

## 무엇이 붙들고 있는가

같은 시점의 CDP 페이지 타겟:

```text
http://tauri.localhost/overlay.html
```

main 창(`http://tauri.localhost/`)은 사라졌고 **`buddy-overlay` 창만 남았다.**
`tauri-runtime-wry-2.11.4/src/lib.rs:4310-4318` 은 창 맵이 **빌 때만** `ExitRequested` 를 내고
`ControlFlow::Exit` 로 가는데, 이 창이 남아 있어 그 조건이 영원히 성립하지 않는다.

`buddy-overlay` 는 `tauri.conf.json` 에서 앱 시작 시 생성되고(`visible: false`), Rust 쪽은 show/hide 만
한다 — `commands.rs:900` 의 `buddy_overlay_show` 는 기존 창을 `get` 할 뿐 생성하지도, 없애지도 않는다.

## 이것이 왜 창 크기 문제로 이어지나

좀비는 `RunEvent::Exit` 핸들러를 장전한 채 자기 세대의 지오메트리 캐시를 들고 있다.
나중에 Windows 로그오프 등으로 그 좀비가 정상 종료되면 낡은 캐시가 최신 저장값을 덮어쓴다.
