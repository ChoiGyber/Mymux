// usage: node ime-busy.mjs <frontendDir> <label>
// Real input pipeline (CDP key events + insertText) delivered while the page's
// main thread is held, the way keystrokes queue up behind a stalled UI.
import { boot, sleep } from "./harness.mjs";
const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=off" });
let code = 0;
try {
  const { send, ev } = h;
  await ev(`(() => { const t = [...terminals.values()][0]; t.term.focus(); t.term.textarea.focus(); })()`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, key: "Process", code: "KeyG", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  const R = {};
  for (const [name, holdMs, words] of [["no_stall", 0, ["한", "글", "입", "력"]], ["stall_400ms", 400, ["한", "글", "입", "력"]], ["stall_same_char", 400, ["ㅋ", "ㅋ", "ㅋ"]], ["stall_800ms_long", 800, ["가", "나", "다", "라", "마", "바"]]]) {
    await ev(`(() => { window.__ptyWrites.length = 0; [...terminals.values()][0].term.textarea.value = ''; })()`);
    if (holdMs) await ev(`void setTimeout(() => { const e = performance.now() + ${holdMs}; while (performance.now() < e) {} }, 0)`);
    await sleep(20);
    const sent = [];
    for (const w of words) { sent.push(key("rawKeyDown"), key("keyUp"), send("Input.insertText", { text: w })); if (!holdMs) { await Promise.all(sent); await sleep(60); } }
    await Promise.all(sent); await sleep(holdMs + 400);
    const got = await ev(`window.__ptyWrites.map(w => w.data).join('')`);
    R[name] = { typed: words.join(""), ptyReceived: got, ok: got === words.join("") };
  }
  console.log(label.padEnd(9), JSON.stringify(R));
  if (Object.values(R).some((r) => !r.ok)) code = 1;
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
