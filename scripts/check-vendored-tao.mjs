#!/usr/bin/env node
// 벤더링한 tao 가드 검사 — 이슈 #36 의 데드락 수정이 vendor/tao 에 아직 살아있는지
// 빌드 전에 확인한다. 하나라도 사라지면 실패(exit 1).
//
//   node scripts/check-vendored-tao.mjs        # 리포 루트 자동 탐지(스크립트 위치 기준)
//   node scripts/check-vendored-tao.mjs <root> # 다른 체크아웃 검사(테스트용)
//
// 왜 필요한가: vendor/tao 는 crates.io 사본이라 누군가 버전을 올리려고 통째로
// 다시 복사하면 패치가 흔적 없이 사라진다. 그러면 앱은 멀쩡히 빌드되고, 한글 IME
// 입력 중 포커스가 바뀔 때만 영구 무응답으로 죽는다 — CI 가 절대 못 잡는 형태다.
//
// 없애도 되는 시점: tauri 가 tao 0.36 이상에 올라탄 릴리즈를 내면 vendor/tao 와
// 루트 Cargo.toml 의 [patch.crates-io] 를 지우고 이 스크립트도 함께 지운다.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const FILES = {
  workspace: "Cargo.toml",
  vendorManifest: "vendor/tao/Cargo.toml",
  eventLoop: "vendor/tao/src/platform_impl/windows/event_loop.rs",
  keyboard: "vendor/tao/src/platform_impl/windows/keyboard.rs",
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
if (readFailed) {
  console.error("\nvendor/tao 가 통째로 사라졌거나 경로가 바뀌었다. 이슈 #36 을 먼저 읽을 것.");
  process.exit(1);
}

// LAYOUT_CACHE 가드가 PeekMessageW 호출을 건너 살아있는지 구조적으로 확인한다.
// 가드를 잡은 줄과 PeekMessageW 줄 사이에, 가드보다 얕은 들여쓰기의 닫는 중괄호가
// 있어야 스코프가 닫힌 것이다.
function layoutCacheHeldAcrossPeek(source) {
  const lines = source.split(/\r?\n/);
  const indentOf = (line) => line.length - line.trimStart().length;
  const offenders = [];

  lines.forEach((line, i) => {
    if (!line.includes("PeekMessageW(")) return;
    let lockLine = -1;
    for (let j = i - 1; j >= 0 && i - j <= 60; j--) {
      if (lines[j].includes("LAYOUT_CACHE.lock()")) {
        lockLine = j;
        break;
      }
    }
    if (lockLine === -1) return;

    const lockIndent = indentOf(lines[lockLine]);
    const closed = lines
      .slice(lockLine + 1, i)
      .some((l) => /^\s*\}\s*;?\s*$/.test(l) && indentOf(l) < lockIndent);
    if (!closed) offenders.push({ peek: i + 1, lock: lockLine + 1 });
  });

  return offenders;
}

const held = layoutCacheHeldAcrossPeek(srcs.keyboard);

const checks = [
  {
    id: "[patch.crates-io] 가 vendor/tao 를 가리킨다",
    ok: () =>
      /\[patch\.crates-io\]/.test(srcs.workspace) &&
      /tao\s*=\s*\{\s*path\s*=\s*"vendor\/tao"\s*\}/.test(srcs.workspace),
    hint: "루트 Cargo.toml 의 패치가 빠졌다. 빌드가 crates.io 의 안 고쳐진 tao 를 쓴다.",
  },
  {
    id: "벤더 사본이 tao 0.35.3 이다",
    ok: () => /^version\s*=\s*"0\.35\.3"$/m.test(srcs.vendorManifest),
    hint:
      "vendor/tao 버전이 바뀌었다. 새 버전에 이 패치가 필요한지 먼저 확인할 것 " +
      "(tao 0.36+ 는 업스트림에서 이미 고쳐졌으니 그때는 벤더링 자체를 걷어낸다).",
  },
  {
    id: "KEY_EVENT_BUILDERS 를 빌려 쓰는 헬퍼가 있다",
    ok: () =>
      /pub\(crate\) fn with_key_event_builder/.test(srcs.keyboard) &&
      /struct BorrowedBuilder/.test(srcs.keyboard) &&
      /impl Drop for BorrowedBuilder/.test(srcs.keyboard),
    hint: "with_key_event_builder / BorrowedBuilder 가 사라졌다. 전역 락이 다시 오래 잡힌다.",
  },
  {
    id: "event_loop.rs 가 전역 맵 락을 직접 잡지 않는다",
    ok: () =>
      !/KEY_EVENT_BUILDERS\s*\.?\s*\n?\s*\.lock\(\)/.test(srcs.eventLoop) &&
      /with_key_event_builder\(/.test(srcs.eventLoop),
    hint:
      "event_loop.rs 가 KEY_EVENT_BUILDERS.lock() 을 다시 직접 잡는다. " +
      "process_message 안의 PeekMessageW 가 재진입하면 그 자리에서 영구 데드락이다.",
  },
  {
    id: "LAYOUT_CACHE 가드가 PeekMessageW 를 건너 살아있지 않다",
    ok: () => held.length === 0,
    hint:
      "keyboard.rs 에서 LAYOUT_CACHE 가드를 쥔 채 PeekMessageW 를 부른다: " +
      held.map((o) => `lock L${o.lock} → peek L${o.peek}`).join(", "),
  },
  {
    id: "재진입 회귀 테스트가 남아있다",
    ok: () => /fn reentrant_lookup_returns_instead_of_blocking/.test(srcs.keyboard),
    hint: "vendor/tao 의 재진입 회귀 테스트가 사라졌다. cargo test -p tao --lib 로 지켜지던 불변조건이다.",
  },
];

let failures = 0;
for (const c of checks) {
  if (c.ok()) {
    console.log(`✔ ${c.id}`);
  } else {
    failures++;
    console.error(`✘ ${c.id}`);
    console.error(`  → ${c.hint}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures}개 가드 소실 — 한글 IME 입력 중 포커스가 바뀌면 앱이 영구 무응답이 될 상태다.`
  );
  console.error("  → 배경: https://github.com/ChoiGyber/Mymux/issues/36");
  process.exit(1);
}

console.log(`\n벤더 tao 가드 전부 통과 (${checks.length}/${checks.length}).`);
