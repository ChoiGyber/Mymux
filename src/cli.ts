#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import process from "node:process";
import { attachSession, daemonStatus, ensureDaemon, request, stopDaemon } from "./client.js";
import { renderPowerShellCompletion } from "./completion.js";
import { getSessionLogPath, resolveDefaultShell } from "./config.js";
import { stripAnsi } from "./ansi.js";
import {
  createDefaultConfig,
  getProfile,
  getProjectConfigPath,
  loadProjectConfig,
  removeProfile,
  upsertProfile,
  writeProjectConfig,
} from "./project-config.js";
import type { SessionRecord } from "./types.js";
import type { ServerMessage } from "./types.js";

const program = new Command();

program
  .name("mycli")
  .description("Personal terminal session manager")
  .version("0.1.0");

program
  .command("init")
  .option("--force", "overwrite existing mycli.config.json")
  .action((options) => {
    const cwd = process.cwd();
    const configPath = getProjectConfigPath(cwd);

    if (fs.existsSync(configPath) && !options.force) {
      throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
    }

    writeProjectConfig(cwd, createDefaultConfig(cwd));
    process.stdout.write(`Created ${configPath}\n`);
  });

program
  .command("open")
  .argument("<name>", "session name")
  .option("--cwd <path>", "working directory")
  .option("--shell <shell>", "shell executable")
  .option("--profile <name>", "profile from mycli.config.json")
  .option("--env <key=value>", "environment variable override", collectValues, [])
  .action(async (name, options) => {
    const config = loadProjectConfig(process.cwd());
    const profile = getProfile(config, options.profile);

    if (options.profile && !profile) {
      throw new Error(`Profile '${options.profile}' not found in mycli.config.json.`);
    }

    const cwd = options.cwd ?? profile?.cwd ?? process.cwd();
    const shell = options.shell ?? profile?.shell ?? resolveDefaultShell();
    const env = {
      ...(profile?.env ?? {}),
      ...parseEnvEntries(options.env),
    };

    const response = await request({
      type: "createSession",
      name,
      cwd,
      shell,
      profileName: options.profile,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    assertSuccess(response);
    process.stdout.write(`${response.message}\n`);
  });

program
  .command("list")
  .option("--json", "print JSON output")
  .option("--status <status>", "filter by session status")
  .option("--match <text>", "filter by session name or cwd")
  .action(async (options) => {
    const response = await request({
      type: "listSessions",
    });

    assertSuccess(response);

    const sessions = filterSessions(response.sessions ?? [], options.status, options.match);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return;
    }

    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
      return;
    }

    process.stdout.write("NAME\tSTATUS\tPID\tPROFILE\tUPDATED\tSHELL\tCWD\n");
    for (const session of sessions) {
      process.stdout.write(
        `${session.name}\t${session.status}\t${session.pid}\t${session.profileName ?? "-"}\t${formatTimestamp(session.updatedAt)}\t${session.shell}\t${session.cwd}\n`,
      );
    }
  });

program
  .command("inspect")
  .argument("<name>", "session name")
  .action(async (name) => {
    const response = await request({
      type: "listSessions",
    });

    assertSuccess(response);
    const session = (response.sessions ?? []).find((entry) => entry.name === name);
    if (!session) {
      throw new Error(`Session '${name}' not found.`);
    }

    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  });

program
  .command("profiles")
  .option("--json", "print JSON output")
  .action((options) => {
    const config = loadProjectConfig(process.cwd());
    const profileNames = Object.keys(config.profiles ?? {}).sort();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(profileNames, null, 2)}\n`);
      return;
    }

    if (profileNames.length === 0) {
      process.stdout.write("No profiles found in mycli.config.json.\n");
      return;
    }

    for (const name of profileNames) {
      process.stdout.write(`${name}\n`);
    }
  });

const profileCommand = program.command("profile").description("Manage project profiles");

profileCommand
  .command("add")
  .argument("<name>", "profile name")
  .option("--cwd <path>", "working directory")
  .option("--shell <shell>", "shell executable")
  .option("--env <key=value>", "environment variable", collectValues, [])
  .action((name, options) => {
    const cwd = process.cwd();
    const env = parseEnvEntries(options.env);
    const profile = {
      cwd: options.cwd,
      shell: options.shell,
      env: Object.keys(env).length ? env : undefined,
    };

    const configPath = upsertProfile(cwd, name, profile);
    process.stdout.write(`Saved profile '${name}' to ${configPath}\n`);
  });

profileCommand
  .command("remove")
  .argument("<name>", "profile name")
  .action((name) => {
    const cwd = process.cwd();
    const config = loadProjectConfig(cwd);
    if (!config.profiles?.[name]) {
      throw new Error(`Profile '${name}' not found.`);
    }

    const configPath = removeProfile(cwd, name);
    process.stdout.write(`Removed profile '${name}' from ${configPath}\n`);
  });

program
  .command("attach")
  .argument("<name>", "session name")
  .description("Attach to a session. Press Ctrl+P to detach.")
  .action(async (name) => {
    await attachSession(name);
  });

program
  .command("kill")
  .argument("<name>", "session name")
  .action(async (name) => {
    const response = await request({
      type: "killSession",
      name,
    });

    assertSuccess(response);
    process.stdout.write(`${response.message}\n`);
  });

program
  .command("rename")
  .argument("<name>", "current session name")
  .argument("<nextName>", "new session name")
  .action(async (name, nextName) => {
    const response = await request({
      type: "renameSession",
      name,
      nextName,
    });

    assertSuccess(response);
    process.stdout.write(`${response.message}\n`);
  });

program
  .command("restore")
  .description("Restore saved sessions into the daemon")
  .action(async () => {
    const response = await request({
      type: "restoreSessions",
    });

    assertSuccess(response);
    process.stdout.write(`${response.message}\n`);
  });

program
  .command("logs")
  .argument("<name>", "session name")
  .option("--lines <number>", "number of lines to print", "50")
  .option("--clean", "strip ANSI escape sequences")
  .option("--follow", "follow appended log output")
  .option("--since <value>", "show log chunks since ISO time or 10m/2h/1d")
  .action(async (name, options) => {
    const lines = Number.parseInt(options.lines, 10);
    if (!Number.isFinite(lines) || lines <= 0) {
      throw new Error("--lines must be a positive integer.");
    }

    const response = await request({
      type: "readLogs",
      name,
      lines,
      clean: Boolean(options.clean),
      since: options.since,
    });

    assertSuccess(response);
    process.stdout.write(`${response.log ?? ""}\n`);

    if (options.follow) {
      await followLogs(name, Boolean(options.clean), options.since);
    }
  });

const daemon = program.command("daemon").description("Manage the background daemon");

daemon.command("status").action(async () => {
  const response = await daemonStatus();
  const sessionCount = response.sessions?.length ?? 0;
  process.stdout.write(`running\tpid=${response.pid}\tsessions=${sessionCount}\n`);
});

daemon.command("stop").action(async () => {
  const response = await stopDaemon();
  process.stdout.write(`${response.message}\n`);
});

daemon.command("restart").action(async () => {
  try {
    await stopDaemon();
  } catch {
    // The daemon may not be running yet.
  }

  await ensureDaemon();
  const status = await daemonStatus();
  process.stdout.write(`running\tpid=${status.pid}\tsessions=${status.sessions?.length ?? 0}\n`);
});

program
  .command("completion")
  .option("--shell <shell>", "shell type", "powershell")
  .action((options) => {
    if (options.shell !== "powershell") {
      throw new Error("Only PowerShell completion is implemented in this MVP.");
    }

    process.stdout.write(`${renderPowerShellCompletion()}\n`);
  });

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

function assertSuccess(response: ServerMessage): asserts response is Extract<
  ServerMessage,
  { type: "success" }
> {
  if (response.type === "error") {
    throw new Error(response.message);
  }

  if (response.type !== "success") {
    throw new Error("Unexpected daemon response.");
  }
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvEntries(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env entry '${entry}'. Expected KEY=value.`);
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1);
    if (!key) {
      throw new Error(`Invalid env entry '${entry}'. Expected KEY=value.`);
    }

    env[key] = value;
  }

  return env;
}

function filterSessions(
  sessions: SessionRecord[],
  status?: string,
  match?: string,
): SessionRecord[] {
  return sessions.filter((session) => {
    if (status && session.status !== status) {
      return false;
    }

    if (match) {
      const normalized = match.toLowerCase();
      return (
        session.name.toLowerCase().includes(normalized) ||
        session.cwd.toLowerCase().includes(normalized)
      );
    }

    return true;
  });
}

async function followLogs(name: string, clean: boolean, since?: string): Promise<void> {
  const logPath = getSessionLogPath(name);
  let offset = determineFollowOffset(logPath, since);

  process.stdout.write(`[mycli] following ${logPath}. Press Ctrl+C to stop.\n`);

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (!fs.existsSync(logPath)) {
        return;
      }

      const size = fs.statSync(logPath).size;
      if (size < offset) {
        offset = size;
        return;
      }

      if (size === offset) {
        return;
      }

      const stream = fs.createReadStream(logPath, {
        encoding: "utf8",
        start: offset,
        end: size - 1,
      });

      let chunk = "";
      stream.on("data", (data: string) => {
        chunk += data;
      });
      stream.on("end", () => {
        offset = size;
        process.stdout.write(clean ? stripAnsi(chunk) : chunk);
      });
    }, 500);

    const stop = () => {
      clearInterval(interval);
      process.off("SIGINT", stop);
      process.stdout.write("\n");
      resolve();
    };

    process.on("SIGINT", stop);
  });
}

function determineFollowOffset(logPath: string, since?: string): number {
  if (!fs.existsSync(logPath)) {
    return 0;
  }

  if (!since) {
    return fs.statSync(logPath).size;
  }

  // The initial `logs --since` output already printed historical content,
  // so follow mode should continue from the current end of the file.
  return fs.statSync(logPath).size;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}
