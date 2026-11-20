// What a click on a pane's mic button does, given the one shared recording.
// There is a single microphone, so at most one pane records at a time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
const start = source.indexOf("function voiceButtonAction(");
if (start < 0) throw new Error("voiceButtonAction not found in app.js");
const end = source.indexOf("\n}\n", start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end + 2), context);
const { voiceButtonAction } = context;

assert.equal(voiceButtonAction({ phase: "idle", target: null }, 3), "start", "idle: the click starts recording that pane");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 3), "stop", "the recording pane's own button stops it");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 5), "stop", "another pane stops the running recording and does not start a second one");
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 3), "ignore", "a click during transcription cannot start an overlapping recording");
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 5), "ignore");
console.log("Voice button checks passed");
