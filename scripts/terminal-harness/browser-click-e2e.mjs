// usage: node browser-click-e2e.mjs <frontendDir> <label>
// End to end through Mymux's own browser panel: a real headless Chrome shows a
// page, the panel displays it by screencast, a real mouse click lands on the
// panel, and we wait for the panel's picture to show what the click did.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const html = `<!doctype html><meta charset="utf-8"><title>t</title><body style="margin:0;height:100vh;background:#fff" onclick="this.style.background = this.dataset.c === 'red' ? 'rgb(0,0,200)' : 'rgb(200,0,0)'; this.dataset.c = this.dataset.c === 'red' ? 'blue' : 'red'"></body>`;
const site = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mymux-e2e-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--headless=new", `http://127.0.0.1:${site.address().port}/`], { stdio: "ignore" });
let h; let code = 0;
try {
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { await sleep(150); } }
  let target;
  for (let i = 0; i < 40 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
  h = await boot(dir, { query: "?echo=off" });
  const { ev, send } = h;
  await ev(`(() => {
    const status = { running: true, port: ${port}, endpoint: "http://127.0.0.1:${port}", browser: "chrome" };
    const pages = [{ wsUrl: ${JSON.stringify(target.webSocketDebuggerUrl)}, targetId: ${JSON.stringify(target.id)}, url: ${JSON.stringify(target.url)}, title: "t" }];
    window.__stubReplies = { browser_status: status, browser_launch: status, browser_page_targets: pages, browser_page_target: pages[0] };
    const p = document.getElementById("browser-port"); if (p) p.value = "${port}";
    window.__frames = 0; window.__sent = [];
    const hm = handleCdpMessage; handleCdpMessage = function (d) { if (String(d).includes("screencastFrame")) window.__frames++; return hm(d); };
    const cs = cdpSend; cdpSend = function (m, p) { if (m.startsWith("Input.dispatchMouse") && p.type !== "mouseMoved") window.__sent.push(p.type + "@" + p.x + "," + p.y); return cs(m, p); };
    setBrowserView(true); setBrowserMode("ai");
  })()`);
  const colour = () => ev(`(async () => { const img = document.getElementById("browser-screen"); if (!img || !img.src || !img.naturalWidth) return null;
    const c = document.createElement("canvas"); c.width = 8; c.height = 8; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 8, 8); const d = g.getImageData(4, 4, 1, 1).data; return d[0] > 150 && d[1] < 90 ? "red" : d[2] > 150 && d[0] < 90 ? "blue" : d[0] > 200 && d[1] > 200 ? "white" : "other:" + [...d].join(","); })()`);
  let first = null;
  for (let i = 0; i < 60 && first !== "white"; i++) { first = await colour(); if (first !== "white") await sleep(200); }
  const R = { label, attached: first === "white", clicks: [] };
  if (R.attached) {
    R.dismissed = await ev(`(() => { const out = []; const img = document.getElementById("browser-screen"); const r = img.getBoundingClientRect();
      for (let i = 0; i < 6; i++) { let e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!e || e === img) break; while (e.parentElement && e.parentElement !== document.body) e = e.parentElement; out.push(e.id || e.className); e.style.display = "none"; }
      return out; })()`);
    const pt = await ev(`(() => { const r = document.getElementById("browser-screen").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const want of ["red", "blue", "red"]) {
      await sleep(1200); // the page is at rest, like a page someone is reading
      const s = Date.now();
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      let shown = "NEVER (4s)";
      while (Date.now() - s < 4000) { if ((await colour()) === want) { shown = Date.now() - s; break; } await sleep(15); }
      const dbg = await ev(`(() => ({ frames: window.__frames, sent: window.__sent, meta: !!lastFrameMeta, ws: cdpWs && cdpWs.readyState, busy: cdpFrameState && cdpFrameState.busy, pending: !!(cdpFrameState && cdpFrameState.pending), active: document.activeElement && document.activeElement.id, hit: (() => { const r = document.getElementById("browser-screen").getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e && (e.id || e.className || e.tagName); })() }))()`);
      const remote = await (async () => { const w = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${target.id}`); await new Promise((r, j) => { w.onopen = r; w.onerror = j; }); const v = await new Promise((res) => { w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result?.result?.value); }; w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.body.style.background", returnByValue: true } })); }); w.close(); return v; })();
      R.clicks.push({ want, pictureUpdatedMs: shown, remoteBackground: remote, framesSoFar: dbg.frames });
    }
  }
  R.errors = h.errors.slice(0, 2).map((e) => e.slice(0, 120));
  console.log(JSON.stringify(R));
  if (!R.attached || R.clicks.some((c) => typeof c.pictureUpdatedMs !== "number")) code = 1;
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally {
  try { h?.close(); } catch {}
  try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  site.close(); await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  process.exit(code);
}
