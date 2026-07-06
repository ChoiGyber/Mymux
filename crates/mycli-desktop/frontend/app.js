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

// Paste into a terminal pane (Ctrl+V / Shift+Insert / right-click). An image on
// the clipboard (e.g. a screenshot) is saved to a temp PNG and its path is typed
// in, so Ctrl+V drops an attachable file path for the running tool (Claude Code
// / Codex). Falls back to clipboard text when there's no image.
// Text must go through term.paste(), not straight to the PTY: xterm wraps it in
// bracketed-paste markers when the app enabled that mode (bash/vim/Claude Code —
// without them each pasted line executes immediately) and normalizes \r\n to \r.
async function pasteIntoPane(id) {
  const entry = terminals.get(id);
  const feed = (text) => {
    if (entry && entry.term) entry.term.paste(text);
    else invoke("pty_write", { id, data: text });
  };
  try {
    const imgPath = await invoke("paste_clipboard_image");
    if (imgPath) { feed(imgPath); return; }
  } catch {}
  try {
    const clip = window.__TAURI_PLUGIN_CLIPBOARD_MANAGER__;
    if (clip && clip.readText) {
      const text = await clip.readText();
      if (text) feed(text);
    }
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
let draggingPaneId = null;
let tabCounter = 0;
let browserTabActive = false;
let cdpWs = null;
let cdpMsgId = 0;
let lastFrameMeta = null;
let screenInputBound = false;
let browserMode = "native"; // 'native' (embedded WebView) | 'ai' (CDP screencast)
let nativeCurrentUrl = "https://www.google.com";
let paneSyncPending = false;
let terminalFontSize = (function () {
  try {
    const v = parseInt(localStorage.getItem("mymux.termFontSize"), 10);
    if (Number.isInteger(v) && v >= 8 && v <= 40) return v;
  } catch {}
  return 14;
})();
// Letter spacing (자간) as a ratio of the font size — adjustable from the toolbar
// (자−/자+) and persisted. 0 = none; default ≈0.1 (~20% of a cell) because Korean/
// CJK glyphs look cramped at 0.
let letterSpacingRatio = (function () {
  try {
    const v = parseFloat(localStorage.getItem("mymux.termLetterSpacing"));
    if (Number.isFinite(v) && v >= 0 && v <= 0.4) return v;
  } catch {}
  return 0.1;
})();
let savedCmds = [];
let currentInput = "";
let acSelectedIdx = -1;
let currentExplorerPath = "";
let currentSftpId = null;
// Explorer directory history (Chrome-style back/forward). Each entry is
// { path, sftpId }; explorerHistIdx points at the currently-shown entry.
let explorerHistory = [];
let explorerHistIdx = -1;
// Explorer file clipboard for copy/cut → paste into another folder (local only).
let fileClipboard = null; // { path, name, mode: 'copy' | 'cut' }
let explorerCtxEntry = null;
let explorerEntries = []; // current dir listing (for in-folder name search)

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
    await explorerGo(home, null);
    await loadDrives();
    renderExplorerFavorites();
  } catch (e) {
    console.error("Init error:", e);
  }
  await setupListeners();
  restorePanelState();
  initBrowserPanel();
  applyBrowserEnabled();

  // Preload the embedded D2Coding font so terminals measure the correct cell
  // size (fixed-width Korean). Once fonts finish, re-measure every open pane's
  // cell grid. NOTE: this microtask runs BEFORE restoreSession() below creates
  // the first session, so that session misses this pass — it's re-measured
  // again explicitly after restore (see the settle pass further down).
  try { await document.fonts.load('1em "D2Coding"'); } catch {}
  document.fonts.ready.then(() => remeasureFontCells());

  // Restore the previous session if one was saved; otherwise open a default terminal.
  try {
    const restored = await restoreSession();
    if (!restored) await maybeShowStartupGuide();
  } catch (e) {
    console.error("Session restore error:", e);
    try { await spawnTerminal(); } catch {}
  }

  // Panes opened during restore/startup are sized before the container layout
  // AND the embedded font have settled. That leaves the first session fitted to
  // a stale cell metric — the prompt cursor lands left of the "$" — and possibly
  // 0 rows. fonts.ready already fired before restore created the pane, so the
  // pane missed it; re-measure cells (not just refit) once layout settles.
  requestAnimationFrame(() => requestAnimationFrame(() => remeasureFontCells()));
  setTimeout(() => remeasureFontCells(), 150);

  startFocusKeeper();
  setupSessionResizer();
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

  btnToggleSidebar.addEventListener("click", () => { sidebar.classList.toggle("collapsed"); persistPanelState(); updatePanelToggleIcons(); });
  btnToggleSessions.addEventListener("click", () => { sessionPanel.classList.toggle("collapsed"); persistPanelState(); updatePanelToggleIcons(); });

  // GitHub shortcut (session panel footer) → open the repo in the OS default browser.
  const btnGithub = document.getElementById("btn-github");
  if (btnGithub) {
    btnGithub.addEventListener("click", () =>
      invoke("open_external", { path: "https://github.com/ChoiGyber/Mymux" }).catch((e) => toast(String(e), true)));
  }
  // Current app version tag inside the GitHub button.
  const versionEl = document.getElementById("app-version");
  if (versionEl && window.__TAURI__.app && window.__TAURI__.app.getVersion) {
    window.__TAURI__.app.getVersion().then((v) => { versionEl.textContent = "v" + v; }).catch(() => {});
  }
  btnSplitH.addEventListener("click", () => splitPane("horizontal"));
  btnSplitV.addEventListener("click", () => splitPane("vertical"));

  // Theme controls
  btnTheme.addEventListener("click", () => setTheme(currentThemeMode() === "dark" ? "light" : "dark"));
  document.querySelectorAll(".accent-swatch").forEach((sw) => {
    sw.addEventListener("click", () => setAccent(sw.dataset.accent));
  });
  btnNewTerminal.addEventListener("click", () => spawnTerminal());

  // "+ SSH" — open a new SSH connection anytime (works with sessions open).
  const btnSsh = document.getElementById("btn-ssh");
  if (btnSsh) btnSsh.addEventListener("click", openSshModal);
  const sshModalEl = document.getElementById("ssh-modal");
  const sshModalConnect = document.getElementById("ssh-modal-connect");
  const sshModalCancel = document.getElementById("ssh-modal-cancel");
  if (sshModalCancel) sshModalCancel.addEventListener("click", closeSshModal);
  if (sshModalConnect) sshModalConnect.addEventListener("click", submitSshModal);
  const sshSaveCmd = document.getElementById("ssh-save-cmd");
  if (sshSaveCmd) sshSaveCmd.addEventListener("click", saveSshAsCommand);
  const sshAddrToggle = document.getElementById("ssh-addr-toggle");
  if (sshAddrToggle) sshAddrToggle.addEventListener("click", (e) => { e.stopPropagation(); toggleSshDropdown(); });
  const sshKeyPick = document.getElementById("ssh-key-pick");
  if (sshKeyPick) sshKeyPick.addEventListener("click", pickSshKeyFile);
  const sshTmuxChk = document.getElementById("ssh-tmux");
  const sshTmuxNameInput = document.getElementById("ssh-tmux-name");
  if (sshTmuxChk && sshTmuxNameInput) {
    sshTmuxChk.addEventListener("change", () => { sshTmuxNameInput.style.display = sshTmuxChk.checked ? "" : "none"; });
  }
  const sshAddrInput = document.getElementById("ssh-modal-input");
  if (sshAddrInput) sshAddrInput.addEventListener("input", () => toggleSshDropdown(false));
  if (sshModalEl) {
    sshModalEl.addEventListener("click", (e) => {
      if (e.target === sshModalEl) { closeSshModal(); return; }
      // Click elsewhere in the modal closes the address dropdown.
      if (!e.target.closest("#ssh-addr-list")) toggleSshDropdown(false);
    });
    sshModalEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitSshModal();
      else if (e.key === "Escape") closeSshModal();
    });
  }

  const shellSel = document.getElementById("default-shell");
  if (shellSel) {
    try { shellSel.value = localStorage.getItem("mymux.defaultShell") || "powershell"; } catch {}
    shellSel.addEventListener("change", () => {
      try { localStorage.setItem("mymux.defaultShell", shellSel.value); } catch {}
      toast("Default shell: " + shellSel.options[shellSel.selectedIndex].text + " (applies to new terminals)");
    });
  }
  btnAdd.addEventListener("click", () => openModal());
  const cmdSearch = document.getElementById("cmd-search");
  if (cmdSearch) cmdSearch.addEventListener("input", () => renderCmdList(savedCmds));
  wireSearchClear(cmdSearch);
  btnCancel.addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
  form.addEventListener("submit", handleSave);

  // Explorer
  btnExplorerUp.addEventListener("click", goUp);
  explorerMode.addEventListener("change", onExplorerModeChange);
  const expSearch = document.getElementById("explorer-search");
  if (expSearch) expSearch.addEventListener("input", () => renderFileList(explorerEntries));
  wireSearchClear(expSearch);
  const btnExpBack = document.getElementById("btn-explorer-back");
  const btnExpFwd = document.getElementById("btn-explorer-forward");
  if (btnExpBack) btnExpBack.addEventListener("click", explorerBack);
  if (btnExpFwd) btnExpFwd.addEventListener("click", explorerForward);

  // Mouse "back"(3) / "forward"(4) special buttons — navigate directory
  // history just like Chrome's back/forward. When the native browser panel is
  // the active surface, defer to its own page history instead.
  window.addEventListener("mousedown", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (browserTabActive) {
      invoke(e.button === 3 ? "browser_pane_back" : "browser_pane_forward").catch(() => {});
    } else if (e.button === 3) {
      explorerBack();
    } else {
      explorerForward();
    }
  });

  // Shell buttons
  document.querySelectorAll(".shell-btn").forEach((btn) => {
    btn.addEventListener("click", () => spawnTerminal(btn.dataset.shell || undefined));
  });

  // SSH
  btnSshConnect.addEventListener("click", connectSsh);
  sshInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connectSsh(); });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    cancelFocusReturnRetries(); // a keystroke proves focus is alive → stop post-return re-focus thrash
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
    // Ctrl+Shift+F — search the focused pane's scrollback. Also match e.code:
    // with the Korean IME active e.key never arrives as the Latin letter.
    if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.code === "KeyF")) {
      e.preventDefault();
      openTermSearch();
    }
    // Ctrl+Shift+Z — maximize / restore the focused pane (tmux zoom)
    if (e.ctrlKey && e.shiftKey && (e.key === "Z" || e.code === "KeyZ")) {
      e.preventDefault();
      togglePaneZoom();
    }
    // Ctrl+Shift+B — broadcast typing to every pane in this tab
    if (e.ctrlKey && e.shiftKey && (e.key === "B" || e.code === "KeyB")) {
      e.preventDefault();
      toggleBroadcast();
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

  // PTY polling loop — reads output from all terminals. Self-scheduling (NOT
  // setInterval): setInterval never awaits its async callback, so when a tick
  // runs long — many sessions × IPC, or a heavy output burst like a large paste
  // — the next tick starts before the previous finishes and overlapping loops
  // pile up, multiplying IPC/render work and tanking throughput (paste crawls,
  // input lags). Here each tick reads every terminal in PARALLEL and only
  // re-arms once done, so there's never more than one pass in flight.
  const pumpTerminals = async () => {
    try {
      await Promise.all([...terminals].map(async ([id, t]) => {
        try {
          const [chunks, exited] = await invoke("pty_read", { id });
          if (chunks.length) {
            t.term.write(chunks.join("")); // one write, not per-chunk
            markPaneActivity(id, t); // unseen badge when this pane is hidden
            trackOutputSilence(id, t); // flash when sustained output goes quiet
          } else if (exited) closeTerminal(id);
        } catch {}
      }));
    } finally {
      setTimeout(pumpTerminals, 16); // ~60fps cadence, but never overlapping
    }
  };
  pumpTerminals();

  // Resize — refit all visible panes. Debounced (coalesced to one animation
  // frame) so a ResizeObserver burst doesn't reflow every pane repeatedly.
  let refitPending = false;
  new ResizeObserver(() => {
    if (refitPending) return;
    refitPending = true;
    requestAnimationFrame(() => { refitPending = false; refitAllPanes(); });
  }).observe(terminalContainer);

  // Explorer: type a path + Enter to jump there.
  const gotoEl = document.getElementById("explorer-goto");
  if (gotoEl) {
    gotoEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const p = gotoEl.value.trim();
        if (p) navigateTo(p);
      }
    });
  }

  // Browser feature on/off toggle (top bar 🌐).
  const btnBrowser = document.getElementById("btn-toggle-browser");
  if (btnBrowser) btnBrowser.addEventListener("click", toggleBrowserEnabled);

  // Scrollback search bar (Ctrl+Shift+F) + per-tab input broadcast (Ctrl+Shift+B).
  initTermSearch();
  const btnBroadcast = document.getElementById("btn-broadcast");
  if (btnBroadcast) btnBroadcast.addEventListener("click", toggleBroadcast);
  // Command palette (Ctrl+Shift+P).
  initCommandPalette();
  // Keyboard shortcuts help modal (toolbar ⌨ button).
  initShortcutsHelp();

  // Terminal text zoom (top bar A−/A+) — same effect as Ctrl -/+.
  const btnFontDec = document.getElementById("btn-font-dec");
  if (btnFontDec) btnFontDec.addEventListener("click", () => adjustTerminalFontSize(-1));
  const btnFontInc = document.getElementById("btn-font-inc");
  if (btnFontInc) btnFontInc.addEventListener("click", () => adjustTerminalFontSize(1));

  // Letter spacing (top bar 자−/자+) — adjust the persisted 자간 ratio live.
  const btnTrackDec = document.getElementById("btn-track-dec");
  if (btnTrackDec) btnTrackDec.addEventListener("click", () => adjustLetterSpacing(-0.025));
  const btnTrackInc = document.getElementById("btn-track-inc");
  if (btnTrackInc) btnTrackInc.addEventListener("click", () => adjustLetterSpacing(0.025));

  // File viewer close button.
  const vClose = document.getElementById("viewer-close");
  if (vClose) vClose.addEventListener("click", closeViewer);

  // Viewer/editor header tools.
  const vEdit = document.getElementById("viewer-edit-toggle");
  if (vEdit) vEdit.addEventListener("click", toggleEditMode);
  const vSave = document.getElementById("viewer-save-btn");
  if (vSave) vSave.addEventListener("click", () => saveViewerFile(activeViewerFileObj()));
  const vFind = document.getElementById("viewer-find-btn");
  if (vFind) vFind.addEventListener("click", () => {
    const ed = document.querySelector("#viewer-body .editor");
    if (ed) toggleFindBar(ed);
  });
  const vAuto = document.getElementById("viewer-autosave");
  if (vAuto) vAuto.addEventListener("change", () => {
    try { localStorage.setItem("mymux.autosave", vAuto.checked ? "true" : "false"); } catch {}
    if (vAuto.checked) { const f = activeViewerFileObj(); if (f && f.dirty) saveViewerFile(f); }
  });

  // Route in-app links (markdown/HTML viewer): web → embedded browser,
  // local file/folder → Explorer / viewer. Delegated so it survives re-renders.
  const vBody = document.getElementById("viewer-body");
  if (vBody) {
    vBody.addEventListener("click", onViewerLinkClick);
    vBody.addEventListener("contextmenu", onViewerContextMenu);
  }
  const vctx = document.getElementById("viewer-ctx");
  if (vctx) {
    vctx.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (btn) handleViewerCtxAction(btn.dataset.act);
      hideViewerCtx();
    });
  }
  document.addEventListener("click", hideViewerCtx);
  document.addEventListener("scroll", hideViewerCtx, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideViewerCtx(); });

  // Explorer right-click file operations (copy/cut/paste/copy-path).
  if (fileListEl) fileListEl.addEventListener("contextmenu", onExplorerContextMenu);
  document.addEventListener("click", hideExplorerCtx);
  document.addEventListener("scroll", hideExplorerCtx, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideExplorerCtx(); });
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
    explorerEntries = entries;
    renderFileList(entries);
  } catch (err) {
    fileListEl.innerHTML = `<li style="padding:10px;color:var(--red);font-size:12px;">${esc(String(err))}</li>`;
  }
}

function renderFileList(entries) {
  fileListEl.innerHTML = "";
  const q = (document.getElementById("explorer-search")?.value || "").trim().toLowerCase();
  for (const entry of entries) {
    // Skip hidden files starting with .
    if (entry.name.startsWith(".")) continue;
    if (q && !entry.name.toLowerCase().includes(q)) continue;

    const li = document.createElement("li");
    li.className = "file-item";

    const iconClass = entry.is_dir ? "dir" : entry.is_symlink ? "link" : "file";
    const icon = entry.is_dir ? "\u{1F4C1}" : entry.is_symlink ? "\u{1F517}" : "\u{1F4C4}";
    const nameClass = entry.is_dir ? "dir" : "file";
    const size = entry.is_dir ? "" : formatSize(entry.size);

    const favOn = entry.is_dir && isExplorerFav(entry.path);
    li.innerHTML = `
      <span class="file-icon ${iconClass}">${icon}</span>
      <span class="file-name ${nameClass}">${esc(entry.name)}</span>
      <span class="file-size">${size}</span>
      <span class="file-item-actions">
        ${entry.is_dir ? `<button class="fav-btn${favOn ? " on" : ""}" title="Favorite">${favOn ? "★" : "☆"}</button>` : ""}
        <button class="cd-btn" title="Open a new terminal here">cd</button>
      </span>
    `;

    li._entry = entry; // for the right-click file-ops menu
    if (entry.is_dir) {
      // Single click enters the folder.
      li.addEventListener("click", () => navigateTo(entry.path));
    } else {
      // Double click opens the file in the viewer tab (single click just selects).
      li.addEventListener("dblclick", () => openFileViewer(entry));
    }

    const favBtnEl = li.querySelector(".fav-btn");
    if (favBtnEl) {
      favBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleExplorerFav(entry.path, entry.name);
      });
    }

    li.querySelector(".cd-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      cdToTerminal(entry.is_dir ? entry.path : currentExplorerPath);
    });

    fileListEl.appendChild(li);
  }
}

function navigateTo(path) {
  explorerGo(path);
}

// ── Explorer right-click file operations (local only) ──
function onExplorerContextMenu(e) {
  const li = e.target.closest(".file-item");
  const entry = li ? li._entry : null;
  const menu = document.getElementById("explorer-ctx");
  if (!menu) return;
  e.preventDefault();
  explorerCtxEntry = entry;
  const local = currentSftpId == null;
  const items = [];
  if (entry) {
    if (local) {
      items.push({ act: "copy", label: "Copy" });
      items.push({ act: "cut", label: "Cut" });
    }
    items.push({ act: "copypath", label: "Copy path" });
  }
  if (local) items.push({ act: "paste", label: "Paste", disabled: !(fileClipboard && fileClipboard.path) });
  if (!items.length) return;
  menu.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label + (it.act === "paste" && fileClipboard ? `  (${fileClipboard.name})` : "");
    if (it.disabled) b.disabled = true;
    else b.addEventListener("click", () => { hideExplorerCtx(); handleExplorerCtxAction(it.act); });
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - h - 8) + "px";
}

function hideExplorerCtx() {
  const m = document.getElementById("explorer-ctx");
  if (m) m.classList.add("hidden");
}

async function handleExplorerCtxAction(act) {
  const entry = explorerCtxEntry;
  if (act === "copy" && entry) {
    fileClipboard = { path: entry.path, name: entry.name, mode: "copy" };
    toast("Copied: " + entry.name);
  } else if (act === "cut" && entry) {
    fileClipboard = { path: entry.path, name: entry.name, mode: "cut" };
    toast("Cut: " + entry.name);
  } else if (act === "copypath" && entry) {
    clipboardWrite(entry.path);
    toast("Path copied");
  } else if (act === "paste") {
    await filePaste();
  }
}

async function filePaste() {
  if (!fileClipboard || currentSftpId != null) return;
  try {
    if (fileClipboard.mode === "copy") {
      await invoke("fs_copy_path", { src: fileClipboard.path, destDir: currentExplorerPath });
    } else {
      await invoke("fs_move_path", { src: fileClipboard.path, destDir: currentExplorerPath });
      fileClipboard = null; // moved — clear so it isn't pasted again
    }
    toast("Pasted");
    loadExplorer();
  } catch (e) {
    toast(String(e), true);
  }
}

// Central explorer navigation. Records into history unless `record` is false
// (back/forward replays). `sftpId` defaults to the current source so plain
// folder clicks keep whichever mode (local PC / SFTP) is active.
function explorerGo(path, sftpId = currentSftpId, record = true) {
  currentSftpId = sftpId == null ? null : sftpId;
  currentExplorerPath = path;
  if (record) {
    const cur = explorerHistory[explorerHistIdx];
    if (!cur || cur.path !== path || cur.sftpId !== currentSftpId) {
      explorerHistory = explorerHistory.slice(0, explorerHistIdx + 1);
      explorerHistory.push({ path, sftpId: currentSftpId });
      explorerHistIdx = explorerHistory.length - 1;
    }
  }
  syncExplorerNav();
  return loadExplorer();
}

function explorerBack() {
  if (explorerHistIdx <= 0) return;
  const e = explorerHistory[--explorerHistIdx];
  explorerGo(e.path, e.sftpId, false);
}

function explorerForward() {
  if (explorerHistIdx >= explorerHistory.length - 1) return;
  const e = explorerHistory[++explorerHistIdx];
  explorerGo(e.path, e.sftpId, false);
}

// Enable/disable the back/forward buttons and keep the source dropdown in sync.
function syncExplorerNav() {
  const back = document.getElementById("btn-explorer-back");
  const fwd = document.getElementById("btn-explorer-forward");
  if (back) back.disabled = explorerHistIdx <= 0;
  if (fwd) fwd.disabled = explorerHistIdx >= explorerHistory.length - 1;
  if (explorerMode) {
    const want = currentSftpId == null ? "local" : String(currentSftpId);
    if (explorerMode.value !== want && [...explorerMode.options].some((o) => o.value === want)) {
      explorerMode.value = want;
    }
  }
}

// ── File viewer (markdown / text) — open a clicked file in a tab ──
let viewerActive = false;
let viewerDir = ""; // directory of the file currently shown — base for relative links
let viewerFiles = []; // open files as tabs: [{ id, path, name, ext, content }]
let activeViewerId = null;
let viewerFileSeq = 0;

const VIEWER_TEXT_EXTS = new Set([
  "md","markdown","txt","log","json","js","ts","jsx","tsx","rs","py","go","java","c","cpp","h","hpp",
  "cs","rb","php","sh","bash","zsh","ps1","bat","cmd","yml","yaml","toml","ini","cfg","conf","xml",
  "html","htm","css","scss","sql","csv","env","lock","mjs","cjs",
]);

// Minimal, safe Markdown → HTML (escapes text first, then applies transforms).
function renderMarkdown(src) {
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t) => {
    t = escHtml(t);
    t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
      // txt/url are already &<>-escaped by escHtml above. Also escape quotes
      // for the attribute context. Allow http(s)/mailto, anchors, and local
      // file paths (relative or Windows-absolute); block other schemes like
      // javascript:/data: by collapsing them to "#".
      const winAbs = /^[a-z]:[\\/]/i.test(url);
      const scheme = !winAbs && /^[a-z][a-z0-9+.-]*:/i.test(url);
      const ok = !scheme || /^(https?:|mailto:)/i.test(url);
      const href = ok ? url.replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "#";
      return `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`;
    });
    return t;
  };
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0, inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```/);
    if (fence) {
      closeList(); i++; let code = "";
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code += lines[i] + "\n"; i++; }
      i++;
      html += `<pre><code>${escHtml(code)}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); html += "<hr/>"; i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { closeList(); html += `<blockquote>${inline(bq[1])}</blockquote>`; i++; continue; }
    const li = line.match(/^\s*[-*+]\s+(.*)$/) || line.match(/^\s*\d+\.\s+(.*)$/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; i++; continue; }
    if (line.trim() === "") { closeList(); i++; continue; }
    closeList(); html += `<p>${inline(line)}</p>`; i++;
  }
  closeList();
  return html;
}

function ensureViewerTab() {
  let tab = document.getElementById("viewer-tab");
  if (!tab) {
    tab = document.createElement("div");
    tab.className = "browser-tab"; // reuse the pinned-tab styling
    tab.id = "viewer-tab";
    tab.innerHTML = `<span>📄</span><span>Viewer</span><span class="tab-close" title="Close">&times;</span>`;
    tab.title = "File viewer";
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) { closeViewer(); return; }
      setViewerView(true);
    });
    terminalTabs.prepend(tab);
  }
  return tab;
}

function setViewerView(on) {
  viewerActive = on;
  const panel = document.getElementById("viewer-panel");
  const tab = document.getElementById("viewer-tab");
  if (on) {
    if (browserTabActive) setBrowserView(false);
    panel.classList.remove("hidden");
    terminalContainer.style.display = "none";
    terminalWelcome.style.display = "none";
    terminalTabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    if (tab) tab.classList.add("active");
  } else {
    panel.classList.add("hidden");
    terminalContainer.style.display = "";
    if (tab) tab.classList.remove("active");
  }
}

function closeViewer() {
  setViewerView(false);
  const tab = document.getElementById("viewer-tab");
  if (tab) tab.remove();
  viewerFiles = [];
  activeViewerId = null;
}

// ── File-viewer right-click menu: copy the selection, or send it to the
//    active terminal session. Appears only when text is selected. ──
let viewerCtxSelection = "";

function onViewerContextMenu(e) {
  const sel = (window.getSelection && window.getSelection().toString()) || "";
  if (!sel.trim()) return; // no selection → leave the default behavior alone
  e.preventDefault();
  viewerCtxSelection = sel;
  const m = document.getElementById("viewer-ctx");
  if (!m) return;
  m.classList.remove("hidden");
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - w - 8)) + "px";
  m.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - h - 8)) + "px";
}

function hideViewerCtx() {
  const m = document.getElementById("viewer-ctx");
  if (m) m.classList.add("hidden");
}

function handleViewerCtxAction(act) {
  const text = viewerCtxSelection;
  if (!text) return;
  if (act === "copy") {
    clipboardWrite(text);
    toast("Copied");
  } else if (act === "send") {
    if (!activeTermId) { toast("No open sessions.", true); return; }
    invoke("pty_write", { id: activeTermId, data: text }); // no trailing Enter — user reviews then runs
    terminals.get(activeTermId)?.term.focus();
    toast("Sent to session");
  }
}

// ── In-app link routing (markdown/HTML viewer) ──
// Web links open in the embedded Native browser; local file/folder links open
// in the sidebar Explorer (folders) or the file viewer (files).
function onViewerLinkClick(e) {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  if (href.startsWith("#")) return; // in-page anchor — let it scroll
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) { openInNativeBrowser(href); return; }
  if (/^\/\//.test(href)) { openInNativeBrowser("https:" + href); return; }
  if (/^mailto:/i.test(href)) { invoke("open_external", { path: href }).catch(() => {}); return; }
  // Windows-absolute path (C:\..) — a local path, NOT a URI scheme. Route to the
  // local opener (which never executes non-viewable files) instead of letting it
  // fall through to a "C:" scheme that would reach open_external.
  if (/^[a-z]:[\\/]/i.test(href)) {
    let t = href.split("#")[0].split("?")[0].replace(/\//g, "\\");
    try { t = decodeURIComponent(t); } catch {}
    openLocalLink(t);
    return;
  }
  // Any other explicit URI scheme (file:, javascript:, custom protocols, …) is
  // not allowed from a document link — drop it. (open_external would launch
  // protocol handlers / local programs.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  // Otherwise: a relative local file/folder path.
  let target = href.split("#")[0].split("?")[0];
  try { target = decodeURIComponent(target); } catch {}
  if (!target) return;
  openLocalLink(resolveLocalPath(viewerDir, target));
}

// Open a web URL in the embedded Native browser panel (not the OS browser).
function openInNativeBrowser(url) {
  if (!browserEnabled()) {
    try { localStorage.setItem("mymux.browserEnabled", "true"); } catch {}
    applyBrowserEnabled();
  }
  if (browserMode !== "native") setBrowserMode("native");
  nativeCurrentUrl = url; // so a first-time pane open lands directly on this URL
  const navUrl = document.getElementById("nav-url");
  if (navUrl) navUrl.value = url;
  setBrowserView(true);
  setTimeout(() => nativeNavigate(url), 80);
}

// Open a local path: folders reveal in the Explorer, files open in the viewer.
async function openLocalLink(target) {
  activateSidebarTab("explorer");
  try {
    await invoke("explorer_list_local", { path: target });
    explorerGo(target, null); // it's a directory
    return;
  } catch {}
  // It's a file. Point the Explorer at its folder. Only open VIEWABLE files in
  // the viewer — never pass an arbitrary local path to open_external, which would
  // LAUNCH executables (.exe/.bat/.msi/…) straight from a clicked document link.
  const dir = dirOf(target);
  if (dir && dir !== currentExplorerPath) {
    try { await invoke("explorer_list_local", { path: dir }); explorerGo(dir, null); } catch {}
  }
  const name = baseName(target);
  const ext = fileExt(name);
  const lower = name.toLowerCase();
  const viewable = VIEWER_TEXT_EXTS.has(ext) || lower === "dockerfile" || lower.endsWith(".gitignore") || ext === "";
  if (viewable) {
    openFileViewer({ path: target, name, is_dir: false, is_symlink: false, size: 0 });
  } else {
    toast("Opened in Explorer: " + name);
  }
}

function activateSidebarTab(name) {
  const tab = document.querySelector(`.sidebar-tab[data-tab="${name}"]`);
  if (tab) tab.click();
  if (sidebar && sidebar.classList.contains("collapsed")) {
    sidebar.classList.remove("collapsed");
    persistPanelState();
    updatePanelToggleIcons();
  }
}

// Panel collapse state — persisted like the session, restored on launch.
function persistPanelState() {
  try {
    localStorage.setItem("mymux.sidebarCollapsed", sidebar.classList.contains("collapsed") ? "true" : "false");
    localStorage.setItem("mymux.sessionCollapsed", sessionPanel.classList.contains("collapsed") ? "true" : "false");
  } catch {}
}

function restorePanelState() {
  try {
    if (localStorage.getItem("mymux.sidebarCollapsed") === "true") sidebar.classList.add("collapsed");
    if (localStorage.getItem("mymux.sessionCollapsed") === "true") sessionPanel.classList.add("collapsed");
  } catch {}
  updatePanelToggleIcons();
}

// Keep the (split-square) SVG icon; just refresh the tooltip for the state.
function updatePanelToggleIcons() {
  const sb = document.getElementById("btn-toggle-sidebar");
  const sp = document.getElementById("btn-toggle-sessions");
  if (sb) sb.title = sidebar.classList.contains("collapsed") ? "Expand sidebar" : "Collapse sidebar";
  if (sp) sp.title = sessionPanel.classList.contains("collapsed") ? "Expand session panel" : "Collapse session panel";
}

// ── Local path helpers (Windows-first; tolerate / and \) ──
function dirOf(p) {
  if (!p) return "";
  const s = String(p).replace(/[\\/]+$/, "");
  const idx = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (idx < 0) return "";
  let d = s.slice(0, idx);
  if (/^[A-Za-z]:$/.test(d)) d += "\\"; // drive root → "E:\"
  else if (d === "") d = "/";           // POSIX root
  return d;
}

// Resolve `rel` against `base`, collapsing . and .. segments.
function resolveLocalPath(base, rel) {
  rel = String(rel || "");
  if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    return rel.replace(/\//g, "\\"); // already absolute
  }
  const combined = (String(base || "").replace(/[\\/]+$/, "") + "\\" + rel).replace(/\//g, "\\");
  const drive = /^[A-Za-z]:/.test(combined) ? combined.slice(0, 2) : "";
  let rest = drive ? combined.slice(2) : combined;
  const leading = rest.startsWith("\\") ? "\\" : "";
  const out = [];
  for (const part of rest.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return drive + leading + out.join("\\");
}

function fileExt(name) {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// ── Multi-file viewer: each opened file becomes a tab; the active one renders. ──
async function openFileViewer(entry) {
  const ext = fileExt(entry.name);
  const lower = entry.name.toLowerCase();
  const isText = VIEWER_TEXT_EXTS.has(ext) || lower === "dockerfile" || lower.endsWith(".gitignore") || ext === "";
  const sftpId = currentSftpId; // when set, the entry is remote — read over SFTP
  if (!isText) {
    if (sftpId != null) { toast("Preview isn't supported for remote binary files.", true); return; }
    invoke("open_external", { path: entry.path }).catch((e) => toast(String(e), true));
    return;
  }
  // Already open → just focus its tab (don't re-read).
  const existing = viewerFiles.find((f) => f.path === entry.path);
  if (existing) {
    activeViewerId = existing.id;
    renderViewerTabs();
    renderViewerBody(existing);
    ensureViewerTab();
    setViewerView(true);
    return;
  }
  let content;
  try {
    content = sftpId != null
      ? await invoke("sftp_read_text_file", { sessionId: sftpId, path: entry.path })
      : await invoke("read_text_file", { path: entry.path });
  } catch (e) {
    if (String(e).includes("BINARY")) {
      if (sftpId != null) { toast("Preview isn't supported for binary files.", true); return; }
      invoke("open_external", { path: entry.path }).catch(() => {});
      return;
    }
    toast(String(e), true);
    return;
  }
  const file = {
    id: ++viewerFileSeq, path: entry.path, name: entry.name, ext, content,
    sftpId: sftpId, // null for local, else the remote SFTP session (for saving back)
    dirty: false,
    // Code/text open straight into the editor; md/html open as a preview first.
    editing: !(ext === "md" || ext === "markdown" || ext === "html" || ext === "htm"),
  };
  viewerFiles.push(file);
  activeViewerId = file.id;
  renderViewerTabs();
  renderViewerBody(file);
  ensureViewerTab();
  setViewerView(true);
}

// Render the active file's content into the viewer body (editor or preview).
function renderViewerBody(file) {
  viewerDir = dirOf(file.path);
  const body = document.getElementById("viewer-body");
  const isHtml = file.ext === "html" || file.ext === "htm";
  const isMd = file.ext === "md" || file.ext === "markdown";
  if (file.editing) {
    body.className = "viewer-body editor-wrap";
    body.innerHTML = "";
    body.appendChild(buildEditor(file));
  } else if (isHtml) {
    // Render HTML in an isolated, sandboxed iframe — an in-app browser preview.
    body.className = "viewer-body html";
    body.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "viewer-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-modals");
    frame.srcdoc = file.content;
    body.appendChild(frame);
  } else if (isMd) {
    body.className = "viewer-body markdown";
    body.innerHTML = renderMarkdown(file.content);
  } else {
    body.className = "viewer-body";
    const pre = document.createElement("pre");
    pre.textContent = file.content;
    body.innerHTML = "";
    body.appendChild(pre);
  }
  renderViewerTools();
}

// ── In-app editor: textarea + line-number gutter + find/replace + go-to-line ──
let autosaveTimer = null;

function autosaveEnabled() {
  try { return localStorage.getItem("mymux.autosave") === "true"; } catch { return false; }
}

// Wire a search input's × clear button: show the × only when there is text,
// and clear + refocus + re-run the input handler when it is clicked.
function wireSearchClear(input) {
  if (!input) return;
  const wrap = input.closest(".search-wrap");
  if (!wrap) return;
  const btn = wrap.querySelector(".search-clear");
  const sync = () => wrap.classList.toggle("has-text", input.value.length > 0);
  input.addEventListener("input", sync);
  if (btn) {
    btn.addEventListener("click", () => {
      input.value = "";
      sync();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  }
  sync();
}

function buildEditor(file) {
  const wrap = document.createElement("div");
  wrap.className = "editor";
  wrap.innerHTML = `
    <div class="editor-find hidden">
      <input class="ef-find" placeholder="Find" spellcheck="false" />
      <button class="ef-prev" title="Previous">↑</button>
      <button class="ef-next" title="Next">↓</button>
      <input class="ef-replace" placeholder="Replace" spellcheck="false" />
      <button class="ef-rep">Replace</button>
      <button class="ef-repall">All</button>
      <span class="ef-sep">Line</span>
      <input class="ef-goto" type="number" min="1" title="Line number" />
      <button class="ef-go">Go</button>
      <button class="ef-close" title="Close">&times;</button>
    </div>
    <div class="editor-main">
      <div class="editor-gutter"></div>
      <textarea class="editor-area" spellcheck="false" wrap="off"></textarea>
    </div>`;
  const ta = wrap.querySelector(".editor-area");
  const gutter = wrap.querySelector(".editor-gutter");
  ta.value = file.content;
  const refreshGutter = () => {
    const lines = ta.value.split("\n").length;
    let s = "";
    for (let i = 1; i <= lines; i++) s += i + "\n";
    gutter.textContent = s;
    gutter.scrollTop = ta.scrollTop;
  };
  refreshGutter();
  ta.addEventListener("input", () => {
    file.content = ta.value;
    if (!file.dirty) { file.dirty = true; renderViewerTabs(); renderViewerTools(); }
    refreshGutter();
    if (autosaveEnabled()) {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveViewerFile(file), 1000);
    }
  });
  ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveViewerFile(file); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); toggleFindBar(wrap, true); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) { e.preventDefault(); toggleFindBar(wrap, true); }
  });
  wireFindBar(wrap, ta);
  setTimeout(() => ta.focus(), 0);
  return wrap;
}

function toggleFindBar(wrap, show) {
  const bar = wrap.querySelector(".editor-find");
  if (!bar) return;
  if (show === undefined) show = bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !show);
  if (show) { const f = bar.querySelector(".ef-find"); if (f) f.focus(); }
}

function wireFindBar(wrap, ta) {
  const q = wrap.querySelector(".ef-find");
  const rep = wrap.querySelector(".ef-replace");
  const findFrom = (backward) => {
    const term = q.value;
    if (!term) return;
    const val = ta.value;
    let idx;
    if (backward) {
      const before = val.lastIndexOf(term, Math.max(0, ta.selectionStart - 1));
      idx = before;
    } else {
      idx = val.indexOf(term, ta.selectionEnd);
      if (idx < 0) idx = val.indexOf(term, 0); // wrap around
    }
    if (idx < 0) { toast("Not found"); return; }
    ta.focus();
    ta.setSelectionRange(idx, idx + term.length);
    // Scroll the match into view (approximate by line).
    const line = val.slice(0, idx).split("\n").length;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 3) * lh);
  };
  wrap.querySelector(".ef-next").addEventListener("click", () => findFrom(false));
  wrap.querySelector(".ef-prev").addEventListener("click", () => findFrom(true));
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); findFrom(e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); toggleFindBar(wrap, false); ta.focus(); }
  });
  wrap.querySelector(".ef-rep").addEventListener("click", () => {
    const term = q.value;
    if (!term) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel === term) {
      const start = ta.selectionStart;
      ta.setRangeText(rep.value, start, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    }
    findFrom(false);
  });
  wrap.querySelector(".ef-repall").addEventListener("click", () => {
    const term = q.value;
    if (!term) return;
    ta.value = ta.value.split(term).join(rep.value);
    ta.dispatchEvent(new Event("input"));
  });
  const goto = wrap.querySelector(".ef-goto");
  const doGoto = () => {
    const n = parseInt(goto.value, 10);
    if (!n || n < 1) return;
    const lines = ta.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(n - 1, lines.length); i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (n - 3) * lh);
  };
  wrap.querySelector(".ef-go").addEventListener("click", doGoto);
  goto.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doGoto(); } });
  wrap.querySelector(".ef-close").addEventListener("click", () => { toggleFindBar(wrap, false); ta.focus(); });
}

async function saveViewerFile(file) {
  if (!file) return;
  try {
    if (file.sftpId != null) {
      await invoke("sftp_write_text_file", { sessionId: file.sftpId, path: file.path, content: file.content });
    } else {
      await invoke("write_text_file", { path: file.path, content: file.content });
    }
    file.dirty = false;
    renderViewerTabs();
    renderViewerTools();
    toast("Saved: " + file.name);
  } catch (e) {
    toast("Save failed: " + String(e), true);
  }
}

function activeViewerFileObj() {
  return viewerFiles.find((f) => f.id === activeViewerId) || null;
}

function toggleEditMode() {
  const f = activeViewerFileObj();
  if (!f) return;
  f.editing = !f.editing;
  renderViewerBody(f);
}

// Update the header tools (edit toggle / save / autosave / find) for the active file.
function renderViewerTools() {
  const f = activeViewerFileObj();
  const tools = document.getElementById("viewer-tools");
  if (!tools) return;
  const editBtn = document.getElementById("viewer-edit-toggle");
  const saveBtn = document.getElementById("viewer-save-btn");
  const findBtn = document.getElementById("viewer-find-btn");
  const auto = document.getElementById("viewer-autosave");
  if (!f) { tools.style.visibility = "hidden"; return; }
  tools.style.visibility = "visible";
  if (editBtn) {
    const eye = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const pencil = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
    editBtn.innerHTML = f.editing ? eye : pencil;
    editBtn.title = f.editing ? "Preview" : "Edit";
  }
  if (saveBtn) {
    saveBtn.classList.toggle("dirty", !!f.dirty);
    saveBtn.style.display = f.editing ? "" : "none";
  }
  if (findBtn) findBtn.style.display = f.editing ? "" : "none";
  if (auto) {
    auto.parentElement.style.display = f.editing ? "" : "none";
    auto.checked = autosaveEnabled();
  }
}

// Rebuild the per-file tab strip inside the viewer head.
function renderViewerTabs() {
  const strip = document.getElementById("viewer-tabs");
  if (!strip) return;
  strip.innerHTML = "";
  for (const f of viewerFiles) {
    const t = document.createElement("div");
    t.className = "viewer-file-tab" + (f.id === activeViewerId ? " active" : "");
    t.title = f.path;
    t.innerHTML = `<span class="vft-name">${f.dirty ? "● " : ""}${esc(f.name)}</span><span class="vft-close" title="Close">&times;</span>`;
    t.addEventListener("click", (e) => {
      if (e.target.classList.contains("vft-close")) { closeViewerFile(f.id); return; }
      activateViewerFile(f.id);
    });
    strip.appendChild(t);
  }
}

function activateViewerFile(id) {
  const f = viewerFiles.find((x) => x.id === id);
  if (!f) return;
  activeViewerId = id;
  renderViewerTabs();
  renderViewerBody(f);
}

// Close one file tab; closing the last one closes the whole viewer.
function closeViewerFile(id) {
  const idx = viewerFiles.findIndex((x) => x.id === id);
  if (idx < 0) return;
  viewerFiles.splice(idx, 1);
  if (viewerFiles.length === 0) { closeViewer(); return; }
  if (activeViewerId === id) {
    const next = viewerFiles[Math.min(idx, viewerFiles.length - 1)];
    activeViewerId = next.id;
    renderViewerBody(next);
  }
  renderViewerTabs();
}

// Operate the CLI in a folder: open a new local terminal already in that
// directory, or `cd` the active SSH terminal for remote paths (escaped).
function cdToTerminal(path) {
  if (currentSftpId) {
    const safe = String(path).replace(/'/g, "'\\''");
    // Route the cd to the SSH terminal that OWNS this sftp session (its pane
    // stores t.sftpId at connect time — see doSshConnect), not just whatever
    // pane happens to be active. Otherwise the cd lands in a local/other shell.
    let targetId = null;
    for (const [id, t] of terminals) {
      if (t.sftpId === currentSftpId) { targetId = id; break; }
    }
    if (targetId == null || !terminals.has(targetId)) {
      if (activeTermId == null || !terminals.has(activeTermId)) {
        toast("이 서버의 SSH 세션을 찾을 수 없습니다.", true);
        return;
      }
      targetId = activeTermId; // fallback: best-effort to the active terminal
    }
    invoke("pty_write", { id: targetId, data: `cd '${safe}'\r` });
    // Bring that SSH session into view so the user sees the directory change.
    const tab = findTabForPane(targetId);
    if (tab && tab.tabIdx !== activeTabIdx) switchToTab(tab.tabIdx);
    setFocusedPane(targetId);
    return;
  }
  // Local: open the folder in the CURRENT window by splitting the active tab.
  // Fall back to a new tab only when no terminal pane is active.
  if (!browserTabActive && activeTabIdx != null && focusedPaneId != null && terminals.has(focusedPaneId)) {
    splitPane("horizontal", path);
  } else {
    spawnTerminal(undefined, path);
  }
}

// ── Explorer favorites (folders, persisted in localStorage) ──
function getExplorerFavorites() {
  try { return JSON.parse(localStorage.getItem("mymux.explorerFavorites") || "[]"); } catch { return []; }
}
function setExplorerFavorites(arr) {
  try { localStorage.setItem("mymux.explorerFavorites", JSON.stringify(arr)); } catch {}
}
function isExplorerFav(path) {
  return getExplorerFavorites().some((f) => f.path === path);
}
function toggleExplorerFav(path, name) {
  const favs = getExplorerFavorites();
  const idx = favs.findIndex((f) => f.path === path);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push({ path, name: name || baseName(path) || path });
  setExplorerFavorites(favs);
  renderExplorerFavorites();
  loadExplorer(); // refresh star state in the list
}
function removeExplorerFav(path) {
  setExplorerFavorites(getExplorerFavorites().filter((f) => f.path !== path));
  renderExplorerFavorites();
  loadExplorer();
}
function renderExplorerFavorites() {
  const el = document.getElementById("explorer-favorites");
  if (!el) return;
  const favs = getExplorerFavorites();
  el.innerHTML = "";
  if (favs.length === 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  for (const f of favs) {
    const chip = document.createElement("div");
    chip.className = "fav-chip";
    chip.title = f.path;
    chip.innerHTML = `<span class="fav-chip-star">★</span><span class="fav-chip-name">${esc(f.name)}</span><button class="fav-chip-x" title="Remove">&times;</button>`;
    chip.querySelector(".fav-chip-star").addEventListener("click", () => cdToTerminal(f.path));
    chip.querySelector(".fav-chip-name").addEventListener("click", () => cdToTerminal(f.path));
    chip.querySelector(".fav-chip-x").addEventListener("click", (e) => {
      e.stopPropagation();
      removeExplorerFav(f.path);
    });
    el.appendChild(chip);
  }
}

async function goUp() {
  let parent;
  if (currentSftpId) {
    // Remote: go up by removing last path component
    const parts = currentExplorerPath.replace(/\/+$/, "").split("/");
    parts.pop();
    parent = parts.join("/") || "/";
  } else {
    parent = await invoke("explorer_parent_dir", { path: currentExplorerPath });
  }
  if (parent) explorerGo(parent);
}

function onExplorerModeChange() {
  const val = explorerMode.value;
  if (val === "local") {
    invoke("explorer_home_dir").then((home) => explorerGo(home, null));
  } else {
    // val is sftp session id
    const id = parseInt(val);
    invoke("sftp_home_dir", { sessionId: id })
      .then((home) => explorerGo(home, id))
      .catch(() => explorerGo("/", id));
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
  // Scrollback search — driven by the shared search bar (Ctrl+Shift+F).
  const searchAddon = new SearchAddon.SearchAddon();
  term.loadAddon(searchAddon);
  // Ctrl+Click opens URLs (in-app browser when enabled); a plain click stays a
  // selection click so it never hijacks text selection over a link.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
    if (event.ctrlKey || event.metaKey) openLinkFromTerminal(uri);
    else hintLinkOnce();
  }));
  term.open(termWrap);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  fitAddon.fit();

  // Spawn the PTY at the pane's ACTUAL fitted grid — not a forced 80×24 floor.
  // A narrow split pane is often < 80 cols; forcing the PTY to 80 while xterm
  // displays fewer makes the program (e.g. Claude Code) lay out to 80 cols, so
  // its long lines and header rules overflow the visible grid and get truncated
  // at the right edge instead of wrapping. Fall back to 80×24 only when fit()
  // hasn't measured yet (cols/rows would be 0).
  const cols = term.cols || 80;
  const rows = term.rows || 24;

  const id = await invoke("pty_spawn", {
    shell: shell || null,
    args: args || null,
    cwd: cwd || null,
    cols,
    rows,
  });

  // Opened in a specific folder → name the session after that folder (shown on
  // the pane label AND in the right-side session list via sessionLabelFor →
  // t.label). Falls back to the shell name when no folder was given.
  const sessionLabel = shell === "ssh"
    ? "SSH"
    : (cwd ? baseName(cwd) : (shell || "Terminal"));
  terminals.set(id, { term, fitAddon, search: searchAddon, paneEl, type: shell === "ssh" ? "ssh" : "local", shell: shell || null, label: sessionLabel, cwd: cwd || null, unseen: false, marks: [], inputMark: null });

  // A brand-new pane's final size isn't settled at spawn (flex sizing, font
  // load, a split ratio applied just after). The container-level observer only
  // fires on window/panel resize — never when a fresh pane lays out — so without
  // this the spawn-time fit can be too wide and the program (e.g. Claude Code)
  // renders past the visible edge, lines truncated, until the user toggles
  // sessions (which forces a refit). Observe this pane's host so the PTY grid
  // reconciles the moment its size settles or changes. Debounced to one frame;
  // refitAllPanes() skips panes whose pixel size is unchanged, so it's cheap.
  // GC'd with termWrap when the pane closes (no manual disconnect needed).
  let roPending = false;
  new ResizeObserver(() => {
    if (roPending) return;
    roPending = true;
    requestAnimationFrame(() => { roPending = false; refitAllPanes(); });
  }).observe(termWrap);

  // Status bar: label + split/close controls. The cwd chip tracks the pane's
  // current directory (setPaneCwd updates it on cd). Blank it when it equals the
  // label so a folder-named session doesn't show the same name twice (e.g.
  // "Mymux   Mymux") — `.pane-cwd:empty` hides it. It reappears once you cd into
  // a folder whose name differs from the label.
  const cwdLabel = cwd ? baseName(cwd) : "~";
  const cwdText = cwdLabel === sessionLabel ? "" : cwdLabel;
  statusBar.innerHTML = `
    <span class="pane-grip" title="Drag to move pane">&#10287;</span>
    <span class="pane-label">${esc(sessionLabel)}</span>
    ${shell !== "ssh" ? `<span class="pane-cwd" title="${esc(cwd || "")}">${esc(cwdText)}</span>` : ""}
    <span class="pane-actions">
      <button class="pane-btn split-h" title="Split horizontally (Ctrl+Shift+D)">&#8596;</button>
      <button class="pane-btn split-v" title="Split vertically (Ctrl+Shift+E)">&#8597;</button>
      <button class="pane-btn close" title="Close pane (Ctrl+Shift+W)">&times;</button>
    </span>
  `;
  statusBar.querySelector(".split-h").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("horizontal"); });
  statusBar.querySelector(".split-v").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("vertical"); });
  statusBar.querySelector(".close").addEventListener("click", (e) => { e.stopPropagation(); closePane(id); });

  // Mouse-drag the status bar onto another pane's edge (top/bottom/left/right)
  // to re-tile. Mouse-based (not HTML5 DnD) so it reliably works over the xterm
  // canvas.
  paneEl.dataset.ptyId = id;
  statusBar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".pane-btn")) return;
    startPaneDrag(id, e);
  });

  // Mouse-wheel must always scroll the scrollback while on the NORMAL buffer.
  // Some CLIs (Claude Code among them) enable mouse tracking without switching
  // to the alt screen; xterm then forwards every wheel event to the program as
  // escape sequences instead of scrolling the viewport — and through ConPTY
  // those reports don't round-trip usefully, so the wheel goes dead (only the
  // scrollbar drag still works) and the program's wheel-triggered redraws can
  // leave half-painted / blank regions. Reclaim the wheel here: on the normal
  // buffer we scroll the viewport ourselves and swallow the event. Alt-screen
  // TUIs (vim/htop/less) keep receiving wheel reports as before, and
  // Ctrl+wheel is left alone for future zoom gestures.
  if (term.attachCustomWheelEventHandler) {
    term.attachCustomWheelEventHandler((e) => {
      try {
        if (e.ctrlKey) return true;
        if (term.buffer.active.type !== "normal") return true;
        if ((term.modes.mouseTrackingMode || "none") === "none") return true; // no conflict — default handling already scrolls
        // deltaMode 1 = lines, 0 = pixels (~one row per ≈ fontSize*1.2 px).
        const rowPx = (term.options.fontSize || 14) * 1.2;
        const lines = e.deltaMode === 1
          ? Math.trunc(e.deltaY)
          : Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / rowPx / 3));
        if (lines) term.scrollLines(lines);
        return false;
      } catch { return true; }
    });
  }

  // Ctrl +/- to change terminal font size, Ctrl+0 to reset (intercept before
  // xterm/PTY so the keys don't reach the shell or zoom the WebView).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      // Paste with Ctrl/Cmd+V (also Ctrl+Shift+V). Match e.code too — with the
      // Korean IME active e.key arrives as "ㅍ"/"ㅊ" or "Process", never the
      // Latin letter, and the shortcut would fall through to the shell.
      if (e.code === "KeyV" || e.key === "v" || e.key === "V") { e.preventDefault(); pasteIntoPane(id); return false; }
      // Copy the selection with Ctrl/Cmd+C (Shift optional). When nothing is
      // selected, fall through so Ctrl+C still sends SIGINT to the shell.
      if (e.code === "KeyC" || e.key === "c" || e.key === "C") {
        const sel = term.getSelection();
        // Clear the selection after copying — if it stuck around, the next
        // Ctrl+C would copy again instead of interrupting the process.
        if (sel) { e.preventDefault(); clipboardWrite(sel); term.clearSelection(); return false; }
      }
      if (e.key === "=" || e.key === "+") { e.preventDefault(); adjustTerminalFontSize(1); return false; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); adjustTerminalFontSize(-1); return false; }
      if (e.key === "0") { e.preventDefault(); setTerminalFontSize(14); return false; }
      if (e.key === "Tab") { e.preventDefault(); focusNextPane(e.shiftKey ? -1 : 1); return false; }
      // Ctrl+Shift+P — command palette.
      if (e.shiftKey && (e.key === "P" || e.code === "KeyP")) { e.preventDefault(); openCommandPalette(); return false; }
      // Ctrl+Shift+↑/↓ — jump between shell prompts (OSC 133 marks).
      if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); jumpPrompt(e.key === "ArrowUp" ? -1 : 1); return false; }
      // Ctrl+A — select the whole current command-input line (Windows-style).
      // At an integrated prompt we always intercept (so it never falls through
      // to readline's beginning-of-line); use Home to jump to the line start.
      // In a full-screen TUI (alt screen) it passes through to the app.
      if (!e.shiftKey && (e.key === "a" || e.key === "A" || e.code === "KeyA")) {
        if (atIntegratedPrompt(terminals.get(id))) {
          e.preventDefault();
          const did = selectCurrentInput(id);
          if (did) hintCtrlAOnce();
          return false;
        }
      }
      // Ctrl+X — cut the selection, or the current input line, and clear it.
      if (!e.shiftKey && (e.key === "x" || e.key === "X" || e.code === "KeyX")) {
        const ti = terminals.get(id);
        if ((ti && ti.term.getSelection()) || atIntegratedPrompt(ti)) {
          if (cutCurrentInput(id)) { e.preventDefault(); return false; }
        }
      }
    }
    // Shift+Insert → paste
    if (e.type === "keydown" && e.shiftKey && e.key === "Insert") { e.preventDefault(); pasteIntoPane(id); return false; }
    return true;
  });

  term.onData((data) => {
    // Typing means the user is interacting, not waiting on a task: remember the
    // time (gates the OSC 133;D "long command finished" flash) and cancel the
    // output-silence watch so keystroke echo never counts as "work output".
    const ti = terminals.get(id);
    if (ti) { ti.lastInputAt = performance.now(); ti.outStart = null; }
    const result = handleTerminalInput(data, id);
    if (result === "consumed") return;
    // Per-tab broadcast (Ctrl+Shift+B): typing in any pane of a broadcasting
    // tab goes to every pane of that tab — tmux synchronize-panes.
    const tab = findTabForPane(id);
    if (tab && tab.broadcast && tab.panes.length > 1) {
      for (const pid of tab.panes) invoke("pty_write", { id: pid, data });
    } else {
      invoke("pty_write", { id, data });
    }
  });

  // Terminal bell → flash this pane/session (task done / needs input).
  if (term.onBell) term.onBell(() => flashPaneNotify(id));
  // Many CLIs (incl. claude/codex notification modes) signal completion with an
  // OSC desktop-notification instead of a plain bell — xterm consumes the
  // trailing BEL of an OSC so onBell alone misses those. Catch the common ones.
  if (term.parser && term.parser.registerOscHandler) {
    // OSC 9 ; <message>  (iTerm-style). Skip ConEmu progress form "9;<digit>;…".
    term.parser.registerOscHandler(9, (data) => { if (!/^[0-9];/.test(data)) flashPaneNotify(id); return false; });
    // OSC 777 ; notify ; <title> ; <body>  (notify-send style).
    term.parser.registerOscHandler(777, (data) => { if (/^notify/.test(data)) flashPaneNotify(id); return false; });
    // OSC 52 ; <target> ; <base64>  — clipboard write from the running app
    // (tmux/vim/Claude Code "copied" actions). xterm drops it by default, so the
    // TUI reports "copied" while the Windows clipboard never changes.
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      if (semi < 0) return true;
      const b64 = data.slice(semi + 1);
      if (b64 === "?") return true; // clipboard read query — never answer
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes); // base64 wraps UTF-8 bytes
        if (text) clipboardWrite(text);
      } catch {}
      return true;
    });
    // OSC 133 shell-integration marks (emitted by our bash rcfile / PS prompt):
    //   A = prompt start, B = command-input start, D;<code> = command finished.
    // A registerMarker() tracks each prompt row as the buffer scrolls/trims, so
    // we can jump between prompts and copy command output blocks; B records where
    // the typed command begins so we can copy/cut the current input line.
    term.parser.registerOscHandler(133, (data) => {
      const t = terminals.get(id);
      if (!t) return true;
      const k = data[0];
      if (k === "A") {
        try {
          const m = term.registerMarker(0);
          if (m) { t.marks.push({ marker: m, exit: null }); if (t.marks.length > 400) t.marks.shift(); }
        } catch {}
      } else if (k === "B") {
        try {
          const m = term.registerMarker(0);
          if (m) t.inputMark = { marker: m, col: term.buffer.active.cursorX };
        } catch {}
      } else if (k === "D") {
        const ec = parseInt((data.split(";")[1] || ""), 10);
        const last = t.marks[t.marks.length - 1];
        if (last && Number.isFinite(ec)) last.exit = ec;
        // Command finished: if it ran ≥5s since the last keystroke, treat it as
        // a task completing and flash the pane. Short interactive commands
        // (ls, cd…) finish well inside the window and stay quiet.
        if (performance.now() - (t.lastInputAt || 0) >= NOTIFY_MIN_WORK_MS) flashPaneNotify(id);
        t.outStart = null; // the shell prompt is back — don't double-fire the silence watcher
      }
      return true;
    });
  }

  // Focus tracking. xterm self-focuses its textarea on mousedown inside the
  // canvas and can swallow the event when the running TUI enables mouse
  // reporting (claude/vim/htop) — but the app only updated focusedPaneId on
  // 'click', so state kept pointing at the old pane and its focus keeper stole
  // focus back within a second ("click twice to enter a pane"). Track the
  // switch on mousedown in the capture phase (runs before xterm can swallow
  // it), plus a DOM focus listener on the helper textarea (the element that
  // actually receives focus; xterm 5.5 has no term.onFocus event) so state
  // syncs whenever xterm focuses itself.
  if (term.textarea) term.textarea.addEventListener("focus", () => { if (focusedPaneId !== id) setFocusedPane(id); });
  paneEl.addEventListener("mousedown", () => { if (focusedPaneId !== id) setFocusedPane(id); }, true);
  paneEl.addEventListener("click", () => setFocusedPane(id));
  termWrap.addEventListener("click", () => { setFocusedPane(id); term.focus(); });
  // A plain mouse drag should select text. dragDropEnabled:false re-enables the
  // webview's native HTML5 drag, which would otherwise hijack a drag that begins
  // over terminal text and stop xterm's selection — suppress it inside the pane.
  termWrap.addEventListener("dragstart", (e) => e.preventDefault());
  // Finishing a drag-select copies automatically (PuTTY-style) — no Ctrl+C
  // needed. onSelectionChange fires on every drag step, so let it settle before
  // touching the clipboard; an empty selection (a clear) is skipped.
  let selCopyTimer = null;
  term.onSelectionChange(() => {
    clearTimeout(selCopyTimer);
    selCopyTimer = setTimeout(() => {
      const sel = term.getSelection();
      if (sel) clipboardWrite(sel);
    }, 120);
  });
  // Right-click: copy the selection if any, otherwise paste the clipboard (PuTTY-style).
  termWrap.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) { await clipboardWrite(sel); term.clearSelection(); }
    else { await pasteIntoPane(id); }
  });

  // NOTE: we used to inject a fake cursor-position report (ESC[1;1R) here. That
  // was unsolicited — no shell asked for it — so on a timing race the bytes
  // landed in readline's input buffer and misaligned the prompt/cursor (cursor
  // appeared inside the "$"). xterm.js answers real DSR (ESC[6n) queries on its
  // own, so the injection is both unnecessary and harmful; removed.

  // Keep this pane focused. The WebView can silently drop the helper-textarea
  // focus when the app sits idle (cursor goes hollow, typing stops until you
  // click again). If focus leaves the textarea and lands on *nothing*
  // (body/null) — i.e. it was dropped, not moved to another pane/input — restore
  // it to the active pane. Clicking another pane/input/overlay sets a real
  // activeElement, which is respected (no steal).
  const helperTa = term.element && term.element.querySelector(".xterm-helper-textarea");
  if (helperTa) {
    helperTa.addEventListener("blur", () => {
      setTimeout(() => {
        if (focusedPaneId !== id) return;              // only the active pane
        if (browserTabActive || viewerActive) return;  // not in terminal mode
        const el = term.element;
        if (!el || el.classList.contains("focus")) return; // xterm already focused
        // Leave it only if focus genuinely moved to another input/pane (rename
        // box, find bar, other terminal); otherwise it was dropped → restore.
        const ae = document.activeElement;
        if (ae && ae !== document.body && !el.contains(ae) &&
            (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
        try { term.focus(); } catch {}
      }, 0);
    });
  }

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
    if (t.unseen) {
      t.unseen = false;
      document.querySelector(`.session-item[data-pty-id="${ptyId}"]`)?.classList.remove("unseen");
    }
  }
  updateSessionActive();
}

// Safety net for terminal focus. The WebView can drop the active terminal's
// focus while the app sits idle — sometimes without firing a blur event, so the
// per-pane blur handler in createPane can miss it. Once a second, if we're in
// terminal mode and focus has fallen to nothing (body/null) rather than a real
// element (another pane, an input, an overlay), pull it back to the active pane.
// This is why a focused session stays selectable until you click elsewhere.
let focusKeeperStarted = false;
// Assigned by startFocusKeeper; called from the global keydown handler so that
// real typing after an Alt-Tab return cancels the remaining focus-restore
// retries (a keystroke proves input focus is alive, so re-blurring the textarea
// would only thrash input and repeat characters).
let cancelFocusReturnRetries = () => {};
function startFocusKeeper() {
  if (focusKeeperStarted) return;
  focusKeeperStarted = true;
  // Restore terminal focus to the visible tab's active pane. The WebView drops
  // the terminal's focus while backgrounded (idle, or when a background app like
  // WIZVERA Veraport briefly steals OS focus), and on Alt-Tab return it fires no
  // usable focus event at all (a known WebView2 limitation), so the cursor goes
  // hollow. Target the visible tab's pane (focusedPaneId can be stale for a
  // hidden tab), skip if it's off-screen, then bounce the helper textarea so
  // xterm re-registers focus. `force` re-focuses even when xterm still looks
  // focused — needed on return, where activeElement/class are stale.
  const restore = (force) => {
    if (browserTabActive || viewerActive) return;
    let pid = focusedPaneId;
    const tab = tabs.get(activeTabIdx);
    if (tab && tab.panes.length && !tab.panes.includes(pid)) pid = tab.panes[0];
    if (pid == null || !terminals.has(pid)) return;
    const t = terminals.get(pid);
    const el = t.term.element;
    if (!el || !el.offsetParent) return; // not visible → leave it
    const ta = el.querySelector(".xterm-helper-textarea");
    if (!force && ta && document.activeElement === ta && el.classList.contains("focus")) return;
    // Respect focus that genuinely moved to a non-terminal input/overlay.
    const ae = document.activeElement;
    if (ae && ae !== document.body && !el.contains(ae) &&
        (ae.tagName === "INPUT" || ae.isContentEditable ||
         (ae.tagName === "TEXTAREA" && !ae.classList.contains("xterm-helper-textarea")))) return;
    try { if (ta) ta.blur(); } catch {}
    try { t.term.focus(); } catch {}
    try { if (ta && document.activeElement !== ta) ta.focus(); } catch {}
    if (focusedPaneId !== pid) { try { setFocusedPane(pid); } catch {} }
  };
  // On return, retry across a few frames — WebView2 can move focus to <body> a
  // tick after the window comes back, overriding an immediate restore. Up to ~5
  // independent signals (Rust refocus, onFocusChanged, hasFocus flip,
  // visibilitychange, window focus) can each fire onReturn on a single return,
  // so COALESCE: run the restore burst at most once per 600ms. Retry handles are
  // kept so the first real keystroke can cancel the pending re-focuses — once
  // the user is typing, focus is proven alive and re-blurring only thrashes it.
  let lastReturn = -1e9;
  let returnRetries = [];
  cancelFocusReturnRetries = () => { for (const h of returnRetries) clearTimeout(h); returnRetries = []; };
  const onReturn = () => {
    const now = performance.now();
    if (now - lastReturn < 600) return;
    lastReturn = now;
    cancelFocusReturnRetries();
    restore(true);
    returnRetries = [
      setTimeout(() => restore(true), 80),
      setTimeout(() => restore(true), 220),
      setTimeout(() => restore(true), 500),
    ];
  };
  window.addEventListener("focus", (e) => {
    if (!e.target || e.target === window || e.target === document || e.target === document.body) onReturn();
    else restore();
  }, true);
  // Idle backstop; also poll document.hasFocus() — a false→true flip means the
  // window returned even when no focus event fired.
  let hadFocus = document.hasFocus();
  setInterval(() => {
    const hf = document.hasFocus();
    if (hf && !hadFocus) onReturn();
    hadFocus = hf;
    restore();
  }, 250);
  try { document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") onReturn(); }); } catch {}
  // Primary Alt-Tab return signal: the Rust side polls the OS foreground window,
  // focuses the webview (reviving DOM input focus — top-level focus alone does
  // not), and emits "mymux-refocus". WebView2 fires no usable focus event on
  // return, so this is the reliable trigger.
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) ev.listen("mymux-refocus", () => onReturn());
  } catch {}
  // Backstop: Tauri's native window focus event (unreliable on Alt-Tab in this
  // WebView2 build, hence the Rust poll above — kept for cases where it fires).
  try {
    const winApi = window.__TAURI__ && window.__TAURI__.window;
    if (winApi && winApi.getCurrentWindow) {
      winApi.getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) { onReturn(); refitAllPanes(); }
      }).catch(() => {});
    }
  } catch {}
}

// Let the user drag the session panel's left edge to resize its width.
function setupSessionResizer() {
  const panel = document.getElementById("session-panel");
  const resizer = document.getElementById("session-resizer");
  if (!panel || !resizer) return;
  const saved = parseInt(localStorage.getItem("mymux.sessionWidth"), 10);
  if (saved >= 140 && saved <= 1000) panel.style.width = saved + "px";
  let startX = 0, startW = 0, dragging = false;
  resizer.addEventListener("mousedown", (e) => {
    if (panel.classList.contains("collapsed")) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    panel.style.transition = "none";          // smooth drag (no 0.2s tween)
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // Panel is pinned to the right; dragging the handle left widens it.
    let w = startW + (startX - e.clientX);
    w = Math.max(140, Math.min(window.innerWidth - 360, w));
    panel.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = parseInt(panel.style.width, 10);
    if (w) localStorage.setItem("mymux.sessionWidth", String(w));
    try { refitAllPanes(true); } catch {} // terminal grid changed with the panel
  });
}

// ── Task-done detection (tmux monitor-silence 계열) ─────────────────────────
// A pane that streamed output for ≥ NOTIFY_MIN_WORK_MS and then went quiet for
// NOTIFY_SILENCE_MS is treated as "task finished" and flashed. Covers programs
// without OSC 133 shell integration (TUIs, streaming CLIs); user keystrokes
// reset the window (see term.onData) so echo never masquerades as work.
const NOTIFY_MIN_WORK_MS = 5000;
const NOTIFY_SILENCE_MS = 1500;
function trackOutputSilence(id, t) {
  const now = performance.now();
  if (t.outStart == null) t.outStart = now;
  t.lastOutAt = now;
  if (t.silenceTimer) clearTimeout(t.silenceTimer);
  t.silenceTimer = setTimeout(() => {
    t.silenceTimer = null;
    if (!terminals.has(id)) return;
    if (t.outStart == null) return; // window already reset by a keystroke or OSC 133;D
    const workedMs = (t.lastOutAt || 0) - t.outStart;
    t.outStart = null; // window consumed either way
    if (workedMs >= NOTIFY_MIN_WORK_MS) flashPaneNotify(id);
  }, NOTIFY_SILENCE_MS);
}

// Briefly pulse a pane + its session-list row to notify task completion
// (driven by the terminal bell — see the pty read loop).
function flashPaneNotify(id) {
  // Base 다홍(scarlet); shift the hue a little per session so simultaneous
  // completions in different panes are tellable apart at a glance.
  const hue = (8 + (Number(id) || 0) * 24) % 360;
  const color = `hsl(${hue}, 88%, 58%)`;
  const pulse = (el) => {
    if (!el) return;
    el.classList.remove("notify-flash");
    void el.offsetWidth; // restart the animation
    el.style.setProperty("--notify-color", color);
    el.classList.add("notify-flash");
    setTimeout(() => el.classList.remove("notify-flash"), 10200);
  };
  const t = terminals.get(id);
  if (t) pulse(t.paneEl);
  pulse(document.querySelector(`.session-item[data-pty-id="${id}"]`));
  // The pulse is invisible when the pane is off-screen or the whole window is
  // in the background — leave a persistent "unseen" badge for the former and
  // flash the taskbar icon (no focus steal) for the latter.
  if (t) {
    const tab = findTabForPane(id);
    if (tab && (tab.tabIdx !== activeTabIdx || browserTabActive || viewerActive)) markUnseen(id, t, tab);
  }
  if (!document.hasFocus()) invoke("window_attention").catch(() => {});
}

// ── Activity badges (tmux monitor-activity) ──────────────────────────────
// Output landing in a pane the user can't see marks its session row and its
// tab with a dot; viewing the tab clears it.
function markPaneActivity(id, t) {
  if (t.unseen) return; // already marked — skip the per-frame DOM work
  const tab = findTabForPane(id);
  if (!tab) return;
  if (tab.tabIdx === activeTabIdx && !browserTabActive && !viewerActive) return; // visible
  markUnseen(id, t, tab);
}
function markUnseen(id, t, tab) {
  t.unseen = true;
  document.querySelector(`.session-item[data-pty-id="${id}"]`)?.classList.add("unseen");
  terminalTabs.querySelector(`.tab[data-id="${tab.tabIdx}"]`)?.classList.add("unseen");
}
function clearUnseenForTab(tabIdx) {
  const tab = tabs.get(tabIdx);
  if (!tab) return;
  for (const pid of tab.panes || []) {
    const t = terminals.get(pid);
    if (t && t.unseen) {
      t.unseen = false;
      document.querySelector(`.session-item[data-pty-id="${pid}"]`)?.classList.remove("unseen");
    }
  }
  terminalTabs.querySelector(`.tab[data-id="${tabIdx}"]`)?.classList.remove("unseen");
}

// ── Pane zoom (tmux prefix+z) ────────────────────────────────────────────
// Temporarily maximize the focused pane over its tab as an absolute overlay —
// no reparenting, so background panes stay live and scroll state is untouched.
// Every layout operation (split/close/move) clears the zoom first so the
// overlay never fights the flex-tree math.
let zoomedPaneId = null;
function togglePaneZoom() {
  const t = terminals.get(focusedPaneId);
  const wasZoomed = zoomedPaneId === focusedPaneId;
  clearPaneZoom();
  if (!wasZoomed && t) {
    const tab = findTabForPane(focusedPaneId);
    t.paneEl.classList.add("zoomed");
    if (tab && tab.rootEl) tab.rootEl.classList.add("has-zoom");
    zoomedPaneId = focusedPaneId;
  }
  requestAnimationFrame(() => refitAllPanes());
}
function clearPaneZoom() {
  if (zoomedPaneId == null) return;
  const t = terminals.get(zoomedPaneId);
  if (t) t.paneEl.classList.remove("zoomed");
  const tab = findTabForPane(zoomedPaneId);
  if (tab && tab.rootEl) tab.rootEl.classList.remove("has-zoom");
  zoomedPaneId = null;
}

// ── Per-tab input broadcast (tmux synchronize-panes) ─────────────────────
function toggleBroadcast() {
  const tab = tabs.get(activeTabIdx);
  if (!tab) return;
  tab.broadcast = !tab.broadcast;
  updateBroadcastUi();
  toast(tab.broadcast
    ? "Broadcast ON — typing goes to every pane in this tab (Ctrl+Shift+B to stop)"
    : "Broadcast off");
}
function updateBroadcastUi() {
  const tab = tabs.get(activeTabIdx);
  const on = !!(tab && tab.broadcast);
  document.getElementById("btn-broadcast")?.classList.toggle("active", on);
  tabs.forEach((t) => { if (t.rootEl) t.rootEl.classList.toggle("broadcasting", !!t.broadcast); });
}

// ── Scrollback search (Ctrl+Shift+F) ─────────────────────────────────────
// One shared bar over the terminal area; it always drives the FOCUSED pane's
// search addon, so switching panes retargets the same bar.
function initTermSearch() {
  const input = document.getElementById("term-search-input");
  if (!input) return;
  const addon = () => terminals.get(focusedPaneId)?.search;
  const find = (back) => {
    const a = addon();
    if (!a || !input.value) return;
    try { back ? a.findPrevious(input.value) : a.findNext(input.value); } catch {}
  };
  input.addEventListener("input", () => {
    const a = addon();
    if (!a) return;
    try { input.value ? a.findNext(input.value, { incremental: true }) : a.clearDecorations?.(); } catch {}
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); closeTermSearch(); }
  });
  document.getElementById("term-search-prev")?.addEventListener("click", () => find(true));
  document.getElementById("term-search-next")?.addEventListener("click", () => find(false));
  document.getElementById("term-search-close")?.addEventListener("click", closeTermSearch);
}
function openTermSearch() {
  if (browserTabActive || viewerActive || !focusedPaneId) return;
  const bar = document.getElementById("term-search");
  const input = document.getElementById("term-search-input");
  if (!bar || !input) return;
  bar.classList.remove("hidden");
  input.focus();
  input.select();
}
function closeTermSearch() {
  const bar = document.getElementById("term-search");
  if (!bar || bar.classList.contains("hidden")) return;
  bar.classList.add("hidden");
  const t = terminals.get(focusedPaneId);
  if (t) {
    try { t.search?.clearDecorations?.(); t.term.clearSelection(); } catch {}
    t.term.focus();
  }
}

// ── Terminal URL opening (web-links addon) ───────────────────────────────
// Ctrl+Click routes into the in-app browser tab when the Browser feature is
// enabled; otherwise falls back to the OS default browser.
function openLinkFromTerminal(uri) {
  if (!/^https?:\/\//i.test(uri)) return;
  if (browserEnabled()) {
    if (browserMode !== "native") setBrowserMode("native");
    setBrowserView(true);
    const nav = document.getElementById("nav-url");
    if (nav) nav.value = uri;
    nativeNavigate(uri);
  } else {
    invoke("open_external", { path: uri }).catch((e) => toast(String(e), true));
  }
}
let linkHintShown = false;
function hintLinkOnce() {
  if (linkHintShown) return;
  linkHintShown = true;
  toast("Ctrl+Click opens links (Ctrl+클릭으로 링크 열기)");
}
let ctrlAHintShown = false;
function hintCtrlAOnce() {
  if (ctrlAHintShown) return;
  ctrlAHintShown = true;
  toast("입력줄 전체 선택됨 — Ctrl+C 복사 / Ctrl+X 잘라내기 (줄 시작은 Home)");
}

// ── OSC 133 shell integration: prompt jump, block copy, input line copy/cut ──
// Marks come from our bash rcfile / PowerShell prompt (see terminal.rs).

// The current command-input line as { startLine, startCol, cellLen, text }, or
// null when nothing is typed or the shell hasn't emitted a 133;B mark yet.
// True when the pane is sitting at a Mymux-integrated shell prompt (normal
// buffer, a live 133;B input mark) — as opposed to a full-screen TUI on the
// alternate screen (vim / claude / htop / less), where Ctrl+A must reach the app.
function atIntegratedPrompt(t) {
  return !!(t && t.inputMark && t.inputMark.marker && !t.inputMark.marker.isDisposed
    && t.term.buffer.active.type === "normal");
}

function getInputRegion(t) {
  const im = t && t.inputMark;
  if (!im || !im.marker || im.marker.isDisposed) return null;
  const buf = t.term.buffer.active;
  if (buf.type !== "normal") return null; // alt-screen TUI — not a shell prompt
  const cols = t.term.cols;
  const startLine = im.marker.line;
  const startCol = im.col;
  // Extend across wrapped continuation rows of the input.
  let endRow = startLine;
  while (true) { const n = buf.getLine(endRow + 1); if (n && n.isWrapped) endRow++; else break; }
  let text = "", lastRow = startLine, lastCellExcl = startCol;
  for (let row = startLine; row <= endRow; row++) {
    const line = buf.getLine(row);
    if (!line) break;
    const from = row === startLine ? startCol : 0;
    for (let c = from; c < cols; c++) {
      const cell = line.getCell(c);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // trailing cell of a wide char
      const ch = cell.getChars() || " ";
      text += ch;
      if (ch !== " ") { lastRow = row; lastCellExcl = c + w; }
    }
  }
  const trimmed = text.replace(/[\s ]+$/, "");
  if (!trimmed) return null;
  const cellLen = (lastRow - startLine) * cols + (lastCellExcl - startCol);
  return { startLine, startCol, cellLen, text: trimmed };
}

// Visually select the current input line. Returns false when there's nothing to
// select (so Ctrl+A can fall through to readline's beginning-of-line).
function selectCurrentInput(id) {
  const t = terminals.get(id);
  const r = getInputRegion(t);
  if (!r) return false;
  try { t.term.select(r.startCol, r.startLine, r.cellLen); } catch { return false; }
  return true;
}

function copyCurrentInput(id) {
  const t = terminals.get(id || focusedPaneId);
  const r = getInputRegion(t);
  if (!r) { toast("입력 중인 명령이 없어요 (셸 통합 준비 전이거나 빈 줄)"); return false; }
  clipboardWrite(r.text);
  toast("현재 명령줄 복사됨");
  return true;
}

// Cut the selection (or, if none, the current input line) and clear it in the
// shell. Returns false when there's nothing to cut (Ctrl+X falls through).
function cutCurrentInput(id) {
  const t = terminals.get(id);
  if (!t) return false;
  const sel = t.term.getSelection();
  const r = getInputRegion(t);
  const text = sel || (r && r.text);
  if (!text) return false;
  clipboardWrite(text);
  t.term.clearSelection();
  // Clear the shell's input line: Escape reverts the line in PSReadLine and
  // cmd.exe; readline (bash/zsh/ssh) uses Ctrl+E then Ctrl+U (to-end, kill-to-start).
  const sh = (t.shell || "").toLowerCase();
  const winShell = /power|pwsh|cmd/.test(sh);
  invoke("pty_write", { id, data: winShell ? "\x1b" : "\x05\x15" });
  toast("현재 명령줄 잘라냄");
  return true;
}

function promptLines(t) {
  return t.marks
    .filter((m) => m.marker && !m.marker.isDisposed)
    .map((m) => m.marker.line)
    .sort((a, b) => a - b);
}

// Scroll to the previous / next prompt mark (Ctrl+Shift+↑/↓).
function jumpPrompt(dir) {
  const t = terminals.get(focusedPaneId);
  if (!t) return;
  const lines = promptLines(t);
  if (!lines.length) { toast("프롬프트 마크 없음 (bash·PowerShell에서 동작)"); return; }
  const view = t.term.buffer.active.viewportY;
  let target = null;
  if (dir < 0) { for (let i = lines.length - 1; i >= 0; i--) if (lines[i] < view) { target = lines[i]; break; } }
  else { for (const l of lines) if (l > view) { target = l; break; } }
  if (target != null) t.term.scrollToLine(target);
  else toast(dir < 0 ? "첫 프롬프트입니다" : "마지막 프롬프트입니다");
}

// Copy the command + output block visible at the top of the viewport.
function copyCommandBlock(id) {
  const t = terminals.get(id || focusedPaneId);
  if (!t) return false;
  const lines = promptLines(t);
  if (!lines.length) { toast("명령 블록 마크 없음 (bash·PowerShell에서 동작)"); return false; }
  const buf = t.term.buffer.active;
  const view = buf.viewportY;
  let start = lines[0];
  for (const l of lines) { if (l <= view) start = l; else break; }
  let end = buf.length - 1;
  for (const l of lines) if (l > start) { end = l - 1; break; }
  let text = "";
  for (let row = start; row <= end; row++) {
    const line = buf.getLine(row);
    if (line) text += line.translateToString(true) + "\n";
  }
  text = text.replace(/\n+$/, "");
  if (!text.trim()) { toast("빈 블록"); return false; }
  clipboardWrite(text);
  toast("명령 블록 복사됨 (" + (end - start + 1) + "줄)");
  return true;
}

// ── Command palette (Ctrl+Shift+P) ───────────────────────────────────────
function commandPaletteActions() {
  return [
    { name: "New terminal / 새 터미널", hint: "Ctrl+Shift+N", run: () => spawnTerminal() },
    { name: "Split pane horizontally / 가로 분할", hint: "Ctrl+Shift+D", run: () => splitPane("horizontal") },
    { name: "Split pane vertically / 세로 분할", hint: "Ctrl+Shift+E", run: () => splitPane("vertical") },
    { name: "Close pane / 패인 닫기", hint: "Ctrl+Shift+W", run: () => focusedPaneId && closePane(focusedPaneId) },
    { name: "Zoom / restore pane / 패인 최대화", hint: "Ctrl+Shift+Z", run: () => togglePaneZoom() },
    { name: "Search scrollback / 스크롤백 검색", hint: "Ctrl+Shift+F", run: () => openTermSearch() },
    { name: "Broadcast input to tab / 입력 브로드캐스트", hint: "Ctrl+Shift+B", run: () => toggleBroadcast() },
    { name: "Jump to previous prompt / 이전 프롬프트", hint: "Ctrl+Shift+↑", run: () => jumpPrompt(-1) },
    { name: "Jump to next prompt / 다음 프롬프트", hint: "Ctrl+Shift+↓", run: () => jumpPrompt(1) },
    { name: "Copy command output block / 명령 블록 복사", hint: "", run: () => copyCommandBlock() },
    { name: "Copy current command line / 현재 명령줄 복사", hint: "", run: () => copyCurrentInput() },
    { name: "Cut current command line / 현재 명령줄 잘라내기", hint: "Ctrl+X", run: () => cutCurrentInput(focusedPaneId) },
    { name: "Select current command line / 현재 명령줄 전체 선택", hint: "Ctrl+A", run: () => selectCurrentInput(focusedPaneId) },
    { name: "New SSH connection / SSH 연결", hint: "", run: () => openSshModal() },
    { name: "Toggle browser panel / 브라우저 패널", hint: "", run: () => toggleBrowserEnabled() },
    { name: "Toggle light / dark theme / 테마 전환", hint: "", run: () => setTheme(currentThemeMode() === "dark" ? "light" : "dark") },
    { name: "Increase font size / 글자 크게", hint: "Ctrl +", run: () => adjustTerminalFontSize(1) },
    { name: "Decrease font size / 글자 작게", hint: "Ctrl -", run: () => adjustTerminalFontSize(-1) },
  ];
}

let paletteFiltered = [], paletteIndex = 0;
function initCommandPalette() {
  const input = document.getElementById("palette-input");
  const ov = document.getElementById("palette-overlay");
  if (!input || !ov) return;
  input.addEventListener("input", () => renderPalette(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
    else if (e.key === "Enter") { e.preventDefault(); runPaletteSelection(); }
  });
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeCommandPalette(); });
}
function openCommandPalette() {
  const ov = document.getElementById("palette-overlay");
  const input = document.getElementById("palette-input");
  if (!ov || !input) return;
  ov.classList.remove("hidden");
  input.value = "";
  renderPalette("");
  input.focus();
}
function closeCommandPalette() {
  document.getElementById("palette-overlay")?.classList.add("hidden");
  const t = terminals.get(focusedPaneId);
  if (t) try { t.term.focus(); } catch {}
}
function fuzzyScore(q, s) {
  if (!q) return 0;
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, streak = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { qi++; streak++; score += streak; } else streak = 0;
  }
  return qi === q.length ? score : -1;
}
function renderPalette(q) {
  const list = document.getElementById("palette-list");
  if (!list) return;
  const actions = commandPaletteActions();
  paletteFiltered = (q
    ? actions.map((a) => ({ a, s: fuzzyScore(q, a.name) })).filter((x) => x.s >= 0).sort((x, y) => y.s - x.s).map((x) => x.a)
    : actions);
  paletteIndex = 0;
  list.innerHTML = "";
  paletteFiltered.forEach((a, i) => {
    const li = document.createElement("li");
    li.className = "palette-item" + (i === 0 ? " sel" : "");
    li.innerHTML = `<span class="palette-name"></span>${a.hint ? `<span class="palette-hint">${esc(a.hint)}</span>` : ""}`;
    li.querySelector(".palette-name").textContent = a.name;
    li.addEventListener("mousemove", () => setPaletteIndex(i));
    li.addEventListener("click", () => { setPaletteIndex(i); runPaletteSelection(); });
    list.appendChild(li);
  });
  if (!paletteFiltered.length) list.innerHTML = `<li class="palette-empty">No matching command</li>`;
}
function setPaletteIndex(i) {
  paletteIndex = i;
  document.querySelectorAll("#palette-list .palette-item").forEach((el, idx) => el.classList.toggle("sel", idx === i));
}
function movePalette(d) {
  if (!paletteFiltered.length) return;
  setPaletteIndex((paletteIndex + d + paletteFiltered.length) % paletteFiltered.length);
  document.querySelectorAll("#palette-list .palette-item")[paletteIndex]?.scrollIntoView({ block: "nearest" });
}
function runPaletteSelection() {
  const a = paletteFiltered[paletteIndex];
  closeCommandPalette();
  if (a) { try { a.run(); } catch (e) { toast(String(e), true); } }
}

// ── Keyboard shortcuts help (toolbar ⌨ button) ───────────────────────────
const SHORTCUTS = [
  ["Panes & tabs / 패인·탭", [
    ["Ctrl+Shift+D", "Split horizontally / 가로 분할"],
    ["Ctrl+Shift+E", "Split vertically / 세로 분할"],
    ["Ctrl+Shift+W", "Close pane / 패인 닫기"],
    ["Ctrl+Shift+N", "New terminal / 새 터미널·탭"],
    ["Ctrl+Tab", "Next pane / 다음 패인"],
    ["Ctrl+Shift+Tab", "Previous pane / 이전 패인"],
    ["Alt + ← ↑ ↓ →", "Move focus between panes / 패인 간 이동"],
    ["Ctrl+Shift+Z", "Zoom / restore pane / 패인 최대화"],
    ["Ctrl + `", "Focus terminal / 터미널 포커스"],
  ]],
  ["Terminal tools / 터미널 도구", [
    ["Ctrl+Shift+P", "Command palette / 커맨드 팔레트"],
    ["Ctrl+Shift+F", "Search scrollback / 스크롤백 검색"],
    ["Ctrl+Shift+B", "Broadcast input to tab / 입력 브로드캐스트"],
    ["Ctrl+Shift+↑ / ↓", "Jump between prompts / 프롬프트 점프"],
    ["Ctrl + / Ctrl − / Ctrl 0", "Font size / 글자 크기"],
    ["Ctrl+Click", "Open link in browser / 링크 열기"],
  ]],
  ["Command line / 명령줄", [
    ["Ctrl+A", "Select the current input line / 입력줄 전체 선택"],
    ["Ctrl+C", "Copy selection (else interrupt) / 선택 복사 (없으면 중단)"],
    ["Ctrl+X", "Cut the current input line / 입력줄 잘라내기"],
    ["Ctrl+V  ·  Shift+Insert", "Paste / 붙여넣기"],
    ["Home", "Beginning of line / 줄 맨 앞으로"],
  ]],
];
function initShortcutsHelp() {
  const btn = document.getElementById("btn-shortcuts");
  const ov = document.getElementById("shortcuts-overlay");
  const body = document.getElementById("shortcuts-body");
  if (!btn || !ov || !body) return;
  body.innerHTML = SHORTCUTS.map(([group, rows]) => `
    <div class="sc-group">
      <div class="sc-group-title">${esc(group)}</div>
      ${rows.map(([k, d]) => `<div class="sc-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join("")}
    </div>`).join("");
  btn.addEventListener("click", openShortcutsHelp);
  document.getElementById("shortcuts-close")?.addEventListener("click", closeShortcutsHelp);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeShortcutsHelp(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.classList.contains("hidden")) closeShortcutsHelp(); });
}
function openShortcutsHelp() { document.getElementById("shortcuts-overlay")?.classList.remove("hidden"); }
function closeShortcutsHelp() {
  document.getElementById("shortcuts-overlay")?.classList.add("hidden");
  const t = terminals.get(focusedPaneId);
  if (t) try { t.term.focus(); } catch {}
}

// Resolve the user's default-shell preference into an identifier for the
// backend. Unset preference defaults to PowerShell ("powershell" → pwsh, or
// built-in powershell.exe when pwsh is absent); "bash" → undefined → Git Bash.
function getDefaultShellId() {
  let pref = "powershell";
  try { pref = localStorage.getItem("mymux.defaultShell") || "powershell"; } catch {}
  if (pref === "powershell") return "powershell";
  if (pref === "cmd") return "cmd.exe";
  return undefined;
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
    const launch = shell !== undefined ? shell : getDefaultShellId();
    const ptyId = await createPane(rootContainer, launch, null, cwd);
    tabs.set(tabIdx, {
      el: tabEl,
      rootEl: rootContainer,
      panes: [ptyId],
      label,
      session: { kind: "local", shell: shell || null, cwd: cwd || null },
    });
    const ti0 = terminals.get(ptyId);
    if (ti0) ti0.session = { kind: "local", shell: shell || null, cwd: cwd || null };
    addTab(tabIdx, label);
    switchToTab(tabIdx);
    refreshSessionList();
  } catch (err) {
    toast("Failed: " + err, true);
    tabEl.remove();
    terminalWelcome.style.display = "";
  }
}

// Reparenting a live pane (split/close/drag-retile/move-to-tab) detaches its
// .xterm-viewport, and the browser resets that element's scrollTop to 0. xterm
// hears the stray scroll event and believes the user scrolled up, so every
// later bottom-pin check — refitAllPanes' wasAtBottom, xterm's own
// follow-output — sees "not at bottom". Net effect: shrink a long session by
// splitting it and the viewport freezes on the old content region, the last
// lines (prompt included) hidden below the fold. Capture who sat at the bottom
// BEFORE the DOM move; the returned repin re-scrolls them now and on the next
// two frames (the reset event lands within the first frame, and the post-move
// refit runs a frame later — cover both sides).
function captureBottomPins() {
  const pinned = [];
  for (const [id, t] of terminals) {
    try {
      const buf = t.term.buffer.active;
      if (buf.viewportY >= buf.baseY) pinned.push(id);
    } catch {}
  }
  const apply = () => {
    for (const id of pinned) {
      const t = terminals.get(id);
      if (t) try { t.term.scrollToBottom(); } catch {}
    }
  };
  return () => {
    apply();
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
  };
}

// Split the focused pane
async function splitPane(direction, cwd) {
  if (!focusedPaneId) return;
  clearPaneZoom(); // layout is about to change — drop any zoom overlay first
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

  // Move existing pane into split (scroll pin captured first — see
  // captureBottomPins for why reparenting breaks bottom-follow).
  const repin = captureBottomPins();
  parent.replaceChild(splitContainer, paneEl);
  splitContainer.appendChild(paneEl);
  repin();

  // Add divider
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  splitContainer.appendChild(divider);
  setupDividerDrag(divider, splitContainer, direction);

  // Create new pane
  try {
    const splitShell = getDefaultShellId();
    const newPtyId = await createPane(splitContainer, splitShell, null, cwd);
    currentTab.panes.push(newPtyId);
    const nti = terminals.get(newPtyId);
    if (nti) nti.session = { kind: "local", shell: splitShell || null, cwd: cwd || null };
    refreshSessionList();

    // Refit all panes in this tab, then re-assert the bottom pin — the spawn
    // spans several frames, past the repin scheduled at the DOM move.
    await new Promise((r) => requestAnimationFrame(r));
    refitAllPanes();
    repin();
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
  clearPaneZoom(); // layout is about to change — drop any zoom overlay first

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

  // If split container now has only one child (+ divider), unwrap it — a
  // reparent of the surviving pane/subtree, so preserve its bottom pin.
  const repin = captureBottomPins();
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
  repin();
}

// A PTY that hit EOF — the shell process exited (`exit`, an SSH drop, a crash).
// The read loop calls this so the dead session doesn't linger frozen on screen;
// tearing it down is exactly a manual pane close (unwrap the split, close the
// tab if it was the last pane). Historically this was CALLED from the read loop
// but never DEFINED, so the ReferenceError was swallowed by that loop's catch
// and exited panes were left on screen until manually closed.
function closeTerminal(ptyId) {
  closePane(ptyId);
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

// Move a pane (session) from its current tab into another tab (drag in the list).
function movePaneToTab(ptyId, targetTabIdx) {
  const srcTab = findTabForPane(ptyId);
  const dstTab = tabs.get(targetTabIdx);
  if (!srcTab || !dstTab || srcTab.tabIdx === targetTabIdx) return;
  clearPaneZoom(); // layout is about to change — drop any zoom overlay first
  const t = terminals.get(ptyId);
  if (!t || !dstTab.rootEl) return;
  const leaf = t.paneEl;

  try {
    // Detach from the source tree (collapses now-empty split containers).
    // Both the moved leaf and collapsed siblings get reparented — keep pins.
    const repin = captureBottomPins();
    detachAndCollapse(leaf, srcTab);
    srcTab.panes = srcTab.panes.filter((p) => p !== ptyId);

    // Append into the destination root as a new split column/row.
    const dstRoot = dstTab.rootEl;
    if (dstRoot.children.length > 0) {
      const vertical = dstRoot.classList.contains("vertical");
      const divider = document.createElement("div");
      divider.className = "pane-divider";
      dstRoot.appendChild(divider);
      setupDividerDrag(divider, dstRoot, vertical ? "vertical" : "horizontal");
    }
    leaf.style.flex = "1";
    dstRoot.appendChild(leaf);
    dstTab.panes.push(ptyId);

    // Close the source tab if it has no panes left (and tell the user).
    const srcEmptied = srcTab.panes.length === 0;
    const srcLabel = srcTab.label || `Tab ${srcTab.tabIdx + 1}`;
    if (srcEmptied) closeTab(srcTab.tabIdx);

    switchToTab(targetTabIdx);
    setFocusedPane(ptyId);
    refreshSessionList();
    // Re-assert the pin synchronously now that the leaf is reparented AND
    // visible (switchToTab) — without this, the pane paints one frame of old
    // scrollback before the rAF apply snaps it to the bottom. Then re-confirm
    // after the refit, which spans the next frame.
    repin();
    requestAnimationFrame(() => { refitAllPanes(); repin(); });
    if (srcEmptied) toast(`Closed the '${srcLabel}' tab — it was the last session`);
  } catch (e) {
    toast("탭이동 오류: " + (e && e.message), true);
    console.error("movePaneToTab failed", e);
  }
}

// NOTE: resize used to leave a stale wrapped prompt + a cursor parked left of
// the "$" in bash panes. Post-resize PTY "nudges" (cols-1→cols, rows+1→rows)
// were tried here and made it WORSE: every extra SIGWINCH re-triggers
// readline's buggy wrapped-prompt redisplay (stale cursor-up math + \b
// overcorrection by the invisible color escapes — captured with
// examples/conpty_probe.rs). The real fix is in mymux_bashrc(): the directory
// lives outside PS1, so the prompt readline redraws can never wrap.

// Refit panes to their container. By default a pane whose pixel size hasn't
// actually changed is skipped: refitting an unchanged pane reflows xterm (which
// pulls scrollback up — the content visibly "jumps") and fires a needless
// SIGWINCH that makes idle shells redraw. The active/streaming pane stays
// bottom-pinned so it looks fine, which is why only idle panes appeared to jump.
// `force` (e.g. font-size change) bypasses the size cache.
function refitAllPanes(force = false) {
  for (const [id, t] of terminals) {
    try {
      const host = (t.term.element && t.term.element.parentElement) || t.paneEl;
      const w = host ? host.clientWidth : 0;
      const h = host ? host.clientHeight : 0;
      if (w === 0 || h === 0) continue;                       // hidden/transient: never fit to 0
      if (!force && w === t._fitW && h === t._fitH) {
        // Pixel size unchanged, so no reflow is needed. But the PTY's grid can
        // still have drifted out of sync with xterm — a transient bad fit, a
        // dropped pty_resize, or focus being stolen while backgrounded. A
        // desynced winsize is exactly what makes a TUI's wrapped lines lose
        // their indent and collapse to column 0 ("줄바꿈이 앞으로 붙는" 증상):
        // the program wraps for the PTY's width but xterm renders a narrower
        // grid, so the overflow rewraps at column 0. Reconcile cheaply — no
        // fit() means no reflow and no content jump — by just re-notifying the
        // backend when the live grid differs from what it last received.
        if (t.term.cols !== t._fitCols || t.term.rows !== t._fitRows) {
          t._fitCols = t.term.cols;
          t._fitRows = t.term.rows;
          invoke("pty_resize", { id, cols: t.term.cols, rows: t.term.rows });
        }
        continue;
      }
      t._fitW = w;
      t._fitH = h;

      // Keep bottom-pinned panes pinned across the reflow; leave others put.
      const buf = t.term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;

      t.fitAddon.fit();

      if (wasAtBottom) { try { t.term.scrollToBottom(); } catch {} }

      // Only notify the backend when the grid actually changed (a no-op resize
      // still delivers SIGWINCH and makes the shell redraw).
      if (t.term.cols !== t._fitCols || t.term.rows !== t._fitRows) {
        t._fitCols = t.term.cols;
        t._fitRows = t.term.rows;
        invoke("pty_resize", { id, cols: t.term.cols, rows: t.term.rows });
      }
    } catch {}
  }
}

// Terminal font size (Ctrl +/-/0), applied to all panes and persisted.
// Force every open terminal to re-measure its character cell. xterm caches the
// cell size at open() time; if the embedded font wasn't fully applied yet — the
// case for the FIRST session created at startup — that cached metric is stale
// and the prompt cursor lands a few columns left of the "$". Toggling fontSize
// re-runs the measurement (the same path Ctrl +/- uses), then we repaint+re-grid.
function remeasureFontCells() {
  for (const [, t] of terminals) {
    try {
      const fs = t.term.options.fontSize;
      t.term.options.fontSize = fs + 1; // change → triggers a cell re-measure
      t.term.options.fontSize = fs;     // restore → re-measures with the real font
      if (t.term.clearTextureAtlas) t.term.clearTextureAtlas();
    } catch {}
  }
  refitAllPanes(true);
}
function setTerminalFontSize(size) {
  terminalFontSize = Math.max(8, Math.min(40, size));
  try { localStorage.setItem("mymux.termFontSize", String(terminalFontSize)); } catch {}
  for (const [, t] of terminals) {
    try {
      t.term.options.fontSize = terminalFontSize;
      t.term.options.letterSpacing = terminalFontSize * letterSpacingRatio; // keep tracking across zoom
    } catch {}
  }
  refitAllPanes(true); // font change keeps pixel size but must re-grid every pane
}
function adjustTerminalFontSize(delta) {
  setTerminalFontSize(terminalFontSize + delta);
}
// Letter spacing (자간) — persisted ratio of font size, applied to every pane.
// Mirrors setTerminalFontSize; a wider cell means fewer cols, so re-grid + refit.
function setLetterSpacingRatio(ratio) {
  letterSpacingRatio = Math.max(0, Math.min(0.4, Math.round(ratio * 1000) / 1000));
  try { localStorage.setItem("mymux.termLetterSpacing", String(letterSpacingRatio)); } catch {}
  for (const [, t] of terminals) {
    try { t.term.options.letterSpacing = terminalFontSize * letterSpacingRatio; } catch {}
  }
  refitAllPanes(true);
}
function adjustLetterSpacing(delta) {
  setLetterSpacingRatio(letterSpacingRatio + delta);
}

// Cycle focus through the active tab's panes in reading order
// (top-to-bottom rows, left-to-right within a row). dir: +1 next, -1 prev.
function focusNextPane(dir) {
  if (activeTabIdx == null || browserTabActive) return;
  const tab = tabs.get(activeTabIdx);
  if (!tab || !tab.panes || tab.panes.length < 2) return;
  const ordered = tab.panes
    .map((id) => ({ id, t: terminals.get(id) }))
    .filter((p) => p.t && p.t.paneEl)
    .map((p) => ({ id: p.id, r: p.t.paneEl.getBoundingClientRect() }))
    .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 5 ? a.r.top - b.r.top : a.r.left - b.r.left));
  const ids = ordered.map((p) => p.id);
  let idx = ids.indexOf(focusedPaneId);
  if (idx < 0) idx = 0;
  const next = (idx + dir + ids.length) % ids.length;
  setFocusedPane(ids[next]);
}

// ── Pane drag-to-rearrange ──
function computeDropPosition(leaf, e) {
  const r = leaf.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const d = { top: y, bottom: 1 - y, left: x, right: 1 - x };
  let pos = "top", min = d.top;
  for (const k of ["bottom", "left", "right"]) {
    if (d[k] < min) { min = d[k]; pos = k; }
  }
  return pos;
}

function getDropIndicator() {
  let ind = document.getElementById("drop-indicator");
  if (!ind) {
    ind = document.createElement("div");
    ind.id = "drop-indicator";
    document.body.appendChild(ind);
  }
  return ind;
}
function showDropIndicator(leaf, position) {
  const ind = getDropIndicator();
  const r = leaf.getBoundingClientRect();
  let left = r.left, top = r.top, width = r.width, height = r.height;
  if (position === "top") height = r.height / 2;
  else if (position === "bottom") { top = r.top + r.height / 2; height = r.height / 2; }
  else if (position === "left") width = r.width / 2;
  else if (position === "right") { left = r.left + r.width / 2; width = r.width / 2; }
  ind.style.display = "block";
  ind.style.left = left + "px";
  ind.style.top = top + "px";
  ind.style.width = width + "px";
  ind.style.height = height + "px";
}
function hideDropIndicator() {
  const ind = document.getElementById("drop-indicator");
  if (ind) ind.style.display = "none";
}

function startPaneDrag(srcId, startEvent) {
  startEvent.preventDefault();
  let dragging = false;
  let curTarget = null;
  let curPos = null;
  const onMove = (e) => {
    if (!dragging) {
      if (Math.abs(e.clientX - startEvent.clientX) + Math.abs(e.clientY - startEvent.clientY) < 5) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const leaf = el && el.closest ? el.closest(".pane-leaf") : null;
    const tid = leaf && leaf.dataset && leaf.dataset.ptyId ? Number(leaf.dataset.ptyId) : null;
    if (leaf && tid && tid !== srcId && terminals.has(tid)) {
      curTarget = tid;
      curPos = computeDropPosition(leaf, e);
      showDropIndicator(leaf, curPos);
    } else {
      curTarget = null;
      hideDropIndicator();
    }
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    hideDropIndicator();
    if (dragging && curTarget != null) movePane(srcId, curTarget, curPos);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Detach a pane-leaf from its split container and collapse the leftover
// single-child container (mirrors closePane's cleanup).
function detachAndCollapse(leaf, tab) {
  const container = leaf.parentElement;
  leaf.remove();
  if (!container) return;
  const divider = [...container.children].find(
    (c) => c.classList && c.classList.contains("pane-divider")
  );
  if (divider) divider.remove();
  const remaining = container.children[0];
  if (remaining) {
    if (container.parentElement && container !== tab.rootEl) {
      container.parentElement.replaceChild(remaining, container);
    }
    if (remaining.style) remaining.style.flex = "1";
  }
}

// Move `srcId` next to `targetId` on the given side (top/bottom/left/right),
// within the same tab.
function movePane(srcId, targetId, position) {
  if (srcId === targetId) return;
  const src = terminals.get(srcId);
  const target = terminals.get(targetId);
  if (!src || !target) return;
  clearPaneZoom(); // layout is about to change — drop any zoom overlay first
  const tab = findTabForPane(targetId);
  if (!tab || !tab.panes.includes(srcId)) return; // same-tab moves only

  const srcLeaf = src.paneEl;
  const targetLeaf = target.paneEl;

  // Re-tiling reparents both leaves (and any collapsed sibling) — keep pins.
  const repin = captureBottomPins();
  detachAndCollapse(srcLeaf, tab);

  const parent = targetLeaf.parentElement;
  if (!parent) return;

  const vertical = position === "top" || position === "bottom";
  const before = position === "top" || position === "left";

  const split = document.createElement("div");
  split.className = `pane-container ${vertical ? "vertical" : "horizontal"}`;
  split.style.cssText = "flex:1;";
  parent.replaceChild(split, targetLeaf);

  const divider = document.createElement("div");
  divider.className = "pane-divider";
  srcLeaf.style.flex = "1";
  targetLeaf.style.flex = "1";

  if (before) {
    split.append(srcLeaf, divider, targetLeaf);
  } else {
    split.append(targetLeaf, divider, srcLeaf);
  }
  setupDividerDrag(divider, split, vertical ? "vertical" : "horizontal");
  repin();

  setFocusedPane(srcId);
  requestAnimationFrame(() => { refitAllPanes(); repin(); });
}

async function connectSsh() {
  await connectSshFields(sshInput.value, sshPort.value, sshPassword.value, sshKeyfile.value);
}

// Shared SSH connect from raw field values — used by the welcome form AND the
// "+ SSH" modal (so a new connection can be opened with sessions already open).
async function connectSshFields(targetVal, portVal, password, keyfile, tmux, tmuxName) {
  const target = (targetVal || "").trim();
  if (!target) return false;
  const parts = target.split("@");
  if (parts.length !== 2) { toast("Format: user@hostname", true); return false; }
  await doSshConnect({
    target,
    username: parts[0],
    host: parts[1],
    port: parseInt(portVal) || 22,
    password: (password || "") || null,
    keyPath: (keyfile || "").trim() || null,
    tmux: !!tmux,
    tmuxName: tmuxName || null,
  });
  return true;
}

// ── "+ SSH" modal — open a new SSH connection at any time ──
function openSshModal() {
  const m = document.getElementById("ssh-modal");
  if (!m) return;
  // The native browser overlay floats above all HTML; hide it so the modal shows.
  if (browserTabActive && browserMode === "native") invoke("browser_pane_hide").catch(() => {});
  m.classList.remove("hidden");
  const inp = document.getElementById("ssh-modal-input");
  if (inp) inp.focus();
}

function closeSshModal() {
  const m = document.getElementById("ssh-modal");
  if (m) m.classList.add("hidden");
  toggleSshDropdown(false);
  const pw = document.getElementById("ssh-modal-password");
  if (pw) pw.value = "";
  // Restore the native browser overlay only if we're still on the browser view.
  if (browserTabActive && browserMode === "native") openNativePane();
}

async function submitSshModal() {
  const target = document.getElementById("ssh-modal-input").value;
  const port = document.getElementById("ssh-modal-port").value;
  const password = document.getElementById("ssh-modal-password").value;
  const keyfile = document.getElementById("ssh-modal-keyfile").value;
  const save = document.getElementById("ssh-save-info");
  const tmux = document.getElementById("ssh-tmux");
  const tmuxName = document.getElementById("ssh-tmux-name");
  const ok = await connectSshFields(target, port, password, keyfile, tmux && tmux.checked, tmuxName && tmuxName.value);
  if (ok) {
    if (save && save.checked) saveSshConn(target.trim(), parseInt(port) || 22, (keyfile || "").trim());
    closeSshModal();
  }
}

// ── Saved SSH connections (address dropdown; password is NEVER stored) ──
function getSshSaved() {
  try { return JSON.parse(localStorage.getItem("mymux.sshSaved") || "[]"); } catch { return []; }
}
function setSshSaved(arr) {
  try { localStorage.setItem("mymux.sshSaved", JSON.stringify(arr)); } catch {}
}
function saveSshConn(target, port, keyPath) {
  if (!target) return;
  const arr = getSshSaved().filter((c) => c.target !== target);
  arr.unshift({ target, port: port || 22, keyPath: keyPath || "" });
  setSshSaved(arr.slice(0, 30));
}
function deleteSshConn(target) {
  setSshSaved(getSshSaved().filter((c) => c.target !== target));
  renderSshDropdown();
  if (!getSshSaved().length) toggleSshDropdown(false);
}
function applySshConn(c) {
  const inp = document.getElementById("ssh-modal-input");
  const port = document.getElementById("ssh-modal-port");
  const key = document.getElementById("ssh-modal-keyfile");
  if (inp) inp.value = c.target || "";
  if (port) port.value = c.port || 22;
  if (key) key.value = c.keyPath || "";
}
function renderSshDropdown() {
  const list = document.getElementById("ssh-addr-list");
  if (!list) return;
  list.innerHTML = "";
  for (const c of getSshSaved()) {
    const item = document.createElement("div");
    item.className = "ssh-dd-item";
    item.innerHTML = `<span class="ssh-dd-name"></span>` +
      (c.keyPath ? `<button class="ssh-dd-tmux" type="button" title="Connect into tmux">⚡</button>` : "") +
      `<button class="ssh-dd-x" type="button" title="Delete">&times;</button>`;
    const label = c.target + (c.port && c.port != 22 ? `:${c.port}` : "") + (c.keyPath ? "  🔑" : "");
    item.querySelector(".ssh-dd-name").textContent = label;
    item.querySelector(".ssh-dd-name").addEventListener("click", () => { applySshConn(c); toggleSshDropdown(false); });
    const tmuxBtn = item.querySelector(".ssh-dd-tmux");
    if (tmuxBtn) tmuxBtn.addEventListener("click", (e) => { e.stopPropagation(); quickConnectTmux(c); });
    item.querySelector(".ssh-dd-x").addEventListener("click", (e) => { e.stopPropagation(); deleteSshConn(c.target); });
    list.appendChild(item);
  }
}
function toggleSshDropdown(show) {
  const list = document.getElementById("ssh-addr-list");
  if (!list) return;
  if (show === undefined) show = list.classList.contains("hidden");
  if (show) {
    if (!getSshSaved().length) { list.classList.add("hidden"); toast("No saved addresses."); return; }
    renderSshDropdown();
    list.classList.remove("hidden");
  } else {
    list.classList.add("hidden");
  }
}
async function pickSshKeyFile() {
  try {
    const path = await invoke("pick_key_file");
    if (path) {
      const key = document.getElementById("ssh-modal-keyfile");
      if (key) key.value = path;
    }
  } catch (e) { /* cancelled */ }
}

// Build a runnable `ssh … "tmux …"` command string for a connection.
function buildSshCommandString(target, port, keyPath, tmux, tmuxName) {
  let cmd = "ssh";
  if (port && Number(port) !== 22) cmd += ` -p ${Number(port)}`;
  if (keyPath) cmd += ` -i "${keyPath}"`;
  if (tmux) cmd += " -t";
  cmd += ` ${target}`;
  if (tmux) {
    const nm = (tmuxName || "").trim().replace(/[^A-Za-z0-9_.-]/g, "");
    cmd += nm ? ` "tmux new-session -A -s ${nm}"` : ` "tmux attach || tmux new-session"`;
  }
  return cmd;
}

// Save the modal's connection as a Commands-tab shortcut (Send/dblclick to run).
async function saveSshAsCommand() {
  const target = (document.getElementById("ssh-modal-input").value || "").trim();
  if (!target) { toast("Enter an address (user@host)", true); return; }
  const port = document.getElementById("ssh-modal-port").value;
  const keyfile = (document.getElementById("ssh-modal-keyfile").value || "").trim();
  const tmuxChk = document.getElementById("ssh-tmux");
  const tmux = tmuxChk && tmuxChk.checked;
  const tmuxName = (document.getElementById("ssh-tmux-name").value || "").trim();
  const command = buildSshCommandString(target, port, keyfile, tmux, tmuxName);
  const name = target + (tmux ? (tmuxName ? ` (tmux:${tmuxName})` : " (tmux)") : "");
  try {
    await invoke("add_command", { name, command, description: "SSH connection shortcut" });
    await loadCommands();
    toast("Saved to Commands — connect with Send");
  } catch (e) {
    toast("Save failed: " + String(e), true);
  }
}

// One-click: SSH in with the saved key and start/attach a tmux session.
function quickConnectTmux(c) {
  const parts = (c.target || "").split("@");
  if (parts.length !== 2) { toast("Format: user@hostname", true); return; }
  closeSshModal();
  doSshConnect({
    target: c.target,
    username: parts[0],
    host: parts[1],
    port: c.port || 22,
    password: null,
    keyPath: c.keyPath || null,
    auth: "key",
    tmux: true,
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

  const sshArgs = ["-p", String(port)];
  if (keyPath) sshArgs.push("-i", keyPath); // use the specified key for the terminal too
  sshArgs.push(target);
  // tmux on connect: a name → create/attach that session; empty → attach to an
  // existing session (or start one if none).
  if (opts.tmux) {
    const nm = (opts.tmuxName || "").trim().replace(/[^A-Za-z0-9_.-]/g, "");
    sshArgs.push("-t", nm ? `tmux new-session -A -s ${nm}` : "tmux attach || tmux new-session");
  }

  try {
    const ptyId = await createPane(rootContainer, "ssh", sshArgs);
    terminals.get(ptyId).sshTarget = target;
    terminals.get(ptyId).session = { kind: "ssh", target, username, host, port, keyPath: keyPath || null, auth };

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
function browserEnabled() {
  try { return localStorage.getItem("mymux.browserEnabled") !== "false"; } catch { return true; }
}
function applyBrowserEnabled() {
  const on = browserEnabled();
  const tab = document.getElementById("browser-tab");
  if (tab) tab.style.display = on ? "" : "none";
  const btn = document.getElementById("btn-toggle-browser");
  if (btn) { btn.classList.toggle("active", on); btn.title = on ? "Turn off browser" : "Turn on browser"; }
  if (!on) {
    // Turning the browser off is also the escape hatch for a stuck native
    // overlay: leave the view if open, and force-hide the child WebView either way.
    if (browserTabActive) setBrowserView(false);
    else invoke("browser_pane_hide").catch(() => {});
  }
}
function toggleBrowserEnabled() {
  try { localStorage.setItem("mymux.browserEnabled", browserEnabled() ? "false" : "true"); } catch {}
  applyBrowserEnabled();
}

function initBrowserPanel() {
  // Persistent Browser tab pinned at the left of the tab strip.
  const tab = document.createElement("div");
  tab.className = "browser-tab";
  tab.id = "browser-tab";
  tab.innerHTML = `${ICON.globe}<span>Browser</span><span class="tab-close" title="Close">&times;</span>`;
  tab.title = "Playwright/CDP browser";
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) { setBrowserView(false); return; }
    setBrowserView(true);
  });
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
    if (viewerActive) setViewerView(false);
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
    // Return focus to the terminal so the app is immediately interactive again
    // (the native overlay holding focus makes the rest of the UI feel inert).
    if (activeTermId && terminals.has(activeTermId)) terminals.get(activeTermId).term.focus();
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
// Serialize a tab's pane layout (DOM tree) into a saveable structure.
// A leaf → { leaf: <pane session> }; a split container → { dir, children: [...] }.
function serializePane(el) {
  if (el.classList && el.classList.contains("pane-leaf")) {
    const id = Number(el.dataset.ptyId);
    const t = terminals.get(id);
    return { leaf: t && t.session ? t.session : { kind: "local", shell: null, cwd: null } };
  }
  const dir = el.classList && el.classList.contains("vertical") ? "vertical" : "horizontal";
  const children = [...el.children]
    .filter((c) => c.classList && (c.classList.contains("pane-leaf") || c.classList.contains("pane-container")))
    .map(serializePane);
  return { dir, children };
}

function collectSession() {
  const arr = [];
  for (const [, tab] of tabs) {
    if (tab.panes && tab.panes.length > 1 && tab.rootEl) {
      // Multi-pane tab → persist the full split layout (tree).
      arr.push({ label: tab.label, tree: serializePane(tab.rootEl) });
    } else if (tab.session) {
      // Single-pane tab → flat entry (backward-compatible with v1).
      arr.push({ ...tab.session, label: tab.label });
    }
  }
  return { version: 2, tabs: arr };
}

// Rebuild a saved pane tree into `parentEl`, spawning each leaf's terminal.
async function buildPaneNode(parentEl, node) {
  if (node && node.leaf) {
    const s = node.leaf;
    if (s.kind === "ssh") {
      const id = await createPane(parentEl, "ssh", ["-p", String(s.port || 22), s.target]);
      const t = terminals.get(id);
      if (t) { t.sshTarget = s.target; t.session = { ...s }; }
    } else {
      const id = await createPane(parentEl, s.shell || getDefaultShellId(), null, s.cwd || undefined);
      const t = terminals.get(id);
      if (t) t.session = { kind: "local", shell: s.shell || null, cwd: s.cwd || null };
    }
    return;
  }
  const dir = node && node.dir === "vertical" ? "vertical" : "horizontal";
  const container = document.createElement("div");
  container.className = "pane-container " + dir;
  container.style.cssText = "flex:1;";
  parentEl.appendChild(container);
  const kids = (node && node.children) || [];
  for (let i = 0; i < kids.length; i++) {
    if (i > 0) {
      const divider = document.createElement("div");
      divider.className = "pane-divider";
      container.appendChild(divider);
      setupDividerDrag(divider, container, dir);
    }
    await buildPaneNode(container, kids[i]);
  }
}

// Restore a multi-pane tab from its saved split tree.
async function restoreTabFromTree(tabData) {
  terminalWelcome.style.display = "none";
  const tabIdx = tabCounter++;
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-instance active";
  terminalContainer.appendChild(tabEl);

  await buildPaneNode(tabEl, tabData.tree);

  const rootEl = [...tabEl.children].find((c) => c.classList && c.classList.contains("pane-container"));
  const paneIds = [...tabEl.querySelectorAll(".pane-leaf")]
    .map((el) => Number(el.dataset.ptyId))
    .filter((n) => !Number.isNaN(n) && terminals.has(n));
  if (paneIds.length === 0 || !rootEl) {
    tabEl.remove();
    return;
  }
  const label = tabData.label || "Terminal";
  tabs.set(tabIdx, {
    el: tabEl,
    rootEl,
    panes: paneIds,
    label,
    session: terminals.get(paneIds[0]) ? terminals.get(paneIds[0]).session : null,
  });
  addTab(tabIdx, label);
  switchToTab(tabIdx);
  refreshSessionList();
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
      if (s.tree) {
        await restoreTabFromTree(s);
      } else if (s.kind === "ssh") {
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
      `${s.username}@${s.host}:${s.port} — enter your password to reconnect`;
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
      // Restore the native browser overlay we hid to surface this dialog.
      if (browserTabActive && browserMode === "native") openNativePane();
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
  // The native browser webview floats above ALL HTML, including this close
  // dialog — if it's showing, the modal would be trapped behind it and the app
  // would appear frozen (only the browser responds). Hide it first; the
  // close-cancel handler restores it if the user backs out.
  await invoke("browser_pane_hide").catch(() => {});
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
    fontSize: terminalFontSize,
    // Letter spacing (자간) — a persisted ratio of the font size so it scales with
    // Ctrl +/- zoom. Default ≈0.1 (~20% of a monospace cell) because Korean/CJK
    // glyphs look cramped at 0; adjustable from the toolbar (자−/자+).
    letterSpacing: terminalFontSize * letterSpacingRatio,
    fontFamily: '"D2Coding", "Cascadia Code", "Consolas", "Noto Sans KR", monospace',
    fontWeight: 300,
    fontWeightBold: 500,
    theme: terminalTheme(),
  });
}

function addTab(tabIdx, label) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = tabIdx;
  tab.innerHTML = `
    <span>${esc(label)}</span>
    <span class="tab-rename" title="Rename">&#9998;</span>
    <span class="tab-close" title="Close">&times;</span>
  `;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) {
      closeTab(tabIdx);
    } else if (e.target.classList.contains("tab-rename")) {
      e.stopPropagation();
      startRenameTabInBar(tabIdx, tab);
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
  if (viewerActive) setViewerView(false);
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
  clearUnseenForTab(tabIdx); // its panes are visible now — clear activity dots
  updateBroadcastUi();       // reflect this tab's broadcast state on the toolbar
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

// Update a pane's working-directory label (shown next to the pane label).
function setPaneCwd(ptyId, path) {
  const t = terminals.get(ptyId);
  if (!t) return;
  t.cwd = path || null;
  const el = t.paneEl && t.paneEl.querySelector(".pane-cwd");
  if (el) {
    const lbl = t.paneEl.querySelector(".pane-label");
    const labelText = lbl ? lbl.textContent : "";
    const cwdLabel = path ? baseName(path) : "~";
    // Blank (→ hidden via .pane-cwd:empty) when it would just repeat the label.
    el.textContent = cwdLabel === labelText ? "" : cwdLabel;
    el.title = path || "";
  }
}

// Reorder a session within its own tab's panes — changes the session-list order
// and the #N numbering. (The split layout on screen is left as-is; moving a
// session to a *different* tab uses movePaneToTab, which relocates the pane.)
function reorderSessionWithin(tab, dragId, targetId, after) {
  const arr = tab.panes;
  const from = arr.indexOf(dragId);
  if (from < 0) return;
  arr.splice(from, 1);
  const to = arr.indexOf(targetId);
  if (to < 0) arr.push(dragId);
  else arr.splice(after ? to + 1 : to, 0, dragId);
  refreshSessionList();
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
    group.title = "Double-click to rename · drop a session here to move it to this tab";
    group.addEventListener("dblclick", () => startRenameTab(tabIdx, group));
    group.addEventListener("dragover", (e) => { e.preventDefault(); group.classList.add("drop-target"); });
    group.addEventListener("dragleave", () => group.classList.remove("drop-target"));
    group.addEventListener("drop", (e) => {
      e.preventDefault();
      group.classList.remove("drop-target");
      const pid = Number(e.dataTransfer.getData("text/plain"));
      if (pid) movePaneToTab(pid, tabIdx);
    });
    sessionListEl.appendChild(group);

    tab.panes.forEach((ptyId, i) => {
      const t = terminals.get(ptyId);
      if (!t) return;
      const dot = t.type === "ssh" ? ICON.globe : "▸";

      const li = document.createElement("li");
      li.className = "session-item" + (ptyId === focusedPaneId ? " active" : "");
      if (t.unseen) li.classList.add("unseen");
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

      const closeBtn = document.createElement("button");
      closeBtn.className = "session-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close session";

      li.append(dotEl, nameEl, renameBtn, paneNo, closeBtn);

      // Drag a session: reorder it within its own tab, or drop it onto another
      // tab's session (or that tab's group header) to move it to that tab.
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(ptyId));
        e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        li.classList.toggle("drop-below", after);
        li.classList.toggle("drop-above", !after);
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-above", "drop-below"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("drop-above", "drop-below");
        const dragId = Number(e.dataTransfer.getData("text/plain"));
        if (!dragId || dragId === ptyId) return;
        const srcTab = findTabForPane(dragId);
        const dstTab = findTabForPane(ptyId);
        if (!srcTab || !dstTab) return;
        if (srcTab.tabIdx === dstTab.tabIdx) {
          const rect = li.getBoundingClientRect();
          const after = (e.clientY - rect.top) > rect.height / 2;
          reorderSessionWithin(dstTab, dragId, ptyId, after); // same tab → reorder
        } else {
          movePaneToTab(dragId, dstTab.tabIdx);               // other tab → move
        }
      });

      li.addEventListener("click", () => focusSession(ptyId));
      nameEl.addEventListener("dblclick", (e) => { e.stopPropagation(); startRenameSession(ptyId, nameEl); });
      renameBtn.addEventListener("click", (e) => { e.stopPropagation(); startRenameSession(ptyId, nameEl); });
      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closePane(ptyId); });

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

// #rrggbb → rgba(r,g,b,a); falls back to a visible blue if the value isn't hex.
function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return `rgba(90,150,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
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
    // Accent-tinted, translucent selection — the old `border` color sat almost
    // on top of the terminal background, so a selection (e.g. Ctrl+A on the
    // input line) was nearly invisible. Translucent keeps the text readable.
    selectionBackground: hexToRgba(accent, 0.42),
    selectionInactiveBackground: hexToRgba(accent, 0.30),
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
      btn.addEventListener("click", () => explorerGo(drive, null));
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

  // Filter by the search box (name / command / description).
  const q = (document.getElementById("cmd-search")?.value || "").trim().toLowerCase();
  const list = q
    ? cmds.filter((c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.command || "").toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q))
    : cmds;

  if (list.length === 0) { if (emptyEl) emptyEl.classList.remove("hidden"); return; }
  if (emptyEl) emptyEl.classList.add("hidden");

  // Favorites pinned to the top; otherwise keep stored order.
  const ordered = [...list].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

  for (const cmd of ordered) {
    const li = document.createElement("li");
    li.className = "cmd-item" + (cmd.favorite ? " is-fav" : "");
    li.innerHTML = `
      <button class="cmd-x" title="Delete (no confirm)">&times;</button>
      <div class="cmd-name">${esc(cmd.name)}</div>
      <div class="cmd-row">
        <span class="cmd-text">${esc(cmd.command)}</span>
        <span class="cmd-actions">
          <button class="fav-btn${cmd.favorite ? " on" : ""}" title="Favorite">${cmd.favorite ? "★" : "☆"}</button>
          <button class="copy-btn" title="Copy">Copy</button>
          <button class="edit-btn" title="Edit">Edit</button>
          <button class="send-btn" title="Send to terminal">Send</button>
        </span>
      </div>
      ${cmd.description ? `<div class="cmd-desc">${esc(cmd.description)}</div>` : ""}
    `;
    li.querySelector(".send-btn").addEventListener("click", (e) => { e.stopPropagation(); sendToTerminal(cmd.command); });
    li.querySelector(".fav-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(cmd); });
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
    toast("Deleted");
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

// Last path component, e.g. "E:\Project\Mymux" -> "Mymux".
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
  if (t && t.term) {
    // Anchor a speech-bubble near the cursor — above by default, but flip
    // below when there isn't enough room above (cursor near the top edge).
    const screenEl = t.term.element || t.paneEl;
    const r = screenEl.getBoundingClientRect();
    const cols = Math.max(t.term.cols || 80, 1);
    const rows = Math.max(t.term.rows || 24, 1);
    const cw = r.width / cols;
    const ch = r.height / rows;
    const buf = t.term.buffer && t.term.buffer.active;
    const curX = buf ? buf.cursorX : 0;
    const curY = buf ? buf.cursorY : rows - 1;
    let left = r.left + curX * cw - 16; // tail aligns near the cursor
    left = Math.max(r.left + 4, Math.min(left, window.innerWidth - 250));
    const lineTop = r.top + curY * ch;
    const lineBottom = r.top + (curY + 1) * ch;
    const gap = 12;
    acPopup.style.left = left + "px";
    // Reveal first so offsetHeight is measurable (no repaint until JS yields).
    acPopup.classList.remove("hidden");
    const popupH = acPopup.offsetHeight;
    if (lineTop - gap - popupH >= 4) {
      // Enough room above → keep the bubble above the cursor.
      acPopup.style.bottom = (window.innerHeight - lineTop + gap) + "px";
      acPopup.style.top = "auto";
      acPopup.classList.remove("below");
    } else {
      // Near the top → flip below the cursor line so it isn't clipped.
      acPopup.style.top = (lineBottom + gap) + "px";
      acPopup.style.bottom = "auto";
      acPopup.classList.add("below");
    }
  } else {
    acPopup.classList.remove("hidden");
  }
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
      explorerGo(home);
      setPaneCwd(ptyId, home);
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
      // Success — the path exists, update explorer + the pane's cwd label.
      explorerGo(targetPath);
      setPaneCwd(ptyId, targetPath);
    } catch {
      // Path doesn't exist or error, don't update
    }
  }, 300);
}

// ── Auto-update: reveal the "Update" button when a newer release exists ──
window.addEventListener("DOMContentLoaded", () => {
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;

    // Wait for the Tauri IPC bridge.
    while (!window.__TAURI__ || !window.__TAURI__.core) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const inv = window.__TAURI__.core.invoke;
    const btn = document.getElementById("btn-update");
    if (!btn) return;

    let newVersion = null;
    try {
      newVersion = await inv("update_check");
    } catch (err) {
      // Network/endpoint errors are non-fatal — just stay hidden.
      console.warn("update_check failed:", err);
      return;
    }
    if (!newVersion) return; // already up to date

    btn.title = `New version ${newVersion} — click to update`;
    btn.classList.remove("hidden");

    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Updating…";
      try {
        // Downloads, installs, and relaunches into the new version.
        await inv("update_install");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = original;
        if (typeof toast === "function") toast("Update failed: " + err, true);
        else console.error("update_install failed:", err);
      }
    });
  };
  start();
});

// ── Startup guide: two side-by-side shells with install instructions ──
// Shown on launch when there is no previous session to restore. Left pane
// guides Claude Code install, right pane guides Codex CLI install. Each pane
// is a live shell, so the user can paste the commands right below the banner.

const GUIDE_CLAUDE =
  "\r\n" +
  "\x1b[1;36m══════ Install Claude Code ══════\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[90mRequires Node.js 18+.\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ npm (all platforms)\x1b[0m\r\n" +
  "  \x1b[33mnpm install -g @anthropic-ai/claude-code\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ Native install\x1b[0m\r\n" +
  "  \x1b[90mmacOS/Linux\x1b[0m\r\n" +
  "  \x1b[33mcurl -fsSL https://claude.ai/install.sh | bash\x1b[0m\r\n" +
  "  \x1b[90mWindows (PowerShell)\x1b[0m\r\n" +
  "  \x1b[33mirm https://claude.ai/install.ps1 | iex\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ Run\x1b[0m   \x1b[33mclaude\x1b[0m\r\n" +
  "\x1b[90mDocs: docs.claude.com/claude-code\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[2m↓ Paste a command into the shell below to install.\x1b[0m\r\n" +
  "\r\n";

const GUIDE_CODEX =
  "\r\n" +
  "\x1b[1;35m══════ Install Codex CLI ══════\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[90mOpenAI Codex CLI. Requires a ChatGPT account\x1b[0m\r\n" +
  "\x1b[90mor an API key.\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ npm (all platforms)\x1b[0m\r\n" +
  "  \x1b[33mnpm install -g @openai/codex\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ Homebrew (macOS/Linux)\x1b[0m\r\n" +
  "  \x1b[33mbrew install codex\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[1;32m▶ Run\x1b[0m   \x1b[33mcodex\x1b[0m\r\n" +
  "\x1b[90mDocs: github.com/openai/codex\x1b[0m\r\n" +
  "\r\n" +
  "\x1b[2m↓ Paste a command into the shell below to install.\x1b[0m\r\n" +
  "\r\n";

// Decide whether to show the install guide based on what is already installed.
// Once both CLIs are set up, no guide is shown — just a normal terminal.
async function maybeShowStartupGuide() {
  let claudeOk = false, codexOk = false;
  try {
    claudeOk = await invoke("tool_installed", { name: "claude" });
    codexOk = await invoke("tool_installed", { name: "codex" });
  } catch (e) {
    console.warn("tool_installed check failed:", e);
  }
  if (claudeOk && codexOk) {
    // Both set up → skip the guide entirely.
    await spawnTerminal();
    return;
  }
  // Show a guide pane only for the tools that still need installing.
  await openStartupGuide(!claudeOk, !codexOk);
}

async function openStartupGuide(showClaude, showCodex) {
  const guides = [];
  if (showClaude) guides.push(GUIDE_CLAUDE);
  if (showCodex) guides.push(GUIDE_CODEX);
  if (guides.length === 0) { await spawnTerminal(); return; }

  terminalWelcome.style.display = "none";

  const tabIdx = tabCounter++;
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-instance active";

  const rootContainer = document.createElement("div");
  rootContainer.className = "pane-container horizontal";
  rootContainer.style.cssText = "flex:1;";
  tabEl.appendChild(rootContainer);
  terminalContainer.appendChild(tabEl);

  try {
    const shell = getDefaultShellId();
    const paneIds = [];

    // First guide pane.
    const firstId = await createPane(rootContainer, shell, null, null);
    terminals.get(firstId).term.write(guides[0]);
    paneIds.push(firstId);

    // Second guide pane (only when both tools need a guide), split left/right.
    if (guides.length === 2) {
      const divider = document.createElement("div");
      divider.className = "pane-divider";
      rootContainer.appendChild(divider);
      setupDividerDrag(divider, rootContainer, "horizontal");

      const secondId = await createPane(rootContainer, shell, null, null);
      terminals.get(secondId).term.write(guides[1]);
      paneIds.push(secondId);
    }

    tabs.set(tabIdx, {
      el: tabEl,
      rootEl: rootContainer,
      panes: paneIds,
      label: "Setup Guide",
      session: { kind: "local", shell: null, cwd: null },
    });
    addTab(tabIdx, "Setup Guide");
    switchToTab(tabIdx);
    refreshSessionList();

    await new Promise((r) => requestAnimationFrame(r));
    refitAllPanes();
    setFocusedPane(paneIds[0]);
  } catch (err) {
    console.error("Startup guide failed:", err);
    tabEl.remove();
    // Fall back to a single default terminal.
    try { await spawnTerminal(); } catch {}
  }
}
