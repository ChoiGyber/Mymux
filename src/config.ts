import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_DIR = path.join(os.homedir(), ".mycli");
export const STATE_FILE = path.join(APP_DIR, "sessions.json");
export const LOGS_DIR = path.join(APP_DIR, "logs");
export const SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\mycli-daemon"
    : path.join(APP_DIR, "mycli.sock");

export function resolveDefaultShell(shell?: string): string {
  if (shell) {
    return shell;
  }

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    ];

    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    return existing ?? "powershell.exe";
  }

  return process.env.SHELL ?? "/bin/bash";
}

export function getSessionLogPath(name: string): string {
  return path.join(LOGS_DIR, `${name}.log`);
}
