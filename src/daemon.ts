#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import pty from "node-pty";
import {
  APP_DIR,
  LOGS_DIR,
  SOCKET_PATH,
  getSessionLogPath,
  resolveDefaultShell,
} from "./config.js";
import { createJsonLineReader, sendJson } from "./protocol.js";
import { ensureAppDir, loadState, saveState } from "./store.js";
import type { ClientMessage, ServerMessage, SessionRecord } from "./types.js";

const MAX_BUFFER_SIZE = 64 * 1024;

interface SessionRuntime {
  record: SessionRecord;
  ptyProcess: pty.IPty;
  logStream: fs.WriteStream;
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

    const runtime = spawnSession(session.name, session.cwd, session.shell, {
      createdAt: session.createdAt,
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
      } satisfies ServerMessage);
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
      sessions.delete(message.name);
      persist();

      sendJson(socket, {
        type: "success",
        message: `Session '${message.name}' killed.`,
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
      const log = readTail(logPath, message.lines);
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
  options?: { createdAt?: string },
): SessionRuntime {
  ensureAppDir();
  const logPath = getSessionLogPath(name);
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });

  const now = new Date().toISOString();
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const runtime: SessionRuntime = {
    record: {
      name,
      shell,
      cwd,
      pid: ptyProcess.pid,
      logPath,
      createdAt: options?.createdAt ?? now,
      updatedAt: now,
      status: "running",
    },
    ptyProcess,
    logStream,
    recentOutput: readRecentLog(logPath),
  };

  ptyProcess.onData((data) => {
    runtime.logStream.write(data);
    runtime.recentOutput = appendRecentOutput(runtime.recentOutput, data);

    if (runtime.attachedClient && !runtime.attachedClient.destroyed) {
      sendJson(runtime.attachedClient, {
        type: "output",
        data: Buffer.from(data, "utf8").toString("base64"),
      } satisfies ServerMessage);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (runtime.attachedClient && !runtime.attachedClient.destroyed) {
      sendJson(runtime.attachedClient, {
        type: "sessionExit",
        name,
        exitCode,
      } satisfies ServerMessage);
    }

    runtime.logStream.end();
    sessions.delete(name);
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

function readTail(logPath: string, lines: number): string {
  if (!fs.existsSync(logPath)) {
    return "";
  }

  const content = fs.readFileSync(logPath, "utf8");
  const safeLineCount = Math.max(1, Math.min(lines, 5000));
  return content.split(/\r?\n/).slice(-safeLineCount).join("\n");
}
