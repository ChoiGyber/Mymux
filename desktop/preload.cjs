const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mycliDesktop", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (payload) => ipcRenderer.invoke("sessions:create", payload),
  killSession: (name) => ipcRenderer.invoke("sessions:kill", name),
  renameSession: (payload) => ipcRenderer.invoke("sessions:rename", payload),
  inspectSession: (payload) => ipcRenderer.invoke("sessions:inspect", payload),
  attachSession: (name) => ipcRenderer.invoke("sessions:attach", name),
  runSessionCommand: (payload) => ipcRenderer.invoke("sessions:run-command", payload),
  daemonStatus: () => ipcRenderer.invoke("daemon:status"),
  listServerProfiles: () => ipcRenderer.invoke("servers:list"),
  saveServerProfile: (profile) => ipcRenderer.invoke("servers:save", profile),
  deleteServerProfile: (name) => ipcRenderer.invoke("servers:delete", name),
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  selectShell: () => ipcRenderer.invoke("dialog:select-shell"),
  selectSshKey: () => ipcRenderer.invoke("dialog:select-ssh-key"),
});
