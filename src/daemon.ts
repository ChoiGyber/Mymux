#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import pty from "node-pty";
import {
  SOCKET_PATH,
  getSessionEventLogPath,
  getSessionLogPath,
  resolveDefaultShell,
} from "./config.js";
import { stripAnsi } from "./ansi.js";
import { createJsonLineReader, sendJson } from "./protocol.js";
import { ensureAppDir, loadState, saveState } from "./store.js";
import type { ClientMessage, ServerMessage, SessionRecord } from "./types.js";

const MAX_BUFFER_SIZE = 64 * 1024;

interface SessionRuntime {
  record: SessionRecord;
  ptyProcess: pty.IPty;
  logStream: fs.WriteStream;
  eventLogStream: fs.WriteStream;
  recentOutput: string;
  attachedClient?: net.Socket;
}

const sessions = new Map<string, SessionRuntime>();

bootstrap();

function bootstrap(): void {
  ensureAppDir();

  if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
    fs.rmSync(SOCKET_PATH, { force: true });
  }

  restoreKnownSessions();

  const server = net.createServer((socket) => {
    const readJson = createJsonLineReader((message) => {
      handleMessage(socket, message as ClientMessage);
    });

    socket.on("data", readJson);
    socket.on("error", () => {
      detachSocket(socket);
    });
    socket.on("close", () => {
      detachSocket(socket);
    });
  });

  server.listen(SOCKET_PATH, () => {
    const payload: ServerMessage = {
      type: "ready",
      pid: process.pid,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  });
}

function restoreKnownSessions(): void {
  const state = loadState();

  for (const session of state.sessions) {
    if (session.status === "stopped" || sessions.has(session.name)) {
      continue;
    }

    const runtime = spawnSession(session.name, session.cwd, session.shell, session.env, {
      createdAt: session.createdAt,
      profileName: session.profileName,
      startupCommand: session.startupCommand,
    });
    runtime.record.createdAt = session.createdAt;
    runtime.record.updatedAt = new Date().toISOString();
  }

  persist();
}

function handleMessage(socket: net.Socket, message: ClientMessage): void {
  switch (message.type) {
    case "health":
      sendJson(socket, {
        type: "success",
        message: "daemon is running",
        pid: process.pid,
        sessions: [...sessions.values()].map((entry) => entry.record),
      } satisfies ServerMessage);
      return;
    case "stopDaemon":
      sendJson(socket, {
        type: "success",
        message: "Daemon stopping.",
        pid: process.pid,
      } satisfies ServerMessage);
      shutdown();
      return;
    case "createSession": {
      if (sessions.has(message.name)) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.name}' already exists.`,
        } satisfies ServerMessage);
        return;
      }

      const runtime = spawnSession(
        message.name,
        message.cwd ?? process.cwd(),
        resolveDefaultShell(message.shell),
        message.env,
        {
          profileName: message.profileName,
          startupCommand: message.startupCommand,
        },
      );

      sendJson(socket, {
        type: "success",
        message: `Session '${message.name}' created.`,
        session: runtime.record,
      } satisfies ServerMessage);
      return;
    }
    case "listSessions":
      sendJson(socket, {
        type: "success",
        message: `${sessions.size} sessions`,
        sessions: [...sessions.values()].map((entry) => entry.record),
      } satisfies ServerMessage);
      return;
    case "restoreSessions": {
      const before = sessions.size;
      restoreKnownSessions();
      const restored = sessions.size - before;
      sendJson(socket, {
        type: "success",
        message: restored > 0 ? `Restored ${restored} sessions.` : "No sessions to restore.",
        sessions: [...sessions.values()].map((entry) => entry.record),
      } satisfies ServerMessage);
      return;
    }
    case "killSession": {
      const runtime = sessions.get(message.name);

      if (!runtime) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.name}' not found.`,
        } satisfies ServerMessage);
        return;
      }

      runtime.record.status = "stopped";
      runtime.ptyProcess.kill();
      runtime.logStream.end();
      runtime.eventLogStream.end();
      sessions.delete(message.name);
      persist();

      sendJson(socket, {
        type: "success",
        message: `Session '${message.name}' killed.`,
      } satisfies ServerMessage);
      return;
    }
    case "renameSession": {
      if (sessions.has(message.nextName)) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.nextName}' already exists.`,
        } satisfies ServerMessage);
        return;
      }

      const runtime = sessions.get(message.name);
      if (!runtime) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.name}' not found.`,
        } satisfies ServerMessage);
        return;
      }

      renameSession(runtime, message.nextName);
      sendJson(socket, {
        type: "success",
        message: `Session '${message.name}' renamed to '${message.nextName}'.`,
        session: runtime.record,
      } satisfies ServerMessage);
      return;
    }
    case "attachSession": {
      const runtime = sessions.get(message.name);

      if (!runtime) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.name}' not found.`,
        } satisfies ServerMessage);
        return;
      }

      if (runtime.attachedClient && !runtime.attachedClient.destroyed) {
        sendJson(socket, {
          type: "error",
          message: `Session '${message.name}' is already attached.`,
        } satisfies ServerMessage);
        return;
      }

      runtime.attachedClient = socket;
      runtime.record.status = "attached";
      runtime.record.updatedAt = new Date().toISOString();
      runtime.ptyProcess.resize(message.cols, message.rows);
      persist();

      sendJson(socket, {
        type: "attached",
        session: runtime.record,
      } satisfies ServerMessage);
      if (runtime.recentOutput) {
        sendJson(socket, {
          type: "output",
          data: Buffer.from(runtime.recentOutput, "utf8").toString("base64"),
        } satisfies ServerMessage);
      }
      return;
    }
    case "stdin": {
      const runtime = findRuntimeBySocket(socket);
      if (runtime) {
        runtime.ptyProcess.write(Buffer.from(message.data, "base64").toString("utf8"));
      }
      return;
    }
    case "resize": {
      const runtime = findRuntimeBySocket(socket);
      if (runtime) {
        runtime.ptyProcess.resize(message.cols, message.rows);
      }
      return;
    }
    case "detach": {
      detachSocket(socket);
      return;
    }
    case "readLogs": {
      const logPath = getSessionLogPath(message.name);
      const log = message.since
        ? readSince(getSessionEventLogPath(message.name), message.since, message.clean ?? false)
        : readTail(logPath, message.lines, message.clean ?? false);
      sendJson(socket, {
        type: "success",
        message: `Read logs for '${message.name}'.`,
        log,
      } satisfies ServerMessage);
      return;
    }
  }
}

function spawnSession(
  name: string,
  cwd: string,
  shell: string,
  envOverrides?: Record<string, string>,
  options?: { createdAt?: string; profileName?: string; startupCommand?: string },
): SessionRuntime {
  ensureAppDir();
  const logPath = getSessionLogPath(name);
  const eventLogPath = getSessionEventLogPath(name);
  const env = {
    ...process.env,
    ...envOverrides,
    TERM: "xterm-256color",
  };
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd,
    env,
  });

  const now = new Date().toISOString();
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const eventLogStream = fs.createWriteStream(eventLogPath, { flags: "a" });
  const runtime: SessionRuntime = {
    record: {
      name,
      shell,
      cwd,
      pid: ptyProcess.pid,
      logPath,
      profileName: options?.profileName,
      env: envOverrides,
      startupCommand: options?.startupCommand,
      createdAt: options?.createdAt ?? now,
      updatedAt: now,
      status: "running",
    },
    ptyProcess,
    logStream,
    eventLogStream,
    recentOutput: readRecentLog(logPath),
  };

  ptyProcess.onData((data) => {
    runtime.logStream.write(data);
    runtime.eventLogStream.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), data })}\n`,
    );
    runtime.recentOutput = appendRecentOutput(runtime.recentOutput, data);

    if (runtime.attachedClient && !runtime.attachedClient.destroyed) {
      sendJson(runtime.attachedClient, {
        type: "output",
        data: Buffer.from(data, "utf8").toString("base64"),
      } satisfies ServerMessage);
    }
  });

  if (options?.startupCommand) {
    setTimeout(() => {
      ptyProcess.write(`${options.startupCommand}\r`);
    }, 120);
  }

  ptyProcess.onExit(({ exitCode }) => {
    if (runtime.attachedClient && !runtime.attachedClient.destroyed) {
      sendJson(runtime.attachedClient, {
        type: "sessionExit",
        name: runtime.record.name,
        exitCode,
      } satisfies ServerMessage);
    }

    runtime.logStream.end();
    runtime.eventLogStream.end();
    sessions.delete(runtime.record.name);
    persist();
  });

  sessions.set(name, runtime);
  persist();
  return runtime;
}

function findRuntimeBySocket(socket: net.Socket): SessionRuntime | undefined {
  for (const runtime of sessions.values()) {
    if (runtime.attachedClient === socket) {
      return runtime;
    }
  }

  return undefined;
}

function detachSocket(socket: net.Socket): void {
  const runtime = findRuntimeBySocket(socket);

  if (!runtime) {
    return;
  }

  runtime.attachedClient = undefined;
  runtime.record.status = "running";
  runtime.record.updatedAt = new Date().toISOString();
  persist();
}

function persist(): void {
  saveState([...sessions.values()].map((entry) => entry.record));
}

function appendRecentOutput(current: string, next: string): string {
  const combined = `${current}${next}`;
  if (combined.length <= MAX_BUFFER_SIZE) {
    return combined;
  }

  return combined.slice(combined.length - MAX_BUFFER_SIZE);
}

function readRecentLog(logPath: string): string {
  if (!fs.existsSync(logPath)) {
    return "";
  }

  const content = fs.readFileSync(logPath, "utf8");
  if (content.length <= MAX_BUFFER_SIZE) {
    return content;
  }

  return content.slice(content.length - MAX_BUFFER_SIZE);
}

function readTail(logPath: string, lines: number, clean: boolean): string {
  if (!fs.existsSync(logPath)) {
    return "";
  }

  const content = fs.readFileSync(logPath, "utf8");
  const safeLineCount = Math.max(1, Math.min(lines, 5000));
  const result = content.split(/\r?\n/).slice(-safeLineCount).join("\n");
  return clean ? stripAnsi(result) : result;
}

function shutdown(): void {
  persist();
  setTimeout(() => {
    process.exit(0);
  }, 25);
}

function renameSession(runtime: SessionRuntime, nextName: string): void {
  const previousName = runtime.record.name;
  const previousLogPath = runtime.record.logPath;
  const previousEventLogPath = getSessionEventLogPath(previousName);
  const nextLogPath = getSessionLogPath(nextName);
  const nextEventLogPath = getSessionEventLogPath(nextName);

  runtime.logStream.end();
  runtime.eventLogStream.end();

  if (fs.existsSync(previousLogPath)) {
    fs.renameSync(previousLogPath, nextLogPath);
  }
  if (fs.existsSync(previousEventLogPath)) {
    fs.renameSync(previousEventLogPath, nextEventLogPath);
  }

  runtime.logStream = fs.createWriteStream(nextLogPath, { flags: "a" });
  runtime.eventLogStream = fs.createWriteStream(nextEventLogPath, { flags: "a" });
  runtime.record.name = nextName;
  runtime.record.logPath = nextLogPath;
  runtime.record.updatedAt = new Date().toISOString();

  sessions.delete(previousName);
  sessions.set(nextName, runtime);
  persist();
}

function readSince(eventLogPath: string, since: string, clean: boolean): string {
  if (!fs.existsSync(eventLogPath)) {
    return "";
  }

  const sinceMs = parseSinceExpression(since);
  const lines = fs.readFileSync(eventLogPath, "utf8").split(/\r?\n/);
  const chunks: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as { timestamp?: string; data?: string };
      if (!entry.timestamp || typeof entry.data !== "string") {
        continue;
      }

      const timestampMs = new Date(entry.timestamp).getTime();
      if (Number.isNaN(timestampMs) || timestampMs < sinceMs) {
        continue;
      }

      chunks.push(entry.data);
    } catch {
      continue;
    }
  }

  const result = chunks.join("");
  return clean ? stripAnsi(result) : result;
}

function parseSinceExpression(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const absoluteTime = new Date(value).getTime();
  if (!Number.isNaN(absoluteTime)) {
    return absoluteTime;
  }

  const match = trimmed.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error("Invalid --since value. Use ISO time or relative values like 10m, 2h, 1d.");
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Date.now() - amount * multipliers[unit];
}
