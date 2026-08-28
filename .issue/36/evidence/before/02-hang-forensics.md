# before — 실제로 멈춘 프로세스에서 채집한 증거

대상: `Mymux.exe` v0.1.59, PID 21236, 시작 2026-08-27 08:11:49, 채집 2026-08-28 08:0x

## 프로세스 상태 — 무한 루프가 아니라 완전한 데드락

```
Responding        : False
CPU delta over 4s : 0 ms          ← 아무 스레드도 돌고 있지 않다
Threads           : 42, 전부 Wait
MainWindowTitle   : Mymux — Command Manager
```

## 스레드 분포 (미니덤프에서 RIP 해석)

```
TID 20120  ntdll!ZwWaitForAlertByThreadId   ← 메인 스레드. 락 대기
TID  9008  win32u!NtUserGetMessage                     메시지 루프 스레드
TID 22320  win32u!NtUserMsgWaitForMultipleObjectsEx    WebView2 UI
TID 16720  win32u!NtUserMsgWaitForMultipleObjectsEx    WebView2 UI
TID  6540  ntdll!ZwRemoveIoCompletion                  WebView2 IPC
TID  6552  ntdll!ZwRemoveIoCompletionEx                tokio IOCP 드라이버
21264 13212 15968 11824 25680   ntdll!ZwReadFile           PTY 리더 5개 (정상)
21720 22728 15988 12800 25400   ntdll!ZwWaitForSingleObject 자식 대기 5개 (정상)
그 외 ~20개                      tokio 워커 park (정상 유휴)
```

**메인 스레드만 다르다.** 나머지는 전부 정상 유휴다.

## 메인 스레드가 기다리는 대상

```
RIP  = ntdll!ZwWaitForAlertByThreadId+0x14
       ← ntdll!RtlWaitOnAddress+0x213
       ← KERNELBASE!WaitOnAddress+0x38     ← Rust/parking_lot futex 경로

R10/RCX = 0x1be3c378378   parking_lot ThreadData (힙)
  +0x00  1                     parker.key (파킹 중)
  +0x08  0x00007ff619505e40    ThreadData.key = 파킹된 락의 주소
                               = Mymux.exe+0x1685e40  ← 바이너리 내 전역 static

Mymux.exe+0x1685e40 의 값 = 0x03
  = parking_lot RawMutex 의 LOCKED_BIT(0x01) | PARKED_BIT(0x02)
```

그 락 주소를 덤프 전체에서 찾으면 참조가 3곳뿐이다.

```
0xbd8f107f18  [stack TID 20120]   메인 스레드 스택
0xbd8f107fb0  [stack TID 20120]   메인 스레드 스택
0x1be3c378380 [heap]              메인 스레드의 ThreadData.key
```

**그 락에 파킹된 스레드는 메인 스레드 하나뿐이다.** 즉 자기가 쥔 락을 자기가 기다린다.

## 메인 스레드 콜스택 — 재진입의 직접 증거

바깥(스택 깊은 쪽) → 안쪽 순서.

```
Mymux+0x70744b                             tao 이벤트 루프
user32!GetMessageW / DispatchMessageW      ← 최상위 메시지 루프
user32!CallWindowProcW
msctf!TF_Notify
msctf!TF_SetShowFloatingStatus
msctf!TF_CreateCicLoadWinStaMutex
msctf!CtfImeDispatchDefImeMessage          ← 한글 IME (TSF)
Mymux+0x7160f5                             tao wndproc  #1
Mymux+0x660dd4
Mymux+0x71575a
Mymux+0xc43034                             ← 전역 락 획득 (성공)
Mymux+0x74e7aa
textinputframework!InputFocusChanged  (x2) ← 포커스 전환
Mymux+0xc3ee9e
user32!PeekMessageW                        ← 중첩 메시지 펌프
win32u!NtUserPeekMessage
ntdll!KiUserCallbackDispatcher
user32!gapfnScSendMessage
user32!SendMessageW                        ← sent 메시지 배달
user32!CallWindowProcW
Mymux+0xc46e93 / Mymux+0xc46cc6            wndproc 썽크
user32!CallWindowProcW
Mymux+0x113ffe0
Mymux+0xc43303                             ← 같은 전역 락 재획득 시도
Mymux+0x660dd4
Mymux+0x717630                             tao wndproc  #2  ← 재진입
Mymux+0x716529
Mymux+0xc39a10
Mymux+0xef25bf                             parking_lot park
KERNELBASE!WaitOnAddress
ntdll!RtlWaitOnAddress
ntdll!ZwWaitForAlertByThreadId             ← 영구 대기
```

`+0x71xxxx`, `+0x660dd4`, `+0xc43xxx` 가 한 스택에 **두 번** 나온다 = 창 프로시저 재진입.

## 시각 정보

```
2026-08-27 08:11:49   Mymux 시작
2026-08-27 12:46:25   마지막 패인 생성 (PTY 5번째)
2026-08-28 00:49:45   ~/.mycli/session.json 마지막 기록  ← 앱이 살아 있던 마지막 시각
2026-08-28 01:49:45   시스템 대기모드 진입 (Kernel-Power 506)
2026-08-28 03:06:06   대기모드 복귀 (Kernel-Power 507)
2026-08-28 08:0x      채집 — 이미 무응답
```

복귀하며 창이 다시 전경이 되는 시점에 포커스 전환이 몰린다.

## 채집 방법 (재현 가능)

```powershell
# 무응답·CPU 정지 확인
$p = Get-Process -Id <PID>; $p.Responding; $p.TotalProcessorTime

# 전체 메모리 덤프
rundll32.exe comsvcs.dll, MiniDump <PID> <out.dmp> full
icacls <out.dmp> /grant "$env:USERNAME:(F)"     # comsvcs 는 SYSTEM/Admin ACL 로 만든다
```

덤프 파싱은 `dbghelp` 없이 미니덤프 스트림(ModuleList=4, ThreadList=3, Memory64List=9)을
직접 읽고 시스템 DLL 의 PE export 테이블로 함수 이름을 붙였다.
