// Shared boot: serve a frontend dir with the stub injected, open it in headless
// Chrome, hand back a CDP session.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot(frontendDir, { query = "", size = "1400,900", chromeArgs = [] } = {}) {
  const root = path.resolve(frontendDir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/__stub.js") { res.writeHead(200, { "content-type": types[".js"] }); return res.end(fs.readFileSync(path.join(here, "stub.js"))); }
    if (p === "/") p = "/index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    let body = fs.readFileSync(file);
    if (p === "/index.html") body = Buffer.from(body.toString("utf8").replace(/<head[^>]*>/i, (m) => m + '<script src="/__stub.js"></script>'));
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const appPort = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mymux-h-"));
  const child = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${size}`,
    "--no-first-run", "--disable-gpu", ...chromeArgs, `http://127.0.0.1:${appPort}/index.html${query}`,
  ], { stdio: "ignore" });
  const close = () => {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  };
  try {
    let cdpPort = 0;
    for (let i = 0; i < 80 && !cdpPort; i++) {
      try { cdpPort = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { await sleep(150); }
    }
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes(`:${appPort}/`)); } catch {}
      if (!page) await sleep(200);
    }
    if (!page) throw new Error("no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0; const pending = new Map(); const errors = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    await send("Runtime.enable");
    const ev = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
      return r.result.result.value;
    };
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) { ready = await ev("typeof terminals !== 'undefined' && terminals.size > 0").catch(() => false); if (!ready) await sleep(250); }
    if (!ready) throw new Error("no terminal pane booted; errors=" + JSON.stringify(errors.slice(0, 3)));
    await sleep(700);
    return { send, ev, errors, close };
  } catch (e) { close(); throw e; }
}
