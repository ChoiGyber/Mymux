const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");

let mainWindow;
const serverProfilesFileName = "desktop-servers.json";

async function loadClientModule() {
  const clientEntry = path.join(app.getAppPath(), "dist", "client.js");
  return import(pathToFileURL(clientEntry).href);
}

async function listSessions() {
  const client = await loadClientModule();
  const response = await client.request({
    type: "listSessions",
  });

  if (response.type !== "success") {
    throw new Error(response.message ?? "Failed to load sessions.");
  }

  return response.sessions ?? [];
}

function getServerProfilesPath() {
  return path.join(app.getPath("userData"), serverProfilesFileName);
}

function loadServerProfiles() {
  const filePath = getServerProfilesPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveServerProfiles(profiles) {
  const filePath = getServerProfilesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profiles, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#10141e",
    title: "MyCli",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("sessions:list", async () => {
  return await listSessions();
});

ipcMain.handle("sessions:create", async (_event, payload) => {
  const client = await loadClientModule();
  const response = await client.request({
    type: "createSession",
    name: payload.name,
    cwd: payload.cwd,
    shell: payload.shell,
    startupCommand: payload.startupCommand,
  });

  if (response.type !== "success") {
    throw new Error(response.message ?? "Failed to create session.");
  }

  return response.session;
});

ipcMain.handle("sessions:kill", async (_event, name) => {
  const client = await loadClientModule();
  const response = await client.request({
    type: "killSession",
    name,
  });

  if (response.type !== "success") {
    throw new Error(response.message ?? "Failed to kill session.");
  }

  return true;
});

ipcMain.handle("sessions:rename", async (_event, payload) => {
  const client = await loadClientModule();
  const response = await client.request({
    type: "renameSession",
    name: payload.name,
    nextName: payload.nextName,
  });

  if (response.type !== "success") {
    throw new Error(response.message ?? "Failed to rename session.");
  }

  return response.session;
});

ipcMain.handle("sessions:inspect", async (_event, payload) => {
  const client = await loadClientModule();
  const sessions = await listSessions();
  const session = sessions.find((entry) => entry.name === payload.name);
  if (!session) {
    throw new Error(`Session '${payload.name}' not found.`);
  }

  if (payload.logs > 0) {
    const logResponse = await client.request({
      type: "readLogs",
      name: payload.name,
      lines: payload.logs,
      clean: true,
    });

    if (logResponse.type === "success") {
      session.logPreview = logResponse.log ?? "";
    }
  }

  return session;
});

ipcMain.handle("sessions:attach", async (_event, name) => {
  const cliEntry = path.join(app.getAppPath(), "dist", "cli.js");
  const command = `"${process.execPath}" "${cliEntry}" attach "${name}"`;
  const child = spawn("cmd.exe", ["/k", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  child.unref();
  return true;
});

ipcMain.handle("sessions:run-command", async (_event, payload) => {
  const client = await loadClientModule();
  const response = await client.request({
    type: "runCommand",
    name: payload.name,
    command: payload.command,
  });

  if (response.type !== "success") {
    throw new Error(response.message ?? "Failed to run command.");
  }

  return response.session;
});

ipcMain.handle("daemon:status", async () => {
  const client = await loadClientModule();
  return await client.daemonStatus();
});

ipcMain.handle("servers:list", async () => {
  return loadServerProfiles();
});

ipcMain.handle("servers:save", async (_event, profile) => {
  const profiles = loadServerProfiles().filter((entry) => entry.name !== profile.name);
  profiles.unshift(profile);
  saveServerProfiles(profiles.slice(0, 25));
  return true;
});

ipcMain.handle("servers:delete", async (_event, name) => {
  const profiles = loadServerProfiles().filter((entry) => entry.name !== name);
  saveServerProfiles(profiles);
  return true;
});

ipcMain.handle("dialog:select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("dialog:select-ssh-key", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "SSH Keys", extensions: ["pem", "ppk", "key"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("dialog:select-shell", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Executables", extensions: ["exe", "cmd", "bat"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});
