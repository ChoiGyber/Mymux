#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import process from "node:process";
import { attachSession, daemonStatus, ensureDaemon, request, stopDaemon } from "./client.js";
import { renderPowerShellCompletion } from "./completion.js";
import {
  APP_DIR,
  AUTOSTART_FILE,
  LOGS_DIR,
  STATE_FILE,
  getSessionLogPath,
  resolveDefaultShell,
} from "./config.js";
import { stripAnsi } from "./ansi.js";
import {
  createDefaultConfig,
  createPresetConfig,
  getProfile,
  getProjectConfigPath,
  importProjectConfig,
  loadProjectConfigFromFile,
  loadProjectConfig,
  removeProfile,
  renameProfile,
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
  .option("--preset <name>", "config preset: minimal, backend, frontend", "minimal")
  .action((options) => {
    const cwd = process.cwd();
    const configPath = getProjectConfigPath(cwd);

    if (fs.existsSync(configPath) && !options.force) {
      throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
    }

    const preset = normalizePreset(options.preset);
    writeProjectConfig(cwd, createPresetConfig(cwd, preset));
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
  .option("--logs <number>", "include recent clean log lines", "0")
  .action(async (name, options) => {
    const response = await request({
      type: "listSessions",
    });

    assertSuccess(response);
    const session = (response.sessions ?? []).find((entry) => entry.name === name);
    if (!session) {
      throw new Error(`Session '${name}' not found.`);
    }

    const logLines = Number.parseInt(options.logs, 10);
    if (!Number.isFinite(logLines) || logLines < 0) {
      throw new Error("--logs must be zero or a positive integer.");
    }

    const payload: Record<string, unknown> = { ...session };
    if (logLines > 0) {
      const logResponse = await request({
        type: "readLogs",
        name,
        lines: logLines,
        clean: true,
      });
      assertSuccess(logResponse);
      payload.logPreview = logResponse.log ?? "";
    }

    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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

profileCommand
  .command("show")
  .argument("<name>", "profile name")
  .action((name) => {
    const config = loadProjectConfig(process.cwd());
    const profile = getProfile(config, name);
    if (!profile) {
      throw new Error(`Profile '${name}' not found.`);
    }

    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  });

profileCommand
  .command("rename")
  .argument("<name>", "current profile name")
  .argument("<nextName>", "new profile name")
  .action((name, nextName) => {
    const cwd = process.cwd();
    const config = loadProjectConfig(cwd);
    if (!config.profiles?.[name]) {
      throw new Error(`Profile '${name}' not found.`);
    }
    if (config.profiles[nextName]) {
      throw new Error(`Profile '${nextName}' already exists.`);
    }

    const configPath = renameProfile(cwd, name, nextName);
    process.stdout.write(`Renamed profile '${name}' to '${nextName}' in ${configPath}\n`);
  });

profileCommand
  .command("validate")
  .argument("[name]", "optional profile name")
  .action((name) => {
    const config = loadProjectConfig(process.cwd());
    const profiles = config.profiles ?? {};

    if (name) {
      const profile = profiles[name];
      if (!profile) {
        throw new Error(`Profile '${name}' not found.`);
      }

      const issues = validateProfile(name, profile);
      renderValidationResult(name, issues);
      return;
    }

    const names = Object.keys(profiles).sort();
    if (names.length === 0) {
      process.stdout.write("No profiles found in mycli.config.json.\n");
      return;
    }

    let hasIssues = false;
    for (const profileName of names) {
      const issues = validateProfile(profileName, profiles[profileName]);
      if (issues.length > 0) {
        hasIssues = true;
      }
      renderValidationResult(profileName, issues);
    }

    if (!hasIssues) {
      process.stdout.write("All profiles are valid.\n");
    }
  });

profileCommand.command("template").action(() => {
  const template = {
    cwd: process.cwd(),
    shell: resolveDefaultShell(),
    env: {
      EXAMPLE_ENV: "value",
    },
  };

  process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
});

const configCommand = program.command("config").description("Manage project config files");

configCommand.command("export").action(() => {
  const config = loadProjectConfig(process.cwd());
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
});

configCommand
  .command("backup")
  .option("--file <path>", "backup file path", ".\\mycli.config.backup.json")
  .action((options) => {
    const config = loadProjectConfig(process.cwd());
    fs.writeFileSync(options.file, `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`Backed up config to ${options.file}\n`);
  });

configCommand
  .command("import")
  .argument("<filePath>", "path to a config JSON file")
  .option("--replace", "replace the current config instead of merging")
  .action((filePath, options) => {
    const resolvedPath = fs.realpathSync(filePath);
    const configPath = importProjectConfig(process.cwd(), resolvedPath, Boolean(options.replace));
    process.stdout.write(`Imported config from ${resolvedPath} into ${configPath}\n`);
  });

configCommand
  .command("diff")
  .argument("<filePath>", "path to a config JSON file")
  .action((filePath) => {
    const resolvedPath = fs.realpathSync(filePath);
    const current = loadProjectConfig(process.cwd());
    const incoming = loadProjectConfigFromFile(resolvedPath);
    const diff = buildConfigDiff(current, incoming);
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  });

configCommand
  .command("restore")
  .argument("<filePath>", "path to a backup config JSON file")
  .action((filePath) => {
    const resolvedPath = fs.realpathSync(filePath);
    const imported = loadProjectConfigFromFile(resolvedPath);
    const configPath = writeProjectConfig(process.cwd(), imported);
    process.stdout.write(`Restored config from ${resolvedPath} into ${configPath}\n`);
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

const sessionCommand = program.command("session").description("Inspect or export session data");

sessionCommand
  .command("export")
  .option("--json", "print session JSON")
  .option("--file <path>", "write session JSON to a file")
  .action(async (options) => {
    const response = await request({
      type: "listSessions",
    });

    assertSuccess(response);
    const sessions = response.sessions ?? [];
    const payload = JSON.stringify(sessions, null, 2);

    if (options.file) {
      fs.writeFileSync(options.file, `${payload}\n`);
      process.stdout.write(`Exported ${sessions.length} sessions to ${options.file}\n`);
      return;
    }

    process.stdout.write(`${payload}\n`);
  });

sessionCommand
  .command("import")
  .argument("<filePath>", "path to exported session JSON")
  .option("--prefix <text>", "prefix imported session names", "imported")
  .option("--skip-existing", "skip imported names that already exist")
  .action(async (filePath, options) => {
    const resolvedPath = fs.realpathSync(filePath);
    const imported = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as SessionRecord[];
    const existingResponse = await request({
      type: "listSessions",
    });
    assertSuccess(existingResponse);
    const existingNames = new Set((existingResponse.sessions ?? []).map((session) => session.name));

    let importedCount = 0;
    let skippedCount = 0;
    for (const session of imported) {
      const nextName = `${options.prefix}-${session.name}`;
      if (options.skipExisting && existingNames.has(nextName)) {
        skippedCount += 1;
        continue;
      }

      const response = await request({
        type: "createSession",
        name: nextName,
        cwd: session.cwd,
        shell: session.shell,
        profileName: session.profileName,
        env: session.env,
      });

      assertSuccess(response);
      importedCount += 1;
      existingNames.add(nextName);
    }

    process.stdout.write(
      `Imported ${importedCount} sessions from ${resolvedPath}` +
        (options.skipExisting ? `, skipped ${skippedCount} existing` : "") +
        "\n",
    );
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

daemon.command("doctor").action(async () => {
  const cwd = process.cwd();
  const configPath = getProjectConfigPath(cwd);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: "appDir",
    ok: fs.existsSync(APP_DIR),
    detail: APP_DIR,
  });
  checks.push({
    name: "logsDir",
    ok: fs.existsSync(LOGS_DIR),
    detail: LOGS_DIR,
  });
  checks.push({
    name: "stateFile",
    ok: fs.existsSync(STATE_FILE),
    detail: STATE_FILE,
  });
  checks.push({
    name: "projectConfig",
    ok: fs.existsSync(configPath),
    detail: configPath,
  });
  checks.push({
    name: "cwd",
    ok: fs.existsSync(cwd),
    detail: cwd,
  });

  let daemonDetail = "not running";
  let daemonOk = false;
  try {
    const status = await daemonStatus();
    daemonOk = true;
    daemonDetail = `pid=${status.pid}, sessions=${status.sessions?.length ?? 0}`;
  } catch (error) {
    daemonDetail = error instanceof Error ? error.message : "Daemon is not running.";
  }

  checks.push({
    name: "daemon",
    ok: daemonOk,
    detail: daemonDetail,
  });

  const maxName = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    process.stdout.write(
      `${check.ok ? "ok " : "bad"} ${check.name.padEnd(maxName)}  ${check.detail}\n`,
    );
  }
});

const autostart = daemon.command("autostart").description("Manage daemon autostart preference");

autostart.command("enable").action(() => {
  ensureAppSettingsDir();
  fs.writeFileSync(AUTOSTART_FILE, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
  process.stdout.write(`Autostart enabled in ${AUTOSTART_FILE}\n`);
});

autostart.command("disable").action(() => {
  ensureAppSettingsDir();
  fs.writeFileSync(AUTOSTART_FILE, `${JSON.stringify({ enabled: false }, null, 2)}\n`);
  process.stdout.write(`Autostart disabled in ${AUTOSTART_FILE}\n`);
});

autostart.command("status").action(() => {
  const enabled = readAutostartEnabled();
  process.stdout.write(`${enabled ? "enabled" : "disabled"}\n`);
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

function validateProfile(
  name: string,
  profile: { cwd?: string; shell?: string; env?: Record<string, string> },
): string[] {
  const issues: string[] = [];

  if (profile.cwd && !fs.existsSync(profile.cwd)) {
    issues.push(`cwd does not exist: ${profile.cwd}`);
  }

  if (profile.shell && !fs.existsSync(profile.shell)) {
    issues.push(`shell does not exist: ${profile.shell}`);
  }

  if (profile.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (!key.trim()) {
        issues.push("env contains an empty key");
      }
      if (typeof value !== "string") {
        issues.push(`env '${key}' must be a string`);
      }
    }
  }

  if (!profile.cwd && !profile.shell && !profile.env) {
    issues.push("profile has no cwd, shell, or env values");
  }

  return issues;
}

function renderValidationResult(name: string, issues: string[]): void {
  if (issues.length === 0) {
    process.stdout.write(`ok  ${name}\n`);
    return;
  }

  process.stdout.write(`bad ${name}\n`);
  for (const issue of issues) {
    process.stdout.write(`  - ${issue}\n`);
  }
}

function buildConfigDiff(
  current: { profiles?: Record<string, unknown> },
  incoming: { profiles?: Record<string, unknown> },
): Record<string, unknown> {
  const currentProfiles = current.profiles ?? {};
  const incomingProfiles = incoming.profiles ?? {};
  const currentNames = new Set(Object.keys(currentProfiles));
  const incomingNames = new Set(Object.keys(incomingProfiles));

  const added = [...incomingNames].filter((name) => !currentNames.has(name)).sort();
  const removed = [...currentNames].filter((name) => !incomingNames.has(name)).sort();
  const changed = [...incomingNames]
    .filter(
      (name) =>
        currentNames.has(name) &&
        JSON.stringify(currentProfiles[name]) !== JSON.stringify(incomingProfiles[name]),
    )
    .sort();

  return {
    added,
    removed,
    changed,
  };
}

function normalizePreset(value: string): "minimal" | "backend" | "frontend" {
  if (value === "minimal" || value === "backend" || value === "frontend") {
    return value;
  }

  throw new Error("Invalid preset. Use one of: minimal, backend, frontend.");
}

function ensureAppSettingsDir(): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function readAutostartEnabled(): boolean {
  if (!fs.existsSync(AUTOSTART_FILE)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(AUTOSTART_FILE, "utf8")) as { enabled?: boolean };
    return Boolean(parsed.enabled);
  } catch {
    return false;
  }
}
