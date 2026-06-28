# Changelog

All notable changes to **Mymux** are documented here.
Mymux의 주요 변경 사항을 기록합니다.

For installers, see the [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases).
설치 파일은 [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)에서 받으세요.

---

## v0.1.9 — 2026-06-28

### Fixed / 버그 수정
- **First-session prompt cursor misalignment / 시작 직후 첫 세션의 프롬프트 커서 정렬 오류.**
  앱을 켜고 **처음 생성되는 터미널**에서 깜빡이는 커서가 `$` 프롬프트 끝이 아니라
  그 왼쪽에 그려지던 문제. (앱 실행 중 새로 연 세션은 정상이었습니다.)

  The very first terminal opened at startup drew its blinking cursor a few
  columns **left of the `$`** instead of after it. Sessions opened later were
  fine.

  - **원인 / Root cause:** 첫 세션은 `document.fonts.ready` 보정 패스가 끝난
    *뒤*에 만들어져 폰트 재측정을 받지 못했고, 그 세션에 유일하게 적용되던
    `refitAllPanes()`(=`fit()`)는 열·행만 다시 잡을 뿐 xterm이 캐싱한 **문자 셀
    크기(char-cell metric)를 재측정하지 않습니다.** 그래서 임베드 폰트(D2Coding)와
    레이아웃이 안정되기 전에 측정된 stale 셀 메트릭으로 첫 프롬프트를 그려 커서가
    몇 칸 어긋났습니다.

    The first session is created *after* the `document.fonts.ready` pass runs, so
    it never got a font re-measure. Its only correction — `refitAllPanes()` —
    calls `fit()`, which re-grids cols/rows but does **not** re-measure xterm's
    cached character cell. The pane kept a stale metric (taken before the
    embedded font and layout settled) and rendered the cursor off by a few cells.

  - **수정 / Fix:** `remeasureFontCells()`를 추가했습니다. 각 터미널의 `fontSize`를
    토글(Ctrl +/- 와 동일 경로)해 xterm이 문자 셀을 **강제로 재측정**하게 하고,
    texture atlas를 갱신한 뒤 refit 합니다. 이 보정은 `document.fonts.ready`
    시점과 **세션 복원 직후**(레이아웃 안정 시) 모두 실행되어, 시작 시 첫 세션도
    올바른 셀 크기로 그려집니다.

    Added `remeasureFontCells()`, which toggles each terminal's `fontSize` (the
    same path Ctrl +/- uses) to force xterm to re-measure the cell, then clears
    the texture atlas and refits. It now runs on `document.fonts.ready` **and**
    again after session restore settles, so the startup session is corrected.

### Notes / 참고
- v0.1.8에서 시도한 불필요한 `ESC[1;1R` 커서 위치 보고 제거는 **실제 원인이 아니었습니다**
  (헛다리). 0.1.7·0.1.8에서 동일한 증상이 났던 이유가 바로 위의 stale 셀 메트릭이며,
  이번 릴리즈에서 근본 원인을 수정했습니다.

  The v0.1.8 change (removing an unsolicited `ESC[1;1R` cursor report) addressed a
  red herring — the misalignment persisted on both 0.1.7 and 0.1.8 because the
  real cause was the stale cell metric above, now fixed.

---

## Earlier releases / 이전 릴리즈
See the commit history and [GitHub Releases](https://github.com/ChoiGyber/Mymux/releases)
for v0.1.8 and earlier.
v0.1.8 이하의 변경 내역은 커밋 기록과 GitHub Releases를 참고하세요.
