import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8");
const start = source.indexOf("const IME_ANCHOR_SETTLE_MS");
const end = source.indexOf("// ── Duplicate Hangul commits", start);
assert.ok(start > 0 && end > start, "composition anchor block not found in app.js");

// A clock the test moves by hand, and timers that only run when it says so.
let now = 1000;
let timers = [];
const context = vm.createContext({
  performance: { now: () => now },
  setTimeout: (fn, ms = 0) => { const id = {}; timers.push({ id, fn, at: now + ms }); return id; },
  clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
});
const advance = (ms) => {
  now += ms;
  for (let guard = 0; guard < 50; guard++) {
    const due = timers.filter((t) => t.at <= now);
    if (!due.length) return;
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  }
  assert.fail("timers keep rescheduling themselves");
};
vm.runInContext(source.slice(start, end), context);
const SETTLE = vm.runInContext("IME_ANCHOR_SETTLE_MS", context);

const handlers = {};
const textarea = { style: {}, value: "한", addEventListener: (name, fn) => { handlers[name] = fn; } };
const view = { style: {}, classList: { contains: () => true }, offsetWidth: 20, offsetHeight: 20, scrollWidth: 20 };
const screen = { clientWidth: 800, clientHeight: 480 };
let render;
const cursor = { cursorX: 79, cursorY: 23 };
const term = {
  textarea, cols: 80, rows: 24, buffer: { active: cursor },
  element: { clientWidth: 800, clientHeight: 480, querySelector: selector => selector === ".xterm-screen" ? screen : view },
  onRender: fn => { render = fn; },
};
const at = (x, y) => { cursor.cursorX = x; cursor.cursorY = y; };
context.installCompositionAnchor(term);

// ── Geometry: the preview stays inside the pane ──────────────────────────
handlers.compositionstart();
handlers.compositionupdate();
assert.equal(view.style.left, "780px", "right-edge preview stays inside the pane");
assert.equal(view.style.top, "460px");
view.offsetWidth = 40;
handlers.compositionupdate();
advance(0);
assert.equal(view.style.left, "760px", "a growing composition remains visible");
assert.equal(textarea.value, "한", "positioning never changes or commits input");
assert.equal(view.style.overflow, "", "CJK glyphs may extend beyond the line box");
view.offsetWidth = 20;
handlers.compositionend();
advance(SETTLE * 2);

// ── A repaint that parks the cursor for a moment ─────────────────────────
at(10, 4);
handlers.compositionstart();
handlers.compositionupdate();
assert.equal(view.style.left, "100px");
at(0, 0);
view.style.left = "0px"; // xterm's own redraw first moves the preview
render();
assert.equal(view.style.left, "100px", "a parked cursor must not move a live composition at once");
assert.equal(textarea.style.top, "80px", "native candidates follow the same anchor");
view.style.left = "0px"; // xterm's deferred render geometry update
advance(0);
assert.equal(view.style.left, "100px", "deferred xterm positioning must also be corrected");
advance(SETTLE / 2);
at(10, 4); // the repaint finishes and the cursor is back at the caret
render();
advance(SETTLE * 2);
assert.equal(view.style.left, "100px", "a cursor that came back leaves the preview alone");
assert.equal(view.style.top, "80px");

// ── The echo of the syllable committed just before this composition ──────
at(12, 4);
render();
assert.equal(view.style.left, "120px", "the new syllable must clear both echoed cells at once");
assert.equal(textarea.style.left, "120px");
at(16, 4); // two more syllables echoed in a single read
render();
assert.equal(view.style.left, "160px", "several echoes in one read are followed too");

// ── Moves that are not a plain echo: followed once the cursor rests ──────
at(2, 5); // an input box wraps to its own left edge
render();
assert.equal(view.style.left, "160px", "a jump to another row waits for the cursor to settle");
advance(SETTLE + 2);
assert.equal(view.style.left, "20px", "a cursor that stays is the caret: wrap inside an input box");
assert.equal(view.style.top, "100px");
at(0, 5); // deletion echoed after the composition started
render();
advance(SETTLE + 2);
assert.equal(view.style.left, "0px", "moving back is followed after settling");

// ── Nothing lingers after the composition ────────────────────────────────
handlers.compositionend();
assert.equal(timers.length, 0, "ending a composition cancels the settle timer");
view.style.left = "0px";
at(40, 10);
render();
advance(SETTLE * 2);
assert.equal(view.style.left, "0px", "committed input restores xterm positioning");
assert.equal(timers.length, 0, "ordinary renders schedule no composition work");

// ── A composition interrupted by blur must not leave a timer behind ──────
handlers.compositionstart();
handlers.compositionupdate();
at(0, 0);
render();
handlers.blur();
assert.equal(timers.filter((t) => t.at > now).length, 0, "blur cancels the settle timer");
advance(SETTLE * 2);

console.log("IME composition anchor checks passed (geometry, echo following and simulated TUI redraw; not native IME acceptance).");
