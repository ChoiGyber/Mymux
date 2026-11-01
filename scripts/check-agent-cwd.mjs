import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/mycli-desktop/frontend/app.js", import.meta.url), "utf8");
function block(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source block ${start}`);
  return source.slice(from, to);
}

function harness(windows = false) {
  const calls = [], timers = [], navigations = [];
  const terminals = new Map();
  const context = vm.createContext({
    IS_WINDOWS: windows, terminals, currentExplorerPath: "/unrelated/explorer",
    localStorage: { getItem: () => "powershell" },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "explorer_home_dir") return windows ? "C:\\Users\\me" : "/home/me";
      if (args?.path.includes("missing")) throw Error("not found");
      return [];
    },
    setTimeout: callback => timers.push(callback),
    explorerGo: (path, source) => navigations.push([path, source]),
    setPaneCwd: (id, cwd) => { terminals.get(id).cwd = cwd; },
    isRemotePane: t => t?.type === "ssh",
  });
  vm.runInContext([
    block("async function initialPaneCwd(", "async function createPane("),
    block("function getDefaultShellId(", "async function spawnTerminal("),
    block("function paneShellKind(", "// One line that cds"),
    block("function paneRunsClaude(", "// `id:status`"),
    block("function syncLocalExplorerOnCd(", "// ── Auto-update:"),
  ].join("\n"), context);
  return { context, calls, timers, navigations, terminals };
}

for (const platform of ["macOS", "Linux"]) {
  const h = harness();
  const { context: c, calls, timers, navigations, terminals } = h;
  assert.equal(await c.initialPaneCwd(undefined, null), "/home/me", `${platform} default shell cwd`);
  assert.equal(await c.initialPaneCwd("ssh", null), null, "remote panes do not claim local home");
  assert.equal(await c.initialPaneCwd("zsh", "/work/project"), "/work/project");
  assert.equal(c.getDefaultShellId(), undefined, "Windows shell preference does not override POSIX default");
  assert.equal(c.paneShellKind({ shell: null }), "posix");
  assert.equal(c.paneShellKind({ shell: "pwsh" }), "powershell");
  assert.equal(c.paneShellKind({ shell: "bash" }), "posix");

  for (const [raw, expected] of [
    ["project", "/home/me/project"], ["../other", "/home/other"],
    ["./project/../other/", "/home/me/other"], ["/work/project/", "/work/project"],
    ["'my project'", "/home/me/my project"], ["~", "/home/me"],
    ["~/project", "/home/me/project"], ["$HOME/project", "/home/me/project"],
    ['"$HOME/project"', "/home/me/project"], ["'~/project'", "/home/me/~/project"],
    ["'$HOME/project'", "/home/me/$HOME/project"], ["''", null],
    ["../../../../", "/"], ["-", null],
  ]) assert.equal(c.posixCdTarget(raw, "/home/me", "/home/me"), expected, `${platform} cd ${raw}`);

  const pane = { cwd: await c.initialPaneCwd(undefined, null), aiMode: true, type: "local" };
  terminals.set(1, pane);
  assert.equal(c.agentPollTargets()[0].cwd, "/home/me", "new default panes participate in transcript polling");
  c.syncLocalExplorerOnCd("cd project", 1);
  await timers.shift()();
  assert.equal(pane.cwd, "/home/me/project");
  assert.equal(c.agentPollTargets()[0].cwd, "/home/me/project", "agent polling follows the POSIX cd");
  assert.deepEqual(navigations.at(-1), ["/home/me/project", null], "local cd selects local Explorer");
  assert.ok(calls.some(([command, args]) => command === "explorer_list_local" && args.path === "/home/me/project"));

  c.syncLocalExplorerOnCd("cd /missing", 1);
  await timers.shift()();
  assert.equal(pane.cwd, "/home/me/project", "invalid cd does not replace the transcript cwd");
  c.syncLocalExplorerOnCd("cd -- ~/other", 1);
  await timers.shift()();
  assert.equal(pane.cwd, "/home/me/other");

  c.syncLocalExplorerOnCd("cd /old", 1);
  c.syncLocalExplorerOnCd("cd /new", 1);
  await timers.shift()();
  await timers.shift()();
  assert.equal(pane.cwd, "/new", "a superseded directory lookup does not overwrite the latest command");
  terminals.set(2, { cwd: "/remote", aiMode: true, type: "ssh" });
  terminals.set(3, { cwd: "/codex", aiMode: true, codexDetected: true });
  assert.equal(c.agentPollTargets().length, 1, "remote and Codex panes do not claim Claude transcripts");
}

const win = harness(true);
win.terminals.set(1, { cwd: "C:\\Users\\me" });
assert.equal(win.context.getDefaultShellId(), "powershell");
assert.equal(win.context.paneShellKind({ shell: null }), "powershell");
win.context.syncLocalExplorerOnCd("cd /d D:/Project", 1);
await win.timers.shift()();
assert.equal(win.terminals.get(1).cwd, "D:\\Project", "Windows cd /d remains supported");
assert.match(block("async function createPane(", "// Mouse-wheel must always"), /cwd: effectiveCwd/);
console.log("Agent cwd checks passed: macOS/Linux defaults, POSIX cd and transcript targets, Windows compatibility (simulated; no native acceptance).");
