// usage: node ime-anchor-cases.mjs <frontendDir> <label>
// Harder placements for the IME preview. The fake PTY does not echo by itself;
// each case pushes the exact output a program would send, when it would send it.
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=off" });
let code = 0;
try {
  const { send, ev } = h;
  await ev(`(() => { const t = [...terminals.values()][0]; t.term.focus(); t.term.textarea.focus(); })()`);
  const state = () => ev(`(() => {
    const t = [...terminals.values()][0]; const term = t.term;
    const view = term.element.querySelector('.composition-view'); const screen = term.element.querySelector('.xterm-screen');
    const cw = screen.clientWidth / term.cols, ch = screen.clientHeight / term.rows; const b = term.buffer.active; const on = view.classList.contains('active');
    return { cx: b.cursorX, cy: b.cursorY, on, col: on ? Math.round(parseFloat(view.style.left || '0') / cw) : null, row: on ? Math.round(parseFloat(view.style.top || '0') / ch) : null };
  })()`);
  const push = (text) => ev(`window.__stubPush([...terminals.keys()][0], ${JSON.stringify(text)})`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, key: "Process", code: "KeyG", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  const compose = async (text) => { await key("rawKeyDown"); await send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }); await key("keyUp"); };
  const commitAndStart = async (done, next) => { await key("rawKeyDown"); await Promise.all([send("Input.insertText", { text: done }), send("Input.imeSetComposition", { text: next, selectionStart: next.length, selectionEnd: next.length })]); await key("keyUp"); };
  const finish = async (text) => { await send("Input.insertText", { text }); await sleep(120); };
  const home = async () => { await push("\x1b[2J\x1b[H> "); await sleep(200); };
  const results = [];
  const expect = async (name, want, wait = 260) => {
    await sleep(wait); const s = await state();
    const ok = s.on && s.col === want.col && s.row === want.row;
    results.push({ name, ok, want, got: { col: s.col, row: s.row }, cursor: { x: s.cx, y: s.cy } });
  };

  // B: both echoes land in one read, after the third syllable has started.
  await home();
  await compose("한"); await commitAndStart("한", "글"); await commitAndStart("글", "ㅇ");
  await push("한글");
  await expect("two echoes arrive together (cursor +4)", { col: 6, row: 0 });
  await finish("입"); await push("입");

  // C: a TUI input box wraps to its own left edge, not the terminal's.
  await home(); await push("\x1b[1;31H"); await sleep(120);
  await compose("한"); await commitAndStart("한", "ㄱ");
  await push("한\x1b[2;3H");
  await expect("input box wraps to the next row at its own indent", { col: 2, row: 1 });
  await finish("글");

  // D: a repaint parks the cursor at the top-left for one frame, then returns.
  await home(); await push("\x1b[5;11H"); await sleep(120);
  await compose("한"); await sleep(120);
  await push("\x1b[1;1H\x1b[Kstatus");
  let parkedSeen = false;
  for (let i = 0; i < 4; i++) { await sleep(8); const s = await state(); if (s.on && s.row === 0) parkedSeen = true; }
  await push("\x1b[5;11H");
  await sleep(200); const d = await state();
  results.push({ name: "repaint parking the cursor for ~30ms does not drag the preview", ok: !parkedSeen && d.col === 10 && d.row === 4, want: { col: 10, row: 4 }, got: { col: d.col, row: d.row, parkedSeen } });
  await finish("한");

  // E: the cursor moves back (a deletion echoed after the composition started).
  await home(); await push("abcd"); await sleep(150);
  await compose("한");
  await push("\b\b  \b\b");
  await expect("cursor moved back by two cells", { col: 4, row: 0 });
  await finish("한");

  // F: the screen scrolls under a composition on the last row.
  await home(); const rows = await ev(`[...terminals.values()][0].term.rows`);
  await push(`\x1b[${rows};1H> `); await sleep(150);
  await compose("한"); await commitAndStart("한", "ㄱ");
  await push("한\r\n> ");
  await expect("prompt redrawn on the last row after a scroll", { col: 2, row: rows - 1 });
  await finish("글");

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ label, passed: results.length - failed.length, failed: failed.length, results, errors: h.errors.slice(0, 2).map((e) => e.slice(0, 120)) }, null, 1));
  if (failed.length) code = 1;
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
