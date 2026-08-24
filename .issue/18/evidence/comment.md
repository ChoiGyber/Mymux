## 작업 요약

전역 Tauri 2 CLI를 업데이트했습니다.

## 검증

- `cargo install tauri-cli --version 2.11.4 --force --jobs 1` 완료
- `cargo tauri --version` 결과: `tauri-cli 2.11.4`
- `cargo metadata --format-version 1 --no-deps` 통과
- 프로젝트 Tauri 의존성은 이미 `tauri ^2.11.5`, `tauri-build ^2.6.3`으로 최신 상태여서 소스 변경 없음
