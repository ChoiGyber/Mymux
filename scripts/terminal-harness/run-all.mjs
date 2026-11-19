#!/usr/bin/env node
// Runs the real-Chromium checks for terminal input and the browser panel against
// the working tree's frontend (or the directory given as the first argument).
//
//   node scripts/terminal-harness/run-all.mjs [frontendDir]
//
// Each check boots the real app.js in headless Chrome with a stubbed Tauri IPC
// (stub.js) and drives it through CDP, so IME, focus and timing behave as they do
// in WebView2. Needs Chrome at the path in harness.mjs. Not wired into CI: it
// needs a browser, and a few seconds per check.
//
// What each one caught on v0.3.8:
//   ime-overlap        every Hangul syllable after the first drawn on the previous one
//   ime-anchor-cases   preview position on wrap, deletion, scroll, repaint
//   ime-busy           "한글입력" typed during a UI stall arrived as "한글입력한글입력글입력입력력"
//   ime-busy-compose   ordinary composition under the same stall (was already fine)
//   focus-panes        43 focus reports to the PTY per pane click, call-stack overflow on split
//   browser-click-e2e  a click in the browser panel never updated the picture
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(process.argv[2] || path.join(here, "../../crates/mycli-desktop/frontend"));
const checks = [
  ["ime-overlap", (o) => o.overlappingSteps === 0 && o.ptyReceived === "한글입" && !o.errors.length],
  ["ime-anchor-cases", (o) => o.failed === 0],
  ["ime-busy", null],
  ["ime-busy-compose", null],
  ["focus-panes", (o) => o.split.uncaughtErrors === 0 && o.clickOtherPane.focusReportsToPty <= 2 && o.windowReturns.focusReportsToPty === 0 && o.focusedPaneStillTyped],
  ["browser-click-e2e", null],
];
let failed = 0;
for (const [name, judge] of checks) {
  const run = spawnSync(process.execPath, [path.join(here, `${name}.mjs`), frontend, "check"], { encoding: "utf8", timeout: 180000 });
  let ok = run.status === 0;
  if (ok && judge) {
    try { ok = judge(JSON.parse(run.stdout.slice(run.stdout.indexOf("{")))); } catch { ok = false; }
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) { failed++; console.log(run.stdout.trim().slice(0, 1500)); console.log(run.stderr.trim().slice(0, 500)); }
}
process.exit(failed ? 1 : 0);
