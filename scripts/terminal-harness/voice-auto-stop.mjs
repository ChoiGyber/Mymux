// usage: node voice-auto-stop.mjs <frontendDir> <label>
// A pane-button recording (click to start, click to stop) stops by itself once
// the speaker goes quiet; a push-to-talk recording does not. Chrome's fake
// microphone plays a generated WAV on a loop: 2 s of speech-like syllables,
// then 4 s of faint room noise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot, sleep } from "./harness.mjs";

function writeSpeechWav(file) {
  const rate = 48000, seconds = 6;
  const pcm = new Int16Array(rate * seconds);
  let seed = 1;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < pcm.length; i++) {
    const t = i / rate;
    let v = noise() * 0.005; // room noise, RMS about 0.003
    // Syllables every 250 ms: 180 ms of a 140 Hz voice with harmonics, then a gap.
    const inSyllable = t % 0.25;
    if (t < 2 && inSyllable < 0.18) {
      let voice = 0;
      for (let k = 1; k <= 6; k++) voice += Math.sin(2 * Math.PI * 140 * k * t) / k;
      v += 0.25 * Math.sin((Math.PI * inSyllable) / 0.18) * voice;
    }
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer)]));
}

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), "mymux-voice-"));
const wav = path.join(wavDir, "speech-then-quiet.wav");
writeSpeechWav(wav);
const h = await boot(dir, {
  query: "?echo=off&voice=1",
  chromeArgs: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
});
let code = 0;
const R = { label, cases: {} };
const fail = (name, why) => { R.cases[name] = { ok: false, why }; code = 1; };
const pass = (name, detail) => { R.cases[name] = { ok: true, ...detail }; };
try {
  const { ev, send } = h;
  await ev(`document.querySelectorAll("#whatsnew-modal").forEach((m) => m.classList.add("hidden"))`);
  await sleep(300);
  const writes = () => ev(`window.__ptyWrites.map((w) => ({ id: w.id, data: w.data }))`);
  const reset = () => ev(`(() => { window.__ptyWrites.length = 0; window.__voiceCalls.length = 0; })()`);
  const joined = (w) => w.map((x) => `${x.id}:${x.data}`).join("|");
  const waitIdle = async (ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if ((await ev(`voiceState.phase`)) === "idle") return true; return false; };
  const pane = await ev(`focusedPaneId`);

  // 1. Click the pane's mic button once and say nothing more: the recording
  //    ends on its own after the speech plus 3 s of quiet, and is typed in.
  //    Speech comes within 4 s of any start, lasts 2 s, then 3 s of quiet.
  await reset();
  const pt = await ev(`(() => { const r = terminals.get(${pane}).paneEl.querySelector(".pane-mic").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  const started = Date.now();
  let stoppedAfter = null;
  while (Date.now() - started < 11000) {
    if ((await ev(`voiceState.phase`)) !== "recording") { stoppedAfter = Date.now() - started; break; }
    await sleep(100);
  }
  const idle1 = await waitIdle(3000);
  await sleep(150);
  const w1 = await writes();
  if (stoppedAfter === null) fail("pane-stops-on-silence", "still recording after 11 s");
  else if (stoppedAfter < 3000) fail("pane-stops-on-silence", `stopped too early, after ${stoppedAfter} ms`);
  else if (!idle1) fail("pane-stops-on-silence", "did not finish transcribing");
  else if (joined(w1) !== `${pane}:안녕하세요`) fail("pane-stops-on-silence", "writes: " + JSON.stringify(w1));
  else pass("pane-stops-on-silence", { stoppedAfterMs: stoppedAfter });

  if ((await ev(`voiceState.phase`)) === "recording") { await ev(`voiceStop()`); await waitIdle(3000); await sleep(150); }

  // 2. Push-to-talk held for 10 s, which always spans speech followed by more
  //    than 3 s of quiet: it keeps recording until the keys are released.
  await reset();
  await ev(`terminals.get(${pane}).term.focus()`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, modifiers: 2, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await key("rawKeyDown");
  await sleep(10000);
  const phase2 = await ev(`voiceState.phase`);
  await key("keyUp");
  const idle2 = await waitIdle(3000);
  await sleep(150);
  const w2 = await writes();
  if (phase2 !== "recording") fail("hold-ignores-silence", "push-to-talk stopped while held, phase " + phase2);
  else if (!idle2) fail("hold-ignores-silence", "did not finish after release");
  else if (joined(w2) !== `${pane}:안녕하세요`) fail("hold-ignores-silence", "writes: " + JSON.stringify(w2));
  else pass("hold-ignores-silence", {});

  R.errors = h.errors.slice(0, 3).map((e) => e.slice(0, 160));
  if (R.errors.length) code = 1;
} catch (e) { R.harnessError = e.message; code = 2; }
finally {
  console.log(JSON.stringify(R));
  h.close();
  try { fs.rmSync(wavDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
