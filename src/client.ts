import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { SOCKET_PATH } from "./config.js";
import { createJsonLineReader, sendJson } from "./protocol.js";
import type { ClientMessage, ServerMessage, SessionRecord } from "./types.js";

function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => reject(error));
  });
}

async function tryConnectSocket(): Promise<net.Socket | undefined> {
  try {
    return await connectSocket();
  } catch {
    return undefined;
  }
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;

  if (!stdout) {
    throw new Error("Failed to start daemon.");
  }

  const [chunk] = (await once(stdout, "data")) as [Buffer];
  const message = JSON.parse(chunk.toString()) as ServerMessage;
  stdout.destroy();

  if (message.type !== "ready") {
    throw new Error("Daemon failed to start.");
  }
}

export async function ensureDaemon(): Promise<void> {
  const existingSocket = await tryConnectSocket();
  if (existingSocket) {
    const socket = existingSocket;
    sendJson(socket, { type: "health" } satisfies ClientMessage);
    socket.destroy();
    return;
  }

  const daemonEntry = path.join(path.dirname(process.argv[1]), "daemon.js");
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  child.unref();
  await waitForReady(child);
}

export async function daemonStatus(): Promise<Extract<ServerMessage, { type: "success" }>> {
  const socket = await tryConnectSocket();
  if (!socket) {
    throw new Error("Daemon is not running.");
  }

  socket.destroy();
  const response = await request({
    type: "health",
  });

  if (response.type !== "success") {
    throw new Error("Failed to read daemon status.");
  }

  return response;
}

export async function stopDaemon(): Promise<Extract<ServerMessage, { type: "success" }>> {
  const socket = await tryConnectSocket();
  if (!socket) {
    throw new Error("Daemon is not running.");
  }

  socket.destroy();
  const response = await request({
    type: "stopDaemon",
  });

  if (response.type !== "success") {
    throw new Error("Failed to stop daemon.");
  }

  return response;
}

export async function request<T extends ServerMessage = ServerMessage>(
  payload: ClientMessage,
): Promise<T> {
  await ensureDaemon();

  const socket = await connectSocket();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const readJson = createJsonLineReader((message) => {
      settled = true;
      socket.end();
      resolve(message as T);
    });

    socket.on("data", readJson);
    socket.on("error", reject);
    socket.on("close", () => {
      if (!settled) {
        reject(new Error("Connection closed before a response was received."));
      }
    });
    sendJson(socket, payload);
  });
}

export async function attachSession(name: string): Promise<void> {
  await ensureDaemon();
  const socket = await connectSocket();

  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 30;

  let attachedSession: SessionRecord | undefined;

  let detached = false;
  let sessionExited = false;
  let attachReady = false;
  let stdinHandler: ((chunk: Buffer) => void) | undefined;
  let stdinEndHandler: (() => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  let detachTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (stdinHandler) {
      process.stdin.off("data", stdinHandler);
    }
    if (stdinEndHandler) {
      process.stdin.off("end", stdinEndHandler);
    }
    if (resizeHandler) {
      process.stdout.off("resize", resizeHandler);
    }
    if (detachTimer) {
      clearTimeout(detachTimer);
      detachTimer = undefined;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const finishReject = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    socket.on(
      "data",
      createJsonLineReader((message) => {
        const payload = message as ServerMessage;

        if (payload.type === "error") {
          cleanup();
          socket.end();
          finishReject(new Error(payload.message));
          return;
        }

        if (payload.type === "attached") {
          attachedSession = payload.session;
          attachReady = true;
          return;
        }

        if (payload.type === "output") {
          process.stdout.write(Buffer.from(payload.data, "base64").toString("utf8"));
          return;
        }

        if (payload.type === "sessionExit") {
          sessionExited = true;
          cleanup();
          socket.end();
          process.stdout.write(
            `\n[mycli] session '${payload.name}' exited with code ${payload.exitCode}\n`,
          );
          finishResolve();
        }
      }),
    );

    socket.on("error", (error) => {
      cleanup();
      finishReject(error);
    });

    socket.on("close", () => {
      cleanup();
      if (detached || sessionExited) {
        finishResolve();
        return;
      }

      finishReject(new Error(`Session '${name}' connection closed.`));
    });

    sendJson(socket, {
      type: "attachSession",
      name,
      cols,
      rows,
    } satisfies ClientMessage);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    stdinHandler = (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      if (text === "\u0010") {
        detached = true;
        sendJson(socket, { type: "detach" } satisfies ClientMessage);
        socket.end();
        if (attachedSession) {
          process.stdout.write(`\n[mycli] detached from '${attachedSession.name}'\n`);
        }
        return;
      }

      sendJson(socket, {
        type: "stdin",
        data: Buffer.from(chunk).toString("base64"),
      } satisfies ClientMessage);
    };

    stdinEndHandler = () => {
      if (process.stdin.isTTY || detached || sessionExited) {
        return;
      }

      const detachAfterFlush = () => {
        if (detached || sessionExited) {
          return;
        }

        detached = true;
        sendJson(socket, { type: "detach" } satisfies ClientMessage);
        socket.end();
        if (attachedSession) {
          process.stdout.write(`\n[mycli] detached from '${attachedSession.name}'\n`);
        }
      };

      if (attachReady) {
        detachTimer = setTimeout(detachAfterFlush, 200);
        return;
      }

      detachTimer = setTimeout(detachAfterFlush, 400);
    };

    resizeHandler = () => {
      sendJson(socket, {
        type: "resize",
        cols: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 30,
      } satisfies ClientMessage);
    };

    process.stdin.on("data", stdinHandler);
    process.stdin.on("end", stdinEndHandler);
    process.stdout.on("resize", resizeHandler);
  });
}
