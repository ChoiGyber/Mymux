// usage: node mac-ime-trace.mjs <frontendDir> <label>
// The macOS IME trace (diagnostic for Hangul splitting into jamo after a Cmd+Tab
// return). Headless Chrome stands in for WKWebView with a Mac user agent, so
// IS_MAC is true; a jamo that bypasses the input method is typed as a plain key,
// the way it would reach xterm if the IME never saw the keystroke.
//   1. The first separate jamo sent to the program writes ~/.mycli/ime-incidents.log
//      with the native focus report and the keystrokes, in time order.
//   2. A composed syllable or plain ASCII writes nothing, and ASCII that is in
//      the record anyway is masked (it may be a password).
//   3. Without a Mac user agent nothing is recorded (Windows untouched).
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
let code = 0;
const R = { label, cases: {} };
const fail = (name, why) => { R.cases[name] = { ok: false, why }; code = 1; };
const check = (name, ok, detail) => { R.cases[name] = { ok, ...detail }; if (!ok) code = 1; };

// Types into the focused pane's textarea the way a key reaches xterm. Like a
// browser, no keypress follows a keydown that was cancelled.
const KEY = (key, keyCode) => `(() => {
  const ta = terminals.get(focusedPaneId).term.textarea;
  ta.focus();
  const down = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, keyCode: ${keyCode}, bubbles: true, cancelable: true });
  ta.dispatchEvent(down);
  if (!down.defaultPrevented) ta.dispatchEvent(new KeyboardEvent("keypress", { key: ${JSON.stringify(key)}, charCode: ${key.codePointAt(0)}, keyCode: ${key.codePointAt(0)}, bubbles: true, cancelable: true }));
  ta.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, keyCode: ${keyCode}, bubbles: true }));
})()`;
const WATCH = `(() => { window.__written = []; window.__stubReplies = { write_text_file: (a) => { window.__written.push(a); return null; } }; })()`;
const ready = async (ev) => {
  for (let i = 0; i < 80; i++) {
    if (await ev(`typeof terminals !== "undefined" && terminals.size > 0 && focusedPaneId != null`).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error("no pane");
};

{
  const h = await boot(dir, { query: "?echo=off", chromeArgs: [`--user-agent=${MAC_UA}`] });
  try {
    const { ev } = h;
    await ready(ev);
    check("is-mac", await ev(`IS_MAC`), {});
    await ev(WATCH);

    // Composed text and ASCII are ordinary typing: no record.
    await ev(`terminals.get(focusedPaneId).term.input("한글 abc", true)`);
    await ev(KEY("a", 65));
    // A keypress the keydown did not cancel, as WebKit can deliver it.
    await ev(`terminals.get(focusedPaneId).term.textarea.dispatchEvent(new KeyboardEvent("keypress", { key: "b", charCode: 98, keyCode: 98, bubbles: true, cancelable: true }))`);
    await sleep(1900);
    check("no-record-for-composed-or-ascii", (await ev(`window.__written.length`)) === 0, {});

    // A Cmd+Tab return as the Rust side reports it, then a jamo that skipped the IME.
    await ev(`window.dispatchEvent(new FocusEvent("focus"))`);
    await ev(`window.__stubEmit("mymux-mac-focus", "focused=true at once: mainIsKey=true firstResponder=WryWebView keyWindow=TaoWindow (main)")`);
    await sleep(20);
    await ev(KEY("ㅎ", 71));
    await ev(KEY("ㅏ", 75));
    await sleep(1900);
    const w = await ev(`window.__written`);
    const log = (w[0] && w[0].content) || "";
    const at = (s) => log.indexOf(s);
    const detail = { writes: w.length, path: w[0] && w[0].path, log: log.slice(0, 1500) };
    check("record-written", w.length === 1 && /\/\.mycli\/ime-incidents\.log$/.test(w[0].path), detail);
    check("record-content",
      at('separate jamo "ㅎ"') >= 0 && at("window:focus") >= 0 && at("window:native") >= 0 &&
      at('keydown ["ㅎ",71') >= 0 && at('emit "ㅎ"') >= 0 && at('emit "ㅏ"') >= 0,
      { log: log.slice(0, 1500) });
    check("record-in-time-order", at("window:native") >= 0 && at("window:native") < at('keydown ["ㅎ",71') &&
      at('keydown ["ㅎ",71') < at('emit "ㅎ"'), {});

    // ASCII typed before the jamo ("한글 abc", then the key "a") is masked: no
    // character and no key code that would spell it out.
    check("ascii-masked",
      !/abc|"a"|"b"|,65\b|char (9[0-9]|1[01][0-9])\b/.test(log) && log.includes('emit "한글****"') && log.includes('keydown ["ascii"'),
      { log: log.slice(0, 1500) });

    // A second jamo right away does not write again (one record per 30s per pane).
    await ev(KEY("ㄴ", 83));
    await sleep(1900);
    check("rate-limited", (await ev(`window.__written.length`)) === 1, {});

    // Simulate the native source-change notification while xterm already owns
    // focus. Chromium supplies the composition events; this checks Mymux's
    // response to the notification, not the macOS input method itself.
    await ev(`(async () => {
      const term = terminals.get(focusedPaneId).term;
      term.focus();
      await new Promise(resolve => term.write("\\x1b[?1004h", resolve));
      window.__sourceFocus = [];
      for (const type of ["blur", "focus"]) {
        term.textarea.addEventListener(type, () => window.__sourceFocus.push(type));
      }
      window.__ptyWrites.length = 0;
    })()`);
    const switchSource = () => ev(`window.__stubEmit("mymux-mac-input-source-changed", null)`);
    const compose = (text) => h.send("Input.imeSetComposition", {
      text, selectionStart: text.length, selectionEnd: text.length,
    });
    for (let round = 0; round < 2; round++) {
      await switchSource();
      await ev(KEY("a", 65));
      await switchSource();
      for (const sequence of [["ㅎ", "하", "한"], ["ㄱ", "그", "글"]]) {
        for (const draft of sequence) await compose(draft);
        // A notification during marked text must leave the composition intact.
        await switchSource();
        await h.send("Input.insertText", { text: sequence.at(-1) });
        await sleep(20);
      }
    }
    const focus = await ev(`window.__sourceFocus.slice()`);
    check("rebinds-on-every-switch-outside-composition",
      focus.join(",") === Array(4).fill("blur,focus").join(","), { focus });
    const input = await ev(`window.__ptyWrites.map(w => w.data).join("")`);
    check("repeated-switch-input-without-focus-bytes", input === "a한글a한글", { input });
    // WebKit's first jamo may already be in the textarea when the Tauri
    // notification arrives, before there is any compositionstart to observe.
    const seed = await ev(`(() => {
      const ta = terminals.get(focusedPaneId).term.textarea;
      const count = window.__sourceFocus.length;
      ta.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText", data: "ㅎ", bubbles: true, cancelable: true,
      }));
      const before = ta.value;
      window.__stubEmit("mymux-mac-input-source-changed", null);
      return { before, after: ta.value, focusEvents: window.__sourceFocus.length - count };
    })()`);
    check("source-change-preserves-first-jamo-seed",
      seed.before === "ㅎ" && seed.after === "ㅎ" && seed.focusEvents === 0, seed);
    await ev(KEY("a", 65));
    const focusBeforeSwitch = await ev(`window.__sourceFocus.length`);
    await switchSource();
    check("source-change-resumes-after-ordinary-typing",
      await ev(`window.__sourceFocus.length`) === focusBeforeSwitch + 2, {});
    const imeKeyFocus = await ev(`(() => {
      const ta = terminals.get(focusedPaneId).term.textarea;
      ta.value = "a";
      window.__ptyWrites.length = 0;
      const count = window.__sourceFocus.length;
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Process", keyCode: 229, bubbles: true, cancelable: true,
      }));
      window.__stubEmit("mymux-mac-input-source-changed", null);
      return window.__sourceFocus.length - count;
    })()`);
    check("source-change-preserves-pending-ime-key", imeKeyFocus === 0, { imeKeyFocus });
    await sleep(20);
    const fallbackInput = await ev(`window.__ptyWrites.map(w => w.data).join("")`);
    check("pending-ime-key-generates-no-deletion", fallbackInput === "", { fallbackInput });
    const afterFallback = await ev(`window.__sourceFocus.length`);
    await switchSource();
    check("source-change-resumes-after-ime-key-settles",
      await ev(`window.__sourceFocus.length`) === afterFallback + 2, {});
    const keptField = await ev(`(() => {
      const field = document.createElement("input");
      document.body.append(field);
      field.focus();
      window.__stubEmit("mymux-mac-input-source-changed", null);
      const kept = document.activeElement === field;
      field.remove();
      return kept;
    })()`);
    check("source-change-preserves-other-input-focus", keptField, {});
    if (h.errors.length) fail("page-errors", h.errors.slice(0, 3));
  } catch (e) {
    fail("harness-mac", String(e));
  } finally {
    h.close();
  }
}

{
  const h = await boot(dir, { query: "?echo=off" });
  try {
    const { ev } = h;
    await ready(ev);
    await ev(WATCH);
    await ev(KEY("ㅎ", 71));
    await sleep(1900);
    check("windows-records-nothing", !(await ev(`IS_MAC`)) && (await ev(`window.__written.length`)) === 0, {});
  } catch (e) {
    fail("harness-windows", String(e));
  } finally {
    h.close();
  }
}

console.log(JSON.stringify(R));
process.exit(code);
