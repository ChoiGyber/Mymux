import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8");
const start = source.indexOf("function compositionPreviewPosition(");
const end = source.indexOf("// ── Duplicate Hangul commits", start);
const timers = [];
const context = vm.createContext({ setTimeout: fn => timers.push(fn) });
vm.runInContext(source.slice(start, end), context);
const handlers = {};
const textarea = { style: {}, value: "한", addEventListener: (name, fn) => { handlers[name] = fn; } };
const view = { style: {}, classList: { contains: () => true }, offsetWidth: 20, offsetHeight: 20 };
const screen = { clientWidth: 800, clientHeight: 480 };
let render;
const term = {
  textarea, cols: 80, rows: 24, buffer: { active: { cursorX: 79, cursorY: 23 } },
  element: { clientWidth: 800, clientHeight: 480, querySelector: selector => selector === ".xterm-screen" ? screen : view },
  onRender: fn => { render = fn; },
};
context.installCompositionAnchor(term);
handlers.compositionstart();
handlers.compositionupdate();
assert.equal(view.style.left, "780px", "right-edge preview stays inside the pane");
assert.equal(view.style.top, "460px");
term.buffer.active.cursorX = 0;
term.buffer.active.cursorY = 0;
view.style.left = "0px"; // xterm's own redraw first moves the preview
render();
assert.equal(view.style.left, "780px", "TUI cursor parking must not move a live composition");
assert.equal(textarea.style.top, "460px", "native candidates follow the same anchor");
view.style.left = "0px"; // xterm's deferred render geometry update
timers.splice(0).forEach(fn => fn());
assert.equal(view.style.left, "780px", "deferred xterm positioning must also be corrected");
view.offsetWidth = 40;
handlers.compositionupdate();
timers.splice(0).forEach(fn => fn());
assert.equal(view.style.left, "760px", "a growing composition remains visible");
assert.equal(textarea.value, "한", "positioning never changes or commits input");
handlers.compositionend();
view.style.left = "0px";
render();
assert.equal(view.style.left, "0px", "committed input restores xterm positioning");
console.log("IME composition anchor checks passed (geometry and simulated TUI redraw; not native IME acceptance).");
