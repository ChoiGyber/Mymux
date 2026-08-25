## 작업 요약

Commands 패널을 컴팩트하게 만들고 표시/숨김 토글과 드래그 이동을 추가했습니다.

## 변경 사항

- Commands 탭 폭과 글자 크기 축소
- 눈 모양 표시/숨김 버튼 추가
- 표시 상태 localStorage 저장
- 헤더 드래그 시 플로팅 패널로 이동
- 위치 localStorage 저장
- Dock 버튼으로 원래 사이드바 위치 복귀

## 검증

- `node --check` 통과
- `cargo check -p mycli-desktop --locked` 통과
- DOM ID 검증 통과
- 별도 개발 실행 파일 생성 및 실행 확인
- Computer Use native pipe 연결 실패로 실제 클릭/드래그 검증은 미실행
