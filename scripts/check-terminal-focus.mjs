import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8");
const start = source.indexOf("function shouldDropTerminalFocusReport(");
const end = source.indexOf("function setFocusedPane(", start);
const context = vm.createContext({ FocusEvent: class { constructor(type) { this.type = type; } } });
vm.runInContext(source.slice(start, end), context);
const received = [];
const t = { ctxSource: "codex", codexDetected: true };
const emit = data => { if (!context.shouldDropTerminalFocusReport(t, data)) received.push(data); };
const textarea = { dispatchEvent: e => { assert.equal(e.type, "focus"); emit("\x1b[I"); } };

// Genuine Alt-Tab out/in, followed by every focus-keeper restore retry.
emit("\x1b[O");
emit("\x1b[I");
for (let i = 0; i < 4; i++) context.restoreTerminalFocusState(t, textarea);
assert.deepEqual(received, [], "Codex must not receive focus bytes as editor input");
for (const text of ["[[][", "[I", "[O", "한글", "\x1b[200~[I\x1b[201~", "\x1b[1;2R"]) emit(text);
assert.equal(received.length, 6, "literal input, paste and other terminal replies are preserved");

// Owner changes to Claude: real focus-in AND focus-out continue to work.
t.ctxSource = "claude";
t.codexDetected = false;
received.length = 0;
emit("\x1b[O");
emit("\x1b[I");
context.restoreTerminalFocusState(t, textarea);
emit("\x1b[I");
assert.deepEqual(received, ["\x1b[O", "\x1b[I", "\x1b[I"], "synthetic suppression must not consume a later real focus event");
assert.equal(t.restoringTerminalFocus, false);
assert.throws(() => context.restoreTerminalFocusState(t, { dispatchEvent: () => { throw Error("disposed"); } }));
assert.equal(t.restoringTerminalFocus, false, "a failed restore must not leave suppression active");
assert.equal(context.shouldDropTerminalFocusReport(null, "\x1b[I"), false);
console.log("Terminal focus event sequence checks passed (simulated Alt-Tab and restore; not native acceptance).");
