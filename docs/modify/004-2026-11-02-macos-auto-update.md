---
id: 004
date: 2026-11-02
title: 맥 자동 업데이트 복구 — 릴리즈 때 맥 빌드 자동 실행 + latest.json 에 darwin 추가 · 맥 설치본 0.1.55 → 0.3.4 교체
type: infra
tags: [macos, updater, latest-json, release, ci]
commits: []
version: 0.3.4
---

# 맥 자동 업데이트 복구

사용자가 맥에서 Mymux 쉘을 처음 열면 입력이 Tab 처럼 밀리고 원하는 글자가 들어가지 않는다고 신고했다. 확인해 보니 맥에 설치된 `/Applications/Mymux.app` 이 **0.1.55(2026-08-11 설치)** 였다. 저장소는 0.3.4 까지 나와 있었다.

## 원인 — 맥은 업데이트 대상이 아니었다

- 앱 업데이터는 `releases/latest/download/latest.json` 을 보는데, v0.3.4 의 `latest.json` 에는 `linux-*`·`windows-*` 만 있고 `darwin-*` 가 없었다. 설치된 맥 앱은 새 버전이 있다는 것을 알 수 없다.
- `macos-build.yml` 은 의도적으로 `latest.json` 을 건드리지 않았고(주석: "the auto-updater manifest is Windows-only"), RELEASING.md §3.6 의 "darwin 블록을 손으로 추가" 단계는 매 릴리즈 빠졌다.
- v0.3.3 은 맥 dmg 자체가 올라가지 않았다(맥 빌드가 수동 단계였기 때문).

## 수정

| 파일 | 내용 |
|------|------|
| `scripts/add-macos-updater.mjs` (신규) | 릴리즈의 `latest.json` 에 `darwin-aarch64`·`darwin-aarch64-app`·`darwin-x86_64`·`darwin-x86_64-app` 을 universal 아카이브 url/서명으로 추가. 다른 플랫폼은 그대로 두고, `latest.json` 의 version 이 태그와 다르면 실패한다. |
| `.github/workflows/macos-build.yml` | `workflow_call` 추가. dmg 와 함께 `Mymux.app.tar.gz` 업로드, 이어서 `latest.json` 을 내려받아 위 스크립트로 병합 후 `--clobber` 재업로드. 스크립트는 워크플로 자신의 커밋(`github.sha`)에서 sparse checkout — 예전 태그를 손으로 다시 빌드할 때 그 태그에 스크립트가 없기 때문. 태그 입력은 `env` 로 전달. |
| `.github/workflows/release.yml` | `macos` 잡 추가: `needs: release`(Windows/Linux 가 `latest.json` 을 쓴 뒤), 태그 푸시일 때만, `macos-build.yml` 호출 + `secrets: inherit`. |
| `RELEASING.md` | 맥은 자동, 기존 수동 절차는 fallback 으로. 수동 업로드 시에도 스크립트로 `latest.json` 병합. |

## 맥 설치본 교체 (현장 조치)

- 기존 앱을 `~/.mycli/backup-20261102/Mymux-0.1.55.app` 으로 옮기고, v0.3.4 릴리즈의 `Mymux_0.3.4_universal.dmg` 에서 `/Applications/Mymux.app` 설치(`codesign --verify --deep` 통과, ad-hoc 서명이라 quarantine 제거).
- 실행 중이던 0.1.55 인스턴스(10/29 부터 실행, 작업 중인 Claude Code 세션이 그 안에 있음)는 종료하지 않았다. 사용자가 Mymux 를 재시작하면 0.3.4 로 뜬다.

## 검증

- 실제 v0.3.4 `latest.json` 으로 스크립트 실행: 기존 5개 플랫폼 그대로 + darwin 4개 추가 확인. 태그 불일치(v0.3.5) 시 AssertionError 로 중단 확인.
- 두 워크플로 YAML 파싱 확인, `scripts/check-macos-gotchas.mjs` 통과.
- 쉘 입력 오류: Mymux zsh 래퍼를 실제 pty 에서 첫 접속·리사이즈·조기 입력으로 재현 → 0.3.4 프롬프트는 커서 위치 정상. 0.1.55 에서의 실제 증상 재현은 하지 않았다. 0.3.4 로 재시작 후 사용자 확인 필요.

## 남은 일

- v0.3.4 에 맥 업데이트를 적용하려면 이 변경을 main 에 푸시한 뒤 `gh workflow run macos-build.yml -f tag=v0.3.4` 실행.
- CI 맥 빌드는 ad-hoc 서명(notarize 없음). 업데이터의 minisign 검증과는 별개라 자동 업데이트는 동작한다.
