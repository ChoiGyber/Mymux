#!/usr/bin/env node
// Minimal stdio MCP server for named Mymux teams. All agent-facing text is English.
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const cwd = path.resolve(arg("--cwd") || process.cwd());
const stateDir = path.resolve(arg("--state-dir") || path.join(cwd, ".mymux-team"));
let workers = [];
try { workers = JSON.parse(arg("--workers-json") || "[]"); } catch {}
const tasks = new Map();

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function result(id, value, isError = false) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) } });
}
async function persist(task) {
  await mkdir(path.join(stateDir, "tasks"), { recursive: true });
  const target = path.join(stateDir, "tasks", `${task.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(task, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}
function runWorker(task, worker) {
  const prompt = [
    "You are a coding worker in a Mymux engineering team. Communicate with the lead agent in English only.",
    "Work only on the assigned task in the shared repository. Do not change files outside its scope.",
    "Do not commit, push, deploy, or perform unrelated cleanup. Inspect the current worktree and preserve other agents' changes.",
    "When finished, report changed files, key decisions, checks actually run, and remaining risks in English.",
    "\nASSIGNED TASK:\n" + task.prompt,
  ].join("\n");
  const cliArgs = ["exec", "--full-auto", "--json"];
  if (worker.model) cliArgs.push("--model", worker.model);
  cliArgs.push(prompt);
  const extractFinal = (stdout) => {
    const messages = [];
    for (const line of String(stdout || "").split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        const item = event.item || event;
        if ((item.type === "agent_message" || item.type === "message") && typeof item.text === "string") messages.push(item.text);
      } catch {}
    }
    return (messages.at(-1) || String(stdout || "")).trim().slice(-50000);
  };
  return execFileAsync("codex", cliArgs, { cwd, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    .then(({ stdout, stderr }) => ({ status: "completed", output: extractFinal(stdout), diagnostics: String(stderr || "").slice(-8000) }))
    .catch((error) => ({ status: "failed", output: extractFinal(error.stdout), diagnostics: String(error.stderr || error.message || "Codex worker failed").slice(-8000) }));
}

async function handleTool(name, input) {
  if (name === "list_workers") return JSON.stringify(workers.map(({ name, model }) => ({ name, model: model || "Codex configured default" })), null, 2);
  if (name === "delegate_task") {
    if ([...tasks.values()].filter((task) => task.status === "running").length >= 3) {
      throw new Error("The team already has three active tasks. Collect results before delegating more work.");
    }
    const worker = workers.find((item) => item.name === input.worker);
    const prompt = String(input.task || "").trim();
    if (!worker) throw new Error("Unknown worker. Call list_workers and use an exact worker name.");
    if (!prompt) throw new Error("Task text is required.");
    const task = { id: randomUUID(), worker: worker.name, status: "running", prompt, startedAt: new Date().toISOString(), output: "", diagnostics: "" };
    tasks.set(task.id, task);
    await persist(task);
    task.promise = runWorker(task, worker).then(async (done) => {
      Object.assign(task, done, { finishedAt: new Date().toISOString() });
      await persist(task);
    });
    return JSON.stringify({ taskId: task.id, worker: worker.name, status: "running" });
  }
  if (name === "collect_results") {
    const ids = Array.isArray(input.taskIds) ? input.taskIds.map(String) : [...tasks.keys()];
    const waitMs = Math.max(0, Math.min(25000, Number(input.waitMs) || 0));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && ids.some((id) => tasks.get(id)?.status === "running")) await new Promise((resolve) => setTimeout(resolve, 350));
    const collected = ids.map((id) => {
      const task = tasks.get(id);
      return task ? { taskId: task.id, worker: task.worker, status: task.status, output: task.output, diagnostics: task.diagnostics } : { taskId: id, status: "unknown" };
    });
    return JSON.stringify(collected, null, 2);
  }
  throw new Error(`Unknown tool: ${name}`);
}

const tools = [
  { name: "list_workers", description: "List the coding workers available in this named Mymux team. Use English for all agent communication.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "delegate_task", description: "Start a bounded coding task on a team worker. The task is asynchronous; call collect_results later. At most three tasks can run simultaneously. Write the task in English, assign non-overlapping files where possible, and never ask workers to commit, push, or deploy.", inputSchema: { type: "object", properties: { worker: { type: "string", description: "Exact worker name from list_workers." }, task: { type: "string", description: "Task instructions in English, including scope and completion evidence." } }, required: ["worker", "task"], additionalProperties: false } },
  { name: "collect_results", description: "Wait briefly for and collect worker results. Call with taskIds returned by delegate_task; use waitMs up to 25000 and repeat while tasks are running. Results are in English.", inputSchema: { type: "object", properties: { taskIds: { type: "array", items: { type: "string" } }, waitMs: { type: "integer", minimum: 0, maximum: 25000 } }, additionalProperties: false } },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mymux-team", version: "1.0.0" } } });
    return;
  }
  if (message.method === "ping") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools } }); return; }
  if (message.method === "tools/call") {
    try { result(message.id, await handleTool(message.params?.name, message.params?.arguments || {})); }
    catch (error) { result(message.id, String(error?.message || error), true); }
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
