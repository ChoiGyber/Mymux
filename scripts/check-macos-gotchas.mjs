#!/usr/bin/env node
// macOS(WKWebView) 가드 검사 — docs/macos-webkit-gotchas.md 의 "현재 코드" 불변조건이
// 소스에 아직 살아있는지 빌드 전에 확인한다. 하나라도 사라지면 실패(exit 1).
//
//   node scripts/check-macos-gotchas.mjs        # 리포 루트 자동 탐지(스크립트 위치 기준)
//   node scripts/check-macos-gotchas.mjs <root> # 다른 체크아웃 검사(테스트용)
//
// CI: ci.yml(macos-gotchas job), release.yml, macos-build.yml 에서 빌드 전에 실행.
// 이 검사는 정적 가드일 뿐이다 — WKWebView 런타임 동작(한글 조합 등)은 못 잡으므로
// 릴리즈 전 §5 수동 스모크 테스트는 여전히 필수.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const FILES = {
  app: "crates/mycli-desktop/frontend/app.js",
  commands: "crates/mycli-desktop/src/commands.rs",
  caps: "crates/mycli-desktop/capabilities/default.json",
  conf: "crates/mycli-desktop/tauri.conf.json",
};

const srcs = {};
let readFailed = false;
for (const [key, rel] of Object.entries(FILES)) {
  try {
    srcs[key] = readFileSync(resolve(root, rel), "utf8");
  } catch (err) {
    console.error(`✘ ${rel} 을(를) 읽을 수 없음: ${err.message}`);
    readFailed = true;
  }
}
if (readFailed) process.exit(1);

// 각 항목: docs/macos-webkit-gotchas.md 의 해당 절(§) 참조.
const checks = [
  {
    id: "§1 한글 IME fix 블록 (첫 자모 seed + insertReplacementText 재경로)",
    file: "app",
    ok: (s) =>
      s.includes("insertReplacementText") &&
      s.includes('addEventListener("beforeinput"') &&
      s.includes("compositionend"),
    hint: "createPane() 안 `if (IS_MAC)` IME 블록이 없어졌거나 리스너가 바뀜. 맥에서 한글이 자모로 분리된다.",
  },
  {
    id: "§1 IME 재경로가 xterm 파이프라인 경유 (raw pty_write 단독 금지)",
    file: "app",
    ok: (s) => s.includes("term.input(") || s.includes("triggerDataEvent("),
    hint: "IME 재전송은 term.input()/coreService.triggerDataEvent() 로만. PTY 직송은 명령추적·약어 자동완성을 깨뜨린다(v1 실패 사례).",
  },
  {
    id: "§3 startFocusKeeper 는 macOS 에서 skip",
    file: "app",
    ok: (s) => {
      const m = s.match(/function startFocusKeeper\(\)\s*\{([\s\S]{0,900})/);
      return !!m && m[1].includes("if (IS_MAC) return;");
    },
    hint: "startFocusKeeper() 도입부의 `if (IS_MAC) return;` 이 사라짐. 맥에서 blur+refocus 루프가 돌면 조합이 자모 단위로 커밋된다.",
  },
  {
    id: "§3 조합 중 refocus 억제 (imeComposing 플래그)",
    file: "app",
    ok: (s) => s.includes("imeComposing = true") && s.includes("t.imeComposing"),
    hint: "compositionstart/end 로 세우는 imeComposing 플래그(조합 중 blur/refocus 금지)가 사라짐.",
  },
  {
    id: "§4 macOS letter-spacing 0 강제",
    file: "app",
    ok: (s) => /effectiveLetterSpacing[\s\S]{0,200}?IS_MAC \? 0/.test(s),
    hint: "effectiveLetterSpacing() 의 `IS_MAC ? 0` 이 사라짐. WebKit 은 letter-spacing 을 셀 폭에 안 접어 커서가 어긋난다.",
  },
  {
    id: "§4 macOS 폰트 체인 SF Mono 우선",
    file: "app",
    ok: (s) => s.includes('"SF Mono"'),
    hint: "맥 시스템 폰트 스택에서 SF Mono 가 빠짐(D2Coding 은 맥에서 너무 넓다).",
  },
  {
    id: "§2 Claude 자격증명 Keychain fallback",
    file: "commands",
    ok: (s) => s.includes("find-generic-password") && s.includes("Claude Code-credentials"),
    hint: "read_claude_credentials() 의 macOS Keychain(security find-generic-password) fallback 이 사라짐. 맥에서 사용량 배지가 안 뜬다.",
  },
  {
    id: "§4 클립보드 capability",
    file: "caps",
    ok: (s) =>
      s.includes("clipboard-manager:allow-write-text") &&
      s.includes("clipboard-manager:allow-read-text"),
    hint: "capabilities/default.json 의 clipboard-manager 권한이 빠짐. 맥에서 드래그복사/우클릭 붙여넣기가 죽는다.",
  },
  {
    id: "§4 withGlobalTauri",
    file: "conf",
    ok: (s) => /"withGlobalTauri"\s*:\s*true/.test(s),
    hint: "tauri.conf.json 의 withGlobalTauri 가 꺼짐. window.__TAURI_PLUGIN_CLIPBOARD_MANAGER__ 전역이 사라진다.",
  },
];

let failures = 0;
for (const c of checks) {
  const pass = c.ok(srcs[c.file]);
  if (pass) {
    console.log(`✔ ${c.id}`);
  } else {
    failures++;
    console.error(`✘ ${c.id}  [${FILES[c.file]}]`);
    console.error(`  → ${c.hint}`);
    console.error("  → 자세한 배경: docs/macos-webkit-gotchas.md");
  }
}

if (failures > 0) {
  console.error(`\n${failures}개 가드 소실 — macOS 빌드가 또 깨질 상태다. 고치기 전에 빌드하지 말 것.`);
  process.exit(1);
}

console.log(`\n모든 macOS 가드 통과 (${checks.length}/${checks.length}).`);
console.log("주의: 이건 정적 검사다. 릴리즈 전 macOS 실기 스모크 테스트(§5)는 여전히 필수:");
console.log("  - zsh/Claude/Codex 에서 한글 “사도행전” 첫 글자부터 정상 조합 + Backspace");
console.log("  - 약어 입력 시 자동입력 없이 선택 대기 / 드래그복사·우클릭 붙여넣기 / 사용량 배지");
