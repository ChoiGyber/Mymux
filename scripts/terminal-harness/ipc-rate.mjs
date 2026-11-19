// usage: node ipc-rate.mjs <frontendDir> <label>
// How much IPC the output pump generates with four panes, and whether output
// still arrives promptly and completely:
//   idle        4 panes, nothing happening            -> calls per second
//   echo        type into a quiet pane                -> ms until the echo is on screen
//   stream      one pane printing continuously        -> calls per second
//   burst       2 MB dumped into a pane               -> all of it arrives, in order
//   spontaneous output starts in a quiet pane         -> ms until it is on screen
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=20" });
let code = 0;
try {
  const { ev } = h;
  // Four panes in the current tab, like the session this was measured on.
  await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 3 && terminals.size < 4; i++) {
      try { await splitPane(i % 2 ? "vertical" : "horizontal"); } catch {}
      await sleep(400);
    }
    return terminals.size;
  })()`).catch(() => null);
  const panes = await ev(`terminals.size`);
  const reads = () => ev(`(() => { const c = window.__invokeCounts; return (c.pty_read || 0) + (c.pty_read_many || 0); })()`);
  const rate = async (ms) => { const a = await reads(); await sleep(ms); return Math.round(((await reads()) - a) / (ms / 1000) * 10) / 10; };
  const R = { label, panes };

  await sleep(1500);
  R.idleCallsPerSec = await rate(4000);

  R.echoLatencyMs = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const [id, t] = [...terminals.entries()].find(([id]) => id === focusedPaneId) || [...terminals.entries()][0];
    const out = [];
    for (let i = 0; i < 8; i++) {
      await sleep(900);                                   // let the pane go quiet first
      const mark = "k" + i; const s = performance.now();
      t.term.input(mark, true);                           // same path as a real key press
      let seen = false;
      while (performance.now() - s < 1500) {
        const b = t.term.buffer.active; const line = b.getLine(b.baseY + b.cursorY)?.translateToString(true) || "";
        if (line.includes(mark)) { seen = true; break; }
        await new Promise((r) => setTimeout(r, 2));
      }
      out.push(seen ? Math.round(performance.now() - s) : -1);
    }
    return out;
  })()`);

  await ev(`void (window.__streamTimer = setInterval(() => window.__stubPush(focusedPaneId, "streaming line " + Date.now() + "\\r\\n"), 20))`);
  await sleep(700);
  R.streamCallsPerSec = await rate(3000);
  await ev(`clearInterval(window.__streamTimer)`);
  await sleep(800);

  R.burst = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const id = focusedPaneId; const t = terminals.get(id);
    let n = 0; const lines = [];
    while (n < 2 * 1024 * 1024) { const line = "L" + String(lines.length).padStart(7, "0") + " " + "x".repeat(60) + "\\r\\n"; lines.push(line); n += line.length; }
    const s = performance.now();
    window.__stubPush(id, lines.join(""));
    const last = "L" + String(lines.length - 1).padStart(7, "0");
    let done = false; let lag = 0; let prev = performance.now();
    while (performance.now() - s < 30000) {
      const b = t.term.buffer.active; let found = false;
      for (let y = b.length - 1; y >= Math.max(0, b.length - 4) && !found; y--) found = (b.getLine(y)?.translateToString(true) || "").startsWith(last);
      if (found) { done = true; break; }
      await new Promise((r) => setTimeout(r, 10));
      const now = performance.now(); lag = Math.max(lag, now - prev - 10); prev = now;
    }
    // In order: the retained scrollback must be consecutive line numbers.
    const b = t.term.buffer.active; let ordered = true; let prevNo = null;
    for (let y = 0; y < b.length; y++) { const m = /^L(\\d{7}) /.exec(b.getLine(y)?.translateToString(true) || ""); if (!m) continue; const no = Number(m[1]); if (prevNo !== null && no !== prevNo + 1) ordered = false; prevNo = no; }
    return { bytes: n, arrived: done, drainMs: Math.round(performance.now() - s), worstMainThreadGapMs: Math.round(lag), ordered };
  })()`);

  R.spontaneousLatencyMs = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const id = focusedPaneId; const t = terminals.get(id); const out = [];
    for (let i = 0; i < 6; i++) {
      await sleep(1100);
      const mark = "spont" + i; const s = performance.now();
      window.__stubPush(id, mark + "\\r\\n");
      let seen = false;
      while (performance.now() - s < 1500) {
        const b = t.term.buffer.active; let found = false;
        for (let y = b.length - 1; y >= Math.max(0, b.length - 4) && !found; y--) found = (b.getLine(y)?.translateToString(true) || "").includes(mark);
        if (found) { seen = true; break; }
        await new Promise((r) => setTimeout(r, 2));
      }
      out.push(seen ? Math.round(performance.now() - s) : -1);
    }
    return out;
  })()`);
  R.errors = h.errors.slice(0, 2).map((e) => e.slice(0, 140));
  console.log(JSON.stringify(R));
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
