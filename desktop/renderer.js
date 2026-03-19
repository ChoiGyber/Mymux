const state = {
  sessions: [],
  selectedName: null,
};

const sessionListEl = document.getElementById("session-list");
const sessionCountEl = document.getElementById("session-count");
const detailNameEl = document.getElementById("detail-name");
const detailEl = document.getElementById("session-detail");
const daemonStatusEl = document.getElementById("daemon-status");
const toastEl = document.getElementById("toast");
const cwdInputEl = document.getElementById("session-cwd");

document.getElementById("refresh-sessions").addEventListener("click", () => {
  refreshAll();
});

document.getElementById("browse-cwd").addEventListener("click", async () => {
  try {
    const selectedPath = await window.mycliDesktop.selectDirectory();
    if (selectedPath) {
      cwdInputEl.value = selectedPath;
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById("create-session").addEventListener("click", async () => {
  const name = document.getElementById("session-name").value.trim();
  const cwd = cwdInputEl.value.trim();
  const shell = document.getElementById("session-shell").value.trim();

  if (!name) {
    showToast("Session name is required.");
    return;
  }

  try {
    await window.mycliDesktop.createSession({
      name,
      cwd: cwd || undefined,
      shell: shell || undefined,
    });
    showToast(`Created '${name}'.`);
    document.getElementById("session-name").value = "";
    refreshAll();
  } catch (error) {
    showToast(error.message);
  }
});

async function refreshAll() {
  await Promise.all([loadDaemonStatus(), loadSessions()]);
}

async function loadDaemonStatus() {
  try {
    const status = await window.mycliDesktop.daemonStatus();
    daemonStatusEl.textContent = `Running • pid ${status.pid} • ${status.sessions?.length ?? 0} sessions`;
  } catch (error) {
    daemonStatusEl.textContent = error.message;
  }
}

async function loadSessions() {
  try {
    state.sessions = await window.mycliDesktop.listSessions();
    renderSessions();

    if (state.selectedName) {
      const session = state.sessions.find((entry) => entry.name === state.selectedName);
      if (session) {
        await selectSession(session.name);
        return;
      }
    }

    if (state.sessions.length > 0) {
      await selectSession(state.sessions[0].name);
    } else {
      detailNameEl.textContent = "No selection";
      detailEl.textContent = "Select a session to inspect it.";
    }
  } catch (error) {
    showToast(error.message);
  }
}

function renderSessions() {
  sessionCountEl.textContent = `${state.sessions.length} sessions`;
  sessionListEl.innerHTML = "";

  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No active sessions.";
    sessionListEl.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const card = document.createElement("div");
    card.className = "session-card";
    if (session.name === state.selectedName) {
      card.classList.add("selected");
    }

    const header = document.createElement("div");
    header.className = "session-card-header";
    header.innerHTML = `<strong>${session.name}</strong><span>${session.status}</span>`;

    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${session.shell} • ${session.cwd}`;

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const inspectButton = makeButton("Inspect", async () => {
      await selectSession(session.name);
    });
    const attachButton = makeButton("Attach", async () => {
      await window.mycliDesktop.attachSession(session.name);
      showToast(`Opened attach console for '${session.name}'.`);
    });
    const renameButton = makeButton("Rename", async () => {
      const nextName = window.prompt("New session name", session.name);
      if (!nextName || nextName === session.name) {
        return;
      }

      try {
        await window.mycliDesktop.renameSession({
          name: session.name,
          nextName,
        });
        showToast(`Renamed '${session.name}' to '${nextName}'.`);
        state.selectedName = nextName;
        await refreshAll();
      } catch (error) {
        showToast(error.message);
      }
    });
    const killButton = makeButton("Kill", async () => {
      try {
        await window.mycliDesktop.killSession(session.name);
        showToast(`Killed '${session.name}'.`);
        if (state.selectedName === session.name) {
          state.selectedName = null;
        }
        await refreshAll();
      } catch (error) {
        showToast(error.message);
      }
    });

    actions.append(inspectButton, attachButton, renameButton, killButton);
    card.append(header, meta, actions);
    sessionListEl.appendChild(card);
  }
}

async function selectSession(name) {
  try {
    state.selectedName = name;
    renderSessions();
    const detail = await window.mycliDesktop.inspectSession({ name, logs: 20 });
    detailNameEl.textContent = name;
    detailEl.textContent = JSON.stringify(detail, null, 2);
  } catch (error) {
    showToast(error.message);
  }
}

function makeButton(label, handler) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.classList.add("hidden");
  }, 2500);
}

refreshAll();
setInterval(refreshAll, 5000);
