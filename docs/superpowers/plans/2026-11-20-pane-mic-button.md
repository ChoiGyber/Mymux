# 세션별 마이크 버튼 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 패인 상단 표시줄에 마이크 버튼을 두고, 누르면 녹음(버튼 자리에 파장 표시), 다시 누르면 인식해서 그 패인에 붙여 넣는다.

**Architecture:** `setupVoiceInput()` 안에 묶인 녹음·인식 로직을 패인 버튼, 팝오버 녹음 버튼, Ctrl+Space가 함께 쓰는 하나의 제어 객체로 꺼낸다. 누를 때 무엇을 할지는 순수 함수 `voiceButtonAction()`이 정하고, 파장은 `AnalyserNode` 신호를 녹음 대상 패인의 캔버스에 그린다.

**Tech Stack:** 바닐라 JS(`crates/mycli-desktop/frontend/app.js`), CSS(`style.css`), Node 검사 스크립트(vm), 헤드리스 Chrome 하네스(CDP).

**Spec:** `docs/superpowers/specs/2026-11-20-pane-mic-button-design.md`

## Global Constraints

- 녹음 중 글자("녹음 중") 표시 금지. 파장만 보인다.
- 인식 결과는 붙여 넣기만 하고 Enter를 보내지 않는다(`term.paste(text)`, 기존과 동일).
- 한 번에 하나만 녹음한다.
- 엔진·모델·언어는 팝오버 설정을 그대로 쓴다. Ctrl+Space와 팝오버 녹음 버튼의 동작은 바뀌지 않는다.
- 패인이 좁아져도 마이크 버튼은 숨기지 않는다(`.close`와 같은 취급).

## Review Focus

1. 녹음 중 대상 패인이 닫힘 → 녹음을 멈추고 결과는 어디에도 넣지 않는다(다른 패인에 들어가면 안 됨).
2. 마이크 권한 거부·장치 없음 → 버튼이 🎙 상태로 돌아오고 알림으로 이유를 보여 준다. 파장 루프·오디오 처리가 남지 않는다.
3. 인식 중에 다시 누름 → 무시한다(두 번째 녹음이 겹쳐 시작되면 안 됨).
4. 녹음 중 다른 패인 버튼 누름 → 진행 중 녹음을 멈추고 원래 패인에 넣는다. 새 녹음은 시작하지 않는다.
5. Ctrl+Space로 녹음 중일 때 그 패인 버튼 → 같은 녹음으로 취급해 멈춘다(상태가 하나라서 버튼에도 파장이 보인다).

---

### Task 1: 버튼 동작 판정 함수

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` (음성 입력 블록, `setupVoiceInput` 앞)
- Create: `scripts/check-voice-buttons.mjs`

**Interfaces:**
- Produces: `voiceButtonAction(state, paneId) -> "start" | "stop" | "ignore"`. `state`는 `{ phase: "idle" | "recording" | "transcribing", target: number | null }`.

- [ ] **Step 1: 실패하는 검사 작성** — `app.js`에서 `function voiceButtonAction(` 부터 다음 빈 줄 두 개 전까지를 vm으로 불러와 확인한다.

```js
assert.equal(voiceButtonAction({ phase: "idle", target: null }, 3), "start");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 3), "stop");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 5), "stop"); // Review Focus 4
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 3), "ignore"); // Review Focus 3
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 5), "ignore");
```

- [ ] **Step 2: 실행해서 실패 확인** — `node scripts/check-voice-buttons.mjs` → "voiceButtonAction not found" 로 실패.
- [ ] **Step 3: `voiceButtonAction` 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령, 마지막 줄 `Voice button checks passed`.
- [ ] **Step 5: 커밋** — `feat(voice): decide what a pane mic click does`

### Task 2: 공용 녹음 제어 + 패인 버튼 + 파장

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js` — `setupVoiceInput()`의 녹음부(현 `rec.onpointerdown` ~ Ctrl+Space 처리), `createPane()`의 상단 표시줄 HTML(`<span class="pane-actions">`), `closePane()`
- Modify: `crates/mycli-desktop/frontend/style.css` — `.pane-mic`, 좁은 패인 컨테이너 쿼리

**Interfaces:**
- Consumes: Task 1의 `voiceButtonAction`.
- Produces (모듈 수준, `kickPtyPump`처럼 기본값을 두고 `setupVoiceInput`에서 채움):
  - `let voiceState = { phase: "idle", target: null }`
  - `let voiceStart = async (paneId) => {}`, `let voiceStop = () => {}`
  - `function onPaneMicClick(paneId)` — `voiceButtonAction` 결과대로 `voiceStart`/`voiceStop` 호출
  - `function renderPaneMicButtons()` — 모든 패인의 `.pane-mic`에 `recording`/`transcribing` 클래스 반영
- 패인 버튼 마크업: `<button class="pane-btn pane-mic" title="음성 입력 (누르면 녹음, 다시 누르면 인식)"><span class="pane-mic-icon">🎙</span><canvas class="pane-mic-wave" width="56" height="16"></canvas></button>` — 분할 버튼 앞.

- [ ] **Step 1: 녹음부를 `voiceStart(paneId)`/`voiceStop()`으로 옮긴다.** 팝오버 `rec.onpointerdown`은 `voiceStart(focusedPaneId)`, `onpointerup`은 `voiceStop()`을 부른다. 대상은 시작 시점에 `voiceState.target`으로 고정하고, 인식 후 `terminals.has(target)`일 때만 붙여 넣는다. 녹음 시작 시 `AudioContext` + `createMediaStreamSource` + `AnalyserNode(fftSize 256)`를 만들고, 끝나면(정상·실패 모두) 루프 취소·`AudioContext.close()`·트랙 정지.
- [ ] **Step 2: 파장 그리기** — `requestAnimationFrame` 루프에서 `getByteTimeDomainData`로 대상 패인 `.pane-mic-wave`에 선을 그린다(색은 `--accent`, 진폭 0일 때 가운데 수평선). 녹음 중에는 아이콘 숨기고 캔버스 표시, 인식 중에는 아이콘 흐리게 + 점 애니메이션(CSS), idle이면 🎙.
- [ ] **Step 3: 패인 버튼 연결** — 클릭 시 `e.stopPropagation()` 후 `onPaneMicClick(id)`. 상단 표시줄 드래그 시작 조건은 이미 `.pane-btn`을 제외한다.
- [ ] **Step 4: 녹음 중 패인 닫힘** — `closePane(id)`에서 `voiceState.target === id`이면 결과를 버리도록 표시하고 `voiceStop()` (Review Focus 1).
- [ ] **Step 5: CSS** — `.pane-mic.recording .pane-mic-icon { display:none }`, `.pane-mic-wave { display:none }` / `.recording .pane-mic-wave { display:inline-block }`, 인식 중 점 애니메이션. 기존 `@container` 규칙이 `.pane-mic`을 숨기지 않는지 확인.
- [ ] **Step 6: 기존 검사 통과 확인** — `node --check crates/mycli-desktop/frontend/app.js && node scripts/check-voice-buttons.mjs && node scripts/terminal-harness/run-all.mjs` → 모두 ok.
- [ ] **Step 7: 커밋** — `feat(voice): mic button with live waveform on every pane`

### Task 3: 실제 Chromium 검증

**Files:**
- Modify: `scripts/terminal-harness/harness.mjs` — `boot(dir, { chromeArgs })` 옵션 추가
- Modify: `scripts/terminal-harness/stub.js` — `voice_managed_status`(`{ python: "C:/stub/python.exe", models: ["small"] }`), `voice_transcribe_local`(인자 기록 후 `"안녕하세요"` 반환)
- Create: `scripts/terminal-harness/voice-pane-button.mjs`; Modify: `run-all.mjs`에 추가

- [ ] **Step 1: 하네스 작성** — Chrome 인자 `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, localStorage에 `mymux.voice.provider=faster-whisper`, `mymux.voice.localMode=python`, `mymux.voice.runner.python=C:/stub/python.exe` 넣고 다시 불러온 뒤 패인 2개로 분할. 확인 항목:
  - 포커스되지 않은 패인의 `.pane-mic` 실제 마우스 클릭 → 그 버튼에 `recording`, 0.6초 동안 캔버스 픽셀이 두 번 이상 바뀜(파장이 움직임), 버튼 안에 "녹음" 글자 없음
  - 다시 클릭 → `transcribing` → `voice_transcribe_local` 1회 호출, `pty_write` 대상 id가 클릭한 패인이고 데이터가 `"안녕하세요"`이며 `\r` 없음, 다른 패인에는 쓰기 없음
  - 녹음 중 다른 패인 버튼 클릭 → 원래 패인에 입력, 새 녹음 없음
  - 녹음 중 그 패인 닫기 → 어떤 패인에도 입력 없음, 버튼 상태 idle
  - `navigator.mediaDevices.getUserMedia`를 거부하도록 바꾼 뒤 클릭 → 버튼 idle 유지, 알림 표시, `voiceState.phase === "idle"` (Review Focus 2)
- [ ] **Step 2: 실행** — `node scripts/terminal-harness/run-all.mjs` → 7개 모두 ok.
- [ ] **Step 3: 커밋** — `test(voice): pane mic button end to end with a fake microphone`
