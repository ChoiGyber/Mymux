// Globals - set after init
let invoke;

// Monochrome inline-SVG icons (use currentColor → theme-aware: white in dark, black in light)
const ICON = {
  globe: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 3.9 5.9 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.9-3.9-9S9.4 5.7 12 3z"/></svg>`,
  moon: `<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z"/></svg>`,
  sun: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`,
};

// Clipboard: lazy load
async function clipboardWrite(text) {
  try {
    const clip = window.__TAURI_PLUGIN_CLIPBOARD_MANAGER__;
    if (clip && clip.writeText) await clip.writeText(text);
  } catch {}
}

// ── DOM refs ──
let sidebar, btnToggleSidebar, btnNewTerminal;
let explorerPath, btnExplorerUp, explorerMode, fileListEl;
let cmdListEl, emptyEl, btnAdd;
let modalOverlay, modalTitle, form, inputName, inputCommand, inputDesc, btnCancel;
let terminalTabs, terminalContainer, terminalWelcome;
let sshInput, sshPort, sshPassword, sshKeyfile, btnSshConnect;
let toastEl, acPopup, acList;
let sessionPanel, sessionListEl, btnToggleSessions, btnSplitH, btnSplitV;
let btnTheme, explorerDrives;

// ── State ──
let editingId = null;
const terminals = new Map(); // ptyId -> { term, fitAddon, paneEl, type }
const tabs = new Map(); // tabIdx -> { root: PaneNode, el: DOM }
let activeTabIdx = null;
let activeTermId = null;
let focusedPaneId = null;
let tabCounter = 0;
let browserTabActive = false;
let cdpWs = null;
let cdpMsgId = 0;
let lastFrameMeta = null;
let screenInputBound = false;
let browserMode = "native"; // 'native' (embedded WebView) | 'ai' (CDP screencast)
let nativeCurrentUrl = "https://www.google.com";
let paneSyncPending = false;
let savedCmds = [];
let currentInput = "";
let acSelectedIdx = -1;
let currentExplorerPath = "";
let currentSftpId = null;

// ── Init: wait for both DOM and Tauri ──
window.addEventListener("DOMContentLoaded", async () => {
  // Wait for Tauri IPC to be ready
  while (!window.__TAURI__ || !window.__TAURI__.core) {
    await new Promise((r) => setTimeout(r, 50));
  }

  invoke = window.__TAURI__.core.invoke;

  // DOM refs
  sidebar = document.getElementById("sidebar");
  btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
  btnNewTerminal = document.getElementById("btn-new-terminal");
  explorerPath = document.getElementById("explorer-path");
  btnExplorerUp = document.getElementById("btn-explorer-up");
  explorerMode = document.getElementById("explorer-mode");
  fileListEl = document.getElementById("file-list");
  cmdListEl = document.getElementById("command-list");
  emptyEl = document.getElementById("empty-state");
  btnAdd = document.getElementById("btn-add");
  modalOverlay = document.getElementById("modal-overlay");
  modalTitle = document.getElementById("modal-title");
  form = document.getElementById("command-form");
  inputName = document.getElementById("input-name");
  inputCommand = document.getElementById("input-command");
  inputDesc = document.getElementById("input-description");
  btnCancel = document.getElementById("btn-cancel");
  terminalTabs = document.getElementById("terminal-tabs");
  terminalContainer = document.getElementById("terminal-container");
  terminalWelcome = document.getElementById("terminal-welcome");
  sshInput = document.getElementById("ssh-input");
  sshPort = document.getElementById("ssh-port");
  sshPassword = document.getElementById("ssh-password");
  sshKeyfile = document.getElementById("ssh-keyfile");
  btnSshConnect = document.getElementById("btn-ssh-connect");
  toastEl = document.getElementById("toast");
  acPopup = document.getElementById("autocomplete-popup");
  acList = document.getElementById("autocomplete-list");
  sessionPanel = document.getElementById("session-panel");
  sessionListEl = document.getElementById("session-list");
  btnToggleSessions = document.getElementById("btn-toggle-sessions");
  btnSplitH = document.getElementById("btn-split-h");
  btnSplitV = document.getElementById("btn-split-v");
  btnTheme = document.getElementById("btn-theme");
  explorerDrives = document.getElementById("explorer-drives");

  // Apply saved theme/accent before anything renders
  initTheme();

  try {
    await loadCommands();
    const home = await invoke("explorer_home_dir");
    currentExplorerPath = home;
    await loadExplorer();
    await loadDrives();
  } catch (e) {
    console.error("Init error:", e);
  }
  await setupListeners();
  initBrowserPanel();

  // Restore the previous session if one was saved; otherwise open a default terminal.
  try {
    const restored = await restoreSession();
    if (!restored) await spawnTerminal();
  } catch (e) {
    console.error("Session restore error:", e);
    try { await spawnTerminal(); } catch {}
  }

  setupCloseHandler();
});

async function setupListeners() {
  // Sidebar tabs
  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".sidebar-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });

  btnToggleSidebar.addEventListener("click", () => sidebar.classList.toggle("collapsed"));
  btnToggleSessions.addEventListener("click", () => sessionPanel.classList.toggle("collapsed"));
  btnSplitH.addEventListener("click", () => splitPane("horizontal"));
  btnSplitV.addEventListener("click", () => splitPane("vertical"));

  // Theme controls
  btnTheme.addEventListener("click", () => setTheme(currentThemeMode() === "dark" ? "light" : "dark"));
  document.querySelectorAll(".accent-swatch").forEach((sw) => {
    sw.addEventListener("click", () => setAccent(sw.dataset.accent));
  });
  btnNewTerminal.addEventListener("click", () => spawnTerminal());
  btnAdd.addEventListener("click", () => openModal());
  btnCancel.addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
  form.addEventListener("submit", handleSave);

  // Explorer
  btnExplorerUp.addEventListener("click", goUp);
  explorerMode.addEventListener("change", onExplorerModeChange);

  // Shell buttons
  document.querySelectorAll(".shell-btn").forEach((btn) => {
    btn.addEventListener("click", () => spawnTerminal(btn.dataset.shell || undefined));
  });

  // SSH
  btnSshConnect.addEventListener("click", connectSsh);
  sshInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connectSsh(); });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalOverlay.classList.contains("hidden")) closeModal();
    // Ctrl+` — focus terminal
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      if (terminals.size === 0) spawnTerminal();
      else if (activeTermId) terminals.get(activeTermId)?.term.focus();
    }
    // Ctrl+Shift+D — split horizontal
    if (e.ctrlKey && e.shiftKey && e.key === "D") {
      e.preventDefault();
      splitPane("horizontal");
    }
    // Ctrl+Shift+E — split vertical
    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      splitPane("vertical");
    }
    // Ctrl+Shift+W — close pane
    if (e.ctrlKey && e.shiftKey && e.key === "W") {
      e.preventDefault();
      if (focusedPaneId) closePane(focusedPaneId);
    }
    // Ctrl+Shift+N — new tab
    if (e.ctrlKey && e.shiftKey && e.key === "N") {
      e.preventDefault();
      spawnTerminal();
    }
    // Alt+Arrow — navigate between panes
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const paneIds = getCurrentTabPanes();
      if (paneIds.length > 1 && focusedPaneId) {
        const idx = paneIds.indexOf(focusedPaneId);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          setFocusedPane(paneIds[(idx + 1) % paneIds.length]);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          setFocusedPane(paneIds[(idx - 1 + paneIds.length) % paneIds.length]);
        }
      }
    }
  });

  function getCurrentTabPanes() {
    if (activeTabIdx == null) return [];
    const tab = tabs.get(activeTabIdx);
    return tab ? tab.panes : [];
  }

  // PTY polling loop — reads output from all terminals
  setInterval(async () => {
    for (const [id, t] of terminals) {
      try {
        const [chunks, exited] = await invoke("pty_read", { id });
        for (const chunk of chunks) {
          t.term.write(chunk);
        }
        if (exited && chunks.length === 0) {
          closeTerminal(id);
        }
      } catch {}
    }
  }, 16); // ~60fps

  // Resize — refit all visible panes
  new ResizeObserver(() => refitAllPanes()).observe(terminalContainer);
}

// ═══════════════════════════════════════════════
// EXPLORER
// ═══════════════════════════════════════════════

async function loadExplorer() {
  fileListEl.innerHTML = "";
  explorerPath.textContent = currentExplorerPath || "/";
  explorerPath.title = currentExplorerPath;
  highlightActiveDrive();

  try {
    let entries;
    if (currentSftpId) {
      entries = await invoke("sftp_list_dir", {
        sessionId: currentSftpId,
        path: currentExplorerPath,
      });
    } else {
      entries = await invoke("explorer_list_local", { path: currentExplorerPath });
    }
    renderFileList(entries);
  } catch (err) {
    fileListEl.innerHTML = `<li style="padding:10px;color:var(--red);font-size:12px;">${esc(String(err))}</li>`;
  }
}

function renderFileList(entries) {
  fileListEl.innerHTML = "";
  for (const entry of entries) {
    // Skip hidden files starting with .
    if (entry.name.startsWith(".")) continue;

    const li = document.createElement("li");
    li.className = "file-item";

    const iconClass = entry.is_dir ? "dir" : entry.is_symlink ? "link" : "file";
    const icon = entry.is_dir ? "\u{1F4C1}" : entry.is_symlink ? "\u{1F517}" : "\u{1F4C4}";
    const nameClass = entry.is_dir ? "dir" : "file";
    const size = entry.is_dir ? "" : formatSize(entry.size);

    li.innerHTML = `
      <span class="file-icon ${iconClass}">${icon}</span>
      <span class="file-name ${nameClass}">${esc(entry.name)}</span>
      <span class="file-size">${size}</span>
      <span class="file-item-actions">
        <button class="cd-btn" title="Open a new terminal here">cd</button>
      </span>
    `;

    if (entry.is_dir) {
      // Single click enters the folder
      li.addEventListener("click", () => navigateTo(entry.path));
    }

    li.querySelector(".cd-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const path = entry.is_dir ? entry.path : currentExplorerPath;
      if (currentSftpId) {
        // Remote explorer: cd inside the active SSH terminal. The path comes
        // from the remote server's listing, so single-quote + escape it to
        // prevent shell injection via a malicious filename.
        const safe = String(path).replace(/'/g, "'\\''");
        sendToTerminal(`cd '${safe}'`);
      } else {
        // Local: open a NEW terminal already in that directory
        spawnTerminal(undefined, path);
      }
    });

    fileListEl.appendChild(li);
  }
}

function navigateTo(path) {
  currentExplorerPath = path;
  loadExplorer();
}

async function goUp() {
  if (currentSftpId) {
    // Remote: go up by removing last path component
    const parts = currentExplorerPath.replace(/\/+$/, "").split("/");
    parts.pop();
    currentExplorerPath = parts.join("/") || "/";
  } else {
    const parent = await invoke("explorer_parent_dir", { path: currentExplorerPath });
    if (parent) currentExplorerPath = parent;
  }
  loadExplorer();
}

function onExplorerModeChange() {
  const val = explorerMode.value;
  if (val === "local") {
    currentSftpId = null;
    invoke("explorer_home_dir").then((home) => {
      currentExplorerPath = home;
      loadExplorer();
    });
  } else {
    // val is sftp session id
    const id = parseInt(val);
    currentSftpId = id;
    invoke("sftp_home_dir", { sessionId: id }).then((home) => {
      currentExplorerPath = home;
      loadExplorer();
    }).catch((err) => {
      currentExplorerPath = "/";
      loadExplorer();
    });
  }
}

function addSftpOption(sftpId, label) {
  const opt = document.createElement("option");
  opt.value = sftpId;
  opt.textContent = label;
  explorerMode.appendChild(opt);
  // Auto switch to new SFTP
  explorerMode.value = sftpId;
  onExplorerModeChange();
}

function removeSftpOption(sftpId) {
  const opt = explorerMode.querySelector(`option[value="${sftpId}"]`);
  if (opt) opt.remove();
  if (explorerMode.value === String(sftpId) || !explorerMode.value) {
    explorerMode.value = "local";
    onExplorerModeChange();
  }
}

// ═══════════════════════════════════════════════
// TERMINAL + PANE MANAGEMENT
// ═══════════════════════════════════════════════

// Create a new PTY-backed pane and return its ptyId
async function createPane(parentEl, shell, args, cwd) {
  const paneEl = document.createElement("div");
  paneEl.className = "pane-leaf";
  const termWrap = document.createElement("div");
  termWrap.style.cssText = "flex:1;overflow:hidden;";
  const statusBar = document.createElement("div");
  statusBar.className = "pane-statusbar";
  paneEl.style.display = "flex";
  paneEl.style.flexDirection = "column";
  paneEl.appendChild(termWrap);
  paneEl.appendChild(statusBar);
  parentEl.appendChild(paneEl);

  const term = createXterm();
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  fitAddon.fit();

  const cols = Math.max(term.cols, 80);
  const rows = Math.max(term.rows, 24);

  const id = await invoke("pty_spawn", {
    shell: shell || null,
    args: args || null,
    cwd: cwd || null,
    cols,
    rows,
  });

  const sessionLabel = shell === "ssh" ? "SSH" : (shell || "Terminal");
  terminals.set(id, { term, fitAddon, paneEl, type: shell === "ssh" ? "ssh" : "local", label: sessionLabel });

  // Status bar: label + split/close controls
  statusBar.innerHTML = `
    <span class="pane-label">${esc(sessionLabel)}</span>
    <span class="pane-actions">
      <button class="pane-btn split-h" title="Split horizontally (Ctrl+Shift+D)">&#8596;</button>
      <button class="pane-btn split-v" title="Split vertically (Ctrl+Shift+E)">&#8597;</button>
      <button class="pane-btn close" title="Close pane (Ctrl+Shift+W)">&times;</button>
    </span>
  `;
  statusBar.querySelector(".split-h").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("horizontal"); });
  statusBar.querySelector(".split-v").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("vertical"); });
  statusBar.querySelector(".close").addEventListener("click", (e) => { e.stopPropagation(); closePane(id); });

  term.onData((data) => {
    const result = handleTerminalInput(data, id);
    if (result !== "consumed") {
      invoke("pty_write", { id, data });
    }
  });

  // Focus tracking
  term.onFocus = () => setFocusedPane(id);
  paneEl.addEventListener("click", () => setFocusedPane(id));
  termWrap.addEventListener("click", () => { setFocusedPane(id); term.focus(); });

  await invoke("pty_write", { id, data: "\x1b[1;1R" });

  setFocusedPane(id);
  return id;
}

function setFocusedPane(ptyId) {
  focusedPaneId = ptyId;
  activeTermId = ptyId;
  document.querySelectorAll(".pane-leaf").forEach((el) => el.classList.remove("focused"));
  const t = terminals.get(ptyId);
  if (t) {
    t.paneEl.classList.add("focused");
    t.term.focus();
  }
  updateSessionActive();
}

async function spawnTerminal(shell, cwd) {
  terminalWelcome.style.display = "none";

  const tabIdx = tabCounter++;
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-instance active";

  const rootContainer = document.createElement("div");
  rootContainer.className = "pane-container horizontal";
  rootContainer.style.cssText = "flex:1;";
  tabEl.appendChild(rootContainer);
  terminalContainer.appendChild(tabEl);

  const label = cwd ? baseName(cwd) : (shell || "Terminal");

  try {
    const ptyId = await createPane(rootContainer, shell, null, cwd);
    tabs.set(tabIdx, {
      el: tabEl,
      rootEl: rootContainer,
      panes: [ptyId],
      label,
      session: { kind: "local", shell: shell || null, cwd: cwd || null },
    });
    addTab(tabIdx, label);
    switchToTab(tabIdx);
    refreshSessionList();
  } catch (err) {
    toast("Failed: " + err, true);
    tabEl.remove();
    terminalWelcome.style.display = "";
  }
}

// Split the focused pane
async function splitPane(direction) {
  if (!focusedPaneId) return;
  const tInfo = terminals.get(focusedPaneId);
  if (!tInfo) return;

  const currentTab = findTabForPane(focusedPaneId);
  if (!currentTab) return;

  const paneEl = tInfo.paneEl;
  const parent = paneEl.parentElement;

  // Create a new split container
  const splitContainer = document.createElement("div");
  splitContainer.className = `pane-container ${direction}`;
  splitContainer.style.cssText = "flex:1;";

  // Move existing pane into split
  parent.replaceChild(splitContainer, paneEl);
  splitContainer.appendChild(paneEl);

  // Add divider
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  splitContainer.appendChild(divider);
  setupDividerDrag(divider, splitContainer, direction);

  // Create new pane
  try {
    const newPtyId = await createPane(splitContainer, null, null);
    currentTab.panes.push(newPtyId);
    refreshSessionList();

    // Refit all panes in this tab
    await new Promise((r) => requestAnimationFrame(r));
    refitAllPanes();
  } catch (err) {
    toast("Split failed: " + err, true);
  }
}

function setupDividerDrag(divider, container, direction) {
  let dragging = false;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    e.preventDefault();

    const rect = container.getBoundingClientRect();
    const children = Array.from(container.children).filter((c) => !c.classList.contains("pane-divider"));

    const onMove = (e) => {
      if (!dragging) return;
      let ratio;
      if (direction === "horizontal") {
        ratio = (e.clientX - rect.left) / rect.width;
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
      }
      ratio = Math.max(0.15, Math.min(0.85, ratio));
      if (children[0]) children[0].style.flex = `${ratio}`;
      if (children[1]) children[1].style.flex = `${1 - ratio}`;
      refitAllPanes();
    };

    const onUp = () => {
      dragging = false;
      divider.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      refitAllPanes();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function closePane(ptyId) {
  const tInfo = terminals.get(ptyId);
  if (!tInfo) return;

  const tab = findTabForPane(ptyId);
  if (!tab) return;

  // If only one pane in tab, close the whole tab
  if (tab.panes.length <= 1) {
    closeTab(tab.tabIdx);
    return;
  }

  // Remove pane from DOM
  const paneEl = tInfo.paneEl;
  const splitContainer = paneEl.parentElement;

  invoke("pty_close", { id: ptyId });
  tInfo.term.dispose();
  paneEl.remove();
  terminals.delete(ptyId);
  tab.panes = tab.panes.filter((p) => p !== ptyId);

  // If split container now has only one child (+ divider), unwrap it
  const divider = splitContainer.querySelector(".pane-divider");
  if (divider) divider.remove();

  const remaining = splitContainer.children[0];
  if (remaining && splitContainer.parentElement) {
    splitContainer.parentElement.replaceChild(remaining, splitContainer);
    if (remaining.style) remaining.style.flex = "1";
  }

  // Focus another pane
  if (tab.panes.length > 0) {
    setFocusedPane(tab.panes[0]);
  }
  refreshSessionList();
  refitAllPanes();
}

function findTabForPane(ptyId) {
  for (const [idx, tab] of tabs) {
    if (tab.panes.includes(ptyId)) {
      tab.tabIdx = idx;
      return tab;
    }
  }
  return null;
}

function refitAllPanes() {
  for (const [id, t] of terminals) {
    try {
      t.fitAddon.fit();
      invoke("pty_resize", { id, cols: t.term.cols, rows: t.term.rows });
    } catch {}
  }
}

async function connectSsh() {
  const target = sshInput.value.trim();
  if (!target) return;

  const parts = target.split("@");
  if (parts.length !== 2) {
    toast("Format: user@hostname", true);
    return;
  }
  await doSshConnect({
    target,
    username: parts[0],
    host: parts[1],
    port: parseInt(sshPort.value) || 22,
    password: sshPassword.value || null,
    keyPath: sshKeyfile.value.trim() || null,
  });
}

// Parameterized SSH connect (used by the form and by session restore).
// auth: 'key' (keyfile/agent → auto-reconnect) | 'password' (prompted on restore).
async function doSshConnect(opts) {
  const { target, username, host, port, password, keyPath } = opts;
  const auth = opts.auth || (password && !keyPath ? "password" : "key");

  terminalWelcome.style.display = "none";

  const tabIdx = tabCounter++;
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-instance active";
  const rootContainer = document.createElement("div");
  rootContainer.className = "pane-container horizontal";
  rootContainer.style.cssText = "flex:1;";
  tabEl.appendChild(rootContainer);
  terminalContainer.appendChild(tabEl);

  const sshArgs = ["-p", String(port), target];

  try {
    const ptyId = await createPane(rootContainer, "ssh", sshArgs);
    terminals.get(ptyId).sshTarget = target;

    tabs.set(tabIdx, {
      el: tabEl,
      rootEl: rootContainer,
      panes: [ptyId],
      label: `SSH: ${target}`,
      // No password is ever persisted — only the auth *kind*.
      session: { kind: "ssh", target, username, host, port, keyPath: keyPath || null, auth },
    });
    addTab(tabIdx, `SSH: ${target}`);
    switchToTab(tabIdx);
    refreshSessionList();

    // Establish SFTP connection for explorer
    toast("Connecting SFTP...");
    try {
      const sftpId = await invoke("sftp_connect", { host, port, username, password, keyPath });
      terminals.get(ptyId).sftpId = sftpId;
      addSftpOption(sftpId, `SSH: ${target}`);
      toast("SFTP connected");
    } catch (sftpErr) {
      toast("SSH opened. SFTP: " + sftpErr, true);
    }
  } catch (err) {
    toast("SSH failed: " + err, true);
    tabEl.remove();
    terminalWelcome.style.display = "";
  }
}

// ── Browser (Playwright/CDP) tab ──
function initBrowserPanel() {
  // Persistent Browser tab pinned at the left of the tab strip.
  const tab = document.createElement("div");
  tab.className = "browser-tab";
  tab.id = "browser-tab";
  tab.innerHTML = `${ICON.globe}<span>Browser</span>`;
  tab.title = "Playwright/CDP browser";
  tab.addEventListener("click", () => setBrowserView(true));
  terminalTabs.prepend(tab);

  // AI (CDP) mode controls
  document.getElementById("btn-browser-launch").addEventListener("click", launchBrowser);
  document.getElementById("btn-browser-stop").addEventListener("click", stopBrowser);
  document.getElementById("btn-browser-refresh").addEventListener("click", refreshBrowserStatus);
  document.getElementById("browser-port").addEventListener("input", () => updateBrowserInfo());
  document.querySelectorAll("#browser-panel .copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => copyBrowserField(btn.dataset.copy));
  });

  // Mode toggle
  document.getElementById("mode-native").addEventListener("click", () => setBrowserMode("native"));
  document.getElementById("mode-ai").addEventListener("click", () => setBrowserMode("ai"));

  // Native address bar
  const navUrl = document.getElementById("nav-url");
  document.getElementById("nav-go").addEventListener("click", () => nativeNavigate(navUrl.value));
  navUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nativeNavigate(navUrl.value);
  });
  document.getElementById("nav-back").addEventListener("click", () => invoke("browser_pane_back").catch(() => {}));
  document.getElementById("nav-forward").addEventListener("click", () => invoke("browser_pane_forward").catch(() => {}));
  document.getElementById("nav-reload").addEventListener("click", () => invoke("browser_pane_reload").catch(() => {}));

  // Keep the native overlay aligned with its viewport box on any layout change.
  const vp = document.getElementById("browser-viewport");
  if (window.ResizeObserver) new ResizeObserver(() => scheduleSync()).observe(vp);
  window.addEventListener("resize", scheduleSync);

  // Reflect link-click navigation back into the address bar (when not editing).
  setInterval(async () => {
    if (!browserTabActive || browserMode !== "native") return;
    if (document.activeElement === navUrl) return;
    try {
      const u = await invoke("browser_pane_url");
      if (u) {
        nativeCurrentUrl = u;
        navUrl.value = u;
      }
    } catch {}
  }, 1500);

  setBrowserMode("native");
  updateBrowserInfo();
}

function setBrowserView(on) {
  browserTabActive = on;
  const panel = document.getElementById("browser-panel");
  const tab = document.getElementById("browser-tab");
  if (on) {
    panel.classList.remove("hidden");
    terminalContainer.style.display = "none";
    terminalWelcome.style.display = "none";
    if (tab) tab.classList.add("active");
    terminalTabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    if (browserMode === "native") {
      openNativePane();
    } else {
      refreshBrowserStatus(); // attaches the screencast if a browser is running
    }
  } else {
    panel.classList.add("hidden");
    terminalContainer.style.display = "";
    if (tab) tab.classList.remove("active");
    // The native webview floats above all HTML, so it MUST hide when the tab
    // isn't visible; also stop any AI screencast stream.
    invoke("browser_pane_hide").catch(() => {});
    detachScreencast();
  }
}

function browserPort() {
  const v = parseInt(document.getElementById("browser-port").value, 10);
  return Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : 9222;
}

function updateBrowserInfo(endpointOverride) {
  const ep = endpointOverride || `http://localhost:${browserPort()}`;
  document.getElementById("browser-endpoint").textContent = ep;
  document.getElementById("browser-mcp-cli").textContent =
    `npx @playwright/mcp@latest --cdp-endpoint ${ep}`;
  document.getElementById("browser-mcp-add").textContent =
    `claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint ${ep}`;
}

function applyBrowserStatus(st) {
  const statusEl = document.getElementById("browser-status");
  if (st && st.running) {
    statusEl.textContent = `● Running · ${st.browser} · ${st.endpoint}`;
    statusEl.classList.remove("stopped");
    statusEl.classList.add("running");
    if (st.port) document.getElementById("browser-port").value = st.port;
    updateBrowserInfo(st.endpoint);
    if (browserTabActive) attachScreencast();
  } else {
    statusEl.textContent = "○ Stopped";
    statusEl.classList.remove("running");
    statusEl.classList.add("stopped");
    updateBrowserInfo();
    detachScreencast();
  }
}

async function refreshBrowserStatus() {
  try {
    const st = await invoke("browser_status");
    applyBrowserStatus(st);
  } catch (e) {
    console.error("browser_status error", e);
  }
}

async function launchBrowser() {
  const port = browserPort();
  const url = document.getElementById("browser-url").value.trim() || null;
  try {
    const st = await invoke("browser_launch", { port, url, headless: true });
    applyBrowserStatus(st);
    toast(`Browser launched (${st.browser}, ${st.endpoint})`);
  } catch (e) {
    toast(String(e), true);
  }
}

async function stopBrowser() {
  try {
    await invoke("browser_close");
    applyBrowserStatus({ running: false });
    toast("Browser stopped");
  } catch (e) {
    toast(String(e), true);
  }
}

async function copyBrowserField(which) {
  const map = {
    endpoint: "browser-endpoint",
    "mcp-cli": "browser-mcp-cli",
    "mcp-add": "browser-mcp-add",
  };
  const el = document.getElementById(map[which]);
  if (!el) return;
  await clipboardWrite(el.textContent);
  toast("Copied");
}

// ── Screencast viewer (CDP over WebSocket, Phase A) ──
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function attachScreencast() {
  if (cdpWs) return; // already attached
  const port = browserPort();
  // The debugging port + page target take a moment after launch; retry briefly.
  let target = null;
  for (let i = 0; i < 24 && !target && browserTabActive; i++) {
    try {
      target = await invoke("browser_page_target", { port });
    } catch {
      await sleep(250);
    }
  }
  if (!target || !browserTabActive) return;
  openCdp(target.wsUrl);
}

function openCdp(wsUrl) {
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error("CDP WebSocket open failed", e);
    return;
  }
  cdpWs = ws;
  ws.onopen = () => {
    cdpSend("Page.enable");
    cdpSend("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1600,
      maxHeight: 1000,
      everyNthFrame: 1,
    });
    bindScreenInput();
  };
  ws.onmessage = (ev) => handleCdpMessage(ev.data);
  ws.onclose = () => {
    if (cdpWs === ws) cdpWs = null;
    setScreenActive(false);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function cdpSend(method, params) {
  if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
  cdpMsgId += 1;
  cdpWs.send(JSON.stringify({ id: cdpMsgId, method, params: params || {} }));
}

function handleCdpMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.method === "Page.screencastFrame") {
    const p = msg.params;
    lastFrameMeta = p.metadata;
    document.getElementById("browser-screen").src = "data:image/jpeg;base64," + p.data;
    setScreenActive(true);
    cdpSend("Page.screencastFrameAck", { sessionId: p.sessionId });
  }
}

function detachScreencast() {
  if (cdpWs) {
    try { cdpSend("Page.stopScreencast"); } catch {}
    try { cdpWs.close(); } catch {}
    cdpWs = null;
  }
  setScreenActive(false);
}

function setScreenActive(on) {
  const vp = document.getElementById("browser-viewport");
  if (vp) vp.classList.toggle("active", on);
}

function screenCoords(e) {
  const img = document.getElementById("browser-screen");
  const m = lastFrameMeta;
  const rect = img.getBoundingClientRect();
  if (!m || !rect.width || !rect.height) return null;
  return {
    x: Math.round(((e.clientX - rect.left) / rect.width) * m.deviceWidth),
    y: Math.round(((e.clientY - rect.top) / rect.height) * m.deviceHeight),
  };
}

function cdpButton(b) {
  return b === 2 ? "right" : b === 1 ? "middle" : "left";
}

function bindScreenInput() {
  if (screenInputBound) return;
  screenInputBound = true;
  const img = document.getElementById("browser-screen");
  img.setAttribute("tabindex", "0");

  img.addEventListener("mousemove", (e) => {
    const c = screenCoords(e);
    if (c) cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  });
  img.addEventListener("mousedown", (e) => {
    const c = screenCoords(e);
    if (!c) return;
    img.focus();
    cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: cdpButton(e.button), clickCount: 1 });
  });
  img.addEventListener("mouseup", (e) => {
    const c = screenCoords(e);
    if (c) cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: cdpButton(e.button), clickCount: 1 });
  });
  img.addEventListener("contextmenu", (e) => e.preventDefault());
  img.addEventListener(
    "wheel",
    (e) => {
      const c = screenCoords(e);
      if (!c) return;
      e.preventDefault();
      cdpSend("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false }
  );

  img.addEventListener("keydown", (e) => {
    sendKey(e, "keyDown");
    if (e.key.length === 1) {
      cdpSend("Input.dispatchKeyEvent", { type: "char", text: e.key, key: e.key });
    }
    if (["Tab", "Enter", " ", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
    }
  });
  img.addEventListener("keyup", (e) => sendKey(e, "keyUp"));
}

function sendKey(e, type) {
  cdpSend("Input.dispatchKeyEvent", {
    type,
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    nativeVirtualKeyCode: e.keyCode,
  });
}

// ── Native embedded browser (child WebView overlay) ──
let nativePaneCreated = false;

function setBrowserMode(mode) {
  browserMode = mode;
  document.getElementById("mode-native").classList.toggle("active", mode === "native");
  document.getElementById("mode-ai").classList.toggle("active", mode === "ai");
  document.getElementById("browser-nav").style.display = mode === "native" ? "" : "none";
  document.getElementById("browser-ai-controls").style.display = mode === "ai" ? "" : "none";
  document.getElementById("browser-conn").style.display = mode === "ai" ? "" : "none";

  if (mode === "native") {
    // AI → Native: stop the screencast, hide its image, show the native pane.
    detachScreencast();
    setScreenActive(false);
    if (browserTabActive) openNativePane();
  } else {
    // Native → AI: hide the native overlay, (re)attach screencast if running.
    invoke("browser_pane_hide").catch(() => {});
    if (browserTabActive) refreshBrowserStatus();
  }
}

async function openNativePane() {
  const vp = document.getElementById("browser-viewport");
  const r = vp.getBoundingClientRect();
  try {
    if (!nativePaneCreated) {
      await invoke("browser_pane_open", {
        url: nativeCurrentUrl,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      });
      nativePaneCreated = true;
    } else {
      // Re-entry: just show + realign, preserving the page that was open.
      await invoke("browser_pane_show");
      await invoke("browser_pane_set_bounds", { x: r.x, y: r.y, width: r.width, height: r.height });
    }
  } catch (e) {
    toast(String(e), true);
  }
}

function scheduleSync() {
  // Debounce: ResizeObserver can fire a storm during window drag; coalesce to
  // one set_bounds per ~100ms so we don't flood the main thread with ops.
  if (paneSyncPending) return;
  paneSyncPending = true;
  setTimeout(() => {
    paneSyncPending = false;
    syncPaneBounds();
  }, 100);
}

async function syncPaneBounds() {
  if (!browserTabActive || browserMode !== "native") return;
  const vp = document.getElementById("browser-viewport");
  const r = vp.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  try {
    await invoke("browser_pane_set_bounds", { x: r.x, y: r.y, width: r.width, height: r.height });
  } catch {}
}

function nativeNavigate(input) {
  const url = (input || "").trim();
  if (!url) return;
  nativeCurrentUrl = url;
  invoke("browser_pane_navigate", { url }).catch((e) => toast(String(e), true));
}

// ── Session persistence + close prompt ──
function collectSession() {
  const arr = [];
  for (const [, tab] of tabs) {
    if (tab.session) arr.push({ ...tab.session, label: tab.label });
  }
  return { version: 1, tabs: arr };
}

async function saveSessionNow() {
  try {
    await invoke("session_save", { data: collectSession() });
  } catch (e) {
    console.error("session_save failed", e);
  }
}

async function restoreSession() {
  let data = null;
  try {
    data = await invoke("session_load");
  } catch (e) {
    console.error("session_load failed", e);
  }
  if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return false;

  const pwSessions = [];
  for (const s of data.tabs) {
    try {
      if (s.kind === "ssh") {
        if (s.auth === "key") {
          // Key/agent auth → reconnect automatically (no secret needed).
          await doSshConnect({
            target: s.target,
            username: s.username,
            host: s.host,
            port: s.port,
            password: null,
            keyPath: s.keyPath || null,
            auth: "key",
          });
        } else {
          pwSessions.push(s); // password auth → prompt below
        }
      } else {
        await spawnTerminal(s.shell || undefined, s.cwd || undefined);
      }
    } catch (e) {
      console.error("restore tab failed", e);
    }
  }

  // Password-auth SSH sessions: prompt one at a time.
  for (const s of pwSessions) {
    await promptSshPasswordRestore(s);
  }

  return tabs.size > 0;
}

function promptSshPasswordRestore(s) {
  return new Promise((resolve) => {
    const modal = document.getElementById("sshpw-modal");
    const input = document.getElementById("sshpw-input");
    const btnConnect = document.getElementById("sshpw-connect");
    const btnSkip = document.getElementById("sshpw-skip");
    document.getElementById("sshpw-target").textContent =
      `${s.username}@${s.host}:${s.port} — 비밀번호를 입력해 재접속`;
    input.value = "";
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);

    function cleanup() {
      modal.classList.add("hidden");
      btnConnect.removeEventListener("click", onConnect);
      btnSkip.removeEventListener("click", onSkip);
      input.removeEventListener("keydown", onKey);
    }
    async function onConnect() {
      const password = input.value || null;
      cleanup();
      await doSshConnect({
        target: s.target,
        username: s.username,
        host: s.host,
        port: s.port,
        password,
        keyPath: s.keyPath || null,
        auth: "password",
      });
      resolve();
    }
    function onSkip() {
      cleanup();
      resolve();
    }
    function onKey(e) {
      if (e.key === "Enter") onConnect();
      else if (e.key === "Escape") onSkip();
    }
    btnConnect.addEventListener("click", onConnect);
    btnSkip.addEventListener("click", onSkip);
    input.addEventListener("keydown", onKey);
  });
}

function closePref() {
  try { return localStorage.getItem("mymux.sessionPref") || "ask"; } catch { return "ask"; }
}
function setClosePref(v) {
  try { localStorage.setItem("mymux.sessionPref", v); } catch {}
}

let closeAppWindow = null;

async function setupCloseHandler() {
  try {
    const winApi = window.__TAURI__ && window.__TAURI__.window;
    if (!winApi || !winApi.getCurrentWindow) return; // graceful: X closes normally
    closeAppWindow = winApi.getCurrentWindow();
    await closeAppWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await handleCloseRequest();
    });

    document.getElementById("close-cancel").addEventListener("click", () => {
      document.getElementById("close-modal").classList.add("hidden");
    });
    document.getElementById("close-save").addEventListener("click", async () => {
      if (document.getElementById("close-remember-pref").checked) setClosePref("always");
      await saveSessionNow();
      await destroyWindow();
    });
    document.getElementById("close-forget").addEventListener("click", async () => {
      if (document.getElementById("close-remember-pref").checked) setClosePref("never");
      await invoke("session_clear").catch(() => {});
      await destroyWindow();
    });
  } catch (e) {
    console.error("close handler setup failed", e);
  }
}

async function destroyWindow() {
  try {
    await closeAppWindow.destroy();
  } catch (e) {
    console.error("window destroy failed", e);
  }
}

async function handleCloseRequest() {
  const pref = closePref();
  if (pref === "always") {
    await saveSessionNow();
    await destroyWindow();
    return;
  }
  if (pref === "never") {
    await invoke("session_clear").catch(() => {});
    await destroyWindow();
    return;
  }
  document.getElementById("close-remember-pref").checked = false;
  document.getElementById("close-modal").classList.remove("hidden");
}

function createXterm() {
  return new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"D2Coding", "Cascadia Code", "Consolas", monospace',
    theme: terminalTheme(),
  });
}

function addTab(tabIdx, label) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = tabIdx;
  tab.innerHTML = `
    <span>${esc(label)}</span>
    <span class="tab-close">&times;</span>
  `;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) {
      closeTab(tabIdx);
    } else {
      switchToTab(tabIdx);
    }
  });
  tab.addEventListener("dblclick", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    e.stopPropagation();
    startRenameTabInBar(tabIdx, tab);
  });
  tab.title = "Double-click to rename";
  terminalTabs.appendChild(tab);
}

function switchToTab(tabIdx) {
  if (browserTabActive) setBrowserView(false);
  activeTabIdx = tabIdx;
  terminalTabs.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", Number(tab.dataset.id) === tabIdx);
  });
  tabs.forEach((t, idx) => {
    t.el.classList.toggle("active", idx === tabIdx);
  });
  const tabInfo = tabs.get(tabIdx);
  if (tabInfo && tabInfo.panes.length > 0) {
    const focusPane = tabInfo.panes.includes(focusedPaneId) ? focusedPaneId : tabInfo.panes[0];
    setFocusedPane(focusPane);
  }
  requestAnimationFrame(() => refitAllPanes());
}

function closeTab(tabIdx) {
  const tabInfo = tabs.get(tabIdx);
  if (!tabInfo) return;

  // Close all panes in this tab
  for (const ptyId of [...tabInfo.panes]) {
    const tInfo = terminals.get(ptyId);
    if (tInfo) {
      if (tInfo.sftpId) {
        invoke("sftp_disconnect", { sessionId: tInfo.sftpId });
        removeSftpOption(tInfo.sftpId);
      }
      invoke("pty_close", { id: ptyId });
      tInfo.term.dispose();
      terminals.delete(ptyId);
    }
  }

  tabInfo.el.remove();
  tabs.delete(tabIdx);

  const tabDom = terminalTabs.querySelector(`.tab[data-id="${tabIdx}"]`);
  if (tabDom) tabDom.remove();

  if (tabs.size > 0) {
    switchToTab(tabs.keys().next().value);
  } else {
    activeTabIdx = null;
    activeTermId = null;
    focusedPaneId = null;
    terminalWelcome.style.display = "";
  }
  refreshSessionList();
}

function sendToTerminal(command) {
  if (!activeTermId) {
    toast("No active terminal.", true);
    return;
  }
  invoke("pty_write", { id: activeTermId, data: command + "\r" });
  terminals.get(activeTermId)?.term.focus();
}

// ═══════════════════════════════════════════════
// SESSION LIST (right panel)
// ═══════════════════════════════════════════════

// Resolve the display name for a terminal/session (custom name wins).
function sessionLabelFor(t) {
  if (!t) return "Terminal";
  return t.customName || (t.sshTarget ? `SSH: ${t.sshTarget}` : (t.label || "Terminal"));
}

// Rebuild the full session list, grouped by tab.
function refreshSessionList() {
  if (!sessionListEl) return;
  sessionListEl.innerHTML = "";

  if (terminals.size === 0) {
    sessionListEl.innerHTML = `<li class="session-empty">No active sessions.</li>`;
    return;
  }

  for (const [tabIdx, tab] of tabs) {
    if (!tab.panes || tab.panes.length === 0) continue;

    const group = document.createElement("li");
    group.className = "session-group";
    group.textContent = tab.label || `Tab ${tabIdx + 1}`;
    group.title = "Double-click to rename tab";
    group.addEventListener("dblclick", () => startRenameTab(tabIdx, group));
    sessionListEl.appendChild(group);

    tab.panes.forEach((ptyId, i) => {
      const t = terminals.get(ptyId);
      if (!t) return;
      const dot = t.type === "ssh" ? ICON.globe : "▸";

      const li = document.createElement("li");
      li.className = "session-item" + (ptyId === focusedPaneId ? " active" : "");
      li.dataset.ptyId = ptyId;

      const dotEl = document.createElement("span");
      dotEl.className = "session-dot";
      dotEl.innerHTML = dot;

      const nameEl = document.createElement("span");
      nameEl.className = "session-name";
      nameEl.textContent = sessionLabelFor(t);
      nameEl.title = "Double-click to rename";

      const renameBtn = document.createElement("button");
      renameBtn.className = "session-rename";
      renameBtn.textContent = "✎"; // ✎
      renameBtn.title = "Rename";

      const paneNo = document.createElement("span");
      paneNo.className = "session-pane";
      paneNo.textContent = `#${i + 1}`;

      li.append(dotEl, nameEl, renameBtn, paneNo);

      li.addEventListener("click", () => focusSession(ptyId));
      nameEl.addEventListener("dblclick", (e) => { e.stopPropagation(); startRenameSession(ptyId, nameEl); });
      renameBtn.addEventListener("click", (e) => { e.stopPropagation(); startRenameSession(ptyId, nameEl); });

      sessionListEl.appendChild(li);
    });
  }
}

// Lightweight: just move the active highlight without rebuilding.
function updateSessionActive() {
  if (!sessionListEl) return;
  sessionListEl.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.ptyId) === focusedPaneId);
  });
}

// Click a session → switch to its tab (if needed) and move the cursor to it.
function focusSession(ptyId) {
  const tab = findTabForPane(ptyId);
  if (!tab) return;
  if (activeTabIdx !== tab.tabIdx) {
    focusedPaneId = ptyId; // switchToTab will honor this when focusing
    switchToTab(tab.tabIdx);
  } else {
    setFocusedPane(ptyId);
  }
  terminals.get(ptyId)?.term.focus();
}

// Inline-rename a session (pane). WebView2 has no window.prompt, so edit in place.
function startRenameSession(ptyId, nameEl) {
  const t = terminals.get(ptyId);
  if (!t) return;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = sessionLabelFor(t);
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      t.customName = input.value.trim() || null;
      const lbl = t.paneEl && t.paneEl.querySelector(".pane-label");
      if (lbl) lbl.textContent = sessionLabelFor(t);
    }
    refreshSessionList();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

// Inline-rename a tab from the session-list group header.
function startRenameTab(tabIdx, groupEl) {
  const tab = tabs.get(tabIdx);
  if (!tab) return;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = tab.label || `Tab ${tabIdx + 1}`;
  input.spellcheck = false;
  groupEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      tab.label = input.value.trim() || tab.label;
      setTabLabel(tabIdx, tab.label);
    }
    refreshSessionList();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

// Update the label span inside a tab in the tab bar.
function setTabLabel(tabIdx, label) {
  const tabDom = terminalTabs.querySelector(`.tab[data-id="${tabIdx}"]`);
  if (!tabDom) return;
  const span = tabDom.querySelector("span:not(.tab-close)");
  if (span) span.textContent = label;
}

// Inline-rename a tab directly in the tab bar (double-click the tab).
function startRenameTabInBar(tabIdx, tabDom) {
  const tab = tabs.get(tabIdx);
  if (!tab) return;
  const span = tabDom.querySelector("span:not(.tab-close)");
  if (!span) return;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = tab.label || `Tab ${tabIdx + 1}`;
  input.spellcheck = false;
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) tab.label = input.value.trim() || tab.label;
    const newSpan = document.createElement("span");
    newSpan.textContent = tab.label;
    input.replaceWith(newSpan);
    refreshSessionList();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

// ═══════════════════════════════════════════════
// THEME (dark / light + accent)
// ═══════════════════════════════════════════════

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function currentThemeMode() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function terminalTheme() {
  const bg = cssVar("--term-bg", "#1a1a2e");
  const fg = cssVar("--term-fg", "#e0e0e0");
  const accent = cssVar("--accent", "#0f9ef0");
  const border = cssVar("--border", "#2a3a5c");
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    selectionBackground: border,
    black: bg,
    red: cssVar("--red", "#f44747"),
    green: cssVar("--green", "#4ec9b0"),
    yellow: cssVar("--yellow", "#dcdcaa"),
    blue: accent,
    magenta: "#c586c0",
    cyan: cssVar("--green", "#4ec9b0"),
    white: fg,
  };
}

function applyTerminalTheme() {
  const theme = terminalTheme();
  for (const [, t] of terminals) {
    try { t.term.options.theme = theme; } catch {}
  }
}

function setTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("mycli-theme", mode); } catch {}
  if (btnTheme) btnTheme.innerHTML = mode === "dark" ? ICON.moon : ICON.sun;
  applyTerminalTheme();
}

function setAccent(accent) {
  document.documentElement.setAttribute("data-accent", accent);
  try { localStorage.setItem("mycli-accent", accent); } catch {}
  document.querySelectorAll(".accent-swatch").forEach((sw) => {
    sw.classList.toggle("active", sw.dataset.accent === accent);
  });
  applyTerminalTheme();
}

function initTheme() {
  let mode = "dark";
  let accent = "blue";
  try {
    mode = localStorage.getItem("mycli-theme") || "dark";
    accent = localStorage.getItem("mycli-accent") || "blue";
  } catch {}
  setTheme(mode);
  setAccent(accent);
}

// ═══════════════════════════════════════════════
// DRIVES (local explorer)
// ═══════════════════════════════════════════════

async function loadDrives() {
  if (!explorerDrives) return;
  try {
    const drives = await invoke("explorer_list_drives");
    explorerDrives.innerHTML = "";
    if (!drives || drives.length <= 1) return; // nothing to switch between
    for (const drive of drives) {
      const btn = document.createElement("button");
      btn.className = "drive-btn";
      btn.dataset.drive = drive;
      btn.textContent = drive.replace(/[\\/]+$/, ""); // "E:"
      btn.addEventListener("click", () => {
        currentSftpId = null;
        if (explorerMode) explorerMode.value = "local";
        currentExplorerPath = drive;
        loadExplorer();
      });
      explorerDrives.appendChild(btn);
    }
    highlightActiveDrive();
  } catch {
    explorerDrives.innerHTML = "";
  }
}

function highlightActiveDrive() {
  if (!explorerDrives) return;
  const cur = (currentExplorerPath || "").toUpperCase().replace(/\//g, "\\");
  explorerDrives.querySelectorAll(".drive-btn").forEach((b) => {
    const d = (b.dataset.drive || "").toUpperCase().replace(/[\\/]+$/, "");
    b.classList.toggle("active", !!d && cur.startsWith(d));
  });
}

// ═══════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════

async function loadCommands() {
  try {
    const cmds = await invoke("list_commands");
    savedCmds = cmds;
    renderCmdList(cmds);
  } catch (err) {
    toast("Error: " + err, true);
  }
}

function renderCmdList(cmds) {
  cmdListEl.innerHTML = "";
  if (cmds.length === 0) { emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");

  // Favorites pinned to the top; otherwise keep stored order.
  const ordered = [...cmds].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

  for (const cmd of ordered) {
    const li = document.createElement("li");
    li.className = "cmd-item" + (cmd.favorite ? " is-fav" : "");
    li.innerHTML = `
      <div class="cmd-name">${esc(cmd.name)}</div>
      <div class="cmd-text">${esc(cmd.command)}</div>
      ${cmd.description ? `<div class="cmd-desc">${esc(cmd.description)}</div>` : ""}
      <div class="cmd-item-actions">
        <button class="fav-btn${cmd.favorite ? " on" : ""}" title="즐겨찾기">${cmd.favorite ? "★" : "☆"}</button>
        <button class="send-btn">Send</button>
        <button class="copy-btn">Copy</button>
        <button class="edit-btn">Edit</button>
        <button class="cmd-x" title="삭제 (바로 삭제)">&times;</button>
      </div>
    `;
    li.querySelector(".fav-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(cmd); });
    li.querySelector(".send-btn").addEventListener("click", (e) => { e.stopPropagation(); sendToTerminal(cmd.command); });
    li.querySelector(".copy-btn").addEventListener("click", (e) => { e.stopPropagation(); copyCmd(cmd); });
    li.querySelector(".edit-btn").addEventListener("click", (e) => { e.stopPropagation(); openModal(cmd); });
    li.querySelector(".cmd-x").addEventListener("click", (e) => { e.stopPropagation(); quickDeleteCmd(cmd); });
    li.addEventListener("dblclick", () => sendToTerminal(cmd.command));
    cmdListEl.appendChild(li);
  }
}

async function toggleFavorite(cmd) {
  try {
    await invoke("set_favorite", { id: cmd.id, favorite: !cmd.favorite });
    await loadCommands();
  } catch (e) {
    toast("Error: " + e, true);
  }
}

async function quickDeleteCmd(cmd) {
  try {
    await invoke("delete_command", { id: cmd.id });
    await loadCommands();
    toast("삭제됨");
  } catch (e) {
    toast("Error: " + e, true);
  }
}

// ── Modal ──
function openModal(cmd) {
  if (cmd) {
    modalTitle.textContent = "Edit Command";
    inputName.value = cmd.name;
    inputCommand.value = cmd.command;
    inputDesc.value = cmd.description || "";
    editingId = cmd.id;
  } else {
    modalTitle.textContent = "Add Command";
    form.reset();
    editingId = null;
  }
  // The native browser webview is a native overlay above all HTML, so it would
  // cover this modal — hide it while the modal is open.
  if (browserTabActive && browserMode === "native") invoke("browser_pane_hide").catch(() => {});
  modalOverlay.classList.remove("hidden");
  inputName.focus();
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  form.reset();
  editingId = null;
  if (browserTabActive && browserMode === "native") {
    invoke("browser_pane_show").catch(() => {});
    scheduleSync();
  }
}

async function handleSave(e) {
  e.preventDefault();
  const name = inputName.value.trim();
  const command = inputCommand.value.trim();
  const description = inputDesc.value.trim();
  if (!name || !command) return;
  try {
    if (editingId) {
      await invoke("update_command", { id: editingId, name, command, description });
      toast("Updated");
    } else {
      await invoke("add_command", { name, command, description });
      toast("Added");
    }
    closeModal();
    await loadCommands();
  } catch (err) { toast("Error: " + err, true); }
}

async function copyCmd(cmd) {
  try { await clipboardWrite(cmd.command); toast("Copied"); } catch { toast("Copied"); }
}

async function deleteCmd(cmd) {
  if (!confirm(`Delete "${cmd.name}"?`)) return;
  try {
    await invoke("delete_command", { id: cmd.id });
    toast("Deleted");
    await loadCommands();
  } catch (err) { toast("Error: " + err, true); }
}

// ── Helpers ──
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.style.background = isError ? "var(--red)" : "var(--accent)";
  toastEl.classList.remove("hidden");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.add("hidden"), 2500);
}

function formatSize(bytes) {
  if (bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

// Last path component, e.g. "E:\Project\MyCli" -> "MyCli".
function baseName(p) {
  if (!p) return "Terminal";
  const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

// ═══════════════════════════════════════════════
// AUTOCOMPLETE
// ═══════════════════════════════════════════════

function handleTerminalInput(data, ptyId) {
  // Track what user types to build current input line
  if (data === "\r" || data === "\n") {
    // Enter pressed — detect cd command and sync explorer
    syncExplorerOnCd(currentInput.trim(), ptyId);
    currentInput = "";
    hideAutocomplete();
    return;
  }

  if (data === "\x1b") {
    // Escape — hide autocomplete
    hideAutocomplete();
    return;
  }

  // Tab — accept selected autocomplete
  if (data === "\t") {
    if (!acPopup.classList.contains("hidden") && acSelectedIdx >= 0) {
      const items = acList.querySelectorAll(".ac-item");
      if (items[acSelectedIdx]) {
        const cmd = items[acSelectedIdx].dataset.command;
        // Clear current input and type the command
        const backspaces = "\x7f".repeat(currentInput.length);
        invoke("pty_write", { id: ptyId, data: backspaces });
        invoke("pty_write", { id: ptyId, data: cmd });
        currentInput = cmd;
        hideAutocomplete();
        // Prevent default tab from being sent
        return "consumed";
      }
    }
    return;
  }

  // Arrow keys in autocomplete
  if (data === "\x1b[A" || data === "\x1b[B") {
    if (!acPopup.classList.contains("hidden")) {
      const items = acList.querySelectorAll(".ac-item");
      if (items.length > 0) {
        if (data === "\x1b[A") acSelectedIdx = Math.max(0, acSelectedIdx - 1);
        else acSelectedIdx = Math.min(items.length - 1, acSelectedIdx + 1);
        items.forEach((el, i) => el.classList.toggle("selected", i === acSelectedIdx));
      }
      return;
    }
    return;
  }

  if (data === "\x7f" || data === "\b") {
    // Backspace
    currentInput = currentInput.slice(0, -1);
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    // Printable character
    currentInput += data;
  } else {
    // Control sequences — ignore for autocomplete tracking
    return;
  }

  // Show/update autocomplete
  if (currentInput.length >= 2) {
    showAutocomplete(currentInput, ptyId);
  } else {
    hideAutocomplete();
  }
}

function showAutocomplete(input, ptyId) {
  const lower = input.toLowerCase();
  const matches = savedCmds.filter(
    (c) =>
      c.name.toLowerCase().includes(lower) ||
      c.command.toLowerCase().includes(lower)
  );

  if (matches.length === 0) {
    hideAutocomplete();
    return;
  }

  acList.innerHTML = "";
  acSelectedIdx = 0;

  matches.slice(0, 8).forEach((cmd, i) => {
    const li = document.createElement("li");
    li.className = "ac-item" + (i === 0 ? " selected" : "");
    li.dataset.command = cmd.command;
    li.innerHTML = `
      <span class="ac-name">${esc(cmd.name)}</span>
      <span class="ac-cmd">${esc(cmd.command)}</span>
    `;
    li.addEventListener("click", () => {
      const backspaces = "\x7f".repeat(currentInput.length);
      invoke("pty_write", { id: ptyId, data: backspaces + cmd.command });
      currentInput = cmd.command;
      hideAutocomplete();
      terminals.get(ptyId)?.term.focus();
    });
    acList.appendChild(li);
  });

  // Position popup near the terminal cursor
  const t = terminals.get(ptyId);
  if (t && t.paneEl) {
    const termRect = t.paneEl.getBoundingClientRect();
    acPopup.style.left = (termRect.left + 20) + "px";
    acPopup.style.bottom = (window.innerHeight - termRect.bottom + 30) + "px";
    acPopup.style.top = "auto";
  }

  acPopup.classList.remove("hidden");
}

function hideAutocomplete() {
  acPopup.classList.add("hidden");
  acSelectedIdx = -1;
}

// ═══════════════════════════════════════════════
// EXPLORER SYNC — follow terminal cd
// ═══════════════════════════════════════════════

function syncExplorerOnCd(input, ptyId) {
  // Only sync if local terminal and local explorer mode
  if (currentSftpId) return;
  const tInfo = terminals.get(ptyId);
  if (!tInfo || tInfo.type === "ssh") return;

  // Only sync when there's a single pane in the active tab
  if (activeTabIdx == null) return;
  const tab = tabs.get(activeTabIdx);
  if (!tab || tab.panes.length !== 1) return;

  let targetPath = null;

  // Detect: cd path, cd /d path, pushd path
  const cdMatch = input.match(/^cd\s+\/d\s+(.+)$/i) || input.match(/^cd\s+(.+)$/i) || input.match(/^pushd\s+(.+)$/i);
  if (cdMatch) {
    targetPath = cdMatch[1].replace(/^["']|["']$/g, "").trim();
  }

  // Detect: drive letter (e.g., "E:", "D:")
  const driveMatch = input.match(/^([a-zA-Z]):[\\/]?$/);
  if (driveMatch) {
    targetPath = driveMatch[1] + ":\\";
  }

  // Detect: cd .. or cd .
  if (input === "cd ..") {
    const parent = currentExplorerPath.replace(/[\\/]+$/, "");
    const idx = Math.max(parent.lastIndexOf("\\"), parent.lastIndexOf("/"));
    if (idx > 0) targetPath = parent.substring(0, idx);
    else if (idx === 0) targetPath = "/";
    else targetPath = parent;
  }

  if (input === "cd" || input === "cd ~" || input === "cd $HOME" || input === "cd %USERPROFILE%") {
    // Go home
    invoke("explorer_home_dir").then((home) => {
      currentExplorerPath = home;
      loadExplorer();
    });
    return;
  }

  if (!targetPath) return;

  // Resolve relative paths
  if (!targetPath.match(/^[a-zA-Z]:/) && !targetPath.startsWith("/") && !targetPath.startsWith("\\")) {
    // Relative path — join with current explorer path
    targetPath = currentExplorerPath.replace(/[\\/]+$/, "") + "\\" + targetPath;
  }

  // Normalize
  targetPath = targetPath.replace(/\//g, "\\");

  // Delay slightly to let the cd command execute, then try to list
  setTimeout(async () => {
    try {
      await invoke("explorer_list_local", { path: targetPath });
      // Success — the path exists, update explorer
      currentExplorerPath = targetPath;
      loadExplorer();
    } catch {
      // Path doesn't exist or error, don't update
    }
  }, 300);
}
