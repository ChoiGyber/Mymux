const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mycliDesktop", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (payload) => ipcRenderer.invoke("sessions:create", payload),
  killSession: (name) => ipcRenderer.invoke("sessions:kill", name),
  renameSession: (payload) => ipcRenderer.invoke("sessions:rename", payload),
  inspectSession: (payload) => ipcRenderer.invoke("sessions:inspect", payload),
  attachSession: (name) => ipcRenderer.invoke("sessions:attach", name),
  daemonStatus: () => ipcRenderer.invoke("daemon:status"),
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
});
