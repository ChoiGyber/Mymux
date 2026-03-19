const state = {
  sessions: [],
  selectedName: null,
  locale: "ko",
};

const translations = {
  ko: {
    brandEyebrow: "포터블 데스크톱",
    brandDescription: "지속되는 셸 세션을 관리하고 필요할 때 attach 콘솔을 열 수 있습니다.",
    createSessionTitle: "로컬 세션 만들기",
    sessionNameLabel: "세션 이름",
    sessionNamePlaceholder: "work",
    workingDirectoryLabel: "작업 디렉터리",
    workingDirectoryPlaceholder: "폴더를 선택하거나 경로를 입력하세요",
    browseButton: "찾아보기",
    terminalTypeLabel: "터미널 종류",
    shellAuto: "자동 선택 (권장)",
    shellPwsh: "PowerShell 7 (pwsh)",
    shellWindowsPowerShell: "Windows PowerShell",
    shellCmd: "명령 프롬프트 (cmd)",
    shellCustom: "사용자 지정 실행 파일...",
    customShellPlaceholder: "실행 파일 경로를 선택하세요",
    createButton: "세션 만들기",
    serverConnectTitle: "서버 접속",
    serverSessionNameLabel: "세션 이름",
    serverNamePlaceholder: "prod-server",
    serverHostLabel: "호스트",
    serverHostPlaceholder: "192.168.0.10 또는 example.com",
    serverUserLabel: "사용자",
    serverUserPlaceholder: "ubuntu",
    serverPortLabel: "포트",
    serverHelperText: "지속 세션 안에서 SSH 접속 명령을 자동으로 시작합니다.",
    serverConnectButton: "SSH로 접속",
    daemonTitle: "데몬",
    loading: "불러오는 중...",
    refreshButton: "새로고침",
    sessionsTitle: "세션",
    sessionsDescription: "한 곳에서 열고, 확인하고, 이름을 바꾸고, 종료하고, attach 할 수 있습니다.",
    sessionListTitle: "세션 목록",
    sessionDetailTitle: "세션 상세",
    noSelection: "선택 없음",
    selectSessionHint: "세션을 선택하면 상세 정보를 볼 수 있습니다.",
    noActiveSessions: "활성 세션이 없습니다.",
    sessionCount: "{count}개 세션",
    daemonStatusRunning: "실행 중 · pid {pid} · {count}개 세션",
    inspectButton: "상세",
    attachButton: "열기",
    renameButton: "이름 변경",
    killButton: "종료",
    createSessionSuccess: "'{name}' 세션을 만들었습니다.",
    createServerSuccess: "'{name}' 서버 세션을 만들었습니다.",
    attachOpened: "'{name}' attach 콘솔을 열었습니다.",
    renamePrompt: "새 세션 이름",
    renameSuccess: "'{from}' 세션 이름을 '{to}'로 바꿨습니다.",
    killSuccess: "'{name}' 세션을 종료했습니다.",
    sessionNameRequired: "세션 이름이 필요합니다.",
    serverHostRequired: "서버 호스트를 입력하세요.",
    customShellRequired: "사용자 지정 셸을 선택하거나 자동 선택으로 돌리세요.",
    detailMissing: "세션을 선택하면 상세 정보를 볼 수 있습니다.",
  },
  en: {
    brandEyebrow: "Portable Desktop",
    brandDescription: "Manage persistent shell sessions and open attach consoles on demand.",
    createSessionTitle: "Create Local Session",
    sessionNameLabel: "Session Name",
    sessionNamePlaceholder: "work",
    workingDirectoryLabel: "Working Directory",
    workingDirectoryPlaceholder: "Choose a folder or type a path",
    browseButton: "Browse",
    terminalTypeLabel: "Terminal Type",
    shellAuto: "Auto (Recommended)",
    shellPwsh: "PowerShell 7 (pwsh)",
    shellWindowsPowerShell: "Windows PowerShell",
    shellCmd: "Command Prompt (cmd)",
    shellCustom: "Custom executable...",
    customShellPlaceholder: "Choose an executable path",
    createButton: "Create Session",
    serverConnectTitle: "Connect Server",
    serverSessionNameLabel: "Session Name",
    serverNamePlaceholder: "prod-server",
    serverHostLabel: "Host",
    serverHostPlaceholder: "192.168.0.10 or example.com",
    serverUserLabel: "User",
    serverUserPlaceholder: "ubuntu",
    serverPortLabel: "Port",
    serverHelperText: "This automatically starts an SSH command inside a persistent session.",
    serverConnectButton: "Connect with SSH",
    daemonTitle: "Daemon",
    loading: "Loading...",
    refreshButton: "Refresh",
    sessionsTitle: "Sessions",
    sessionsDescription: "Open, inspect, rename, kill, and attach from one place.",
    sessionListTitle: "Session List",
    sessionDetailTitle: "Session Detail",
    noSelection: "No selection",
    selectSessionHint: "Select a session to inspect it.",
    noActiveSessions: "No active sessions.",
    sessionCount: "{count} sessions",
    daemonStatusRunning: "Running · pid {pid} · {count} sessions",
    inspectButton: "Inspect",
    attachButton: "Attach",
    renameButton: "Rename",
    killButton: "Kill",
    createSessionSuccess: "Created '{name}'.",
    createServerSuccess: "Created server session '{name}'.",
    attachOpened: "Opened attach console for '{name}'.",
    renamePrompt: "New session name",
    renameSuccess: "Renamed '{from}' to '{to}'.",
    killSuccess: "Killed '{name}'.",
    sessionNameRequired: "Session name is required.",
    serverHostRequired: "Server host is required.",
    customShellRequired: "Choose a custom shell executable or switch back to Auto.",
    detailMissing: "Select a session to inspect it.",
  },
};

const sessionListEl = document.getElementById("session-list");
const sessionCountEl = document.getElementById("session-count");
const detailNameEl = document.getElementById("detail-name");
const detailEl = document.getElementById("session-detail");
const daemonStatusEl = document.getElementById("daemon-status");
const toastEl = document.getElementById("toast");
const cwdInputEl = document.getElementById("session-cwd");
const shellSelectEl = document.getElementById("session-shell-select");
const customShellRowEl = document.getElementById("custom-shell-row");
const customShellInputEl = document.getElementById("session-shell-custom");
const languageSelectEl = document.getElementById("language-select");
const sessionNameInputEl = document.getElementById("session-name");
const serverNameInputEl = document.getElementById("server-name");
const serverHostInputEl = document.getElementById("server-host");
const serverUserInputEl = document.getElementById("server-user");
const serverPortInputEl = document.getElementById("server-port");

const SHELL_PRESETS = {
  auto: undefined,
  pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
};

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

shellSelectEl.addEventListener("change", () => {
  customShellRowEl.classList.toggle("hidden-row", shellSelectEl.value !== "custom");
});

document.getElementById("browse-shell").addEventListener("click", async () => {
  try {
    const selectedPath = await window.mycliDesktop.selectShell();
    if (selectedPath) {
      customShellInputEl.value = selectedPath;
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById("create-session").addEventListener("click", async () => {
  const name = sessionNameInputEl.value.trim();
  const cwd = cwdInputEl.value.trim();
  const shell = resolveShellSelection();

  if (!name) {
    showToast(t("sessionNameRequired"));
    return;
  }

  try {
    await window.mycliDesktop.createSession({
      name,
      cwd: cwd || undefined,
      shell: shell || undefined,
    });
    showToast(t("createSessionSuccess", { name }));
    sessionNameInputEl.value = "";
    refreshAll();
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById("create-server-session").addEventListener("click", async () => {
  const name = serverNameInputEl.value.trim();
  const host = serverHostInputEl.value.trim();
  const user = serverUserInputEl.value.trim();
  const port = serverPortInputEl.value.trim();
  const shell = resolveShellSelection();

  if (!name) {
    showToast(t("sessionNameRequired"));
    return;
  }

  if (!host) {
    showToast(t("serverHostRequired"));
    return;
  }

  try {
    await window.mycliDesktop.createSession({
      name,
      cwd: cwdInputEl.value.trim() || undefined,
      shell: shell || undefined,
      startupCommand: buildSshCommand({ host, user, port }),
    });
    showToast(t("createServerSuccess", { name }));
    serverNameInputEl.value = "";
    serverHostInputEl.value = "";
    serverUserInputEl.value = "";
    serverPortInputEl.value = "22";
    refreshAll();
  } catch (error) {
    showToast(error.message);
  }
});

languageSelectEl.addEventListener("change", () => {
  state.locale = languageSelectEl.value;
  applyTranslations();
  renderSessions();
  renderDetailPlaceholderIfNeeded();
  loadDaemonStatus();
});

async function refreshAll() {
  await Promise.all([loadDaemonStatus(), loadSessions()]);
}

async function loadDaemonStatus() {
  try {
    const status = await window.mycliDesktop.daemonStatus();
    daemonStatusEl.textContent = t("daemonStatusRunning", {
      pid: String(status.pid),
      count: String(status.sessions?.length ?? 0),
    });
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
      state.selectedName = null;
      renderDetailPlaceholderIfNeeded();
    }
  } catch (error) {
    showToast(error.message);
  }
}

function renderSessions() {
  sessionCountEl.textContent = t("sessionCount", { count: String(state.sessions.length) });
  sessionListEl.innerHTML = "";

  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("noActiveSessions");
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

    const inspectButton = makeButton(t("inspectButton"), async () => {
      await selectSession(session.name);
    });
    const attachButton = makeButton(t("attachButton"), async () => {
      await window.mycliDesktop.attachSession(session.name);
      showToast(t("attachOpened", { name: session.name }));
    });
    const renameButton = makeButton(t("renameButton"), async () => {
      const nextName = window.prompt(t("renamePrompt"), session.name);
      if (!nextName || nextName === session.name) {
        return;
      }

      try {
        await window.mycliDesktop.renameSession({
          name: session.name,
          nextName,
        });
        showToast(t("renameSuccess", { from: session.name, to: nextName }));
        state.selectedName = nextName;
        await refreshAll();
      } catch (error) {
        showToast(error.message);
      }
    });
    const killButton = makeButton(t("killButton"), async () => {
      try {
        await window.mycliDesktop.killSession(session.name);
        showToast(t("killSuccess", { name: session.name }));
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

function renderDetailPlaceholderIfNeeded() {
  if (state.selectedName) {
    return;
  }

  detailNameEl.textContent = t("noSelection");
  detailEl.textContent = t("detailMissing");
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

function resolveShellSelection() {
  if (shellSelectEl.value === "custom") {
    const value = customShellInputEl.value.trim();
    if (!value) {
      throw new Error(t("customShellRequired"));
    }
    return value;
  }

  return SHELL_PRESETS[shellSelectEl.value];
}

function buildSshCommand({ host, user, port }) {
  const target = user ? `${user}@${host}` : host;
  const safePort = port && port !== "22" ? ` -p ${port}` : "";
  return `ssh${safePort} ${target}`;
}

function applyTranslations() {
  document.documentElement.lang = state.locale;

  for (const element of document.querySelectorAll("[data-i18n]")) {
    const key = element.dataset.i18n;
    element.textContent = t(key);
  }

  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = element.dataset.i18nPlaceholder;
    element.placeholder = t(key);
  }

  for (const option of shellSelectEl.querySelectorAll("option[data-i18n]")) {
    option.textContent = t(option.dataset.i18n);
  }
}

function t(key, variables = {}) {
  const template = translations[state.locale][key] ?? translations.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name) => variables[name] ?? "");
}

applyTranslations();
renderDetailPlaceholderIfNeeded();
refreshAll();
setInterval(refreshAll, 5000);
