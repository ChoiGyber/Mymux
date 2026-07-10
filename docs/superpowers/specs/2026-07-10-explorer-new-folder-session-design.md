# Explorer: 새 폴더 만들기 + 세션 오픈 모달

## 목적
로컬 탐색기에서 폴더를 만들고, 필요하면 그 자리에서 바로 터미널 세션을 열 수 있게 한다.

## UI
- `explorer-nav` 줄(뒤로/앞으로/위/경로 옆)에 `+` 버튼 추가. id=`btn-explorer-newfolder`.
- SFTP 모드(`currentSftpId != null`)에서는 버튼을 숨김(local 전용).

## 모달 (통합 1개)
`+` 클릭 시 모달 오픈. 내용:
- 폴더명 입력 필드(자동 포커스, Enter로 확인 트리거)
- "세션을 열까요?" 체크박스 (기본 체크 ON)
- 체크 ON일 때만 보이는 라디오: "새 탭" / "지금 탭" (기본값: 지금 탭)
- 취소 / 확인 버튼

동작:
- 취소 → 모달 닫고 아무 것도 안 함
- 확인:
  1. 폴더명이 비어있거나 `/`, `\` 등 구분자를 포함하면 인라인 에러 표시하고 모달 유지
  2. 백엔드 `fs_create_dir(dir_path, name)` 호출 → 이미 존재하면 에러 문자열 반환, 모달 내 인라인 에러로 표시(모달 유지)
  3. 성공 시 `loadExplorer()`로 목록 새로고침, 모달 닫기
  4. "세션을 열까요?" 체크가 켜져 있으면 새로 만든 폴더 경로로 세션 오픈:
     - "지금 탭" 선택 → 기존 `cdToTerminal(path)`와 동일한 분기(활성 탭+포커스 pane 있으면 `splitPane`, 없으면 새 탭)
     - "새 탭" 선택 → 무조건 `spawnTerminal(undefined, path)`로 새 탭에 오픈

## 백엔드
`crates/mycli-desktop/src/commands.rs`에 추가:
```rust
#[tauri::command]
pub fn fs_create_dir(dir: String, name: String) -> Result<String, String> {
    // dir/name 조합, 빈 이름/구분자 거부, 이미 존재하면 에러, std::fs::create_dir로 생성, 새 경로 문자열 반환
}
```
`fs_copy_path`/`fs_move_path`와 동일한 스타일(에러는 `Result<_, String>`으로 사용자 표시 문구).

`crates/mycli-desktop/src/main.rs`의 `invoke_handler`에 `commands::fs_create_dir` 등록.

## 프론트엔드 변경
- `index.html`: `explorer-nav`에 `+` 버튼 추가, 새 폴더 모달 마크업 추가(다른 모달과 동일한 `.modal-overlay` 구조 재사용).
- `app.js`:
  - 버튼 클릭 핸들러 → 모달 오픈 함수(폴더명 인풋 초기화·포커스, 체크박스/라디오 기본값 세팅)
  - 확인 핸들러 → 위 동작 순서대로 `invoke("fs_create_dir", ...)` 호출 → 성공 시 `loadExplorer()` + 세션 오픈 분기
  - SFTP 모드 전환 시 `+` 버튼 표시/숨김 동기화(`syncExplorerNav()`에 추가)

## 테스트
- 수동 QA: 로컬 탐색기에서 `+` → 폴더 생성 → 지금 탭에 세션 열림 확인, 새 탭 옵션 확인, 이름 중복/빈 이름 에러 확인, SFTP 모드에서 버튼 숨김 확인.
