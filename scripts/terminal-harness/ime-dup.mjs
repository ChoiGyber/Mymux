// usage: node ime-dup.mjs <frontendDir> <label>
// Event orders that make xterm 5.5 send one IME commit twice, and the orders
// that look similar but are deliberate repeats. Prints what reached the PTY.
import { boot } from "./harness.mjs";
const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=off" });
let code = 0;
try {
  const out = await h.ev(`(async () => {
    const t = [...terminals.values()][0]; const ta = t.term.textarea; t.term.focus(); ta.focus();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ke = (type) => ta.dispatchEvent(new KeyboardEvent(type, { key: 'Process', code: 'KeyA', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    const kd = () => ke('keydown'), ku = () => ke('keyup');
    const inp = (data, type = 'insertText', composing = false) => ta.dispatchEvent(new InputEvent('input', { data, inputType: type, isComposing: composing, bubbles: true }));
    const ce = (type, data) => ta.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    const reset = async () => { await sleep(250); ta.value = ''; window.__ptyWrites.length = 0; };
    const grab = async () => { await sleep(150); return window.__ptyWrites.map((w) => w.data).join('|'); };
    const R = {};
    await reset(); kd(); ku(); ta.value = '한'; inp('한'); R.A_commit_before_timer = await grab();
    await reset();
    for (let i = 0; i < 2; i++) { kd(); ce('compositionstart', ''); ta.value += 'ㄱ'; ce('compositionupdate', 'ㄱ'); inp('ㄱ', 'insertCompositionText', true);
      ta.value = ta.value.slice(0, -1) + '가'; ce('compositionupdate', '가'); inp('가', 'insertCompositionText', true); ce('compositionend', '가'); ku(); await sleep(5); }
    R.B_composition_gaga = await grab();
    await reset(); kd(); ku(); await sleep(15); ta.value += 'ㅋ'; inp('ㅋ'); await sleep(15); kd(); ku(); await sleep(15); ta.value += 'ㅋ'; inp('ㅋ'); R.C_slow_repeat_kk = await grab();
    await reset(); kd(); kd(); ta.value = '한'; inp('한'); ta.value = '한글'; inp('글'); R.D_pileup_two_keys = await grab();
    await reset(); kd(); await sleep(15); ta.value = '한'; inp('한'); R.E_timer_first = await grab();
    await reset(); kd(); ku(); ta.value = 'ㅋ'; inp('ㅋ'); kd(); ku(); ta.value = 'ㅋㅋ'; inp('ㅋ'); R.G_fast_repeat_kk = await grab();
    await reset(); kd(); ku(); ta.value += '한'; inp('한'); await sleep(200); kd(); ku(); ta.value += '한'; inp('한'); R.H_dup_then_real_repeat = await grab();
    await reset(); kd(); ta.value = '한'; inp('한'); kd(); ta.value = '한글'; inp('글'); kd(); ta.value = '한글입'; inp('입'); R.J_three_keys_interleaved = await grab();
    return R;
  })()`);
  console.log(label.padEnd(8), JSON.stringify(out));
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
