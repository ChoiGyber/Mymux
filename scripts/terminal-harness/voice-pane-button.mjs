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

  // 7. Closing a whole tab (not just a pane) while one of its panes records:
  //    nothing is typed, the state is idle, and the very next click records.
  await reset();
  await ev(`spawnNewTerminalTab()`);
  await sleep(700);
  await ev(`splitPane("horizontal")`);
  await sleep(700);
  const tabPane = await ev(`focusedPaneId`);
  const tabIdx = await ev(`findTabForPane(${tabPane}).tabIdx`);
  await click(tabPane);
  await sleep(300);
  await ev(`closeTab(${tabIdx})`);
  const idle7 = await waitIdle();
  await sleep(400);
  const w7 = await writes();
  const survivor = await ev(`focusedPaneId`);
  await click(survivor);
  await sleep(300);
  const next7 = await button(survivor);
  await click(survivor);
  await waitIdle();
  await sleep(200);
  const w7b = await writes();
  if (!idle7) fail("tab-closed-while-recording", "state stayed " + (await ev(`voiceState.phase`)));
  else if (w7.length) fail("tab-closed-while-recording", "typed into: " + JSON.stringify(w7));
  else if (!next7.cls.includes("recording")) fail("tab-closed-while-recording", "the next click did not start recording: " + next7.cls);
  else if (w7b.map((w) => `${w.id}:${w.data}`).join("|") !== `${survivor}:안녕하세요`) fail("tab-closed-while-recording", "after: " + JSON.stringify(w7b));
  else pass("tab-closed-while-recording", {});

  // 8. Push-to-talk again while the previous utterance is still being
  //    recognised: the new one records (as before this feature), both arrive.
  await reset();
  const p8 = await ev(`focusedPaneId`);
  await ev(`terminals.get(${p8}).term.focus()`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, modifiers: 2, key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await key("rawKeyDown"); await sleep(300); await key("keyUp");
  await sleep(60); // first utterance is now transcribing (the stub takes 300 ms)
  await key("rawKeyDown"); await sleep(250);
  const phase8 = await ev(`voiceState.phase`);
  await key("keyUp");
  await waitIdle();
  await sleep(500);
  const w8 = await writes();
  if (phase8 !== "recording") fail("ptt-during-transcription", "second press did not record, phase " + phase8);
  else if (w8.map((w) => `${w.id}:${w.data}`).join("|") !== `${p8}:안녕하세요|${p8}:안녕하세요`) fail("ptt-during-transcription", "writes: " + JSON.stringify(w8));
  else pass("ptt-during-transcription", {});

  // Every toast from here on is recorded (a toast disappears after 2 s).
  await ev(`(() => { window.__toasts = []; const orig = toast; toast = (m, e) => { window.__toasts.push(String(m)); orig(m, e); }; })()`);
  const joined = (w) => w.map((x) => `${x.id}:${x.data}`).join("|");
  // A failed case may leave a recording running; stop it so the next one starts clean.
  const settle = async () => { if ((await ev(`voiceState.phase`)) === "recording") { await ev(`voiceStop()`); await waitIdle(); await sleep(150); } await reset(); };
  const setMaxMs = (ms) => ev(`typeof VOICE_LIMITS === "object" && (VOICE_LIMITS.maxMs = ${ms})`);

  // 9. A recording stops by itself at the maximum length, says so, and what
  //    was recorded is still typed into its pane.
  await settle();
  await setMaxMs(1500);
  const p9 = await ev(`focusedPaneId`);
  await click(p9);
  await sleep(1000);
  const phase9 = await ev(`voiceState.phase`);
  const idle9 = await waitIdle();
  await sleep(150);
  const w9 = await writes();
  const toasts9 = await ev(`window.__toasts.slice()`);
  await setMaxMs(120000);
  if (phase9 !== "recording") fail("max-length-stops", "not recording before the limit: " + phase9);
  else if (!idle9) fail("max-length-stops", "did not stop at the limit");
  else if (joined(w9) !== `${p9}:안녕하세요`) fail("max-length-stops", "writes: " + JSON.stringify(w9));
  else if (!toasts9.some((m) => m.includes("최대 길이"))) fail("max-length-stops", "no notice: " + JSON.stringify(toasts9));
  else pass("max-length-stops", { toast: toasts9.find((m) => m.includes("최대 길이")) });

  // 10. With the 🎙 popover open, a pane-button recording: the mouse passing
  //     over the popover's hold-to-talk button does not stop it, and the
  //     status line describes the pane button, not hold-to-talk.
  await settle();
  await ev(`document.getElementById("voice-popover").classList.remove("hidden")`);
  const p10 = await ev(`focusedPaneId`);
  await click(p10);
  await sleep(300);
  const status10 = await ev(`document.getElementById("voice-status").textContent`);
  const recPt = await ev(`(() => { const r = document.getElementById("voice-record").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: recPt.x, y: recPt.y });
  await sleep(100);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: recPt.x - recPt.w, y: recPt.y });
  await sleep(200);
  const phase10 = await ev(`voiceState.phase`);
  await click(p10);
  await waitIdle();
  await sleep(150);
  const w10 = await writes();
  await ev(`document.getElementById("voice-popover").classList.add("hidden")`);
  if (!recPt.w) fail("popover-pass-over-keeps-recording", "popover record button not visible");
  else if (phase10 !== "recording") fail("popover-pass-over-keeps-recording", "passing over the popover button left the phase " + phase10);
  else if (joined(w10) !== `${p10}:안녕하세요`) fail("popover-pass-over-keeps-recording", "writes: " + JSON.stringify(w10));
  else pass("popover-pass-over-keeps-recording", {});
  if (/떼면/.test(status10) || !/자동/.test(status10)) fail("pane-status-text", "status: " + status10);
  else pass("pane-status-text", { status: status10 });

  // 11. Push-to-talk still says "release to transcribe".
  await settle();
  const p11 = await ev(`focusedPaneId`);
  await ev(`terminals.get(${p11}).term.focus()`);
  await key("rawKeyDown");
  await sleep(250);
  const status11 = await ev(`document.getElementById("voice-status").textContent`);
  await key("keyUp");
  await waitIdle();
  await sleep(150);
  if (!/떼면/.test(status11)) fail("ptt-status-text", "status: " + status11);
  else pass("ptt-status-text", { status: status11 });

  // 12. The recording pane goes out of sight (another tab is shown): the
  //     floating indicator appears, and goes away once the pane is back.
  await settle();
  const p12 = await ev(`focusedPaneId`);
  const tab12 = await ev(`findTabForPane(${p12}).tabIdx`);
  const indicator = () => ev(`(() => { const el = document.getElementById("voice-recording"); return { shown: el.getClientRects().length > 0, text: el.textContent }; })()`);
  await click(p12);
  await sleep(300);
  const i12a = await indicator();
  await ev(`spawnNewTerminalTab()`);
  await sleep(700);
  const i12b = await indicator();
  await ev(`switchToTab(${tab12})`);
  await sleep(300);
  const i12c = await indicator();
  await click(p12);
  await waitIdle();
  await sleep(150);
  const w12 = await writes();
  if (i12a.shown) fail("indicator-when-pane-hidden", "indicator shown while the pane button is in view");
  else if (!i12b.shown) fail("indicator-when-pane-hidden", "no indicator while the recording pane is in another tab");
  else if (i12c.shown) fail("indicator-when-pane-hidden", "indicator stayed after returning to the pane");
  else if (joined(w12) !== `${p12}:안녕하세요`) fail("indicator-when-pane-hidden", "writes: " + JSON.stringify(w12));
  else pass("indicator-when-pane-hidden", { text: i12b.text });

  // 13. A very narrow pane (under 130 px): recording keeps the close button
  //     inside the status bar.
  await settle();
  const p13 = await ev(`focusedPaneId`);
  await ev(`terminals.get(${p13}).paneEl.style.flex = "0 0 110px"`);
  await sleep(200);
  await click(p13);
  await sleep(300);
  const geo = await ev(`(() => { const bar = terminals.get(${p13}).paneEl.querySelector(".pane-statusbar"); const b = bar.getBoundingClientRect(), c = bar.querySelector(".close").getBoundingClientRect(); return { bar: Math.round(b.width), barRight: Math.round(b.right), closeRight: Math.round(c.right), closeW: Math.round(c.width), wave: bar.querySelector(".pane-mic-wave").offsetWidth, cls: bar.querySelector(".pane-mic").className }; })()`);
  await click(p13);
  await waitIdle();
  await sleep(150);
  await ev(`terminals.get(${p13}).paneEl.style.flex = ""`);
  if (!geo.cls.includes("recording")) fail("narrow-pane-close-visible", "not recording: " + geo.cls);
  else if (geo.bar > 130) fail("narrow-pane-close-visible", "pane was not narrowed: " + JSON.stringify(geo));
  else if (!geo.closeW || geo.closeRight > geo.barRight) fail("narrow-pane-close-visible", "close button pushed out: " + JSON.stringify(geo));
  else pass("narrow-pane-close-visible", geo);

  // 14. The engine is not set up: the click says so at once and opens no
  //     microphone (it used to record first and complain afterwards).
  await settle();
  await ev(`(() => { window.__gum = 0; const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md); md.getUserMedia = (c) => { window.__gum++; return orig(c); }; window.__savedRunner = localStorage.getItem("mymux.voice.runner.python"); localStorage.removeItem("mymux.voice.runner.python"); window.__toasts.length = 0; })()`);
  const p14 = await ev(`focusedPaneId`);
  await click(p14);
  await sleep(300);
  const phase14 = await ev(`voiceState.phase`);
  const gum14 = await ev(`window.__gum`);
  const toasts14 = await ev(`window.__toasts.slice()`);
  await ev(`localStorage.setItem("mymux.voice.runner.python", window.__savedRunner)`);
  if (phase14 !== "idle") fail("engine-missing-before-recording", "phase " + phase14);
  else if (gum14) fail("engine-missing-before-recording", "the microphone was opened");
  else if (!toasts14.some((m) => m.includes("설치되지"))) fail("engine-missing-before-recording", "toasts: " + JSON.stringify(toasts14));
  else pass("engine-missing-before-recording", { toast: toasts14[0] });

  // 5. Microphone refused: idle again, the reason is shown, nothing left running.
  await settle();
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
