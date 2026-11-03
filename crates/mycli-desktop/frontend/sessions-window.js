const tauri = window.__TAURI__;
const events = tauri && tauri.event;

function sendMain(event, payload) {
  return events?.emitTo?.("main", event, payload).catch((error) => console.warn("Sessions window event failed", error));
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.theme) document.documentElement.dataset.theme = snapshot.theme;
  if (snapshot.accent) document.documentElement.dataset.accent = snapshot.accent;
  document.getElementById("session-list").innerHTML = snapshot.sessions || "";
  document.getElementById("ssh-fav-list").innerHTML = snapshot.favorites || "";
  document.getElementById("attention-items").innerHTML = snapshot.attention || "";
  for (const [status, value] of Object.entries(snapshot.counts || {})) {
    const counter = document.querySelector(`[data-attention-status="${status}"] b`);
    if (counter) counter.textContent = String(value);
  }
}

document.getElementById("session-list").addEventListener("click", (event) => {
  const action = event.target.closest(".session-action");
  if (action) {
    const row = action.closest(".session-item");
    const type = action.classList.contains("session-close") ? "close"
      : action.classList.contains("session-rename") ? "rename"
      : action.classList.contains("session-fav") ? "favorite" : null;
    if (type && row) sendMain("mymux:sessions-window-action", { type, ptyId: Number(row.dataset.ptyId) });
    return;
  }
  const toggle = event.target.closest(".session-agents-toggle,.session-agent-more");
  if (toggle) {
    const ptyId = Number(toggle.dataset.ownerPty || toggle.closest(".session-item")?.dataset.ptyId);
    if (Number.isFinite(ptyId)) sendMain("mymux:sessions-window-action", { type: "toggle-agents", ptyId });
    return;
  }
  const agent = event.target.closest(".session-agent[data-owner-pty]");
  if (agent) {
    sendMain("mymux:sessions-window-action", { type: "agent-detail", ptyId: Number(agent.dataset.ownerPty), agentId: agent.dataset.agentId });
    return;
  }
  const row = event.target.closest(".session-item[data-pty-id]");
  if (row) sendMain("mymux:sessions-window-action", { type: "focus", ptyId: Number(row.dataset.ptyId) });
});

document.getElementById("session-list").addEventListener("dblclick", (event) => {
  const name = event.target.closest(".session-name");
  const group = event.target.closest(".session-group");
  if (name) {
    const row = name.closest(".session-item");
    if (row) sendMain("mymux:sessions-window-action", { type: "rename", ptyId: Number(row.dataset.ptyId) });
  } else if (group) {
    sendMain("mymux:sessions-window-action", { type: "rename-tab", tabIdx: Number(group.dataset.tabIdx) });
  }
});

document.getElementById("ssh-fav-list").addEventListener("click", (event) => {
  const item = event.target.closest(".ssh-fav-item");
  if (!item) return;
  sendMain("mymux:sessions-window-action", {
    type: event.target.closest(".ssh-fav-x") ? "remove-favorite" : "connect-favorite",
    favoriteIndex: Number(item.dataset.favoriteIndex),
  });
});

document.getElementById("attention-items").addEventListener("click", (event) => {
  const item = event.target.closest(".attention-item[data-owner-pty]");
  if (item) sendMain("mymux:sessions-window-action", { type: "focus", ptyId: Number(item.dataset.ownerPty) });
});

document.getElementById("btn-dock-sessions").addEventListener("click", () => sendMain("mymux:sessions-window-dock", {}));

function setupSessionsTabDrag() {
  const handle = document.getElementById("sessions-drag-handle");
  if (!handle) return;
  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    drag = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, active: false };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >= 8) {
      drag.active = true;
      document.getElementById("session-header")?.classList.add("sessions-dragging");
    }
    if (drag.active) sendMain("mymux:sessions-window-drag", { x: event.screenX, y: event.screenY });
  });
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const active = drag.active;
    drag = null;
    document.getElementById("session-header")?.classList.remove("sessions-dragging");
    if (active) sendMain("mymux:sessions-window-drop", { x: event.screenX, y: event.screenY });
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  events?.listen?.("mymux:sessions-window-dock-target", (event) => {
    document.body.classList.toggle("sessions-dock-target", !!event.payload?.inside);
  });
}

async function startSessionsWindow() {
  if (!events?.listen || !events?.emitTo) return;
  await events.listen("mymux:sessions-window-update", (event) => applySnapshot(event.payload));
  await events.listen("mymux:sessions-window-close", () => window.__TAURI__?.window?.getCurrentWindow?.().close());
  const current = tauri.window?.getCurrentWindow?.();
  if (current?.onCloseRequested) {
    await current.onCloseRequested(() => sendMain("mymux:sessions-window-closed", {}));
  }
  await sendMain("mymux:sessions-window-ready", {});
  setupSessionsTabDrag();
}

startSessionsWindow().catch((error) => console.error("Sessions window setup failed", error));
