// usage: node screencast-click.mjs
// The built-in browser shows a headless Chrome through Page.startScreencast and
// forwards clicks over CDP. Measures, for a given everyNthFrame, how long after a
// click the first frame that shows the result arrives. Same launch flags and
// screencast parameters as browser.rs / app.js.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page1 = `<!doctype html><meta charset="utf-8"><title>one</title><body style="margin:0;font:40px sans-serif;background:#fff">
<a id="link" href="/two" style="display:block;padding:60px">go to page two</a>
<button id="btn" style="display:block;margin:20px 60px;font:40px sans-serif" onclick="document.body.style.background='#c00';document.title='clicked'">change once</button>
<button id="slow" style="display:block;margin:20px 60px;font:40px sans-serif" onclick="setTimeout(()=>{document.body.style.background='#060';document.title='late'},400)">change after 400ms</button></body>`;
const page2 = `<!doctype html><meta charset="utf-8"><title>two</title><body style="margin:0;font:40px sans-serif;background:#00c;color:#fff"><p style="padding:60px">page two</p></body>`;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(req.url.startsWith("/two") ? page2 : page1); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function run(everyNthFrame, ackGapMs = 0) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mymux-sc-"));
  const child = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--headless=new", `${base}/one`], { stdio: "ignore" });
  const out = {};
  try {
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) { try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { await sleep(150); } }
    let target;
    for (let i = 0; i < 40 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0; let lastAck = 0; const pending = new Map(); const frames = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method === "Page.screencastFrame") {
        frames.push({ t: performance.now(), bytes: d.params.data.length, data: d.params.data });
        const ack = () => ws.send(JSON.stringify({ id: ++seq, method: "Page.screencastFrameAck", params: { sessionId: d.params.sessionId } }));
        const wait = Math.max(0, lastAck + ackGapMs - performance.now()); lastAck = performance.now() + wait;
        if (wait > 0) setTimeout(ack, wait); else ack();
      }
    };
    const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    await send("Page.enable");
    await send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame });
    await sleep(1200);
    const center = async (id) => (await send("Runtime.evaluate", { returnByValue: true, expression: `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()` })).result.result.value;
    const title = async () => (await send("Runtime.evaluate", { returnByValue: true, expression: "document.title" })).result.result.value;
    // The first frame after the click whose pixels differ from the one before it
    // is the first time the user sees that anything happened.
    const click = async (name, id, wantTitle, changeAtMs = 0) => {
      await sleep(900);
      const pt = await center(id); const before = frames.length; const lastBefore = frames[frames.length - 1]?.data;
      const s = performance.now();
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      let pageChangedMs = null;
      for (let i = 0; i < 100 && pageChangedMs === null; i++) { if ((await title()) === wantTitle) pageChangedMs = Math.round(performance.now() - s); else await sleep(20); }
      await sleep(4000);
      const after = frames.slice(before);
      const changed = after.find((f) => f.data !== lastBefore);
      const late = after.filter((f) => f.t - s > changeAtMs - 20);
      out[name] = { pageChangedMs, framesIn4s: after.length, resultShownMs: late.length ? Math.round(late[0].t - s) : "NEVER" };
    };
    await click("singleRepaint", "btn", "clicked");
    await click("lateRepaint", "slow", "late", 400);
    await click("linkNavigation", "link", "two");
    // Continuous animation: how much the preview costs when the page never rests.
    await sleep(500);
    await send("Runtime.evaluate", { expression: "document.body.insertAdjacentHTML('beforeend', '<div style=\"width:200px;height:200px;background:#fc0;animation:s 1s linear infinite\"></div><style>@keyframes s{to{transform:translateX(900px) rotate(360deg)}}</style>')" });
    await sleep(500); const b = frames.length; const t0 = performance.now(); await sleep(3000);
    const anim = frames.slice(b); out.animation = { framesPerSec: Math.round(anim.length / ((performance.now() - t0) / 1000) * 10) / 10, kbPerSec: Math.round(anim.reduce((a, f) => a + f.bytes, 0) / 3 / 1024) };
    ws.close();
  } finally {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
  return out;
}
for (const [n, gap] of [[4, 0], [1, 0], [1, 50]]) console.log(`everyNthFrame=${n} ackGap=${gap}ms`, JSON.stringify(await run(n, gap)));
server.close();
process.exit(0);
