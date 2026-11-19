// usage: node focus-panes.mjs <frontendDir> <label>
// With four panes: what does opening a pane, switching panes and coming back to
// the window cost in focus events, focus reports sent to the programs, and
// uncaught errors? The programs have focus reporting on, as Claude Code does.
import { boot, sleep } from "./harness.mjs";

const [dir, label] = [process.argv[2], process.argv[3] || "run"];
const h = await boot(dir, { query: "?echo=20" });
let code = 0;
try {
  const { ev, send } = h;
  const R = { label };
  const errorsBefore = () => h.errors.length;
  let e0 = errorsBefore();
  await ev(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__focusEvents = 0;
    document.addEventListener("focus", (e) => { if (e.target?.classList?.contains("xterm-helper-textarea")) window.__focusEvents++; }, true);
    for (let i = 0; i < 3; i++) { try { await splitPane(i % 2 ? "vertical" : "horizontal"); } catch {} await sleep(500); }
    for (const id of terminals.keys()) window.__stubPush(id, "\\x1b[?1004h");
    await sleep(400); })()`);
  R.panes = await ev(`terminals.size`);
  R.split = { focusEvents: await ev(`window.__focusEvents`), uncaughtErrors: errorsBefore() - e0 };

  const measure = async (name, action) => {
    await sleep(700);
    e0 = errorsBefore();
    await ev(`(() => { window.__focusEvents = 0; window.__ptyWrites.length = 0; })()`);
    const syncMs = await action();
    await sleep(900);
    const reports = await ev(`window.__ptyWrites.filter((w) => /\\x1b\\[[IO]/.test(w.data)).length`);
    R[name] = { focusEvents: await ev(`window.__focusEvents`), focusReportsToPty: reports, syncMs, uncaughtErrors: errorsBefore() - e0 };
  };
  // A real mouse click on another pane.
  await measure("clickOtherPane", async () => {
    const pt = await ev(`(() => { const other = [...terminals.entries()].find(([id]) => id !== focusedPaneId)[1]; const r = other.paneEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const s = Date.now();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    return Date.now() - s;
  });
  await measure("clickBack", async () => {
    const pt = await ev(`(() => { const other = [...terminals.entries()].find(([id]) => id !== focusedPaneId)[1]; const r = other.paneEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const s = Date.now();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    return Date.now() - s;
  });
  await measure("windowReturns", async () => ev(`(() => { const t = terminals.get(focusedPaneId); t.term.element.classList.remove("focus"); const s = performance.now(); window.dispatchEvent(new FocusEvent("focus")); return Math.round((performance.now() - s) * 10) / 10; })()`));
  R.focusedPaneStillTyped = await ev(`(async () => { const t = terminals.get(focusedPaneId); window.__ptyWrites.length = 0; t.term.input("ok", true); await new Promise((r) => setTimeout(r, 100)); return document.activeElement === t.term.textarea && window.__ptyWrites.map((w) => w.data).join("") === "ok"; })()`);
  console.log(JSON.stringify(R));
} catch (e) { console.error("HARNESS ERROR:", e.message); code = 2; }
finally { h.close(); process.exit(code); }
