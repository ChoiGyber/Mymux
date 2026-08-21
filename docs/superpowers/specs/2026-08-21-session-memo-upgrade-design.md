# 세션 메모 다중화와 로컬 음성입력 설치 안내

## 목적

두 가지를 한 번에 고친다. 둘 다 "이미 넣었지만 실제로 쓰기 불편한 기능"이다.

**메모** — 지금 세션 메모는 패인당 텍스트 하나(`t.session.memo`)다. 빌드 로그, 접속
메모, TODO 를 한 통에 이어붙일 수밖에 없어서 쌓일수록 못 쓴다. 메모를 여러 개로 쪼개고,
왼쪽 제목 목록 · 오른쪽 본문으로 나누고, 검색과 txt 내보내기를 붙인다.

**음성입력** — 로컬 faster-whisper 경로가 사실상 동작하지 않는다. 입력칸 placeholder 는
`python faster_whisper_cli.py` 인데 `voice.rs:80` 의 `validate_runner` 는 파일명이
`faster-whisper.exe`/`faster_whisper.exe`/`whisper.exe` 인 **절대경로 exe** 만 통과시킨다.
그런 exe 를 어떻게 얻는지는 앱 어디에도, 저장소 어디에도 없다. 실제로 사용자는
`C:\Tools\MymuxWhisper\faster_whisper_wrapper.py` 를 직접 작성해 PyInstaller 로 빌드해야 했다
(저장소 루트의 `faster-whisper.spec` 이 그 흔적이다). 무엇을 설치해야 하는지 앱이 직접,
정확한 링크와 함께 안내하도록 바꾼다.

---

# 1부 · 세션 메모 다중화

## 1.1 결정 사항

| 항목 | 결정 |
|---|---|
| 메모 제목 | 본문 첫 줄에서 자동 파생. 제목을 더블클릭하면 직접 입력할 수 있고, 그 뒤로는 고정 |
| txt 저장 범위 | **현재 보고 있는 메모 1개**. 파일명 기본값은 메모 제목 |
| 저장 위치 | Windows 기본 "다른 이름으로 저장" 대화상자 (`tauri-plugin-dialog`) |
| 담는 그릇 | 기존 메모 팝오버를 그대로 쓰고 크기만 키운다. 새 창·모달을 만들지 않는다 |
| 구버전 호환 | 저장은 `memos` 만 한다. 옛 `memo` 문자열은 **읽기만** 하고 다시 쓰지 않는다 |

## 1.2 데이터 모델

```js
t.session.memos        = [{ id, title, body }]
t.session.activeMemoId = "lz4k2p-a91"   // 마지막으로 보던 메모, 없으면 memos[0]
```

- `id` — `Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5)`.
  세션 저장을 넘어 유지돼야 하므로 배열 인덱스를 쓰지 않는다.
- `title` — 사용자가 직접 붙인 이름. 빈 문자열이면 본문에서 파생한다.
- `body` — 본문.

제목 파생 규칙:

```js
function memoTitle(m) {
  if (m.title) return m.title;
  const first = (m.body || "").split("\n").find((l) => l.trim()) || "";
  return first.trim().slice(0, 200) || "(빈 메모)";
}
```

목록 정렬은 하지 않는다. 새 메모는 배열 맨 앞에 넣고 그 외에는 순서를 건드리지 않는다.
`updatedAt` 으로 정렬하면 타이핑하는 동안 목록이 움직여서 못 쓴다.

## 1.3 한도

| 대상 | 한도 | 초과 시 |
|---|---|---|
| 메모 1개 본문 | 64KB | 앞부분을 잘라내고 최근 tail 유지 (현행 `MAX_MEMO` 동작 그대로) |
| 세션당 메모 개수 | 100개 | 생성 차단 + 토스트 "메모는 세션당 100개까지입니다." |

`session.json` 은 모든 패인의 메모를 한 파일에 담으므로 개수 상한이 필요하다.

## 1.4 마이그레이션

불러오기 경로에서 한 함수로 정규화한다.

```js
function normalizeMemos(s) {
  if (Array.isArray(s.memos)) return s.memos.filter(isMemoLike).map(sanitizeMemo);
  if (typeof s.memo === "string" && s.memo.trim()) return [newMemo({ body: s.memo })];
  return [];
}
```

`memo` 를 실어 나르던 세션 저장/복원 지점 6곳을 `memos` + `activeMemoId` 로 바꾼다.

| 위치 | 지금 |
|---|---|
| `app.js:6246` | SSH 복원 `sessionMeta.memo` |
| `app.js:6874` | 스냅샷 `(t0.session.memo) \|\| tab.session.memo` |
| `app.js:6924` | 로컬 패인 복원 `memo: s.memo \|\| ""` |
| `app.js:7014` | 키인증 SSH 복원 인자 |
| `app.js:7023` | 로컬 탭 복원 `t.session.memo = s.memo` |
| `app.js:7169` | 비번인증 SSH 복원 인자 |

`app.js:6874` 는 `||` 폴백을 쓰고 있는데 **빈 배열은 truthy** 라서 그대로 옮기면 안 된다.
`memos.length ? live : saved` 로 바꾼다.

## 1.5 레이아웃

팝오버 기본 크기를 300×250 → **560×360**, 최소 크기를 260×180 → **420×260** 으로 올린다.
`MEMO_POPOVER_SIZE_KEY` 를 `mymux.memoPopoverSize.v2` 로 올려 옛 300×250 이 되살아나지 않게 한다.

```
┌──────────────────────────────────────────────┐
│ 🗒 세션 라벨                              [×] │  .memo-head (드래그 이동)
├───────────────┊──────────────────────────────┤
│ [🔍 검색     ] ┊  ┌────────────────────────┐ │
│ [＋ 새 메모  ] ┊  │ .memo-text (textarea)  │ │
│ ───────────── ┊  │                        │ │
│  npm run bu…  ┊  └────────────────────────┘ │
│ ▸빌드 로그    ┊  [복사][입력][실행][txt][삭제]│
│  TODO 정리    ┊                              │
└───────────────┴──────────────────────────────┘
 .memo-side     ↑ .memo-splitter (4px)
```

`.memo-body` 를 `display:flex` 로 두고 그 안에 `.memo-side` / `.memo-splitter` / `.memo-main`.

### 왼쪽 패널 (`.memo-side`)

- `flex: 0 0 var(--memo-side-w)` — 기본 `160px`.
- 스플리터 드래그로 **110px ~ 팝오버 폭의 60%** 사이에서 조절. 폭은
  `localStorage["mymux.memoSideWidth.v1"]` 에 저장한다.
- 팝오버 자체가 좁아져 상한이 내려가면 폭을 clamp 한다 (`ResizeObserver` 에서 처리).

### 제목 표시

```css
.memo-item {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-dim);
}
.memo-item.active {
  color: var(--text); font-weight: 600; background: var(--surface-hover);
}
```

"패널 크기만큼 제목 보이게" 는 ellipsis 로 충족된다 — 패널을 넓히면 넓힌 만큼 더 보인다.
잘린 제목은 `title` 속성으로 전체를 hover 툴팁에 띄운다.

### 검색

`.memo-search` 입력값으로 제목 + 본문을 대소문자 무시 부분일치 필터링한다. 목록만 좁히고
활성 메모는 바꾸지 않는다. 활성 메모가 필터에서 빠져도 오른쪽 본문은 그대로 둔다 —
검색어를 쳤다고 편집 중이던 내용이 사라지면 안 된다.

### 제목 이름 바꾸기

`.memo-item` 더블클릭 → 그 자리에 `<input>` 을 띄운다. Enter/blur 로 확정, Escape 로 취소.
빈 값으로 확정하면 `title = ""` 이 되어 다시 자동 파생으로 돌아간다.

### 삭제

`confirm()` 은 쓰지 않는다 — WebView2 모달은 이벤트 루프를 막고, 이 저장소는 CDP 로 UI 를
검증하므로 자동화도 함께 멈춘다. 대신 2단계 버튼:

1. 🗑 클릭 → 버튼이 3초간 빨간 "삭제?" 로 바뀐다
2. 3초 안에 다시 클릭 → 삭제. 시간이 지나면 원래대로 복귀

마지막 메모를 지우면 빈 메모 하나를 자동 생성해 오른쪽이 비지 않게 한다.

## 1.6 드래그 자동수집

`appendPaneMemo(id, sel)` 는 **활성 메모**에 쌓는다. 메모가 하나도 없으면 하나 만들고
활성으로 잡는다. 중복 append 방지(현행 `cur === add || cur.endsWith("\n" + add)`)는 그대로 둔다.

`sendMemoToPane(id, text, run)` 의 시그니처는 **바꾸지 않는다.** 메모 팝오버 말고도
SFTP 업로드 경로(`app.js:1282`)가 업로드한 파일명을 AI 입력창에 넣을 때 이 함수를 쓴다.

## 1.7 txt 저장

### 백엔드 (신규)

```rust
#[tauri::command]
pub fn save_text_file_as(
    app: tauri::AppHandle,
    suggested_name: String,
    content: String,
) -> Result<Option<String>, String>
```

- `app.dialog().file()` + `.set_file_name()` + `.add_filter("텍스트 문서", &["txt"])`
  + `.blocking_save_file()`. `pick_key_file` 과 같은 sync 커맨드 형태를 따른다
  (워커 스레드에서 돌아 메인 스레드 디스패치가 교착되지 않는다).
- 취소하면 `Ok(None)`.
- 파일명 정제는 Rust 에서 한다 (테스트 가능한 지점을 백엔드에 둔다):
  `\ / : * ? " < > |` 와 제어문자를 `_` 로, 앞뒤 공백·마침표 제거, 60자로 절단,
  결과가 비면 `메모`. 확장자가 `.txt` 가 아니면 붙인다.
- 기록 형식은 **UTF-8 BOM + CRLF**. 윈도우 메모장·엑셀에서 한글이 깨지지 않게 하기 위함이다.

### ACL 등록

이슈 #7 에서 빠뜨려 런타임에 막혔던 항목이다. 세 곳 모두 건드린다.

1. `crates/mycli-desktop/build.rs` 의 `APP_COMMANDS` 에 `"save_text_file_as"` 추가
2. `crates/mycli-desktop/capabilities/default.json` 에 `"allow-save-text-file-as"` 추가
3. `crates/mycli-desktop/src/main.rs` 의 `invoke_handler` 에 등록

`permissions/autogenerated/*.toml` 은 `tauri_build` 가 생성한다.

---

# 2부 · 로컬 음성입력 설치 안내

## 2.1 결정 사항

| 항목 | 결정 |
|---|---|
| 지원 경로 | **단독 실행 파일과 Python 둘 다.** 팝오버에서 라디오로 고른다 |
| 모델 지정 | 폴더 경로가 아니라 **모델 이름 드롭다운**. `prompt()` 는 없앤다 |
| 녹음 포맷 | 프런트에서 16kHz 모노 **WAV** 로 변환해 넘긴다 |
| 래퍼 스크립트 | Mymux 가 동봉한다. 사용자가 만들지 않는다 |
| Deepgram 경로 | 손대지 않는다 |

## 2.2 설치 안내 UI

`#voice-popover` 폭을 280px → **360px** 로 넓히고, 안내는 `<details>` 접이식으로 넣어
평소에는 접혀 있게 한다. 링크 버튼은 `open_external(url)` 을 호출한다
(`explorer <url>` 이라 http(s) 도 기본 브라우저로 열린다).

```
Provider  [로컬 faster-whisper ▾]
방식      (•) 단독 실행 파일   ( ) Python

▼ 설치 안내
  ─ 단독 실행 파일 (Python 불필요) ─
  ① [다운로드 페이지 열기 ↗]
     Faster-Whisper-XXL_r245.4_windows.7z · 1.36GB
     Windows 11 탐색기가 .7z 를 기본 지원합니다
  ② 압축을 풀고 faster-whisper-xxl.exe 선택  [찾아보기…]

  ─ Python ─
  ① [python.org 열기 ↗]  Python 3.9 이상
  ② pip install faster-whisper   [복사] [현재 패인에 입력]
  ③ (GPU 쓸 때만) cuBLAS + cuDNN 9 for CUDA 12  [안내 열기 ↗]
  ④ python.exe 선택  [찾아보기…]

모델   [small ▾]   (첫 실행 시 자동 다운로드)
언어   [한국어 ▾]
[설치 확인]   상태: ✅ faster-whisper 1.1.1
☑ Ctrl+Space 눌러서 말하기
[🎤 눌러서 말하기]
```

### 안내에 넣을 링크 (실측 확인함, 2026-08-21)

| 용도 | URL |
|---|---|
| 단독 실행 파일 | `https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL` |
| Python 설치 | `https://www.python.org/downloads/windows/` |
| faster-whisper | `https://github.com/SYSTRAN/faster-whisper` |
| GPU 라이브러리 | `https://github.com/SYSTRAN/faster-whisper#gpu` |
| 7-Zip (Windows 10 이하) | `https://www.7-zip.org/` |

.7z 기본 지원은 Windows 11 23H2 부터다. 그 아래 버전에서도 열 수 있도록 7-Zip 링크를 같이 둔다.

Windows 자산은 `Faster-Whisper-XXL_r245.4_windows.7z`, 1358MB, 2025-04-13 갱신.
버전 문자열은 시간이 지나면 낡으므로 UI 에는 **파일명과 크기를 참고값으로만** 적고
"릴리즈 페이지에서 최신 windows 7z 를 받으세요" 라고 쓴다.

### localStorage 키

| 키 | 값 |
|---|---|
| `mymux.voice.provider` | `deepgram` \| `local` |
| `mymux.voice.localMode` | `standalone` \| `python` |
| `mymux.voice.runner.standalone` | exe 절대경로 |
| `mymux.voice.runner.python` | python.exe 절대경로 |
| `mymux.voice.model` | `tiny`\|`base`\|`small`\|`medium`\|`large-v3`\|`turbo` (기본 `small`) |
| `mymux.voice.language` | `ko`\|`en`\|`ja`\|`auto` (기본 `ko`) |
| `mymux.voice.pushToTalk` | `"1"`\|`"0"` (기본 `"1"`) |

옛 `mymux.voice.modelPath` 는 읽지 않는다.

## 2.3 녹음 포맷을 WAV 로 바꾸는 이유

WebView2 의 `MediaRecorder` 는 `audio/webm;codecs=opus` 만 낸다. whisper 계열 CLI 는 webm 을
읽으려면 ffmpeg 가 필요하고, 그게 없으면 "설치는 다 했는데 아무것도 안 나온다" 가 된다.
가장 실패 확률이 높은 지점이므로 프런트에서 없앤다.

```js
// blob → 16kHz 모노 16bit PCM WAV
const buf = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
// ... BufferSource 연결 후 startRendering() → PCM16 인코딩 → WAV 헤더 부착
```

부수 효과로 base64 페이로드도 작아진다.

## 2.4 백엔드 변경 (`crates/mycli-desktop/src/voice.rs`)

### `validate_runner` 완화

```rust
fn validate_runner(path: &Path, mode: LocalMode) -> Result<(), String>
```

절대경로 + 실존 파일 검사는 유지하고, 허용 파일명만 모드별로 나눈다.

| 모드 | 허용 파일명 |
|---|---|
| `Standalone` | `faster-whisper-xxl.exe`, `faster-whisper.exe`, `whisper-faster.exe`, `whisper.exe` (+ 확장자 없는 유닉스 대응) |
| `Python` | `python.exe`, `pythonw.exe`, `python3.exe`, `python`, `python3` |

### `voice_transcribe_local` 재설계

```rust
#[tauri::command]
pub async fn voice_transcribe_local(
    app: tauri::AppHandle,
    audio_base64: String,
    mode: String,        // "standalone" | "python"
    runner_path: String,
    model: String,       // 이름만. 경로 아님
    language: String,    // "ko" | "en" | "ja" | "auto"
) -> Result<String, String>
```

- `model` / `language` 는 화이트리스트로 검증한다. 프로세스 인자로 그대로 들어가므로
  자유 문자열을 받지 않는다.
- 오디오는 임시 폴더에 `.wav` 로 쓰고, 끝나면 임시 폴더째 지운다.
- **standalone**:
  `runner "<wav>" -m <model> -l <lang> -f txt -o "<tmpdir>"` 실행 후 `tmpdir` 에 생긴
  텍스트 파일을 읽는다. 구현 시 `--help` 로 플래그를 먼저 확인하고, `.txt` 가 아닌
  결과물이 나오면 타임스탬프 줄을 걷어낸다.
- **python**: `python.exe <동봉 wrapper.py> "<wav>" --model <m> --language <l>` → stdout.
- 타임아웃 90초, stdout 32KB 상한은 현행 유지.

### `voice_check_local` (신규)

```rust
#[tauri::command]
pub async fn voice_check_local(mode: String, runner_path: String) -> Result<String, String>
```

- standalone: `<runner> --help` 를 5초 타임아웃으로 실행 → 첫 줄 반환
- python: `<python> -c "import faster_whisper, sys; print(faster_whisper.__version__)"` → 버전 반환
- 실패하면 무엇이 없는지 + 무엇을 깔아야 하는지가 담긴 한국어 메시지를 돌려준다.
  `ImportError` 면 "faster-whisper 가 설치돼 있지 않습니다. `pip install faster-whisper` 를
  실행하세요." 로 매핑한다.

### `voice_pick_runner` (신규)

```rust
#[tauri::command]
pub fn voice_pick_runner(app: tauri::AppHandle) -> Option<String>
```

`.exe` 필터를 건 네이티브 파일 선택기. `pick_key_file` 과 같은 형태.

### ACL 등록

`voice_check_local`, `voice_pick_runner`, `save_text_file_as` — 1.7절과 같은 3곳
(`build.rs`, `capabilities/default.json`, `main.rs`).

## 2.5 동봉 래퍼 스크립트

새 파일 `crates/mycli-desktop/resources/whisper_wrapper.py`:

```python
import argparse, sys
from faster_whisper import WhisperModel

p = argparse.ArgumentParser()
p.add_argument("audio")
p.add_argument("--model", default="small")
p.add_argument("--language", default="ko")
a = p.parse_args()

model = WhisperModel(a.model, device="auto", compute_type="default")
segments, _ = model.transcribe(
    a.audio, language=None if a.language == "auto" else a.language
)
sys.stdout.write(" ".join(s.text.strip() for s in segments))
```

번들 등록은 **두 파일 모두** 고쳐야 한다. Tauri 는 플랫폼 설정을 base 위에 키 단위로
덮으므로, `tauri.windows.conf.json` 에만 `bundle.resources` 가 있는 지금 상태에서
base 에만 추가하면 Windows 빌드에서 누락된다.

- `crates/mycli-desktop/tauri.conf.json` → `bundle.resources`
- `crates/mycli-desktop/tauri.windows.conf.json` → 기존 `resources` 에 항목 추가

런타임 해석은 `app.path().resolve("resources/whisper_wrapper.py", BaseDirectory::Resource)`.
찾지 못하면 `CARGO_MANIFEST_DIR` 기준 경로로 폴백해 `cargo run` 개발 빌드도 동작하게 한다.

## 2.6 프런트 정리

- `setupVoiceInput`(`app.js:293-305`) 삭제. `setupVoiceInputSafe` 만 쓰이는 죽은 중복이고,
  없어진 `command:` 인자로 `voice_transcribe_local` 을 부르고 있다.
- 남는 함수 이름을 `setupVoiceInput` 으로 되돌린다.
- Ctrl+Space 전역 핸들러에 `mymux.voice.pushToTalk` 게이트를 건다. 지금은 터미널에서
  무엇을 치든 전역으로 가로챈다.
- 녹음 중에는 팝오버를 열지 않아도 보이도록 화면 하단에 "🎤 녹음 중…" 인디케이터를 띄운다.
- 로컬 모드인데 runner 경로가 비어 있으면 🎙 툴바 버튼에 미설정 표시(●)를 단다.

---

## 3 · 검증

이 저장소에는 프런트엔드 테스트 인프라가 없다(`frontend/` 에 `package.json` 없음,
CI 는 `cargo test --workspace`). 따라서 검증 가능한 로직은 Rust 로 밀어 넣는다.

| 대상 | 방법 |
|---|---|
| txt 파일명 정제 | `cargo test` 단위 테스트 (금지문자, 길이 절단, 빈 결과, 확장자 부착) |
| `validate_runner` 모드별 허용 | `cargo test` 단위 테스트 |
| `model`/`language` 화이트리스트 | `cargo test` 단위 테스트 |
| 메모 UI (목록·검색·스플리터·활성 강조·이름변경·삭제) | WebView2 CDP e2e |
| txt 저장 대화상자 | 실기 확인 (네이티브 대화상자라 CDP 로 못 잡는다) |
| 음성 로컬 경로 | 실기 확인 — 설치물이 필요해 CI 에서 돌릴 수 없다 |

CDP 검증 시 주의(이슈 #7 에서 겪음): `term.input()` 으로 문자를 넣을 때는 **글자 사이에
30ms 를 둔다.** 연속으로 밀어 넣으면 PTY 순서가 섞인다.

## 3.1 · 구현 분할

1부(메모)와 2부(음성입력)는 겹치는 파일이 `app.js`·`build.rs`·`capabilities/default.json`
뿐이고 로직은 완전히 분리돼 있다. 이슈와 브랜치를 둘로 나눠 병렬로 진행할 수 있다.
같은 워크트리에서 순차로 하면 ACL 세 파일에서만 충돌이 나므로 그쪽이 더 단순하다.

## 4 · 범위 밖

- Deepgram 경로 개선
- 메모의 세션 간 이동·공유, 마크다운 렌더링, 태그
- 음성 자동 설치(winget/pip 대리 실행) — 실패 지점이 많아 안내와 확인까지만 한다
- 전체 메모 일괄 내보내기
