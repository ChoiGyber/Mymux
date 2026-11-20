// usage: node voice-pane-button.mjs <frontendDir> <label>
// The per-pane mic button in real Chromium with a fake microphone (Chrome's
// built-in test tone), clicked with real mouse events.
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, {
  query: "?echo=off&voice=1",
  chromeArgs: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
let code = 0;
const R = { label, cases: {} };
const fail = (name, why) => { R.cases[name] = { ok: false, why }; code = 1; };
const pass = (name, detail) => { R.cases[name] = { ok: true, ...detail }; };
try {
  const { ev, send } = h;
  await ev(`(async () => {
    document.querySelectorAll("#whatsnew-modal").forEach((m) => m.classList.add("hidden"));
    await splitPane("horizontal");
    await new Promise((r) => setTimeout(r, 600));
  })()`);
  const ids = await ev(`[...terminals.keys()]`);
  if (ids.length !== 2) throw new Error("expected two panes, got " + ids.length);
  const focused = await ev(`focusedPaneId`);
  const other = ids.find((id) => id !== focused);

  const click = async (paneId) => {
    const pt = await ev(`(() => { const b = terminals.get(${paneId})?.paneEl.querySelector(".pane-mic"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!pt) throw new Error(`pane ${paneId} has no .pane-mic button`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  };
  const button = (paneId) => ev(`(() => { const b = terminals.get(${paneId})?.paneEl.querySelector(".pane-mic"); return b ? { cls: b.className, text: b.textContent.trim(), wave: b.querySelector("canvas.pane-mic-wave")?.toDataURL() || null, waveShown: b.querySelector("canvas.pane-mic-wave")?.offsetWidth > 0 } : null; })()`);
  const writes = () => ev(`window.__ptyWrites.map((w) => ({ id: w.id, data: w.data }))`);
  const reset = () => ev(`(() => { window.__ptyWrites.length = 0; window.__voiceCalls.length = 0; })()`);
  const waitIdle = async () => { for (let i = 0; i < 60; i++) { if ((await ev(`voiceState.phase`)) === "idle") return true; await sleep(50); } return false; };

  // 1. Record on the pane that is NOT focused; the waveform moves; no "녹음" text.
  await reset();
  await click(other);
  await sleep(250);
  const frames = [];
  // Chrome's fake microphone beeps about once a second and is silent between,
  // so sample long enough to always include a beep.
  for (let i = 0; i < 10; i++) { frames.push(await button(other)); await sleep(150); }
  const distinct = new Set(frames.map((f) => f.wave)).size;
  const b1 = frames[0];
  if (!b1.cls.includes("recording")) fail("record-other-pane", "button is not in recording state: " + b1.cls);
  else if (!b1.waveShown) fail("record-other-pane", "waveform canvas is not visible");
  else if (distinct < 2) fail("record-other-pane", "waveform did not change over 600 ms");
  else if (/녹음/.test(b1.text)) fail("record-other-pane", "button shows recording text: " + b1.text);
  else pass("record-other-pane", { distinctFrames: distinct });

  // 2. Click again: transcribe, paste into that pane only, no Enter.
  await click(other);
  await sleep(60);
  const during = await button(other);
  await waitIdle();
  await sleep(150);
  const w2 = await writes();
  const calls2 = await ev(`window.__voiceCalls.length`);
  const toOther = w2.filter((w) => w.id === other).map((w) => w.data).join("");
  if (!during.cls.includes("transcribing")) fail("stop-and-paste", "no transcribing state while recognising: " + during.cls);
  else if (calls2 !== 1) fail("stop-and-paste", "voice_transcribe_local calls: " + calls2);
  else if (toOther !== "안녕하세요") fail("stop-and-paste", "pane received " + JSON.stringify(toOther));
  else if (w2.some((w) => w.id !== other)) fail("stop-and-paste", "another pane received input: " + JSON.stringify(w2));
  else if (w2.some((w) => w.data.includes("\r"))) fail("stop-and-paste", "Enter was sent");
  else if ((await button(other)).cls.match(/recording|transcribing/)) fail("stop-and-paste", "button did not return to idle");
  else pass("stop-and-paste", {});

  // 3. While one pane records, the other pane's button stops it (into the first pane) and starts nothing.
  await reset();
  await click(other);
  await sleep(400);
  await click(focused);
  await waitIdle();
  await sleep(150);
  const w3 = await writes();
  const startedSecond = (await button(focused)).cls.includes("recording");
  if (startedSecond) fail("other-button-stops", "the second pane started recording");
  else if (w3.map((w) => `${w.id}:${w.data}`).join("|") !== `${other}:안녕하세요`) fail("other-button-stops", "writes: " + JSON.stringify(w3));
  else pass("other-button-stops", {});

  // 4. The recording pane is closed mid-recording: nothing is typed anywhere.
  await reset();
  await click(focused);
  await sleep(300);
  await ev(`closePane(${focused})`);
  const idle4 = await waitIdle();
  await sleep(500);
  const w4 = await writes();
  if (!idle4) fail("closed-while-recording", "state did not return to idle");
  else if (w4.length) fail("closed-while-recording", "typed into: " + JSON.stringify(w4));
  else pass("closed-while-recording", { transcribeCalls: await ev(`window.__voiceCalls.length`) });

  // 6. Ctrl+Space starts the same shared recording: that pane's button shows the
  //    waveform, and clicking it stops and pastes into that pane.
  await reset();
  const pttPane = await ev(`focusedPaneId`);
  await ev(`terminals.get(${pttPane}).term.focus()`);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await sleep(200);
  // Holding the keys: Windows sends auto-repeat keydowns, which must not reach the program either.
  for (let i = 0; i < 3; i++) await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: " ", code: "Space", windowsVirtualKeyCode: 32, autoRepeat: true });
  await sleep(200);
  const b6 = await button(pttPane);
  await click(pttPane);
  await waitIdle();
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await sleep(200);
  const w6 = await writes();
  if (!b6.cls.includes("recording") || !b6.waveShown) fail("ctrl-space-shares-button", "button not showing the Ctrl+Space recording: " + b6.cls);
  else if (w6.map((w) => `${w.id}:${w.data}`).join("|") !== `${pttPane}:안녕하세요`) fail("ctrl-space-shares-button", "writes: " + JSON.stringify(w6));
  else if ((await ev(`window.__voiceCalls.length`)) !== 1) fail("ctrl-space-shares-button", "transcribed more than once");
  else pass("ctrl-space-shares-button", {});

  // 5. Microphone refused: idle again, the reason is shown, nothing left running.
  await reset();
  await ev(`(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")); })()`);
  await click(other);
  await sleep(300);
  const b5 = await button(other);
  const toast5 = await ev(`(() => { const t = document.getElementById("toast"); return t && !t.classList.contains("hidden") ? t.textContent : ""; })()`);
  if ((await ev(`voiceState.phase`)) !== "idle") fail("mic-refused", "state is " + (await ev(`voiceState.phase`)));
  else if (b5.cls.includes("recording")) fail("mic-refused", "button stuck in recording");
  else if (!toast5) fail("mic-refused", "no message shown");
  else pass("mic-refused", { toast: toast5.slice(0, 80) });

  R.errors = h.errors.slice(0, 3).map((e) => e.slice(0, 160));
  if (R.errors.length) code = 1;
} catch (e) { R.harnessError = e.message; code = 2; }
finally {
  console.log(JSON.stringify(R));
  h.close();
  process.exit(code);
}
