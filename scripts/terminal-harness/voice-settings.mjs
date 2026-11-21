// usage: node voice-settings.mjs <frontendDir> <label>
// The 🎙 settings after the Deepgram engine was removed (v0.3.13): the local
// engine is the only one, so the popover opens straight on its setup, and the
// red "not set up" dot on 🎙 appears only for someone who has started setting
// voice input up, never for someone who has never used it.
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=off" });
let code = 0;
const R = { label, cases: {} };
const fail = (name, why) => { R.cases[name] = { ok: false, why }; code = 1; };
const pass = (name, detail) => { R.cases[name] = { ok: true, ...detail }; };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));
try {
  const { ev } = h;
  const dot = () => ev(`document.getElementById("btn-voice-input").classList.contains("not-ready")`);
  // Loads the app again with the given localStorage, as an updated install
  // starts with whatever the previous version saved.
  const restart = async (storage) => {
    await ev(`(() => { localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v); window.__old = 1; location.reload(); })()`);
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await ev(`typeof window.__old === "undefined" && typeof terminals !== "undefined" && terminals.size > 0`).catch(() => false)) break;
    }
    await sleep(700); // the managed-install status arrives asynchronously
  };

  // 1. Nothing left of the engine choice or the API key.
  const leftovers = await ev(`["voice-provider", "voice-api-key", "voice-save-key", "voice-key-row"].filter((id) => document.getElementById(id))`);
  check("no-engine-choice", leftovers.length === 0, { leftovers });

  // 2. Someone who has never opened 🎙 sees no dot.
  check("no-dot-before-opening", !(await dot()), {});

  // 3. Opening 🎙 shows the local setup at once; from then on, until a runner
  //    is picked, the dot stays, also after the popover is closed again.
  await ev(`document.getElementById("btn-voice-input").click()`);
  await sleep(100);
  const opened = await ev(`(() => ({
    popover: !document.getElementById("voice-popover").classList.contains("hidden"),
    local: document.getElementById("voice-local").getClientRects().length > 0,
    setup: document.getElementById("voice-auto-setup").getClientRects().length > 0,
  }))()`);
  const dotOpen = await dot();
  await ev(`document.getElementById("btn-voice-input").click()`);
  await sleep(100);
  const dotClosed = await dot();
  check("opens-on-local-setup", opened.popover && opened.local && opened.setup, opened);
  check("dot-after-opening", dotOpen && dotClosed, { dotOpen, dotClosed });

  // 4. An install that had picked the local engine before the update keeps its
  //    dot; the old setting itself is dropped.
  await restart({ "mymux.voice.provider": "faster-whisper" });
  const oldLocal = { dot: await dot(), provider: await ev(`localStorage.getItem("mymux.voice.provider")`) };
  check("old-local-choice-keeps-dot", oldLocal.dot && oldLocal.provider === null, oldLocal);

  // 5. An install that had stayed on Deepgram gets no dot until 🎙 is opened.
  await restart({ "mymux.voice.provider": "deepgram" });
  const oldCloud = { dot: await dot(), provider: await ev(`localStorage.getItem("mymux.voice.provider")`) };
  check("old-deepgram-choice-no-dot", !oldCloud.dot && oldCloud.provider === null, oldCloud);

  // 6. A finished setup shows no dot.
  await restart({ "mymux.voice.opened": "1", "mymux.voice.runner.standalone": "C:/stub/faster-whisper-xxl.exe" });
  check("ready-no-dot", !(await dot()), {});

  if (h.errors.length) fail("page-errors", h.errors.slice(0, 3));
} catch (e) {
  fail("harness", String(e));
} finally {
  h.close();
}
console.log(JSON.stringify(R));
process.exit(code);
