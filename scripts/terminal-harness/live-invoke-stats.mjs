// Times every Tauri invoke by command for N seconds on the running app, then
// restores the original function. Pass-through only: arguments and results are
// untouched. The wrapper also removes itself after a deadline in case this
// script dies mid-run.
const PORT = process.argv[2] || "10436";
const SECONDS = Number(process.argv[3] || 75);
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.url.endsWith("tauri.localhost/"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const ime = await evalJs(`(() => {
  const out = {};
  for (const [id, t] of terminals) {
    const view = t.paneEl.querySelector('.composition-view');
    const ta = t.paneEl.querySelector('.xterm-helper-textarea');
    out[id] = { cursorX: t.term.buffer.active.cursorX, cursorY: t.term.buffer.active.cursorY,
      view: view ? { cls: view.className, left: view.style.left, top: view.style.top, text: view.textContent.length, overflow: view.style.overflow, maxWidth: view.style.maxWidth } : null,
      ta: ta ? { left: ta.style.left, top: ta.style.top, len: ta.value.length } : null,
      cellW: t.paneEl.querySelector('.xterm-screen')?.clientWidth / t.term.cols,
      trace: (t.imeTraceBuf || []).slice(-60).map(e => typeof e === 'string' ? e.replace(/[\\uAC00-\\uD7A3\\u3131-\\u318E]/g, '한') : e) };
  }
  return out;
})()`);
console.log("IME", JSON.stringify(ime));

const armed = await evalJs(`(() => {
  if (window.__ivk) return 'already-armed';
  const orig = invoke;
  const p = window.__ivk = { orig, stats: {}, slow: [], probe: [], stop: false, inflight: 0, maxInflight: 0 };
  const wrapped = function (cmd, args, opts) {
    const s = performance.now(); p.inflight++; if (p.inflight > p.maxInflight) p.maxInflight = p.inflight;
    const done = () => { p.inflight--; const d = performance.now() - s; const e = (p.stats[cmd] ||= { n: 0, sum: 0, max: 0, d: [] }); e.n++; e.sum += d; if (d > e.max) e.max = d; if (e.d.length < 6000) e.d.push(d); if (d > 100) p.slow.push([Math.round(s), cmd, Math.round(d)]); };
    let r; try { r = orig.call(this, cmd, args, opts); } catch (err) { done(); throw err; }
    if (r && typeof r.then === 'function') r.then(done, done); else done();
    return r;
  };
  invoke = wrapped;
  p.restore = () => { if (invoke === wrapped) invoke = orig; };
  setTimeout(() => { p.restore(); }, ${(SECONDS + 20) * 1000});
  // Rust main-thread responsiveness: a trivial synchronous command every 100ms.
  const ping = async () => { const s = performance.now(); try { await orig('browser_control_info'); } catch {} p.probe.push([Math.round(s), performance.now() - s]); if (!p.stop) setTimeout(ping, 100); };
  ping();
  return 'armed';
})()`);
console.log("ARM", armed);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const res = await evalJs(`(() => {
  const p = window.__ivk; p.stop = true; p.restore();
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null; };
  const stats = Object.entries(p.stats).map(([k, e]) => ({ cmd: k, n: e.n, perSec: +(e.n / ${SECONDS}).toFixed(1), avg: +(e.sum / e.n).toFixed(1), p50: q(e.d, .5), p95: q(e.d, .95), max: +e.max.toFixed(0), totalMs: Math.round(e.sum) })).sort((a, b) => b.totalMs - a.totalMs);
  const pr = p.probe.map(x => x[1]);
  const out = { restored: invoke === p.orig, maxInflight: p.maxInflight, stats, slow: p.slow.slice(0, 60),
    probe: { n: pr.length, p50: q(pr, .5), p95: q(pr, .95), p99: q(pr, .99), max: q(pr, 1), over50: p.probe.filter(x => x[1] > 50).map(x => [x[0], Math.round(x[1])]) } };
  delete window.__ivk; return out;
})()`);
console.log("RESTORED", res.restored, "maxInflight", res.maxInflight);
console.table(res.stats);
console.log("SLOW(>100ms) [t, cmd, ms]", JSON.stringify(res.slow));
console.log("PROBE", JSON.stringify(res.probe));
ws.close();
