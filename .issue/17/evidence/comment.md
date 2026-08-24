## 작업 요약

Electron을 `43.4.1`, electron-builder를 `26.15.3`으로 업데이트했습니다.

## 검증

- TypeScript build 통과
- Electron `v43.4.1` 실행 및 6초 생존 확인
- production dependency audit 0 vulnerabilities
- Windows portable 패키징은 `node-pty` native rebuild에서 MSB8040으로 차단됨

## 변경 파일

- `package.json`
- `package-lock.json`

## 미해결 환경 조건

설치된 Visual Studio Build Tools에 Spectre 완화 라이브러리를 추가한 뒤 `npm run package:portable` 재실행이 필요합니다.
