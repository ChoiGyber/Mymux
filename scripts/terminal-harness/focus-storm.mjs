// usage: node focus-storm.mjs <frontendDir> <label>
// Measures what one "window came back" costs: how many focus events the helper
// textarea receives, how long the main thread is held, and how many focus
// reports (ESC[I) reach the PTY when the running program asked for them.
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=30" });
let code = 0;
try {
  const { ev } = h;
  const out = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const [id, t] = [...terminals.entries()][0]; const ta = t.term.textarea;
    t.term.focus(); ta.focus();
    window.__stubPush(id, "\\x1b[?1004h");           // the program turns focus reporting on
    await sleep(300);
    const run = async (name, trigger) => {
      let focusEvents = 0; const count = () => { focusEvents++; };
      ta.addEventListener("focus", count);
      window.__ptyWrites.length = 0;
      const s = performance.now(); let threw = null;
      try { trigger(); } catch (e) { threw = String(e).slice(0, 80); }
      const syncMs = performance.now() - s;
      await sleep(900);                                // let the 80/220/500 ms retries run
      ta.removeEventListener("focus", count);
      const reports = window.__ptyWrites.filter((w) => w.data.includes("\\x1b[I")).length;
      return { name, focusEvents, syncMs: Math.round(syncMs * 10) / 10, focusReportsToPty: reports, threw };
    };
    const R = [];
    // xterm drops its "focus" class when the window loses focus; the textarea stays activeElement.
    const loseClass = () => t.term.element.classList.remove("focus");
    loseClass();
    R.push(await run("window focus returns (class stale)", () => window.dispatchEvent(new FocusEvent("focus"))));
    await sleep(700);
    R.push(await run("window focus returns (class intact)", () => window.dispatchEvent(new FocusEvent("focus"))));
    await sleep(700);
    loseClass();
    R.push(await run("250ms backstop tick (class stale)", () => {}));
    return R;
  })()`);
  console.log(JSON.stringify({ label, results: out, uncaught: h.errors.length, firstError: (h.errors[0] || "").slice(0, 90) }, null, 1));
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
