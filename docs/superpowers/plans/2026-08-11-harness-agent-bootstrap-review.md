# 설치 시 harness / agent 자동 셋팅 — 실현 가능성 검토

작성 2026-08-11. **검토 단계 — 구현 미착수.**

## 무엇을 하려는 것인가

초보자가 Mymux를 설치하면, AI CLI(Claude Code / Codex)를 바로 쓸 수 있도록
GitHub에 정리해 둔 harness(에이전트·스킬·프로젝트 지침) 묶음이 자동으로
깔려 있게 하는 것. 사용자가 별도 설정 없이 "설치 → 실행 → 바로 작업"이
되도록 돕는 온보딩 기능이다.

## 결론

**가능하다. 단 "설치 프로그램"이 아니라 "첫 실행 마법사"로 구현해야 한다.**

NSIS 설치 훅(`crates/mycli-desktop/installer-hooks.nsh`)에서 처리하면 안 되는
이유:

- 설치 관리자는 승격된 권한/다른 사용자 컨텍스트로 돌 수 있어, 파일이 엉뚱한
  홈 디렉터리(`~/.claude`)에 떨어질 수 있다.
- 동의를 받거나 무엇이 설치되는지 보여줄 UI가 없다. 사용자의 기존 AI 설정을
  말없이 건드리는 셈이 된다.
- macOS(dmg)·Linux(deb/AppImage)에는 NSIS가 없다. Windows 전용 반쪽 기능이 된다.

## 이미 있는 부품 (새로 만들 게 적다)

| 필요한 것 | 이미 있는 것 |
| --- | --- |
| 첫 실행 온보딩 화면 | `maybeShowStartupGuide()` (`frontend/app.js`) — claude/codex 미설치 시 설치 안내 패인을 띄운다 |
| CLI 설치 여부 판별 | `tool_installed` (`src/tools.rs`) — PATH + PATHEXT 탐색 |
| "한 번만 씨딩, 사용자가 지우면 존중" | `seed_default_commands()` + `~/.mycli/.defaults_seeded` 마커 (`src/commands.rs`) |
| GitHub에서 받아오기 | 업데이터 (`src/update.rs`) |
| 앱과 함께 파일 배포 | Tauri `bundle.resources` (현재 conpty.dll / OpenConsole.exe 배포에 사용 중) |
| `~/.claude` 위치 파악 | `claude_account_usage` (`src/commands.rs`) — `CLAUDE_CONFIG_DIR` 존중, 읽기 전용 |

## 무엇을 깔 것인가 — 위험도별 구분

### 1단계: 안전 (v1 권장)

파일을 **새로 추가**하기만 하므로 기존 설정을 깨뜨릴 수 없다.

- `~/.claude/agents/mymux-*.md` — 서브에이전트 정의
- `~/.claude/skills/mymux-*/SKILL.md` — 스킬
- 프로젝트용 `CLAUDE.md` 템플릿 (새 폴더에서 시작할 때 복사)

`mymux-` 접두사로 네임스페이스를 잡아 사용자의 기존 에이전트와 이름이
충돌하지 않게 한다.

### 2단계: 중간 (플러그인)

oh-my-claudecode / superpowers 같은 플러그인은 **설정 파일을 직접 편집하지
말고**, Mymux 패인에 `claude plugin marketplace add …` 명령을 타이핑해서
실행시킨다. Mymux엔 이미 패인에 명령을 입력·실행하는 기능이 있다.
설치 과정과 실패가 사용자 화면에 그대로 보이므로 디버깅이 쉽고, Claude Code의
설정 포맷이 바뀌어도 우리 코드가 깨지지 않는다.

### 3단계: 위험 (v1에서 제외 권장)

`~/.claude/settings.json`의 hooks 병합. OMC가 이미 훅을 관리하고 있고 과거에
훅 경로 문제로 전부 깨진 이력이 있다. 잘못 병합하면 사용자의 기존 Claude
설정을 망가뜨린다. 꼭 해야 한다면 수정 전 백업이 필수다.

## 지켜야 할 안전 규칙

1. **옵트인** — 첫 실행 시 체크박스로 물어본다. 기본 동작으로 몰래 하지 않는다.
2. **덮어쓰기 금지** — 이미 있는 파일은 절대 건드리지 않는다. 없을 때만 쓴다.
3. **미리보기** — 무엇이 어디에 설치되는지 목록을 먼저 보여준다.
4. **제거 버튼** — 설치한 파일 목록을 기록해 두고 되돌릴 수 있게 한다.
5. **마커 + 버전** — `~/.mycli/.harness_seeded`에 팩 버전을 기록해, 갱신 시
   새 항목만 추가하고 사용자가 지운 항목은 되살리지 않는다
   (`seed_default_commands`와 동일한 규칙).

## 배포 방식

**앱에 고정 팩을 번들 + GitHub에서 갱신**하는 하이브리드를 권장한다.

- 번들: 오프라인에서도 동작하고, 버전이 앱과 함께 고정돼 재현 가능하다.
- GitHub: 앱을 새로 릴리즈하지 않고도 팩을 갱신할 수 있다. 반드시 고정된
  리포지터리/태그에서만 받아야 한다(임의 URL 입력 허용 금지).

## 예상 작업량

- Rust `harness_seed` 커맨드 (목록 조회 / 설치 / 제거) — 150~250줄
- 첫 실행 마법사 모달 (`app.js` + `style.css`)
- 팩 콘텐츠 (에이전트·스킬 문서)

대략 하루 규모.
