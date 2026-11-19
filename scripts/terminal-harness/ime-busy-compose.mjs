// usage: node ime-busy-compose.mjs <frontendDir> <label>
// The normal Korean IME flow (composition events) delivered while the main
// thread is held: does a stalled UI corrupt ordinary Hangul typing?
import { boot, sleep } from "./harness.mjs";
const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=off" });
let code = 0;
try {
  const { send, ev } = h;
  await ev(`(() => { const t = [...terminals.values()][0]; t.term.focus(); t.term.textarea.focus(); })()`);
  const key = (type) => send("Input.dispatchKeyEvent", { type, key: "Process", code: "KeyG", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  const comp = (text) => send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  const R = {};
  for (const [name, holdMs] of [["no_stall", 0], ["stall_400ms", 400], ["stall_800ms", 800]]) {
    await ev(`(() => { window.__ptyWrites.length = 0; const t = [...terminals.values()][0]; t.term.textarea.blur(); t.term.textarea.focus(); })()`);
    await sleep(150);
    if (holdMs) await ev(`void setTimeout(() => { const e = performance.now() + ${holdMs}; while (performance.now() < e) {} }, 0)`);
    await sleep(20);
    const q = []; const step = async (...ps) => { q.push(...ps); if (!holdMs) { await Promise.all(q); await sleep(40); } };
    // ㅎ ㅏ ㄴ | ㄱ ㅡ ㄹ | ㅇ ㅣ ㅂ, then a space commits the last syllable.
    await step(key("rawKeyDown"), comp("ㅎ"), key("keyUp")); await step(key("rawKeyDown"), comp("하"), key("keyUp")); await step(key("rawKeyDown"), comp("한"), key("keyUp"));
    await step(key("rawKeyDown"), send("Input.insertText", { text: "한" }), comp("ㄱ"), key("keyUp")); await step(key("rawKeyDown"), comp("그"), key("keyUp")); await step(key("rawKeyDown"), comp("글"), key("keyUp"));
    await step(key("rawKeyDown"), send("Input.insertText", { text: "글" }), comp("ㅇ"), key("keyUp")); await step(key("rawKeyDown"), comp("이"), key("keyUp")); await step(key("rawKeyDown"), comp("입"), key("keyUp"));
    await step(key("rawKeyDown"), send("Input.insertText", { text: "입" }), key("keyUp"));
    await Promise.all(q); await sleep(holdMs + 400);
    const got = await ev(`window.__ptyWrites.map(w => w.data).join('')`);
    R[name] = { ptyReceived: got, ok: got === "한글입" };
  }
  console.log(label.padEnd(9), JSON.stringify(R));
  if (Object.values(R).some((r) => !r.ok)) code = 1;
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
