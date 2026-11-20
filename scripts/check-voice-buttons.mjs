// What a click on a pane's mic button does, given the one shared recording,
// and when a click-started recording stops by itself for silence.
// There is a single microphone, so at most one pane records at a time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
const context = vm.createContext({});
for (const name of ["voiceButtonAction", "voiceSilenceStep"]) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = source.indexOf("\n}\n", start);
  vm.runInContext(source.slice(start, end + 2), context);
}
const { voiceButtonAction, voiceSilenceStep } = context;

assert.equal(voiceButtonAction({ phase: "idle", target: null }, 3), "start", "idle: the click starts recording that pane");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 3), "stop", "the recording pane's own button stops it");
assert.equal(voiceButtonAction({ phase: "recording", target: 3 }, 5), "stop", "another pane stops the running recording and does not start a second one");
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 3), "ignore", "a click during transcription cannot start an overlapping recording");
assert.equal(voiceButtonAction({ phase: "transcribing", target: 3 }, 5), "ignore");

// The silence detector is fed one input level (RMS, 0..1) per animation frame.
// `script` is a list of [level, ms]; a level may be a function of the frame
// number, and "gap" means no frames at all for that long (window hidden).
// Returns the time in ms of the frame that asked to stop, or null.
const LIMITS = { silenceMs: 3000, maxMs: 120000, minSpeechMs: 400 };
const FRAME = 1000 / 60;
const QUIET = 0.002, TALK = 0.1;
function run(script) {
  const s = {};
  let t = 0, frame = 0;
  for (const [level, ms] of script) {
    if (level === "gap") { t += ms; continue; }
    const end = t + ms;
    for (; t < end; t += FRAME, frame++) {
      const rms = typeof level === "function" ? level(frame) : level;
      if (voiceSilenceStep(s, rms, t, LIMITS)) return Math.round(t);
    }
  }
  return null;
}
const near = (actual, expected, why) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= 50, `${why}: stopped at ${actual}, expected about ${expected}`);

assert.equal(run([[QUIET, 10000]]), null, "nobody has spoken yet: never stop (the max length covers a forgotten recording)");
near(run([[QUIET, 1000], [TALK, 1000], [QUIET, 5000]]), 5000, "speech, then 3 s of quiet");
assert.equal(run([[QUIET, 500], [TALK, 100], [QUIET, 6000]]), null, "a click or a cough is not speech");
assert.equal(
  run(Array.from({ length: 6 }, () => [[TALK, 1000], [QUIET, 2500]]).flat()),
  null,
  "pauses shorter than the silence limit never stop it",
);
near(run([[0.03, 2000], [0.3, 1000], [0.03, 5000]]), 6000, "a noisy room: its steady noise counts as quiet");
assert.equal(run([[(f) => (f % 2 ? 0.02 : 0.04), 10000]]), null, "a fluctuating noise floor alone is not speech");
// Real speech dips between syllables; those dips pull the floor down even when
// the speaker is already talking in the very first frame.
const SPEECH = (f) => (Math.floor(f / 9) % 3 === 2 ? 0.005 : TALK);
near(run([[SPEECH, 2000], [QUIET, 4000]]), 5000, "talking from the first frame");
assert.equal(run([[QUIET, 200], [TALK, 1000], ["gap", 10000], [QUIET, 2000]]), null, "time with the window hidden (no frames) is not silence");
near(run([[QUIET, 200], [TALK, 1000], ["gap", 10000], [QUIET, 4000]]), 14200, "after the window comes back, 3 s of quiet stops it");
console.log("Voice button checks passed");
