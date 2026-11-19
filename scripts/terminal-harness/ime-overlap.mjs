// usage: node ime-overlap.mjs <frontendDir> <label> [screenshotPath]
// Types Hangul through Chromium's real IME pipeline (CDP imeSetComposition /
// insertText) into a pane whose PTY echoes after 30 ms, the way a Korean IME
// does it: committing one syllable and starting the next in the same instant.
// Reports where the composition preview sits relative to the terminal cursor.
import fs from "node:fs";
import { boot, sleep } from "./harness.mjs";

const [dir, label, shot] = [process.argv[2], process.argv[3] || "run", process.argv[4]];
const h = await boot(dir, { query: "?echo=30" });
let code = 0;
try {
  const { send, ev } = h;
  await ev(`(() => { const t = [...terminals.values()][0]; t.term.focus(); t.term.textarea.focus(); return document.activeElement === t.term.textarea; })()`);
  const state = () => ev(`(() => {
    const t = [...terminals.values()][0]; const term = t.term;
    const view = term.element.querySelector('.composition-view'); const screen = term.element.querySelector('.xterm-screen');
    const cellW = screen.clientWidth / term.cols; const b = term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY).translateToString(true);
    return { cursorX: b.cursorX, cursorY: b.cursorY, line, active: view.classList.contains('active'), previewText: view.textContent,
      previewCol: view.classList.contains('active') ? Math.round(parseFloat(view.style.left || '0') / cellW * 100) / 100 : null,
      previewRow: view.classList.contains('active') ? Math.round(parseFloat(view.style.top || '0') / (screen.clientHeight / term.rows) * 100) / 100 : null };
  })()`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, key: "Process", code: "KeyG", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  const compose = async (text) => { await key("rawKeyDown"); await send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }); await key("keyUp"); };
  // The IME commits the finished syllable and opens the next composition from
  // one keydown: no await between the two, so both land before the echo.
  const commitAndStart = async (done, next) => {
    await key("rawKeyDown");
    const a = send("Input.insertText", { text: done });
    const b = send("Input.imeSetComposition", { text: next, selectionStart: next.length, selectionEnd: next.length });
    await Promise.all([a, b]); await key("keyUp");
  };
  const steps = [];
  const check = async (name, wait = 160) => { await sleep(wait); const s = await state(); steps.push({ name, ...s, overlap: s.active ? s.cursorX - s.previewCol : null }); };

  await compose("ㅎ"); await sleep(60); await compose("하"); await sleep(60); await compose("한");
  await check("first syllable composing (nothing echoed yet)");
  await commitAndStart("한", "ㄱ");
  await check("한 committed + ㄱ started, echo arrived");
  await compose("그"); await sleep(60); await compose("글");
  await check("second syllable composing");
  await commitAndStart("글", "ㅇ");
  await check("글 committed + ㅇ started, echo arrived");
  await compose("이"); await sleep(60); await compose("입");
  await check("third syllable composing");
  if (shot) {
    const r = await ev(`(() => { const t = [...terminals.values()][0]; const s = t.term.element.querySelector('.xterm-screen').getBoundingClientRect(); const ch = s.height / t.term.rows; return { x: s.left, y: s.top + t.term.buffer.active.cursorY * ch - ch, width: 260, height: ch * 3 }; })()`);
    const png = await send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 4 } });
    fs.writeFileSync(shot, Buffer.from(png.result.data, "base64"));
  }
  await send("Input.insertText", { text: "입" });
  await sleep(200);
  const final = await state();
  const writes = await ev(`window.__ptyWrites.map(w => w.data).join('')`);
  const bad = steps.filter((s) => s.active && Math.abs(s.overlap) > 0.26);
  console.log(JSON.stringify({ label, steps, final: { line: final.line, cursorX: final.cursorX }, ptyReceived: writes, overlappingSteps: bad.length, errors: h.errors.slice(0, 3) }, null, 1));
  if (bad.length || writes !== "한글입") code = 1;
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
