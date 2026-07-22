// Globals - set after init
let invoke;

// Platform: on macOS we lock to the system shell (zsh) and use Mac-native
// monospace fonts; the Windows shell choices (Git Bash/PowerShell/CMD) are hidden.
const IS_MAC =
  /Mac/i.test(navigator.platform || "") ||
  /Mac OS X|Macintosh/i.test(navigator.userAgent || "");

// Curated terminal font choices. D2Coding is bundled and has full-width Hangul
// glyphs metriced for a monospace grid — the only choice guaranteed not to
// misalign Korean text. The others are real system/coding fonts users may
// prefer for Latin text; picking one still keeps D2Coding as the fallback for
// any character it lacks (e.g. Hangul), so mixed Korean/English lines stay
// readable even though the fallback glyph's metrics can differ slightly.
// The first entry in each list is the default and must match the previous
// hardcoded chain exactly, so existing installs render unchanged until the
// user actively picks something else.
const FONT_CHOICES = IS_MAC
  ? [
      { key: "sfmono", label: "SF Mono (영문 전용, 기본값)", css: '"SF Mono", "SFMono-Regular", "Menlo", "Monaco", "D2Coding", monospace' },
      { key: "d2coding", label: "D2Coding (한글 지원)", css: '"D2Coding", "SF Mono", "SFMono-Regular", "Menlo", "Monaco", monospace' },
      { key: "menlo", label: "Menlo (영문 전용)", css: '"Menlo", "D2Coding", monospace' },
      { key: "monaco", label: "Monaco (영문 전용)", css: '"Monaco", "D2Coding", monospace' },
    ]
  : [
      { key: "d2coding", label: "D2Coding (한글 지원, 기본값)", css: '"D2Coding", "Cascadia Code", "Consolas", "Noto Sans KR", monospace' },
      { key: "cascadia", label: "Cascadia Code (영문 전용)", css: '"Cascadia Code", "D2Coding", monospace' },
      { key: "consolas", label: "Consolas (영문 전용)", css: '"Consolas", "D2Coding", monospace' },
    ];

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
    armNotifyCycle(id); // paste is real user input — re-arm the task-done notify
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
let terminalFontKey = (function () {
  try {
    const v = localStorage.getItem("mymux.termFontFamily");
    if (v && FONT_CHOICES.some((f) => f.key === v)) return v;
  } catch {}
  return FONT_CHOICES[0].key;
})();
// Effective per-cell letter spacing in px. On macOS this is forced to 0: WKWebView
// (WebKit) applies CSS `letter-spacing` as trailing space that xterm's DOM renderer
// does NOT fold into its cell-width measurement, so any non-zero value drifts every
// glyph a fraction of a cell to the right. Past ~a line that desyncs xterm's cursor
// column from zsh's ZLE model — characters land in the wrong column and zsh's
// erase-by-`\b \b` paints its space at the visible cursor, so Backspace looks like it
// types a space. SF Mono/Menlo are already comfortably spaced (unlike D2Coding's
// narrow CJK cells that the ratio was tuned for), so 0 is also the right look on Mac.
function effectiveLetterSpacing() {
  return IS_MAC ? 0 : terminalFontSize * letterSpacingRatio;
}
let savedCmds = [];
let currentInput = "";
const COMMAND_HISTORY_KEY = "mymux.commandHistory.v1";
const COMMAND_HISTORY_LIMIT = 200;
const SESSION_ACTIONS_SIDE_KEY = "mymux.sessionActionsSide.v1";
let sessionActionsSide = (() => {
  try { return localStorage.getItem(SESSION_ACTIONS_SIDE_KEY) === "left" ? "left" : "right"; }
  catch { return "right"; }
})();
let commandHistory = loadCommandHistory();
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
  // Clicking the path label copies the current directory to the clipboard.
  explorerPath.addEventListener("click", () => {
    if (!currentExplorerPath) return;
    clipboardWrite(currentExplorerPath);
    toast("Copied: " + currentExplorerPath);
  });
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

  // Before the (possibly modal-gated) session restore below so the effort
  // poller starts even while the re-run dialog waits for the user.
  initCtxUsage();

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

  // 🔔 Task-done flash settings modal (where the completion pulse shows).
  const btnNotifySettings = document.getElementById("btn-notify-settings");
  const notifyModal = document.getElementById("notify-modal");
  const notifyChkPane = document.getElementById("notify-chk-pane");
  const notifyChkList = document.getElementById("notify-chk-list");
  const notifyCharRadios = document.querySelectorAll('input[name="notify-char"]');
  const notifyChkBubble = document.getElementById("notify-chk-bubble");
  const notifyDialect = document.getElementById("notify-dialect");
  const notifyChkCtxBadge = document.getElementById("notify-chk-ctxbadge");
  const notifyChkCtxVoice = document.getElementById("notify-chk-ctxvoice");
  initFoxDrag();
  if (btnNotifySettings && notifyModal) {
    const closeNotifyModal = () => {
      notifyModal.classList.add("hidden");
      // Restore the native browser overlay only if we're still on the browser view.
      if (browserTabActive && browserMode === "native") openNativePane();
    };
    btnNotifySettings.addEventListener("click", () => {
      notifyChkPane.checked = notifyFlashPrefs.pane;
      notifyChkList.checked = notifyFlashPrefs.list;
      notifyCharRadios.forEach((r) => { r.checked = r.value === notifyFlashPrefs.character; });
      if (notifyChkBubble) notifyChkBubble.checked = notifyFlashPrefs.bubble;
      if (notifyDialect) notifyDialect.value = notifyFlashPrefs.dialect;
      if (notifyChkCtxBadge) notifyChkCtxBadge.checked = notifyFlashPrefs.ctxBadge;
      if (notifyChkCtxVoice) notifyChkCtxVoice.checked = notifyFlashPrefs.ctxVoice;
      // The native browser overlay floats above all HTML; hide it so the modal shows.
      if (browserTabActive && browserMode === "native") invoke("browser_pane_hide").catch(() => {});
      notifyModal.classList.remove("hidden");
    });
    document.getElementById("notify-modal-close").addEventListener("click", closeNotifyModal);
    notifyModal.addEventListener("click", (e) => { if (e.target === notifyModal) closeNotifyModal(); });
    notifyModal.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNotifyModal(); });
    notifyChkPane.addEventListener("change", () => { notifyFlashPrefs.pane = notifyChkPane.checked; saveNotifyFlashPrefs(); });
    notifyChkList.addEventListener("change", () => { notifyFlashPrefs.list = notifyChkList.checked; saveNotifyFlashPrefs(); });
    notifyCharRadios.forEach((r) => r.addEventListener("change", () => {
      if (!r.checked) return;
      notifyFlashPrefs.character = r.value;
      notifyFlashPrefs.fox = r.value !== "none"; // keep legacy flag roughly in sync
      saveNotifyFlashPrefs();
      const fox = document.getElementById("fox-buddy");
      if (r.value === "none") hideFox();
      else if (fox) fox.dataset.char = r.value; // live-switch the visible character
    }));
    if (notifyChkBubble) notifyChkBubble.addEventListener("change", () => {
      notifyFlashPrefs.bubble = notifyChkBubble.checked;
      saveNotifyFlashPrefs();
      const fox = document.getElementById("fox-buddy");
      if (!notifyChkBubble.checked && fox) fox.classList.remove("bubble-on", "bubble-below");
    });
    if (notifyDialect) notifyDialect.addEventListener("change", () => {
      notifyFlashPrefs.dialect = notifyDialect.value;
      saveNotifyFlashPrefs();
    });
    if (notifyChkCtxBadge) notifyChkCtxBadge.addEventListener("change", () => {
      notifyFlashPrefs.ctxBadge = notifyChkCtxBadge.checked;
      saveNotifyFlashPrefs();
      // Apply immediately: hide (or re-show) every existing badge.
      for (const [pid, tt] of terminals) if (tt.ctxPct != null || tt.codexDetected) updateCtxUi(pid, tt);
      updateGlobalUsageUi();
    });
    if (notifyChkCtxVoice) notifyChkCtxVoice.addEventListener("change", () => {
      notifyFlashPrefs.ctxVoice = notifyChkCtxVoice.checked;
      saveNotifyFlashPrefs();
    });
  }

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
  const sshSaveFav = document.getElementById("ssh-save-fav");
  if (sshSaveFav) sshSaveFav.addEventListener("click", saveSshFavFromModal);
  renderSshFavs(); // SSH favorites in the session panel (one-click reconnect)
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
    if (IS_MAC) {
      // macOS uses the fixed system shell — hide the Windows shell picker.
      shellSel.style.display = "none";
    } else {
      try { shellSel.value = localStorage.getItem("mymux.defaultShell") || "powershell"; } catch {}
      shellSel.addEventListener("change", () => {
        try { localStorage.setItem("mymux.defaultShell", shellSel.value); } catch {}
        toast("Default shell: " + shellSel.options[shellSel.selectedIndex].text + " (applies to new terminals)");
      });
    }
  }

  // macOS: hide the Windows-only shell quick-buttons (PowerShell/CMD/Git Bash).
  // Keep only "Default Shell", which routes to the system shell.
  if (IS_MAC) {
    document.querySelectorAll(".shell-btn").forEach((btn) => {
      const ds = (btn.dataset.shell || "").toLowerCase();
      if (ds === "powershell.exe" || ds === "cmd.exe" || ds === "bash") {
        btn.style.display = "none";
      } else if (ds === "") {
        btn.textContent = "Terminal (zsh)";
      }
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
  const btnExpNewFolder = document.getElementById("btn-explorer-newfolder");
  if (btnExpNewFolder) btnExpNewFolder.addEventListener("click", openNewFolderModal);
  const newFolderOpenSession = document.getElementById("newfolder-open-session");
  if (newFolderOpenSession) {
    newFolderOpenSession.addEventListener("change", () => {
      const opts = document.getElementById("newfolder-session-opts");
      if (opts) opts.classList.toggle("hidden", !newFolderOpenSession.checked);
    });
  }
  const newFolderName = document.getElementById("newfolder-name");
  if (newFolderName) {
    newFolderName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirmNewFolder(); }
    });
  }
  const newFolderCancel = document.getElementById("newfolder-cancel");
  if (newFolderCancel) newFolderCancel.addEventListener("click", closeNewFolderModal);
  const newFolderConfirm = document.getElementById("newfolder-confirm");
  if (newFolderConfirm) newFolderConfirm.addEventListener("click", confirmNewFolder);

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
    // Ctrl+Shift+O — flip split orientation (side-by-side ↔ stacked)
    if (e.ctrlKey && e.shiftKey && e.key === "O") {
      e.preventDefault();
      flipSplitDirection();
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
    // Ctrl+PageUp / Ctrl+PageDown — switch between sessions/tabs
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      switchToAdjacentTab(e.key === "PageDown" ? 1 : -1);
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
            const data = chunks.join("");
            t.term.write(data, () => {
              const tt = terminals.get(id);
              if (tt) scanCtxUsage(id, tt, data); // Claude/Codex statusline -> ctx/model badge
            }); // one write, not per-chunk
            markPaneActivity(id, t); // unseen badge when this pane is hidden
            trackOutputSilence(id, t); // flash when sustained output goes quiet
            if (t.pendingReplay) armReplaySettle(id, t); // SSH: replay once the prompt settles
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

  // Terminal font family picker (top bar), persisted; see FONT_CHOICES.
  const fontSel = document.getElementById("term-font");
  if (fontSel) {
    fontSel.innerHTML = FONT_CHOICES.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join("");
    fontSel.value = terminalFontKey;
    fontSel.addEventListener("change", () => setTerminalFontFamily(fontSel.value));
  }

  // Terminal text zoom (top bar A−/A+) — same effect as Ctrl -/+.
  const btnFontDec = document.getElementById("btn-font-dec");
  if (btnFontDec) btnFontDec.addEventListener("click", () => adjustTerminalFontSize(-1));
  const btnFontInc = document.getElementById("btn-font-inc");
  if (btnFontInc) btnFontInc.addEventListener("click", () => adjustTerminalFontSize(1));

  // Letter spacing (top bar 자−/자+) — adjust the persisted 자간 ratio live.
  // Hidden on macOS: letter-spacing is force-disabled there (effectiveLetterSpacing),
  // so the buttons would be dead controls.
  const btnTrackDec = document.getElementById("btn-track-dec");
  const btnTrackInc = document.getElementById("btn-track-inc");
  if (IS_MAC) {
    if (btnTrackDec) btnTrackDec.style.display = "none";
    if (btnTrackInc) btnTrackInc.style.display = "none";
  } else {
    if (btnTrackDec) btnTrackDec.addEventListener("click", () => adjustLetterSpacing(-0.025));
    if (btnTrackInc) btnTrackInc.addEventListener("click", () => adjustLetterSpacing(0.025));
  }

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
  explorerPath.title = (currentExplorerPath || "") + " — click to copy";
  renderDriveRow();

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

    const cdBtn = li.querySelector(".cd-btn");
    cdBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cdToTerminal(entry.is_dir ? entry.path : currentExplorerPath);
    });
    // Right-click the cd button: open a session there AND run a saved command.
    cdBtn.addEventListener("contextmenu", (e) => showCdCommandMenu(e, entry.is_dir ? entry.path : currentExplorerPath));
    cdBtn.title = "Open a new terminal here (right-click: run a saved command here)";

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
  const btnNewFolder = document.getElementById("btn-explorer-newfolder");
  if (btnNewFolder) btnNewFolder.classList.toggle("hidden", currentSftpId != null);
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
    armNotifyCycle(targetId); // user-launched command — its completion should notify
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

// ── Explorer: new folder modal ──
function openNewFolderModal() {
  const modal = document.getElementById("newfolder-modal");
  const nameInput = document.getElementById("newfolder-name");
  const errEl = document.getElementById("newfolder-error");
  const openSession = document.getElementById("newfolder-open-session");
  const tabCurrent = document.getElementById("newfolder-tab-current");
  const opts = document.getElementById("newfolder-session-opts");
  if (!modal || !nameInput) return;
  nameInput.value = "";
  if (errEl) { errEl.textContent = ""; errEl.classList.add("hidden"); }
  if (openSession) openSession.checked = true;
  if (tabCurrent) tabCurrent.checked = true;
  if (opts) opts.classList.remove("hidden");
  modal.classList.remove("hidden");
  nameInput.focus();
}

function closeNewFolderModal() {
  const modal = document.getElementById("newfolder-modal");
  if (modal) modal.classList.add("hidden");
}

function showNewFolderError(msg) {
  const errEl = document.getElementById("newfolder-error");
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

async function confirmNewFolder() {
  const nameInput = document.getElementById("newfolder-name");
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    showNewFolderError("폴더 이름이 비어있거나 올바르지 않습니다.");
    return;
  }
  let newPath;
  try {
    newPath = await invoke("fs_create_dir", { dir: currentExplorerPath, name });
  } catch (e) {
    showNewFolderError(String(e));
    return;
  }
  closeNewFolderModal();
  await loadExplorer();
  const openSession = document.getElementById("newfolder-open-session");
  if (openSession && openSession.checked) {
    const tabNew = document.getElementById("newfolder-tab-new");
    if (tabNew && tabNew.checked) {
      spawnTerminal(undefined, newPath);
    } else {
      cdToTerminal(newPath);
    }
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
// Best-effort local tracking of the command line the user is typing, for panes
// without OSC 133 shell-integration (SSH to a plain server). Accumulates
// printable keystrokes; applies backspace; and gives up on the current line the
// moment an escape sequence (arrow keys / history / tab-complete) or a control
// key (Ctrl-C/U/W) arrives — those edit the line in ways we can't mirror, so a
// partial guess would be wrong. Only tracks while xterm is on the NORMAL buffer,
// so typing inside a full-screen TUI never leaks in.
function trackTypedInput(ti, data) {
  if (!ti || !ti.term) return;
  if (ti.term.buffer.active.type !== "normal") { ti.typedBuf = ""; return; }
  let buf = ti.typedBuf || "";
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "\r" || ch === "\n") continue;         // submit — handled by caller
    if (ch === "\x1b") { buf = ""; break; }           // escape seq (arrows/history) → bail
    if (ch === "\x7f" || ch === "\b") { buf = buf.slice(0, -1); continue; } // backspace
    if (ch.charCodeAt(0) < 0x20) { buf = ""; continue; }  // Ctrl-C/U/W… → reset line
    buf += ch;
  }
  ti.typedBuf = buf;
}

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
  // Top-right usage badge (model | effort | ctx%) — filled by scanCtxUsage when
  // a Claude Code statusline shows up in this pane; hidden while empty (CSS).
  const ctxBadgeEl = document.createElement("div");
  ctxBadgeEl.className = "pane-ctx";
  paneEl.appendChild(ctxBadgeEl);
  // Favorite commands become a draggable edge dock while an AI CLI owns this
  // pane, leaving the terminal's command input unobstructed.
  const commandShortcutsEl = document.createElement("div");
  commandShortcutsEl.className = "pane-command-shortcuts";
  paneEl.appendChild(commandShortcutsEl);
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
  // lastInputAt baseline = pane birth, so the long-task check (10+ min since
  // last input) has a sane anchor even in a pane the user never typed in
  // (e.g. a restored session auto-replaying its command).
  terminals.set(id, { id, term, fitAddon, search: searchAddon, paneEl, commandShortcutsEl, type: shell === "ssh" ? "ssh" : "local", shell: shell || null, label: sessionLabel, cwd: cwd || null, unseen: false, marks: [], inputMark: null, lastInputAt: performance.now() });
  renderPaneCommandShortcuts(id);

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
    requestAnimationFrame(() => {
      roPending = false;
      refitAllPanes();
      positionPaneCommandDock(terminals.get(id));
    });
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
      <button class="pane-btn flip" title="분할 방향 전환 상하 ↔ 좌우 (Ctrl+Shift+O)">&#8635;</button>
      <button class="pane-btn close" title="Close pane (Ctrl+Shift+W)">&times;</button>
    </span>
  `;
  statusBar.querySelector(".split-h").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("horizontal"); });
  statusBar.querySelector(".split-v").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); splitPane("vertical"); });
  statusBar.querySelector(".flip").addEventListener("click", (e) => { e.stopPropagation(); setFocusedPane(id); flipSplitDirection(); });
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
    // Real keystrokes re-arm the once-per-cycle task-done notification and
    // reset the silence window so keystroke echo never counts as "work
    // output" (see the term.onData note — onData can't tell typing from
    // xterm-generated replies). Bare modifiers are skipped: Alt fires when
    // alt-tabbing away, Ctrl on Ctrl+wheel zoom — neither is interaction.
    if (e.type === "keydown" && !NOTIFY_REARM_SKIP_KEYS.has(e.key)) armNotifyCycle(id);
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
    // NOTE: do NOT re-arm the task-done notification here. onData is not only
    // user typing — xterm also routes terminal-GENERATED data through it:
    // focus reports CSI I/O (when the running app enables mode 1004, as Claude
    // Code does), color/DA/DSR query replies, mouse reports, and alt-screen
    // wheel→arrow conversion. Window-focus churn and idle redraws kept
    // re-opening the once-per-cycle gate, so a completely idle pane re-flashed
    // forever. Real interaction re-arms via armNotifyCycle instead: keydown
    // (custom key handler), paste, UI-launched commands — plus mouse CLICKS
    // inside a mouse-tracking TUI (picking a Claude Code menu option is input
    // too). SGR press reports only; hover/move/wheel reports must not re-arm.
    const ti = terminals.get(id);
    if (/\x1b\[<[0-2];\d+;\d+M/.test(data)) armNotifyCycle(id);
    // Remember the command being submitted so a restored session can offer to
    // re-run it (e.g. relaunch `claude`/`codex`). Two capture paths:
    //   • Local shells with Mymux OSC 133 integration → getInputRegion (exact).
    //   • SSH / shells without 133 (a plain remote server) → a locally-tracked
    //     keystroke line buffer, so re-run works even without tmux on the remote.
    // Both are gated to the NORMAL buffer, so keystrokes typed INTO a full-screen
    // app (vim/htop/claude, alt-screen) never masquerade as a shell command.
    if (ti && commandReplayEnabled()) {
      try {
        trackTypedInput(ti, data);
        if (data.includes("\r") || data.includes("\n")) {
          const r = getInputRegion(ti);
          let cmd = r && r.text ? r.text.trim() : "";
          if (!cmd && ti.term.buffer.active.type === "normal") cmd = (ti.typedBuf || "").trim();
          if (cmd) { ti.lastCmd = cmd; if (ti.session) ti.session.lastCmd = cmd; }
          ti.typedBuf = "";
        }
      } catch {}
    }
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

  // Notify at most ONCE per input cycle. A stopped/idle program that keeps
  // ringing the bell or re-emitting an OSC desktop-notification (some TUIs,
  // pollers, and shells do this while sitting idle) would otherwise re-flash the
  // pane/fox forever. Shared with the silence watcher + OSC 133;D via the same
  // notifiedQuiet flag, which term.onData clears the moment the user types — so
  // the next real interaction re-arms a single fresh notification.
  const notifyOnce = () => {
    const t = terminals.get(id);
    if (!t || t.notifiedQuiet) return;
    t.notifiedQuiet = true;
    flashPaneNotify(id);
  };

  // Terminal bell → flash this pane/session (task done / needs input).
  if (term.onBell) term.onBell(notifyOnce);
  // Many CLIs (incl. claude/codex notification modes) signal completion with an
  // OSC desktop-notification instead of a plain bell — xterm consumes the
  // trailing BEL of an OSC so onBell alone misses those. Catch the common ones.
  if (term.parser && term.parser.registerOscHandler) {
    // OSC 9 ; <message>  (iTerm-style). Skip ConEmu progress form "9;<digit>;…".
    term.parser.registerOscHandler(9, (data) => { if (!/^[0-9];/.test(data)) notifyOnce(); return false; });
    // OSC 777 ; notify ; <title> ; <body>  (notify-send style).
    term.parser.registerOscHandler(777, (data) => { if (/^notify/.test(data)) notifyOnce(); return false; });
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
        // First prompt after restore is ready → replay the remembered command.
        if (t.pendingReplay) firePendingReplay(id);
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
        // Guard with notifiedQuiet (shared with the silence watcher) so an idle
        // session whose prompt periodically re-emits 133;D — its lastInputAt is
        // long stale, so the ≥5s test always passes — flashes only ONCE and then
        // stays put until the user actually types again (term.onData clears it).
        if (!t.notifiedQuiet && performance.now() - (t.lastInputAt || 0) >= NOTIFY_MIN_WORK_MS) {
          t.notifiedQuiet = true;
          flashPaneNotify(id);
        }
        t.outStart = null; // the shell prompt is back — don't double-fire the silence watcher
        setPaneAiMode(t, false);
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
  if (term.textarea) {
    term.textarea.addEventListener("focus", () => { if (focusedPaneId !== id) setFocusedPane(id); });
    // IME (Hangul) composition guard. When returning to the window, the focus
    // keeper blurs+refocuses this textarea; doing that mid-composition makes the
    // IME commit the syllable twice ("글자가 2개씩") and detaches its candidate
    // window. Track composition so restore() leaves an actively-composing textarea
    // alone, and cancel the pending post-return refocus retries the moment the
    // user starts composing (composition proves input focus is alive).
    term.textarea.addEventListener("compositionstart", () => {
      const ti = terminals.get(id); if (ti) ti.imeComposing = true;
      cancelFocusReturnRetries();
    });
    term.textarea.addEventListener("compositionend", () => {
      const ti = terminals.get(id); if (ti) ti.imeComposing = false;
    });

    // ── macOS WKWebView IME shim ──────────────────────────────────────────────
    // On macOS WebKit the Korean/CJK IME fires NO composition events and instead
    // delivers every refinement as an `input` event with inputType
    // `insertReplacementText` (isComposing:false, keyCode 229) — xterm.js never
    // sees a composition, forwards only the raw first jamo and drops the
    // replacements, so syllables split (xtermjs/xterm.js#5887, #5894; WKWebView
    // only, Chrome/Electron unaffected). Hijack that flow at `beforeinput`: erase
    // the partial we already sent (Backspace ×liveLen) and send the refined
    // syllable, bypassing xterm entirely. ASCII/normal keys fall through to xterm.
    if (IS_MAC) {
      const ta = term.textarea;
      let liveLen = 0; // display chars of the in-progress syllable already sent to the PTY
      const commit = () => { liveLen = 0; };
      ta.addEventListener("beforeinput", (e) => {
        const it = e.inputType;
        const d = e.data || "";
        const isReplace = it === "insertReplacementText";
        const isImeInsert = it === "insertText" && !!d && /[^\x00-\x7F]/.test(d) && !e.isComposing;
        if (!isReplace && !isImeInsert) { commit(); return; } // ASCII/other → let xterm handle
        e.preventDefault();
        e.stopImmediatePropagation();
        const erase = isReplace ? "\x7f".repeat(liveLen) : "";
        invoke("pty_write", { id, data: erase + d });
        liveLen = [...d].length;
        try { ta.value = ""; } catch {}
      }, true);
      ta.addEventListener("compositionend", commit);
      ta.addEventListener("blur", commit);
    }
  }
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
      if (sel) { clipboardWrite(sel); appendPaneMemo(id, sel); }
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

// On window return, WebView2/Chromium leaves xterm's rAF-based renderer paused
// for a beat, so shell echo written by the poll loop buffers and only paints in
// a burst (cursor sits still, then a clump of chars appears — the "coming back
// from another session lags" report). Force an immediate re-render of every
// visible pane so what's already buffered paints right away.
function forceRepaintVisiblePanes() {
  const tab = tabs.get(activeTabIdx);
  if (!tab || !tab.panes) return;
  for (const pid of tab.panes) {
    const t = terminals.get(pid);
    if (!t || !t.term) continue;
    try {
      const rows = t.term.rows || 0;
      if (rows > 0) t.term.refresh(0, rows - 1);
    } catch {}
  }
}

let focusKeeperStarted = false;
// Assigned by startFocusKeeper; called from the global keydown handler so that
// real typing after an Alt-Tab return cancels the remaining focus-restore
// retries (a keystroke proves input focus is alive, so re-blurring the textarea
// would only thrash input and repeat characters).
let cancelFocusReturnRetries = () => {};
function startFocusKeeper() {
  if (focusKeeperStarted) return;
  focusKeeperStarted = true;
  // macOS WKWebView fires proper focus events and drives IME composition in the
  // xterm helper textarea normally. The focus-restore loop below is a Windows/
  // WebView2 workaround that blurs+refocuses that textarea every 250ms — on a
  // Mac that cancels Hangul/CJK composition mid-syllable (jamo commit one by
  // one). Skip the whole keeper on macOS.
  if (IS_MAC) return;
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
    if (t.imeComposing) return; // mid-Hangul composition — blur/refocus here double-types & breaks the IME
    const el = t.term.element;
    if (!el || !el.offsetParent) return; // not visible → leave it
    const ta = el.querySelector(".xterm-helper-textarea");
    if (!force && ta && document.activeElement === ta && el.classList.contains("focus")) return;
    // Respect focus that genuinely moved to a non-terminal input/overlay.
    const ae = document.activeElement;
    if (ae && ae !== document.body && !el.contains(ae) &&
        (ae.tagName === "INPUT" || ae.isContentEditable ||
         (ae.tagName === "TEXTAREA" && !ae.classList.contains("xterm-helper-textarea")))) return;
    // Preserve the scrollback position across the focus dance. Calling .focus()
    // on the helper textarea (which sits at the cursor row, i.e. the bottom)
    // makes the browser scroll the viewport to reveal it — so if the user has
    // scrolled UP to read scrollback and focus is then restored (Alt-Tab return,
    // or a background app like Veraport stealing focus every few seconds), the
    // view snaps to the bottom. They scroll up again, it snaps again → the
    // intermittent "위아래로 튕김" bounce. Save scrollTop and put it back.
    const vp = el.querySelector(".xterm-viewport");
    const savedTop = vp ? vp.scrollTop : null;
    try { if (ta) ta.blur(); } catch {}
    try { t.term.focus(); } catch {}
    try { if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true }); } catch {}
    if (vp && savedTop != null && vp.scrollTop !== savedTop) vp.scrollTop = savedTop;
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
    if (buddyOverlayShown) { invoke("buddy_overlay_hide").catch(() => {}); buddyOverlayShown = false; } // app is back — drop the desktop buddy
    cancelFocusReturnRetries();
    restore(true);
    forceRepaintVisiblePanes(); // wake xterm's rAF renderer so buffered echo paints now, not in a burst
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
    if (ev && ev.listen) {
      ev.listen("mymux-refocus", () => onReturn());
      // Buddy overlay clicked → jump to that session in the main window.
      ev.listen("buddy:goto", (e) => { buddyOverlayShown = false; const sid = e && e.payload; if (sid != null) focusSession(Number(sid)); });
    }
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
// A pane whose output spans ≥ NOTIFY_MIN_WORK_MS since the last keystroke and
// then goes quiet for NOTIFY_SILENCE_MS is treated as "task finished" and
// flashed. Covers programs without OSC 133 shell integration (TUIs, streaming
// CLIs). The work window ACCUMULATES across quiet gaps — sporadic-output tasks
// (downloads, plugin updates: burst → silence → burst) must still notify — and
// only a keystroke resets it (see term.onData), so echo never masquerades as
// work. To keep periodic-output programs (watch, pollers) from re-flashing
// every few seconds, each keystroke-to-keystroke cycle notifies at most once.
const NOTIFY_MIN_WORK_MS = 5000;
const NOTIFY_SILENCE_MS = 1500;
// Re-arm the once-per-input-cycle task-done notification for a pane. Called on
// REAL user interaction only — keydown, paste, TUI mouse clicks, UI-launched
// commands — never from term.onData wholesale (it also carries xterm-generated
// focus reports / query replies; see the onData note). Also stamps lastInputAt
// (gates the OSC 133;D ≥5s check) and resets the output-silence work window.
const NOTIFY_REARM_SKIP_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"]);
function armNotifyCycle(id) {
  const t = terminals.get(id);
  if (!t) return;
  t.lastInputAt = performance.now();
  t.outStart = null;
  t.notifiedQuiet = false;
}
function trackOutputSilence(id, t) {
  const now = performance.now();
  if (t.outStart == null) t.outStart = now;
  t.lastOutAt = now;
  if (t.silenceTimer) clearTimeout(t.silenceTimer);
  t.silenceTimer = setTimeout(() => {
    t.silenceTimer = null;
    if (!terminals.has(id)) return;
    if (t.outStart == null) return; // window reset by a keystroke or OSC 133;D
    const workedMs = (t.lastOutAt || 0) - t.outStart;
    if (workedMs >= NOTIFY_MIN_WORK_MS && !t.notifiedQuiet) {
      t.notifiedQuiet = true; // once per input cycle
      t.outStart = null;
      flashPaneNotify(id);
    }
    // Below the threshold: keep the window open so later bursts accumulate.
  }, NOTIFY_SILENCE_MS);
}

// Where the task-done pulse shows (🔔 toolbar modal): pane border and/or the
// session-list row. Both off = no visual flash (unseen badge / taskbar
// attention still apply).
const notifyFlashPrefs = (() => {
  const base = { pane: true, list: true, fox: true, character: null, bubble: true, dialect: "chungcheong", ctxBadge: true, ctxVoice: true };
  let p;
  try { p = { ...base, ...JSON.parse(localStorage.getItem("notifyFlashPrefs") || "{}") }; }
  catch { p = { ...base }; }
  // Migrate the old boolean `fox` flag → `character` ("classic" | "none").
  // New installs (no saved prefs at all) default straight to "mascot".
  if (p.character == null) {
    const hadSavedPrefs = localStorage.getItem("notifyFlashPrefs") != null;
    p.character = !hadSavedPrefs ? "mascot" : (p.fox ? "classic" : "none");
  }
  return p;
})();
function saveNotifyFlashPrefs() {
  try { localStorage.setItem("notifyFlashPrefs", JSON.stringify(notifyFlashPrefs)); } catch {}
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
    if (el._notifyTimeout) clearTimeout(el._notifyTimeout);
    el._notifyTimeout = setTimeout(() => el.classList.remove("notify-flash"), 10200);
  };
  const t = terminals.get(id);
  // 10+ minutes since the user's last input → the buddy trades its plain cheer
  // for a dialect-flavored "작업 다 끝났어, 다음 작업 하자!" line. lastInputAt is
  // stamped by armNotifyCycle (real input) and at pane creation as a baseline.
  const longTask = t && performance.now() - (t.lastInputAt || 0) >= BUDDY_LONG_TASK_MS;
  if (notifyFlashPrefs.pane && t) pulse(t.paneEl);
  if (notifyFlashPrefs.list) pulse(document.querySelector(`.session-item[data-pty-id="${id}"]`));
  if (notifyFlashPrefs.character && notifyFlashPrefs.character !== "none" && t) showFoxAt(t.paneEl, id, longTask);
  // The pulse is invisible when the pane is off-screen or the whole window is
  // in the background — leave a persistent "unseen" badge for the former and
  // flash the taskbar icon (no focus steal) for the latter.
  if (t) {
    const tab = findTabForPane(id);
    if (tab && (tab.tabIdx !== activeTabIdx || browserTabActive || viewerActive)) markUnseen(id, t, tab);
  }
  if (!document.hasFocus()) {
    invoke("window_attention").catch(() => {});
    maybeShowBuddyOverlay(id, t, longTask);
  }
}
// When a task finishes while the app is hidden/covered, pop a desktop buddy
// overlay (a separate always-on-top window) at the screen's bottom-right so the
// finished session is noticeable without the app in view. Respects the 🔔
// character choice ("none" opts out). macOS positions it per the OS.
let buddyOverlayShown = false;
function maybeShowBuddyOverlay(id, t, longTask) {
  const char = notifyFlashPrefs.character;
  if (!char || char === "none") return;
  try {
    invoke("buddy_overlay_show", {
      sessionId: id,
      title: t ? sessionLabelFor(t) : "세션",
      character: char === "mascot" ? "mascot" : "classic",
      dialect: notifyFlashPrefs.dialect || "standard",
      longTask: !!longTask,
    }).then(() => { buddyOverlayShown = true; }).catch(() => {});
  } catch {}
}

// Hovering a flashing pane (or its session-list row) acknowledges the
// notification: stop the pulse on BOTH elements for that session at once.
// Delegated on document so it covers rows recreated by refreshSessionList.
function clearPaneFlash(id) {
  const els = [
    terminals.get(id)?.paneEl,
    document.querySelector(`.session-item[data-pty-id="${id}"]`),
  ];
  for (const el of els) {
    if (!el) continue;
    el.classList.remove("notify-flash");
    if (el._notifyTimeout) { clearTimeout(el._notifyTimeout); el._notifyTimeout = null; }
  }
  // NOTE: deliberately does NOT hide the fox — the mouse usually sits on (or
  // crosses) the finished pane, so tying the fox to hover-ack made it vanish
  // the instant it appeared. The fox leaves on click or its own timer.
}

// ── Fox buddy 🦊 — a little mascot that glides to the pane whose task just
// finished and sways/blinks there for the pulse duration. Drag to move it
// anywhere; click to dismiss. Toggled in the 🔔 notify settings modal.
let foxHideTimer = null;
let foxFadeTimer = null;
let foxMascotRevert = null;
// Shown once ever, the very first time the buddy appears for a brand-new
// user, explaining what it is and how to turn it off. Never repeats after.
const FOX_INTRO_KEY = "mymuxFoxIntroSeen";
let foxIntroPending = (() => { try { return localStorage.getItem(FOX_INTRO_KEY) == null; } catch { return false; } })();
const FOX_INTRO_MESSAGE = "작업이 끝나면 제가 알려드려요! 🔔 아이콘으로 끌 수도 있어요.";
// Encouragement lines the buddy speaks, per Korean dialect (표준어 + 4 사투리).
const BUDDY_PHRASES = {
  standard:    ["잘했어요! 👏", "수고했어요!", "오늘도 멋져요!", "이대로 쭉 가요!", "완벽해요! ✨", "최고예요!", "고생 많았어요!"],
  gyeongsang:  ["억수로 잘했다 아이가!", "욕봤다 마!", "단디 했네 그마!", "잘한다 잘한다!", "억수로 대단하데이!", "고생했데이!", "머스마 잘하네!"],
  jeolla:      ["겁나 잘했어야!", "욕봤네 잉~", "허벌나게 잘했구마잉!", "아따 잘하네 잉!", "수고혔어라~", "겁나게 멋지구마잉!", "잘혔어야~"],
  gangwon:     ["잘했드래요!", "욕봤드래요~", "참 잘했잖소!", "대단하드래!", "고생 많았드래요!", "멋지드래요!", "잘하잖소~"],
  chungcheong: ["잘혔슈~", "욕봤슈~", "잘했구먼유~", "대단허유~", "수고혔슈~", "멋지구먼유~", "그려유, 잘혔슈~"],
};
// A task that ran 10+ minutes since the user's last input deserves more than a
// plain cheer: the buddy says "all done — on to the next task!" instead, in the
// same dialect the user picked for encouragement lines.
const BUDDY_LONG_TASK_MS = 10 * 60 * 1000;
const BUDDY_LONG_PHRASES = {
  standard:    ["작업 다 끝났어요! 다음 작업 하러 가요! 🚀", "긴 작업 끝~ 이제 다음 거 해볼까요?", "다 끝났어요! 다음 작업 시작해요!"],
  gyeongsang:  ["작업 다 끝났다 아이가! 다음 꺼 하러 가자!", "인자 다 됐데이~ 다음 작업 해뿌자!", "끝났다 마! 다음 거 하러 가재이!"],
  jeolla:      ["작업 다 끝났어야! 다음 것 하러 가잔께!", "인자 다 됐구마잉~ 다음 작업 해불자잉!", "다 끝났응께 다음 거 하러 가야제~"],
  gangwon:     ["작업 다 끝났드래요! 다음 거 하러 가요~", "다 됐잖소! 다음 작업 해봅시다!", "인제 끝났드래~ 다음 거 하드래요!"],
  chungcheong: ["작업 다 끝났슈~ 다음 거 하러 가유~", "인저 다 됐구먼유~ 다음 작업 해유~", "다 끝났으니께 다음 거 해봐유~"],
};
// Show the encouragement bubble above (or below) the buddy, clamped to the
// viewport so it's never clipped off an edge. `left/top/FW/FH` are the buddy's
// target fixed-position rect.
function showFoxBubble(fox, left, top, FW, FH, longTask, overrideText) {
  const bubble = fox.querySelector(".fox-bubble");
  if (!bubble) return;
  // overrideText (ctx usage announcements) IS the message — it shows even when
  // the encouragement bubble is toggled off; it has its own 🔔 toggle instead.
  if (!notifyFlashPrefs.bubble && !overrideText) { fox.classList.remove("bubble-on", "bubble-below"); return; }
  if (overrideText) {
    bubble.textContent = overrideText;
  } else if (foxIntroPending) {
    bubble.textContent = FOX_INTRO_MESSAGE;
    foxIntroPending = false;
    try { localStorage.setItem(FOX_INTRO_KEY, "1"); } catch {}
  } else {
    const dialect = BUDDY_PHRASES[notifyFlashPrefs.dialect] ? notifyFlashPrefs.dialect : "standard";
    const list = longTask ? BUDDY_LONG_PHRASES[dialect] : BUDDY_PHRASES[dialect];
    // Vary by pane id + timer handle so repeats differ without Math.random.
    const idx = (Math.abs(Number(fox._paneId) || 0) + (bubble._spin = (bubble._spin || 0) + 1)) % list.length;
    bubble.textContent = list[idx];
  }
  fox.classList.remove("bubble-below");
  bubble.style.transform = "translateX(-50%)";
  bubble.style.removeProperty("--tail-x");
  fox.classList.add("bubble-on");
  // Measure now (size is position-independent even while the buddy glides).
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const winW = window.innerWidth, winH = window.innerHeight, M = 6;
  const centerX = left + FW / 2;
  const bLeft = centerX - bw / 2;
  let dx = 0;
  if (bLeft < M) dx = M - bLeft;
  else if (bLeft + bw > winW - M) dx = (winW - M) - (bLeft + bw);
  bubble.style.transform = `translateX(calc(-50% + ${Math.round(dx)}px))`;
  const tailX = Math.max(12, Math.min(bw - 12, bw / 2 - dx));
  bubble.style.setProperty("--tail-x", `${Math.round(tailX)}px`);
  if (top - 9 - bh < M) fox.classList.add("bubble-below"); // no room above → drop below
}

function showFoxAt(paneEl, paneId, longTask, overrideText) {
  const fox = document.getElementById("fox-buddy");
  if (!fox || !paneEl) return;
  // Cancel any in-flight fade-out so a re-appearance shows a solid fox.
  if (foxFadeTimer) { clearTimeout(foxFadeTimer); foxFadeTimer = null; }
  fox.classList.remove("fox-leaving");
  // Pick the character chosen in the 🔔 modal ("classic" | "mascot").
  const char = notifyFlashPrefs.character === "mascot" ? "mascot" : "classic";
  fox.dataset.char = char;
  if (char === "mascot") {
    // Celebrate: restart the cheer animation, then settle back to idle.
    const mascot = fox.querySelector(".fox-mascot");
    if (mascot) {
      mascot.dataset.state = "idle"; void mascot.offsetWidth; mascot.dataset.state = "cheer";
      if (foxMascotRevert) clearTimeout(foxMascotRevert);
      foxMascotRevert = setTimeout(() => { mascot.dataset.state = "idle"; }, 1600);
    }
  }
  const r = paneEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return; // pane on a hidden tab — unseen badge covers it
  const FW = 64, FH = 55;
  // Bottom-right INSIDE the pane, lifted off the edge so it never covers
  // scrollbars or the bar below. Narrow panes: center horizontally and clamp
  // into the pane so the fox is never squeezed off the edge.
  let left = r.right - FW - 14;
  if (left < r.left + 2) left = Math.max(2, r.left + (r.width - FW) / 2);
  let top = r.bottom - FH - 18;
  if (top < r.top + 2) top = Math.max(2, r.top + (r.height - FH) / 2);
  fox._paneId = paneId;
  if (fox.classList.contains("hidden")) {
    // First appearance: place instantly (no glide from a stale position) and
    // play a little pop so it's unmistakable.
    fox.style.transition = "none";
    fox.style.left = left + "px";
    fox.style.top = top + "px";
    fox.classList.remove("hidden");
    void fox.offsetWidth;
    fox.style.transition = "";
    fox.classList.remove("fox-pop"); void fox.offsetWidth; fox.classList.add("fox-pop");
  } else {
    // Already out: glide over to the newly finished pane.
    fox.style.left = left + "px";
    fox.style.top = top + "px";
    fox.classList.remove("fox-pop"); void fox.offsetWidth; fox.classList.add("fox-pop");
  }
  showFoxBubble(fox, left, top, FW, FH, longTask, overrideText); // encouragement bubble (clamped to viewport)
  if (foxHideTimer) clearTimeout(foxHideTimer);
  foxHideTimer = setTimeout(hideFox, 10200); // matches the border-pulse lifetime
}
function hideFox() {
  if (foxHideTimer) { clearTimeout(foxHideTimer); foxHideTimer = null; }
  const fox = document.getElementById("fox-buddy");
  if (!fox || fox.classList.contains("hidden")) return;
  fox.classList.remove("bubble-on", "bubble-below");
  // Fade + shrink out (CSS transition), then fully hide once it's invisible.
  fox.classList.add("fox-leaving");
  if (foxFadeTimer) clearTimeout(foxFadeTimer);
  foxFadeTimer = setTimeout(() => {
    foxFadeTimer = null;
    fox.classList.add("hidden");
    fox.classList.remove("fox-leaving");
    fox._paneId = null;
  }, 450); // matches the opacity/transform transition
}
// Drag to move (transition off while dragging); a plain click dismisses.
function initFoxDrag() {
  const fox = document.getElementById("fox-buddy");
  if (!fox) return;
  fox.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const r = fox.getBoundingClientRect();
    let moved = false;
    fox.classList.add("dragging");
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) moved = true;
      fox.style.left = (r.left + ev.clientX - startX) + "px";
      fox.style.top = (r.top + ev.clientY - startY) + "px";
    };
    const onUp = () => {
      fox.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) { hideFox(); return; } // click = acknowledge
      // Dragged somewhere on purpose — keep it around a bit longer.
      if (foxHideTimer) { clearTimeout(foxHideTimer); foxHideTimer = setTimeout(hideFox, 20000); }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Session usage (ctx) badge ────────────────────────────────────────────────
// Claude Code(+OMC HUD statusline)가 패인에 그리는 `ctx:[██░░]NN%` / `Model: X`
// 텍스트를 PTY 출력에서 파싱해, 세션 목록과 패인 우상단에 "model | effort | NN%"
// 배지로 고정 표시한다. effort는 statusline에 없어 ~/.claude/settings.json의
// effortLevel을 주기적으로 읽는다(전역값 — /model로 바꾸면 그 파일에 저장됨).
// Codex CLI도 지원: 하단 상태줄의 `NN% context left`(잔량!)를 사용량으로 변환해
// 같은 배지를 쓰고, 세션 배너의 소문자 `model: gpt-…` 라인에서 모델명을 얻는다.
// 한 패인에서 두 도구가 번갈아 나오면 나중에 보인 쪽이 현재값이 된다.
// The bar body never contains "]" and the percent sits right after optional
// ANSI color codes, so one regex covers both `ctx:67%` and `ctx:[██░░]67%`.
const CTX_RE = /ctx:(?:\[[^\]]*\])?(?:\x1b\[[0-9;]*m)*(\d{1,3})%/;
// `Model: Fable 5` is wrapped in cyan — capture stops at the trailing ESC.
const CTX_MODEL_RE = /Model:\s*(?:\x1b\[[0-9;]*m)*([^\x1b\r\n]{1,24})/;
// Codex has used both `97% context left` and `Context left: 97%` in its TUI.
// Match either order (and the newer "remaining" wording) after terminal escape
// sequences have been removed. Keeping this independent from a line ending is
// important: Codex repaints its footer with cursor-motion controls, not newlines.
const CODEX_CTX_RE = /(?:\bcontext(?:\s+window)?\s+(?:left|remaining)\s*:?\s*(\d{1,3})\s*%|\b(\d{1,3})\s*%\s*(?:context(?:\s+window)?\s*)?(?:left|remaining))(?!\w)/i;
// Codex banner/status line. Limit accepted ids to Codex/OpenAI model families
// so Claude's own `Model: …` statusline can never populate this field.
const CODEX_MODEL_RE = /\bmodel\s*:\s*((?:gpt|o|codex)[A-Za-z0-9._-]{0,58})/i;
const CODEX_MODEL_ID_RE = /\b((?:gpt|o|codex)[A-Za-z0-9._-]{1,58})\b/i;
// Codex prints its product banner before it has rendered a context footer.
// Detect that banner so the per-pane indicators can appear immediately with
// a placeholder instead of waiting for the first completed turn.
const CODEX_START_RE = /\b(?:openai\s+)?codex(?:\s+cli)?\b/i;
// CSI covers styles, cursor movement and erase controls. OSC is included because
// some terminals emit title updates in the same PTY chunk as the status footer.
const TERMINAL_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -\/]*[@-~])/g;

function terminalPlainText(text) {
  return text.replace(TERMINAL_ESCAPE_RE, "");
}
function terminalVisibleTail(term, maxLines = 6) {
  try {
    const buf = term && term.buffer && term.buffer.active;
    if (!buf || !buf.getLine) return "";
    const lines = [];
    const start = Math.max(0, buf.baseY + buf.cursorY - maxLines + 1);
    const end = Math.min(buf.length - 1, buf.baseY + buf.cursorY);
    for (let i = start; i <= end; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
function tailAfterLastLineBreak(text) {
  const i = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return i >= 0 ? text.slice(i + 1) : text;
}
function parseCodexFooter(text) {
  const tail = text.slice(-360).trimEnd();
  let found = null;
  for (const m of tail.matchAll(new RegExp(CODEX_CTX_RE.source, "gi"))) {
    const left = parseInt(m[1] || m[2], 10);
    if (Number.isNaN(left)) continue;
    found = {
      pct: 100 - Math.min(100, left),
      index: text.length - tail.length + m.index,
      end: text.length - tail.length + m.index + m[0].length,
    };
  }
  if (!found) return null;
  const relEnd = found.end - (text.length - tail.length);
  const sameStatusLineSuffix = tailAfterLastLineBreak(tail.slice(relEnd));
  if (sameStatusLineSuffix.length > 96) return null;
  const relIndex = found.index - (text.length - tail.length);
  const lineStart = Math.max(tail.lastIndexOf("\n", relIndex), tail.lastIndexOf("\r", relIndex));
  found.line = tail.slice(lineStart + 1, relEnd + sameStatusLineSuffix.length);
  return found;
}
// Account-wide Claude rate limits ride the same HUD statusline:
// `5h:45%(3h42m) wk:12%(2d5h) mo:8%(15d3h)` — value colored, reset time dimmed,
// stale readings get a `*` after the % and a `~` before the reset time.
const CL_LIMIT_KEYS = [
  ["5h:", /5h:(?:\x1b\[[0-9;]*m)*(\d{1,3})%(?:\x1b\[[0-9;]*m|\*)*(?:\((~?[0-9dhm]+)\))?/, "fiveH", "fiveHReset"],
  ["wk:", /wk:(?:\x1b\[[0-9;]*m)*(\d{1,3})%(?:\x1b\[[0-9;]*m|\*)*(?:\((~?[0-9dhm]+)\))?/, "wk", "wkReset"],
  ["mo:", /mo:(?:\x1b\[[0-9;]*m)*(\d{1,3})%(?:\x1b\[[0-9;]*m|\*)*(?:\((~?[0-9dhm]+)\))?/, "mo", "moReset"],
];
// Account-wide usage shown in the top toolbar. Claude comes from any pane's
// statusline; Codex from the newest rollout's rate_limits snapshot (poll).
let claudeLimits = null;    // { fiveH, fiveHReset, wk, wkReset, mo, moReset, at } — from a pane's HUD statusline
let claudeLimitsApi = null; // same shape (5h+wk only) — from the OAuth usage API; works without OMC/statusline
let codexLimits = null;     // { pct, label, secondary, resetsAt, plan, at }
// Two independent sources feed the CL readout: the live pane statusline
// (claudeLimits) and the direct OAuth usage API (claudeLimitsApi). Whichever was
// refreshed most recently wins — a rendering Claude pane redraws its statusline
// constantly so it dominates in-app, while the 60s API poll takes over the
// moment that statusline goes quiet (Claude closed, or running outside Mymux).
function activeClaudeLimits() {
  const aAt = (claudeLimits && claudeLimits.at) || -1;
  const bAt = (claudeLimitsApi && claudeLimitsApi.at) || -1;
  if (aAt < 0 && bAt < 0) return null;
  return bAt > aAt ? claudeLimitsApi : claudeLimits;
}
function parseCodexConfig(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "im"));
    return m ? m[1].trim() : null;
  };
  return {
    model: get("model"),
    reasoningEffort: get("model_reasoning_effort"),
  };
}
const CTX_STALE_MS = 5 * 60 * 1000; // no statusline redraw for 5 min → dim badge
const CTX_LEVELS = [50, 70, 85];    // buddy announces when first crossing these
const CTX_REARM_DROP = 10;          // re-arm once usage falls 10%p under a level
// Per-dialect announcement lines, indexed by level (50% / 70% / 85%).
const CTX_PHRASES = {
  standard:    ["컨텍스트를 반쯤 썼어요! (50%)", "컨텍스트 70%를 넘었어요~ 슬슬 정리를 생각해봐요!", "컨텍스트가 거의 다 찼어요(85%)! /compact 어때요?"],
  gyeongsang:  ["컨텍스트 반이나 썼다 아이가! (50%)", "70% 넘었데이~ 슬슬 정리해라 마!", "거의 다 찼다 아이가(85%)! /compact 해뿌라!"],
  jeolla:      ["컨텍스트 반이나 썼어야~ (50%)", "70% 넘었구마잉~ 슬슬 정리허소!", "거의 다 찼당께(85%)! /compact 해불드라고잉!"],
  gangwon:     ["컨텍스트 반이나 썼드래요~ (50%)", "70% 넘었잖소~ 슬슬 정리하드래요!", "거의 다 찼드래요(85%)! /compact 해봅시다!"],
  chungcheong: ["컨텍스트 반이나 썼슈~ (50%)", "70% 넘었구먼유~ 슬슬 정리해유~", "거의 다 찼슈(85%)! /compact 해야 혀유~"],
};
let claudeEffort = null; // e.g. "xhigh" — from ~/.claude/settings.json
let codexConfiguredModel = null; // from ~/.codex/config.toml
let codexSessionModel = null; // active session model from Codex settings events
let codexConfiguredReasoningEffort = null; // from ~/.codex/config.toml
let codexSessionReasoningEffort = null; // active session reasoning setting from rollout events
let codexSessionCtxPct = null; // active session context usage from rollout token_count events
let codexSessionCtxAt = 0;

// Scan one pump-tick's worth of PTY output for the statusline patterns. Keeps a
// short tail so a pattern split across ticks still matches on the next one.
function scanCtxUsage(id, t, data) {
  const rawText = (t._ctxTail || "") + data;
  t._ctxTail = rawText.slice(-360);
  const visibleText = terminalVisibleTail(t.term);
  const text = terminalPlainText(rawText + (visibleText ? "\n" + visibleText : ""));
  let changed = false;
  if (!t.codexDetected && CODEX_START_RE.test(text)) {
    t.codexDetected = true;
    setPaneAiMode(t, true);
    if (t.ctxSource !== "codex") {
      t.ctxSource = "codex";
      changed = true;
    }
    applyCodexSessionSnapshot();
    loadCodexLimits();
  }
  // Only the LAST occurrence matters — the statuslines redraw constantly and
  // older matches in the same burst are already outdated.
  // Claude (OMC HUD): `ctx:NN%` where NN is percent USED.
  let claudePct = null, claudeAt = -1;
  const ci = text.lastIndexOf("ctx:");
  if (ci >= 0) {
    const m = CTX_RE.exec(text.slice(ci, ci + 90));
    if (m) { claudePct = Math.min(100, parseInt(m[1], 10)); claudeAt = ci; }
  }
  // Codex: `NN% context left` where NN is percent REMAINING → invert.
  // A status footer is the final visible text in a repaint. Restrict parsing to
  // that tail so a model reply containing the same words cannot overwrite a
  // session badge. `trimEnd` retains all meaningful status text.
  const codexFooter = parseCodexFooter(text);
  let codexPct = null, codexAt = -1;
  if (codexFooter) {
    codexPct = codexFooter.pct;
    codexAt = codexFooter.index;
    if (!t.codexDetected) {
      t.codexDetected = true;
      changed = true;
      applyCodexSessionSnapshot();
      loadCodexLimits();
    }
    setPaneAiMode(t, true);
  }
  // Both tools can show up in one pane over time — the later sighting wins.
  const pct = codexAt > claudeAt ? codexPct : claudePct;
  if (pct != null) {
    const source = codexAt > claudeAt ? "codex" : "claude";
    setPaneAiMode(t, true);
    t.ctxAt = performance.now(); // fresh sighting even when the value is equal
    if (pct !== t.ctxPct || source !== t.ctxSource) { t.ctxPct = pct; t.ctxSource = source; changed = true; }
    maybeAnnounceCtx(id, t);
  }
  const mi = text.lastIndexOf("Model:");
  if (mi >= 0) {
    const m = CTX_MODEL_RE.exec(text.slice(mi, mi + 60));
    if (m) {
      const name = m[1].trim();
      if (name && name !== t.ctxModel) { t.ctxModel = name; changed = true; }
    }
  }
  let codexModel = null;
  for (const m of text.matchAll(new RegExp(CODEX_MODEL_RE.source, "gi"))) codexModel = m[1];
  if (!codexModel && codexFooter && codexFooter.line) {
    const m = CODEX_MODEL_ID_RE.exec(codexFooter.line);
    if (m) codexModel = m[1];
  }
  if (codexModel && codexModel !== t.codexModel) {
    t.codexModel = codexModel;
    changed = true;
    if (t.ctxSource === "codex" || t.codexDetected) loadCodexLimits();
  }
  // Account-wide Claude rate limits (5h:34% wk:12% …) — global, not per-pane.
  let limitsChanged = false;
  for (const [key, re, field, rfield] of CL_LIMIT_KEYS) {
    const ki = text.lastIndexOf(key);
    if (ki < 0) continue;
    const m = re.exec(text.slice(ki, ki + 44));
    if (!m) continue;
    const v = Math.min(100, parseInt(m[1], 10));
    claudeLimits = claudeLimits || {};
    if (claudeLimits[field] !== v || (m[2] && claudeLimits[rfield] !== m[2])) limitsChanged = true;
    claudeLimits[field] = v;
    if (m[2]) claudeLimits[rfield] = m[2];
    claudeLimits.at = performance.now();
  }
  if (limitsChanged) updateGlobalUsageUi();
  if (changed) updateCtxUi(id, t);
}

// 초록(0%) → 다홍(~85%) → 빨강(100%) continuous hue ramp.
function ctxColor(pct) {
  const hue = Math.max(0, 130 - (pct / 100) * 145);
  return `hsl(${Math.round(hue)}, 85%, 55%)`;
}
function ctxBadgeText(t) {
  const parts = [];
  if (t.ctxSource === "codex") {
    // Codex's status footer has no reasoning setting, so prefer the active
    // rollout value and fall back to config.toml. ctxPct is converted from "left".
    parts.push(codexSessionModel || t.codexModel || codexConfiguredModel || "Codex");
    const effort = codexSessionReasoningEffort || codexConfiguredReasoningEffort;
    if (effort) parts.push(effort);
  } else {
    if (t.ctxModel) parts.push(t.ctxModel);
    if (claudeEffort) parts.push(claudeEffort);
  }
  parts.push(t.ctxPct == null ? "?" : t.ctxPct + "%");
  return parts.join(" | ");
}

// Refresh both badges (pane overlay + session-list pill) for one session.
function updateCtxUi(id, t) {
  if (t.ctxPct == null && !t.codexDetected) return;
  const show = notifyFlashPrefs.ctxBadge;
  const color = t.ctxPct == null ? "var(--text-muted, #8b93a7)" : ctxColor(t.ctxPct);
  const stale = t.ctxPct != null && performance.now() - (t.ctxAt || 0) > CTX_STALE_MS;
  const pe = t.paneEl && t.paneEl.querySelector(".pane-ctx");
  if (pe) {
    pe.textContent = show ? ctxBadgeText(t) : "";
    pe.style.color = color;
    pe.style.borderColor = color;
    pe.classList.toggle("stale", stale);
  }
  const li = document.querySelector(`.session-item[data-pty-id="${id}"]`);
  if (li) {
    let se = li.querySelector(".session-ctx");
    if (!show) { if (se) se.remove(); return; }
    if (!se) {
      se = document.createElement("span");
      se.className = "session-ctx";
      const nameEl = li.querySelector(".session-name");
      if (nameEl) nameEl.after(se); else li.appendChild(se);
    }
    se.textContent = ctxBadgeText(t);
    se.title = ctxBadgeText(t); // full "model | effort | ctx" on hover
    se.style.color = color;
    se.style.borderColor = color;
    se.classList.toggle("stale", stale);
  }
}

// Buddy speaks when usage first crosses 50/70/85% — once per crossing. A real
// drop (compact/clear) re-arms the level so the next climb announces again.
function maybeAnnounceCtx(id, t) {
  const pct = t.ctxPct;
  const lvl = CTX_LEVELS.reduce((n, th) => n + (pct >= th ? 1 : 0), 0);
  const cur = t.ctxLvl || 0;
  if (lvl > cur) {
    t.ctxLvl = lvl;
    if (notifyFlashPrefs.ctxVoice && notifyFlashPrefs.character && notifyFlashPrefs.character !== "none") {
      const dialect = CTX_PHRASES[notifyFlashPrefs.dialect] ? notifyFlashPrefs.dialect : "standard";
      // Swap the phrase's hardcoded level % (50/70/85) for the real current %
      // so the buddy speaks the same number the badge shows.
      showFoxAt(t.paneEl, id, false, CTX_PHRASES[dialect][lvl - 1].replace(/\d+%/, pct + "%"));
    }
  } else if (lvl < cur && pct <= CTX_LEVELS[cur - 1] - CTX_REARM_DROP) {
    t.ctxLvl = lvl;
  }
}

// ── Account-wide usage (top toolbar) ────────────────────────────────────────
// `CL 5h:34% wk:12% │ CX 30d:5%` — Claude comes from any pane's statusline,
// Codex from the newest ~/.codex rollout's rate_limits snapshot (60s poll).
function usageSeg(label, pct, stale) {
  const s = document.createElement("span");
  s.className = "usage-seg" + (stale ? " stale" : "");
  s.append(label + ":");
  const b = document.createElement("b");
  b.textContent = pct + "%";
  b.style.color = ctxColor(pct);
  s.appendChild(b);
  return s;
}
// A usage "reset" is a large drop in a rate-limit percentage — a fresh window
// opened and the budget is free again. When detected, flash an "N" beside CL/CX
// for RESET_N_MS so it's noticeable at a glance. Tracked per source (CL 5h, CX).
const RESET_N_MS = 60000;
const RESET_DROP = 40; // ≥40%p fall from ≥50% counts as a reset
let prevCL5h = null, prevCXpct = null;
let clResetAt = 0, cxResetAt = 0;
function detectUsageReset(now) {
  const cl = activeClaudeLimits();
  const cur5h = cl && cl.fiveH != null ? cl.fiveH : null;
  if (prevCL5h != null && cur5h != null && prevCL5h >= 50 && cur5h <= prevCL5h - RESET_DROP) {
    clResetAt = now; setTimeout(updateGlobalUsageUi, RESET_N_MS + 200); // clear the N later
  }
  if (cur5h != null) prevCL5h = cur5h;
  const curCX = codexLimits && codexLimits.pct != null ? codexLimits.pct : null;
  if (prevCXpct != null && curCX != null && prevCXpct >= 50 && curCX <= prevCXpct - RESET_DROP) {
    cxResetAt = now; setTimeout(updateGlobalUsageUi, RESET_N_MS + 200);
  }
  if (curCX != null) prevCXpct = curCX;
}
function resetNBadge() {
  const n = document.createElement("span");
  n.className = "usage-reset-n";
  n.textContent = "N";
  n.title = "방금 사용량이 리셋됨 (New)";
  return n;
}
function updateGlobalUsageUi() {
  const el = document.getElementById("usage-global");
  if (!el) return;
  el.textContent = "";
  el.title = "";
  if (!notifyFlashPrefs.ctxBadge) return;
  const now = performance.now();
  detectUsageReset(now);
  const tips = [];
  const cl = activeClaudeLimits();
  if (cl && (cl.fiveH != null || cl.wk != null || cl.mo != null)) {
    const stale = now - (cl.at || 0) > 10 * 60 * 1000;
    const tool = document.createElement("span");
    tool.className = "usage-tool";
    tool.textContent = "CL";
    el.appendChild(tool);
    if (clResetAt && now - clResetAt < RESET_N_MS) el.appendChild(resetNBadge());
    if (cl.fiveH != null) el.appendChild(usageSeg("5h", cl.fiveH, stale));
    if (cl.wk != null) el.appendChild(usageSeg("wk", cl.wk, stale));
    if (cl.mo != null) el.appendChild(usageSeg("mo", cl.mo, stale));
    tips.push("Claude 전체 사용량"
      + (cl.fiveHReset ? ` · 5h 리셋까지 ${cl.fiveHReset}` : "")
      + (cl.wkReset ? ` · 주간 리셋까지 ${cl.wkReset}` : ""));
  }
  if (codexLimits && codexLimits.pct != null) {
    if (el.childElementCount) {
      const div = document.createElement("span");
      div.className = "usage-div";
      div.textContent = "│";
      el.appendChild(div);
    }
    const tool = document.createElement("span");
    tool.className = "usage-tool";
    tool.textContent = "CX";
    el.appendChild(tool);
    if (cxResetAt && now - cxResetAt < RESET_N_MS) el.appendChild(resetNBadge());
    el.appendChild(usageSeg(codexLimits.label || "usage", codexLimits.pct, false));
    if (codexLimits.secondary) el.appendChild(usageSeg(codexLimits.secondary.label || "wk", codexLimits.secondary.pct, false));
    tips.push(`Codex 전체 사용량 (plan: ${codexLimits.plan || "?"})`
      + (codexLimits.resetsAt ? ` · 리셋까지 ${fmtEpochRemain(codexLimits.resetsAt)}` : ""));
  }
  el.title = tips.join("\n");
}
function fmtEpochRemain(epochSec) {
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "곧";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}
// Codex writes a rate_limits snapshot into its session rollout on every reply;
// mine the newest rollout's tail for the last one. Works no matter where the
// codex session runs (a Mymux pane, VS Code, a plain terminal).
function findKeyDeep(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKeyDeep(v, key);
    if (r != null) return r;
  }
  return null;
}
function firstValueDeep(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && obj[key] !== "") return obj[key];
  }
  for (const v of Object.values(obj)) {
    const r = firstValueDeep(v, keys);
    if (r != null && r !== "") return r;
  }
  return null;
}
function numberValueDeep(obj, keys) {
  const value = firstValueDeep(obj, keys);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function codexWindowLabel(min) {
  if (min == null) return "";
  if (min % 1440 === 0 && min >= 1440) return (min / 1440) + "d";
  if (min % 60 === 0 && min >= 60) return (min / 60) + "h";
  return min + "m";
}
function parseCodexTokenCountEvent(ev) {
  const payload = ev && ev.payload ? ev.payload : {};
  if (ev.type !== "token_count" && payload.type !== "token_count") return null;

  const info = payload.info || ev.info || {};
  const usage = info.total_token_usage || payload.total_token_usage || ev.total_token_usage || info.last_token_usage || {};
  const inputTokens = numberValueDeep({ usage, info, payload, ev }, ["input_tokens", "inputTokens"]);
  const totalTokens = numberValueDeep({ usage, info, payload, ev }, ["total_tokens", "totalTokens"]);
  const windowTokens = numberValueDeep({ info, payload, ev }, ["model_context_window", "modelContextWindow", "context_window", "contextWindow"]);
  if (!windowTokens || windowTokens <= 0) return null;

  // Cached input is billed differently but still occupies the prompt context.
  const used = inputTokens != null ? inputTokens : totalTokens;
  if (used == null) return null;
  return Math.max(0, Math.min(100, Math.round((used / windowTokens) * 100)));
}
function applyCodexSessionSnapshot() {
  for (const [pid, tt] of terminals) {
    if (!tt.codexDetected && tt.ctxSource !== "codex") continue;
    let changed = false;
    const stalePanePct = tt.ctxPct == null || performance.now() - (tt.ctxAt || 0) > 10_000;
    if (codexSessionCtxPct != null && stalePanePct) {
      tt.ctxPct = codexSessionCtxPct;
      tt.ctxAt = codexSessionCtxAt || performance.now();
      tt.ctxSource = "codex";
      maybeAnnounceCtx(pid, tt);
      changed = true;
    }
    if (changed || tt.ctxSource === "codex") updateCtxUi(pid, tt);
  }
}
async function loadCodexLimits() {
  try {
    const tail = await invoke("codex_rollout_tail", { maxBytes: 65536 });
    const lines = tail.split("\n");
    let foundSessionSettings = false;
    let foundSessionCtx = false;
    let foundRateLimits = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!foundSessionSettings && (lines[i].indexOf('"turn_context"') >= 0 || lines[i].indexOf('"thread_settings_applied"') >= 0 || lines[i].indexOf('"session_meta"') >= 0)) {
        try {
          const ev = JSON.parse(lines[i]);
          const tc = ev.payload || {};
          const ts = tc.thread_settings || ev.thread_settings || {};
          const nextModel = firstValueDeep({ tc, ts }, ["model", "model_id"]);
          const nextReasoningEffort = firstValueDeep({ tc, ts }, ["effort", "model_reasoning_effort", "reasoning_effort", "reasoningEffort"]);
          if ((nextModel && nextModel !== codexSessionModel)
            || (nextReasoningEffort && nextReasoningEffort !== codexSessionReasoningEffort)) {
            if (nextModel) codexSessionModel = nextModel;
            if (nextReasoningEffort) codexSessionReasoningEffort = nextReasoningEffort;
            applyCodexSessionSnapshot();
          }
          foundSessionSettings = Boolean(nextModel || nextReasoningEffort);
        } catch {}
      }
      if (!foundSessionCtx && lines[i].indexOf('"type":"token_count"') >= 0) {
        try {
          const ev = JSON.parse(lines[i]);
          const nextPct = parseCodexTokenCountEvent(ev);
          if (nextPct != null) {
            if (nextPct !== codexSessionCtxPct) {
              codexSessionCtxPct = nextPct;
              codexSessionCtxAt = performance.now();
            }
            applyCodexSessionSnapshot();
            foundSessionCtx = true;
          }
        } catch {}
      }
      if (foundRateLimits || lines[i].indexOf('"rate_limits"') < 0) {
        if (foundSessionSettings && foundSessionCtx && foundRateLimits) break;
        continue;
      }
      try {
        const rl = findKeyDeep(JSON.parse(lines[i]), "rate_limits");
        const p = rl && rl.primary;
        if (!p || p.used_percent == null) continue;
        codexLimits = {
          pct: Math.min(100, Math.round(p.used_percent)),
          label: codexWindowLabel(p.window_minutes),
          secondary: rl.secondary && rl.secondary.used_percent != null
            ? { pct: Math.min(100, Math.round(rl.secondary.used_percent)), label: codexWindowLabel(rl.secondary.window_minutes) }
            : null,
          resetsAt: p.resets_at || null,
          plan: rl.plan_type || null,
          at: performance.now(),
        };
        updateGlobalUsageUi();
        foundRateLimits = true;
      } catch { /* line cut at the tail boundary — try the previous one */ }
      if (foundSessionSettings && foundSessionCtx && foundRateLimits) break;
    }
  } catch { /* codex not installed / no rollouts — segment stays hidden */ }
}

// Fetch account-wide Claude usage straight from Anthropic's OAuth endpoint so
// the CL readout works without OMC's HUD and without a Claude pane in Mymux.
// Read-only/safe: the Rust side never refreshes or rewrites the login file, so
// an expired/absent token just errors and this source silently stays empty.
async function loadClaudeUsageApi() {
  try {
    const u = await invoke("claude_account_usage");
    if (!u || (u.fiveH == null && u.wk == null)) return;
    claudeLimitsApi = {
      fiveH: u.fiveH,
      fiveHReset: fmtIsoRemain(u.fiveHResetsAt),
      wk: u.wk,
      wkReset: fmtIsoRemain(u.wkResetsAt),
      at: performance.now(),
    };
    updateGlobalUsageUi();
  } catch { /* no creds / expired / offline — the CL API source stays absent */ }
}
// ISO-8601 instant → compact "3h42m" / "2d5h" remaining, matching the HUD's
// reset-time format so both CL sources render identically in the tooltip.
function fmtIsoRemain(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return null;
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

// effort(예: xhigh)는 statusline에 안 나오므로 설정 파일에서 읽는다. /model로
// 바꾸면 settings.json이 갱신되니 1분 폴링이면 충분히 따라간다.
async function loadClaudeEffort() {
  try {
    const home = await invoke("explorer_home_dir");
    const txt = await invoke("read_text_file", { path: home + "/.claude/settings.json" });
    const next = JSON.parse(txt).effortLevel || null;
    if (next !== claudeEffort) {
      claudeEffort = next;
      for (const [pid, tt] of terminals) if (tt.ctxPct != null || tt.codexDetected) updateCtxUi(pid, tt);
    }
  } catch { /* no Claude settings — badge simply omits effort */ }
}

async function loadCodexModelSetting() {
  try {
    const home = await invoke("explorer_home_dir");
    const txt = await invoke("read_text_file", { path: home + "/.codex/config.toml" });
    const next = parseCodexConfig(txt);
    if (next.model !== codexConfiguredModel || next.reasoningEffort !== codexConfiguredReasoningEffort) {
      codexConfiguredModel = next.model;
      codexConfiguredReasoningEffort = next.reasoningEffort;
      for (const [pid, tt] of terminals) if ((tt.ctxPct != null || tt.codexDetected) && tt.ctxSource === "codex") updateCtxUi(pid, tt);
    }
  } catch { /* no Codex config — badge simply omits the fallback model */ }
}

function initCtxUsage() {
  loadClaudeEffort();
  setInterval(loadClaudeEffort, 60_000);
  loadCodexModelSetting();
  setInterval(loadCodexModelSetting, 60_000);
  loadCodexLimits();
  setInterval(loadCodexLimits, 5_000);
  loadClaudeUsageApi();
  setInterval(loadClaudeUsageApi, 60_000);
  // Staleness sweep: dim badges whose statusline stopped redrawing (Claude
  // Code exited or the pane went back to a plain shell).
  setInterval(() => {
    for (const [pid, tt] of terminals) if (tt.ctxPct != null || tt.codexDetected) updateCtxUi(pid, tt);
    updateGlobalUsageUi();
  }, 30_000);
}
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.(".notify-flash");
  if (!el) return;
  const pid = Number(el.dataset.ptyId);
  if (Number.isFinite(pid)) clearPaneFlash(pid);
  else el.classList.remove("notify-flash");
});

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
    { name: "Flip split orientation / 분할 방향 전환 (상하 ↔ 좌우)", hint: "Ctrl+Shift+O", run: () => flipSplitDirection() },
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
    ["Ctrl+PageUp / PageDown", "Switch sessions / tabs / 세션(탭) 전환"],
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
  // macOS: always use the system login shell (zsh); the Windows shell prefs
  // (PowerShell/CMD/Git Bash) don't exist here. undefined → Rust new_default_prog.
  if (IS_MAC) return undefined;
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
    return ptyId;
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
    return newPtyId;
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
    // Read orientation live from the container so flip-direction keeps drag correct.
    const horizontal = container.classList.contains("horizontal");

    const onMove = (e) => {
      if (!dragging) return;
      let ratio;
      if (horizontal) {
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

// Flip the focused pane's split between side-by-side (horizontal) and stacked
// (vertical) — a quick "상하 ↔ 좌우" toggle without drag-retiling. The divider
// reads its orientation live from the container, so no re-wiring is needed.
function flipSplitDirection() {
  const t = terminals.get(focusedPaneId);
  if (!t || !t.paneEl) return;
  const c = t.paneEl.parentElement;
  if (!c || !c.classList || !c.classList.contains("pane-container")) return;
  const kids = [...c.children].filter((x) => !x.classList.contains("pane-divider"));
  if (kids.length < 2) { toast("이 패인은 분할되어 있지 않아요 — 먼저 분할하세요"); return; }
  const toVertical = c.classList.contains("horizontal");
  c.classList.toggle("horizontal", !toVertical);
  c.classList.toggle("vertical", toVertical);
  refitAllPanes();
  saveSessionNow();
}

function closePane(ptyId) {
  const tInfo = terminals.get(ptyId);
  if (!tInfo) return;
  if (memoPopover && Number(memoPopover.dataset.ptyId) === ptyId) closeMemoPopover();
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
      t.term.options.letterSpacing = effectiveLetterSpacing(); // keep tracking across zoom
    } catch {}
  }
  refitAllPanes(true); // font change keeps pixel size but must re-grid every pane
}
// Terminal font family, applied to all panes and persisted. Mirrors
// setTerminalFontSize; a different font's cell metrics can change the glyph
// width, so re-measure + re-grid the same way a size change does.
function setTerminalFontFamily(key) {
  if (!FONT_CHOICES.some((f) => f.key === key)) return;
  terminalFontKey = key;
  try { localStorage.setItem("mymux.termFontFamily", terminalFontKey); } catch {}
  const css = FONT_CHOICES.find((f) => f.key === terminalFontKey).css;
  for (const [, t] of terminals) {
    try { t.term.options.fontFamily = css; } catch {}
  }
  remeasureFontCells();
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
    try { t.term.options.letterSpacing = effectiveLetterSpacing(); } catch {}
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

// ── SSH favorites: one-click reconnect from the session panel ─────────────
// Stored WITHOUT passwords: {target, port, keyPath, tmux, tmuxName}.
// Key auth → connects immediately; no key → asks for the password only.
function getSshFavs() {
  try { return JSON.parse(localStorage.getItem("mymux.sshFavorites") || "[]"); } catch { return []; }
}
function setSshFavs(arr) {
  try { localStorage.setItem("mymux.sshFavorites", JSON.stringify(arr)); } catch {}
  renderSshFavs();
}
function addSshFav(f) {
  if (!f || !f.target) return;
  const key = (x) => `${x.target}|${x.tmux ? x.tmuxName || "(tmux)" : ""}`;
  const arr = getSshFavs().filter((x) => key(x) !== key(f));
  arr.unshift({ target: f.target, port: f.port || 22, keyPath: f.keyPath || "", tmux: !!f.tmux, tmuxName: f.tmuxName || "" });
  setSshFavs(arr.slice(0, 20));
  toast("★ SSH favorite saved");
}
function renderSshFavs() {
  const list = document.getElementById("ssh-fav-list");
  if (!list) return;
  list.innerHTML = "";
  for (const f of getSshFavs()) {
    const li = document.createElement("li");
    li.className = "ssh-fav-item";
    const label = f.target + (f.tmux ? ` (tmux${f.tmuxName ? ":" + f.tmuxName : ""})` : "") + (f.keyPath ? " 🔑" : "");
    li.innerHTML = `<span class="ssh-fav-star">★</span><span class="ssh-fav-name"></span><button class="ssh-fav-x" title="Remove favorite">×</button>`;
    li.querySelector(".ssh-fav-name").textContent = label;
    li.title = "Click to connect" + (f.keyPath ? "" : " (asks for the password)");
    li.addEventListener("click", () => connectSshFav(f));
    li.querySelector(".ssh-fav-x").addEventListener("click", (e) => {
      e.stopPropagation();
      setSshFavs(getSshFavs().filter((x) => !(x.target === f.target && x.tmuxName === f.tmuxName && x.tmux === f.tmux)));
    });
    list.appendChild(li);
  }
}
function connectSshFav(f) {
  const parts = (f.target || "").split("@");
  if (parts.length !== 2) { toast("Format: user@hostname", true); return; }
  const opts = {
    target: f.target, username: parts[0], host: parts[1],
    port: f.port || 22, keyPath: f.keyPath || null,
    tmux: !!f.tmux, tmuxName: f.tmuxName || null,
  };
  if (f.keyPath) {
    // Key auth → straight in, no questions.
    doSshConnect({ ...opts, password: null, auth: "key" });
  } else {
    // Password auth → ask for the password only (same prompt as restore).
    promptSshPassword(opts);
  }
}
// Save the connection of a live SSH pane as a favorite (star on its row).
function addSshFavFromSession(s) {
  if (!s || s.kind !== "ssh") return;
  addSshFav({ target: s.target, port: s.port, keyPath: s.keyPath || "", tmux: !!s.tmux, tmuxName: s.tmuxName || "" });
}
// Save the ssh-modal form as a favorite without connecting.
function saveSshFavFromModal() {
  const target = (document.getElementById("ssh-modal-input").value || "").trim();
  if (!target || target.split("@").length !== 2) { toast("Enter an address (user@host)", true); return; }
  const tmuxChk = document.getElementById("ssh-tmux");
  addSshFav({
    target,
    port: parseInt(document.getElementById("ssh-modal-port").value) || 22,
    keyPath: (document.getElementById("ssh-modal-keyfile").value || "").trim(),
    tmux: !!(tmuxChk && tmuxChk.checked),
    tmuxName: (document.getElementById("ssh-tmux-name").value || "").trim(),
  });
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
    // No password is ever persisted — only the auth *kind*. tmux settings ride
    // along so favorites / session restore reattach the same tmux session.
    const sessionMeta = {
      kind: "ssh", target, username, host, port,
      keyPath: keyPath || null, auth,
      tmux: !!opts.tmux, tmuxName: (opts.tmuxName || "").trim() || null,
      lastCmd: opts.lastCmd || null, // carried through restore so re-run works over SSH
      memo: opts.memo || null,       // scratch memo rides restore too
    };
    const ptyId = await createPane(rootContainer, "ssh", sshArgs);
    terminals.get(ptyId).sshTarget = target;
    terminals.get(ptyId).session = sessionMeta;

    tabs.set(tabIdx, {
      el: tabEl,
      rootEl: rootContainer,
      panes: [ptyId],
      label: `SSH: ${target}`,
      session: sessionMeta,
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
      // Single-pane tab → flat entry (backward-compatible with v1). Pull the
      // live pane's remembered command (tab.session is a separate object that
      // isn't updated as the user types).
      const t0 = tab.panes && terminals.get(tab.panes[0]);
      const lastCmd = (t0 && t0.session && t0.session.lastCmd) || tab.session.lastCmd || null;
      const memo = (t0 && t0.session && t0.session.memo) || tab.session.memo || null;
      arr.push({ ...tab.session, lastCmd, memo, label: tab.label });
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
      if (t) t.session = { kind: "local", shell: s.shell || null, cwd: s.cwd || null, lastCmd: s.lastCmd || null, memo: s.memo || "" };
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
            tmux: !!s.tmux,
            tmuxName: s.tmuxName || null,
            lastCmd: s.lastCmd || null,
            memo: s.memo || null,
          });
        } else {
          pwSessions.push(s); // password auth → prompt below
        }
      } else {
        const pid = await spawnTerminal(s.shell || undefined, s.cwd || undefined);
        const t = pid != null ? terminals.get(pid) : null;
        if (t && t.session && s.lastCmd) t.session.lastCmd = s.lastCmd;
        if (t && t.session && s.memo) t.session.memo = s.memo;
      }
    } catch (e) {
      console.error("restore tab failed", e);
    }
  }

  // Password-auth SSH sessions: prompt one at a time.
  for (const s of pwSessions) {
    await promptSshPasswordRestore(s);
  }

  // Offer to re-run the commands that were running before quit (claude/codex…).
  try { await maybeReplayCommands(); } catch (e) { console.error("replay prompt failed", e); }

  return tabs.size > 0;
}

// ── Command replay: after restore, offer to re-run each pane's last command ──
function commandReplayEnabled() {
  try { return localStorage.getItem("mymux.replayCommands") !== "false"; } catch { return true; }
}
async function maybeReplayCommands() {
  if (!commandReplayEnabled()) return;
  const cands = [];
  for (const [pid, t] of terminals) {
    const cmd = t.session && t.session.lastCmd;
    if (cmd) cands.push({ id: pid, cmd, label: t.label || "Terminal" });
  }
  if (!cands.length) return;
  const chosen = await promptReplayCommands(cands);
  for (const c of chosen) scheduleReplay(c.id, c.cmd);
}
// Fire the remembered command once the pane's shell prompt is ready. 133;A
// (prompt start) is the reliable local trigger; a timed fallback covers SSH /
// shells without Mymux shell-integration.
function scheduleReplay(id, cmd) {
  const t = terminals.get(id);
  if (!t) return;
  t.pendingReplay = cmd;
  if (atIntegratedPrompt(t)) { firePendingReplay(id); return; }
  // No shell-integration (SSH to a plain server): the remote prompt appears
  // after a network round-trip, so a fixed delay is unreliable. armReplaySettle
  // (called from the read loop) fires ~700ms after the prompt output settles;
  // this hard cap guarantees it still runs if no output ever arrives.
  if (t._replayFallback) clearTimeout(t._replayFallback);
  t._replayFallback = setTimeout(() => firePendingReplay(id), 6000);
}
// Re-armed on each output burst for a pane awaiting replay: once output has been
// quiet for a beat, the remote prompt is up → send the command.
function armReplaySettle(id, t) {
  if (!t.pendingReplay) return;
  if (t._replaySettle) clearTimeout(t._replaySettle);
  t._replaySettle = setTimeout(() => firePendingReplay(id), 700);
}
function firePendingReplay(id) {
  const t = terminals.get(id);
  if (!t || !t.pendingReplay) return;
  const cmd = t.pendingReplay;
  t.pendingReplay = null;
  if (t._replayFallback) { clearTimeout(t._replayFallback); t._replayFallback = null; }
  if (t._replaySettle) { clearTimeout(t._replaySettle); t._replaySettle = null; }
  invoke("pty_write", { id, data: cmd + "\r" });
}
// Batch confirm modal: one list, checkboxes (default on), run selected.
function promptReplayCommands(cands) {
  return new Promise((resolve) => {
    const modal = document.getElementById("replay-modal");
    const list = document.getElementById("replay-list");
    const btnRun = document.getElementById("replay-run");
    const btnSkip = document.getElementById("replay-skip");
    const chkOff = document.getElementById("replay-disable");
    if (!modal || !list) { resolve([]); return; }
    list.innerHTML = "";
    cands.forEach((c, i) => {
      const row = document.createElement("label");
      row.className = "chk-row";
      row.innerHTML = `<input type="checkbox" data-i="${i}" checked /> <b>${esc(c.label)}</b> — <code>${esc(c.cmd)}</code>`;
      list.appendChild(row);
    });
    if (chkOff) chkOff.checked = false;
    modal.classList.remove("hidden");

    function cleanup() {
      modal.classList.add("hidden");
      btnRun.removeEventListener("click", onRun);
      btnSkip.removeEventListener("click", onSkip);
    }
    function finish(chosen) {
      if (chkOff && chkOff.checked) { try { localStorage.setItem("mymux.replayCommands", "false"); } catch {} }
      cleanup();
      resolve(chosen);
    }
    function onRun() {
      const picked = [];
      list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (cb.checked) { const c = cands[Number(cb.dataset.i)]; if (c) picked.push(c); }
      });
      finish(picked);
    }
    function onSkip() { finish([]); }
    btnRun.addEventListener("click", onRun);
    btnSkip.addEventListener("click", onSkip);
  });
}

// Password-only prompt used by session restore AND favorite clicks.
// `s` carries target/username/host/port(/keyPath/tmux/tmuxName).
function promptSshPassword(s) {
  return promptSshPasswordRestore(s);
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
        tmux: !!s.tmux,
        tmuxName: s.tmuxName || null,
        lastCmd: s.lastCmd || null,
        memo: s.memo || null,
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
    letterSpacing: effectiveLetterSpacing(),
    // User-selectable (toolbar font-family picker), persisted; see FONT_CHOICES.
    fontFamily: (FONT_CHOICES.find((f) => f.key === terminalFontKey) || FONT_CHOICES[0]).css,
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

function switchToAdjacentTab(dir) {
  const tabEls = Array.from(terminalTabs.querySelectorAll(".tab"));
  if (tabEls.length < 2) return;
  const idx = tabEls.findIndex((el) => Number(el.dataset.id) === activeTabIdx);
  const nextEl = tabEls[(idx + dir + tabEls.length) % tabEls.length];
  if (nextEl) switchToTab(Number(nextEl.dataset.id));
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
  armNotifyCycle(activeTermId); // user-launched command — its completion should notify
  invoke("pty_write", { id: activeTermId, data: command + "\r" });
  terminals.get(activeTermId)?.term.focus();
}

// ── Directory-bound commands (cwd + alias combos) ─────────────────────────
// Detect a pane's shell family so the "cd here, then run" line uses syntax
// that shell actually supports (PowerShell 5.1 has no `&&`).
function paneShellKind(t) {
  if (!t) return "powershell";
  if (t.type === "ssh") return "posix";
  const s = (t.shell || (localStorage.getItem("mymux.defaultShell") || "powershell")).toLowerCase();
  if (s.includes("pwsh") || s.includes("powershell")) return "powershell";
  if (s.includes("cmd")) return "cmd";
  return "posix";
}

// One line that cds into the command's directory (when set) and runs it.
// The command only runs if the cd succeeded.
function commandComboLine(cmd, kind) {
  const dir = (cmd.cwd || "").trim();
  if (!dir) return cmd.command;
  if (kind === "powershell") return `cd '${dir.replace(/'/g, "''")}'; if ($?) { ${cmd.command} }`;
  if (kind === "cmd") return `cd /d "${dir}" && ${cmd.command}`;
  return `cd '${dir.replace(/'/g, "'\\''")}' && ${cmd.command}`;
}

const AI_CLI_COMMAND_RE = /(?:^|[;&|]\s*)(?:claude|codex)(?:\s|$)/i;

function runCommandCombo(cmd, ptyId = activeTermId) {
  if (ptyId == null || !terminals.has(ptyId)) {
    toast("No active terminal.", true);
    return;
  }
  const line = commandComboLine(cmd, paneShellKind(terminals.get(ptyId)));
  if (AI_CLI_COMMAND_RE.test(cmd.command || "")) setPaneAiMode(terminals.get(ptyId), true);
  armNotifyCycle(ptyId); // user-launched command — its completion should notify
  invoke("pty_write", { id: ptyId, data: line + "\r" });
  terminals.get(ptyId)?.term.focus();
}

// Write a command line once the new pane's shell is ready: wait for the first
// OSC 133;A prompt mark (bash rcfile / PS prompt emit it), with a timeout
// fallback for shells without integration (ConPTY queues the input anyway).
function sendCommandWhenReady(ptyId, line) {
  const t0 = performance.now();
  const tick = () => {
    const t = terminals.get(ptyId);
    if (!t) return; // pane closed before the shell came up
    if ((t.marks && t.marks.length > 0) || performance.now() - t0 > 2500) {
      armNotifyCycle(ptyId); // user-launched command — its completion should notify
      invoke("pty_write", { id: ptyId, data: line + "\r" });
      return;
    }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 150);
}

// cd-button context menu: open a session AT the folder and run a saved command.
async function openSessionWithCommand(path, cmd) {
  if (currentSftpId) {
    // Remote: reuse the cd routing (owning SSH pane), as one guarded line.
    let targetId = null;
    for (const [id, t] of terminals) {
      if (t.sftpId === currentSftpId) { targetId = id; break; }
    }
    if (targetId == null) targetId = activeTermId;
    if (targetId == null || !terminals.has(targetId)) { toast("이 서버의 SSH 세션을 찾을 수 없습니다.", true); return; }
    const safe = String(path).replace(/'/g, "'\\''");
    armNotifyCycle(targetId); // user-launched command — its completion should notify
    invoke("pty_write", { id: targetId, data: `cd '${safe}' && ${cmd.command}\r` });
    const tab = findTabForPane(targetId);
    if (tab && tab.tabIdx !== activeTabIdx) switchToTab(tab.tabIdx);
    setFocusedPane(targetId);
    return;
  }
  // Local: new pane already starts in the folder — just run the command there.
  let ptyId = null;
  if (!browserTabActive && activeTabIdx != null && focusedPaneId != null && terminals.has(focusedPaneId)) {
    ptyId = await splitPane("horizontal", path);
  } else {
    ptyId = await spawnTerminal(undefined, path);
  }
  if (ptyId != null) sendCommandWhenReady(ptyId, cmd.command);
}

function showCdCommandMenu(e, dirPath) {
  const menu = document.getElementById("cdcmd-menu");
  if (!menu) return;
  e.preventDefault();
  e.stopPropagation();
  if (!savedCmds.length) { toast("No saved commands."); return; }
  menu.innerHTML = "";
  const items = [...savedCmds].sort((a, b) => (b.favorite === true) - (a.favorite === true)).slice(0, 15);
  for (const cmd of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = (cmd.favorite ? "★ " : "") + cmd.name;
    item.title = cmd.command;
    item.addEventListener("click", () => {
      menu.classList.add("hidden");
      openSessionWithCommand(dirPath, cmd);
    });
    menu.appendChild(item);
  }
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.classList.remove("hidden");
  const hide = (ev) => {
    if (!menu.contains(ev.target)) { menu.classList.add("hidden"); document.removeEventListener("mousedown", hide, true); }
  };
  document.addEventListener("mousedown", hide, true);
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

// ── Session scratch memo 🗒 ───────────────────────────────────────────────────
// A per-session temporary notepad. Drag-selecting in the terminal auto-appends
// to it (on top of the usual clipboard copy); the text is freely editable, can
// be copied in one click, and can be sent to the pane's command line — typed for
// review, or run outright. It lives on t.session.memo so it rides the existing
// session_save/session_load pipeline: it survives a restart and is dropped when
// the pane is closed.
function paneMemo(id) {
  const t = terminals.get(id);
  return t && t.session && typeof t.session.memo === "string" ? t.session.memo : "";
}
function setPaneMemo(id, text) {
  const t = terminals.get(id);
  if (!t) return;
  if (!t.session) t.session = { kind: "local", shell: null, cwd: null };
  // Cap runaway growth (drag-collect can append large log chunks) by keeping the
  // most recent tail; session.json is persisted and reloaded on every restart.
  const MAX_MEMO = 64 * 1024;
  t.session.memo = text.length > MAX_MEMO ? text.slice(text.length - MAX_MEMO) : text;
  markMemoIndicator(id);
  scheduleMemoSave();
}
// Drag-select auto-collect: append the selection as its own line, skipping an
// exact repeat (onSelectionChange settles more than once per drag).
function appendPaneMemo(id, sel) {
  const add = (sel || "").replace(/\s+$/, "");
  if (!add) return;
  const cur = paneMemo(id);
  if (cur === add || cur.endsWith("\n" + add)) return;
  setPaneMemo(id, cur ? cur.replace(/\n+$/, "") + "\n" + add : add);
  if (memoPopover && Number(memoPopover.dataset.ptyId) === id) {
    const ta = memoPopover.querySelector(".memo-text");
    if (ta && document.activeElement !== ta) { ta.value = paneMemo(id); ta.scrollTop = ta.scrollHeight; }
  }
}
let memoSaveTimer = null;
function scheduleMemoSave() {
  clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(saveSessionNow, 800);
}
function markMemoIndicator(id) {
  const btn = document.querySelector(`.session-item[data-pty-id="${id}"] .session-memo`);
  if (btn) btn.classList.toggle("has-memo", !!paneMemo(id));
}
// Type the memo into the pane's command line. run=false pastes it for review
// (bracketed-paste safe, no Enter); run=true writes it raw and presses Enter.
function sendMemoToPane(id, text, run) {
  const t = terminals.get(id);
  if (!t || !t.term) return;
  const body = text || "";
  if (!body) return;
  armNotifyCycle(id);
  focusSession(id);
  if (run) invoke("pty_write", { id, data: body.replace(/\r?\n/g, "\r").replace(/\r+$/, "") + "\r" });
  else t.term.paste(body);
}
let memoPopover = null;
function closeMemoPopover() {
  if (memoPopover) { memoPopover.remove(); memoPopover = null; }
  document.removeEventListener("mousedown", onMemoOutside, true);
  document.removeEventListener("keydown", onMemoKey, true);
}
function onMemoOutside(e) {
  if (!memoPopover) return;
  if (memoPopover.contains(e.target)) return;
  if (e.target.closest && e.target.closest(".session-memo")) return; // its own toggle
  closeMemoPopover();
}
function onMemoKey(e) { if (e.key === "Escape") closeMemoPopover(); }
// Open (or toggle) the memo popover for a session, anchored to its 🗒 button.
function openMemoPopover(id, anchorEl) {
  const wasOpen = memoPopover && Number(memoPopover.dataset.ptyId) === id;
  closeMemoPopover();
  if (wasOpen) return; // clicking the same button again just closes it
  const t = terminals.get(id);
  if (!t) return;
  const pop = document.createElement("div");
  pop.className = "memo-popover";
  pop.dataset.ptyId = String(id);
  const head = document.createElement("div");
  head.className = "memo-head";
  const title = document.createElement("span");
  title.className = "memo-title";
  title.textContent = "🗒 " + sessionLabelFor(t);
  const xBtn = document.createElement("button");
  xBtn.className = "memo-x"; xBtn.textContent = "×"; xBtn.title = "닫기";
  head.append(title, xBtn);
  const ta = document.createElement("textarea");
  ta.className = "memo-text";
  ta.placeholder = "붙여넣기(Ctrl+V) 하거나, 터미널에서 드래그하면 자동으로 쌓입니다.";
  ta.value = paneMemo(id);
  const tools = document.createElement("div");
  tools.className = "memo-tools";
  const mk = (cls, label, tip) => {
    const b = document.createElement("button");
    b.className = "memo-btn " + cls; b.textContent = label; b.title = tip;
    return b;
  };
  const copyBtn = mk("memo-copy", "📋 복사", "전체 복사");
  const typeBtn = mk("memo-type", "⌨️ 입력", "명령줄에 입력 (검토 후 직접 실행)");
  const runBtn = mk("memo-run", "▶️ 실행", "명령줄에 입력하고 바로 실행");
  const clearBtn = mk("memo-clear", "🗑", "메모 비우기");
  tools.append(copyBtn, typeBtn, runBtn, clearBtn);
  pop.append(head, ta, tools);
  document.body.appendChild(pop);
  // Position next to the anchor button, clamped to the viewport.
  const r = anchorEl.getBoundingClientRect();
  const pw = 300, ph = pop.offsetHeight || 250;
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 8);
  let top = r.top;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  memoPopover = pop;
  ta.addEventListener("input", () => setPaneMemo(id, ta.value));
  xBtn.addEventListener("click", closeMemoPopover);
  copyBtn.addEventListener("click", async () => {
    await clipboardWrite(ta.value);
    const old = copyBtn.textContent; copyBtn.textContent = "✓ 복사됨";
    setTimeout(() => { copyBtn.textContent = old; }, 900);
  });
  typeBtn.addEventListener("click", () => { sendMemoToPane(id, ta.value, false); closeMemoPopover(); });
  runBtn.addEventListener("click", () => { sendMemoToPane(id, ta.value, true); closeMemoPopover(); });
  clearBtn.addEventListener("click", () => { ta.value = ""; setPaneMemo(id, ""); ta.focus(); });
  setTimeout(() => ta.focus(), 0);
  document.addEventListener("mousedown", onMemoOutside, true);
  document.addEventListener("keydown", onMemoKey, true);
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

      const memoBtn = document.createElement("button");
      memoBtn.className = "session-memo" + (paneMemo(ptyId) ? " has-memo" : "");
      memoBtn.textContent = "🗒";
      memoBtn.title = "임시 메모 — 드래그 자동수집 · 복사 · 명령줄 입력/실행";
      memoBtn.addEventListener("click", (e) => { e.stopPropagation(); openMemoPopover(ptyId, memoBtn); });

      const paneNo = document.createElement("span");
      paneNo.className = "session-pane";
      paneNo.textContent = `#${i + 1}`;

      const closeBtn = document.createElement("button");
      closeBtn.className = "session-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close session";

      const actionsEl = document.createElement("span");
      actionsEl.className = `session-actions session-actions-${sessionActionsSide}`;
      actionsEl.draggable = true;
      actionsEl.title = "Drag session actions to the left or right";
      actionsEl.setAttribute("aria-label", "Session actions; drag to move to the left or right");
      actionsEl.append(renameBtn, memoBtn);

      // SSH panes: star saves this connection as a one-click favorite.
      if (t.type === "ssh" && t.session && t.session.kind === "ssh") {
        const favBtn = document.createElement("button");
        favBtn.className = "session-fav";
        favBtn.textContent = "★";
        favBtn.title = "Save as SSH favorite (one-click reconnect)";
        favBtn.addEventListener("click", (e) => { e.stopPropagation(); addSshFavFromSession(t.session); });
        actionsEl.append(favBtn);
      }
      actionsEl.append(closeBtn);
      if (sessionActionsSide === "left") li.append(actionsEl, dotEl, nameEl, paneNo);
      else li.append(dotEl, nameEl, paneNo, actionsEl);

      actionsEl.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer.setData("application/x-mymux-session-actions", String(ptyId));
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("actions-dragging");
      });
      actionsEl.addEventListener("dragend", (e) => {
        e.stopPropagation();
        sessionListEl.querySelectorAll(".session-item").forEach((el) => {
          el.classList.remove("actions-dragging", "drop-actions-left", "drop-actions-right");
        });
      });

      // Drag a session: reorder it within its own tab, or drop it onto another
      // tab's session (or that tab's group header) to move it to that tab.
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        if (e.target.closest(".session-actions")) return;
        e.dataTransfer.setData("text/plain", String(ptyId));
        e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragover", (e) => {
        const actionId = Number(e.dataTransfer.getData("application/x-mymux-session-actions"));
        if (actionId) {
          if (actionId !== ptyId) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = li.getBoundingClientRect();
          const side = e.clientX - rect.left < rect.width / 2 ? "left" : "right";
          li.classList.toggle("drop-actions-left", side === "left");
          li.classList.toggle("drop-actions-right", side === "right");
          li.classList.remove("drop-above", "drop-below");
          return;
        }
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        li.classList.toggle("drop-below", after);
        li.classList.toggle("drop-above", !after);
      });
      li.addEventListener("dragleave", (e) => {
        if (li.contains(e.relatedTarget)) return;
        li.classList.remove("drop-above", "drop-below", "drop-actions-left", "drop-actions-right");
      });
      li.addEventListener("drop", (e) => {
        const actionId = Number(e.dataTransfer.getData("application/x-mymux-session-actions"));
        if (actionId) {
          e.preventDefault();
          e.stopPropagation();
          li.classList.remove("drop-actions-left", "drop-actions-right");
          if (actionId !== ptyId) return;
          const rect = li.getBoundingClientRect();
          sessionActionsSide = e.clientX - rect.left < rect.width / 2 ? "left" : "right";
          try { localStorage.setItem(SESSION_ACTIONS_SIDE_KEY, sessionActionsSide); } catch {}
          refreshSessionList();
          return;
        }
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

  // Rebuilding dropped the ctx pills — re-attach them for sessions that have one.
  for (const [pid, tt] of terminals) if (tt.ctxPct != null || tt.codexDetected) updateCtxUi(pid, tt);
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
  const btns = [...explorerDrives.querySelectorAll(".drive-btn")];
  if (currentSftpId == null) {
    const cur = (currentExplorerPath || "").toUpperCase().replace(/\//g, "\\");
    btns.forEach((b) => {
      const d = (b.dataset.drive || "").toUpperCase().replace(/[\\/]+$/, "");
      b.classList.toggle("active", !!d && cur.startsWith(d));
    });
    return;
  }
  // Remote shortcuts: only the LONGEST matching prefix lights up ("/" would
  // otherwise match every path).
  const cur = currentExplorerPath || "";
  let best = null;
  for (const b of btns) {
    const p = b.dataset.path;
    if (!p) continue;
    if (cur === p || cur.startsWith(p.endsWith("/") ? p : p + "/")) {
      if (!best || p.length > best.dataset.path.length) best = b;
    }
  }
  btns.forEach((b) => b.classList.toggle("active", b === best));
}

// Which source the drive-button row is rendered for ("local" or an sftp id).
// Local shows Windows drive letters; SFTP shows remote shortcuts instead:
// root + home, plus each mounted volume when the server has /Volumes (macOS —
// USB sticks and external drives live there).
let driveRowMode = "local";
async function renderDriveRow() {
  if (!explorerDrives) return;
  const mode = currentSftpId == null ? "local" : String(currentSftpId);
  if (driveRowMode === mode) { highlightActiveDrive(); return; }
  driveRowMode = mode;
  if (mode === "local") { await loadDrives(); highlightActiveDrive(); return; }
  explorerDrives.innerHTML = "";
  const sftpId = currentSftpId;
  const stale = () => currentSftpId !== sftpId || driveRowMode !== mode;
  const add = (label, path, title) => {
    const btn = document.createElement("button");
    btn.className = "drive-btn";
    btn.dataset.path = path;
    btn.textContent = label;
    btn.title = title || path;
    btn.addEventListener("click", () => explorerGo(path, sftpId));
    explorerDrives.appendChild(btn);
  };
  add("/", "/", "Root");
  try {
    const home = await invoke("sftp_home_dir", { sessionId: sftpId });
    if (stale()) return;
    if (home && home !== "/") add("~", home, "Home: " + home);
  } catch {}
  try {
    const vols = await invoke("sftp_list_dir", { sessionId: sftpId, path: "/Volumes" });
    if (stale()) return;
    for (const v of vols.filter((e) => e.is_dir)) {
      add(v.name.length > 12 ? v.name.slice(0, 11) + "…" : v.name, v.path, v.name);
    }
  } catch {} // no /Volumes — not a Mac; root/home shortcuts still apply
  highlightActiveDrive();
}

// ═══════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════

async function loadCommands() {
  try {
    const cmds = await invoke("list_commands");
    savedCmds = cmds;
    renderCmdList(cmds);
    renderAllPaneCommandShortcuts();
  } catch (err) {
    toast("Error: " + err, true);
  }
}

function commandShortcutLabel(cmd) {
  const alias = String(cmd.alias || "").replace(/\s+/g, "").trim();
  if (alias) return alias.slice(0, 4).toUpperCase();
  const words = String(cmd.command || "").match(/[A-Za-z0-9]+/g) || [];
  const initials = words.slice(0, 3).map((word) => word[0]).join("");
  if (initials) return initials.toUpperCase();
  return Array.from(String(cmd.name || "CMD").trim()).slice(0, 3).join("") || "CMD";
}

function favoriteTarget(cmd) {
  const target = cmd.favoriteTarget || cmd.favorite_target;
  return target === "ai" ? "ai" : "shell";
}

function paneShortcutCommands(mode) {
  return [...savedCmds]
    .filter((cmd) => cmd && cmd.command && cmd.favorite)
    .filter((cmd) => favoriteTarget(cmd) === mode)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .slice(0, 6);
}

const AI_COMMAND_DOCK_Y_KEY = "mymux.aiCommandDockY.v1";

function savedAiCommandDockY() {
  try {
    const value = Number(localStorage.getItem(AI_COMMAND_DOCK_Y_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  } catch {
    return null;
  }
}

function positionPaneCommandDock(t) {
  const host = t && t.commandShortcutsEl;
  if (!host || t.commandDockY == null) return;
  const paneHeight = t.paneEl.clientHeight;
  const dockHeight = host.offsetHeight;
  if (!paneHeight || !dockHeight) return;
  const minTop = 28;
  const maxTop = Math.max(minTop, paneHeight - dockHeight - 54);
  const top = Math.max(minTop, Math.min(maxTop, Math.round(t.commandDockY * paneHeight)));
  host.style.top = `${top}px`;
  host.style.bottom = "auto";
}

function bindPaneCommandDockDrag(ptyId, handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const t = terminals.get(ptyId);
    if (!t || !t.commandShortcutsEl) return;
    event.preventDefault();
    event.stopPropagation();
    setFocusedPane(ptyId);

    const dock = t.commandShortcutsEl;
    const paneRect = t.paneEl.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const grabOffset = event.clientY - dockRect.top;
    const onMove = (moveEvent) => {
      const minTop = 28;
      const maxTop = Math.max(minTop, paneRect.height - dock.offsetHeight - 54);
      const top = Math.max(minTop, Math.min(maxTop, moveEvent.clientY - paneRect.top - grabOffset));
      t.commandDockY = top / Math.max(paneRect.height, 1);
      dock.style.top = `${Math.round(top)}px`;
      dock.style.bottom = "auto";
    };
    const onUp = () => {
      try { localStorage.setItem(AI_COMMAND_DOCK_Y_KEY, String(t.commandDockY)); } catch {}
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function renderPaneCommandShortcuts(ptyId) {
  const t = terminals.get(ptyId);
  const host = t && t.commandShortcutsEl;
  if (!host) return;
  const mode = t.aiMode ? "ai" : "shell";
  host.replaceChildren();
  host.classList.toggle("shell-mode", mode === "shell");
  host.classList.toggle("ai-mode", mode === "ai");
  if (mode === "ai") {
    const handle = document.createElement("div");
    handle.className = "pane-command-dock-grip";
    handle.textContent = "::";
    handle.title = "Drag shortcuts up or down";
    handle.setAttribute("aria-label", "Drag shortcut dock");
    bindPaneCommandDockDrag(ptyId, handle);
    host.appendChild(handle);
  }
  for (const cmd of paneShortcutCommands(mode)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pane-command-shortcut";
    button.textContent = commandShortcutLabel(cmd);
    button.title = [cmd.name, cmd.description, cmd.command].filter(Boolean).join("\n");
    button.setAttribute("aria-label", `Run ${cmd.name || cmd.command}`);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setFocusedPane(ptyId);
      runCommandCombo(cmd, ptyId);
    });
    host.appendChild(button);
  }
  host.classList.toggle("ai-hidden", host.querySelectorAll(".pane-command-shortcut").length === 0);
  if (t.commandDockY == null) t.commandDockY = savedAiCommandDockY();
  if (mode === "ai") requestAnimationFrame(() => positionPaneCommandDock(t));
  else {
    host.style.top = "";
    host.style.bottom = "";
  }
}

function renderAllPaneCommandShortcuts() {
  for (const ptyId of terminals.keys()) renderPaneCommandShortcuts(ptyId);
}

function setPaneAiMode(t, active) {
  if (!t || t.aiMode === active) return;
  t.aiMode = active;
  renderPaneCommandShortcuts(t.id);
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
        <span class="cmd-text" title="${esc(cmd.cwd ? "in " + cmd.cwd : "")}">${cmd.alias ? `<span class="cmd-alias">${esc(cmd.alias)}</span>` : ""}${cmd.cwd ? `<span class="cmd-cwd" title="${esc(cmd.cwd)}">📁</span>` : ""}${esc(cmd.command)}</span>
        <span class="cmd-actions">
          <button class="fav-btn${cmd.favorite ? " on" : ""}" title="Favorite">${cmd.favorite ? "★" : "☆"}</button>
          <button class="copy-btn" title="Copy">Copy</button>
          <button class="edit-btn" title="Edit">Edit</button>
          <button class="send-btn" title="Send to terminal">Send</button>
        </span>
      </div>
      ${cmd.description ? `<div class="cmd-desc">${esc(cmd.description)}</div>` : ""}
    `;
    li.querySelector(".send-btn").addEventListener("click", (e) => { e.stopPropagation(); runCommandCombo(cmd); });
    const favButton = li.querySelector(".fav-btn");
    const activeMode = terminals.get(focusedPaneId ?? activeTermId)?.aiMode ? "ai" : "shell";
    const currentTarget = favoriteTarget(cmd);
    favButton.title = cmd.favorite
      ? `Pinned to ${currentTarget === "ai" ? "AI command dock" : "shell shortcuts"}`
      : `Pin to ${activeMode === "ai" ? "AI command dock" : "shell shortcuts"}`;
    favButton.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(cmd); });
    li.querySelector(".copy-btn").addEventListener("click", (e) => { e.stopPropagation(); copyCmd(cmd); });
    li.querySelector(".edit-btn").addEventListener("click", (e) => { e.stopPropagation(); openModal(cmd); });
    li.querySelector(".cmd-x").addEventListener("click", (e) => { e.stopPropagation(); quickDeleteCmd(cmd); });
    li.addEventListener("dblclick", () => runCommandCombo(cmd));
    cmdListEl.appendChild(li);
  }
}

async function toggleFavorite(cmd) {
  try {
    const target = terminals.get(focusedPaneId ?? activeTermId)?.aiMode ? "ai" : "shell";
    const favorite = !cmd.favorite || favoriteTarget(cmd) !== target;
    await invoke("set_favorite", { id: cmd.id, favorite, favoriteTarget: target });
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
  const inputCwd = document.getElementById("input-cwd");
  const inputAlias = document.getElementById("input-alias");
  if (cmd) {
    modalTitle.textContent = "Edit Command";
    inputName.value = cmd.name;
    inputCommand.value = cmd.command;
    inputDesc.value = cmd.description || "";
    if (inputCwd) inputCwd.value = cmd.cwd || "";
    if (inputAlias) inputAlias.value = cmd.alias || "";
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
  const cwd = (document.getElementById("input-cwd")?.value || "").trim();
  const alias = (document.getElementById("input-alias")?.value || "").trim();
  if (!name || !command) return;
  try {
    if (editingId) {
      await invoke("update_command", { id: editingId, name, command, description, cwd, alias });
      toast("Updated");
    } else {
      await invoke("add_command", { name, command, description, cwd, alias });
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
  toastEl._timer = setTimeout(() => toastEl.classList.add("hidden"), 2000);
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

function loadCommandHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMMAND_HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.command === "string" && entry.command.trim())
      .map((entry) => ({
        command: entry.command.trim(),
        count: Math.max(1, Number(entry.count) || 1),
        lastUsed: Number(entry.lastUsed) || 0,
      }))
      .slice(0, COMMAND_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveCommandHistory() {
  try {
    localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory.slice(0, COMMAND_HISTORY_LIMIT)));
  } catch {}
}

function rememberCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized || normalized.length < 2) return;
  if (/^(cls|clear|exit)$/i.test(normalized)) return;
  if (normalized.startsWith("\x1b")) return;

  const now = Date.now();
  const existing = commandHistory.find((entry) => entry.command === normalized);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastUsed = now;
  } else {
    commandHistory.push({ command: normalized, count: 1, lastUsed: now });
  }
  commandHistory.sort((a, b) => (b.count || 1) - (a.count || 1) || (b.lastUsed || 0) - (a.lastUsed || 0));
  commandHistory = commandHistory.slice(0, COMMAND_HISTORY_LIMIT);
  saveCommandHistory();
}

function handleTerminalInput(data, ptyId) {
  const tInfo = terminals.get(ptyId);
  if (tInfo && typeof tInfo.acInput !== "string") tInfo.acInput = "";
  const getInput = () => (tInfo ? tInfo.acInput : currentInput);
  const setInput = (value) => {
    currentInput = value;
    if (tInfo) tInfo.acInput = value;
  };
  // Track what user types to build current input line
  if (data === "\r" || data === "\n") {
    // Enter pressed — detect cd command and sync explorer
    const typedRaw = getInput();
    const typed = typedRaw.trim();
    syncExplorerOnCd(typed, ptyId);
    setInput("");
    hideAutocomplete();
    // Alias typed at the prompt: erase it and run the full combo instead
    // (cd into the saved directory, then the command — one Enter).
    const aliasCmd = typed && savedCmds.find((c) => c.alias && c.alias === typed);
    if (aliasCmd) {
      invoke("pty_write", { id: ptyId, data: "\x7f".repeat(typedRaw.length) });
      runCommandCombo(aliasCmd, ptyId);
      return "consumed";
    }
    rememberCommand(typed);
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
        const item = items[acSelectedIdx];
        const saved = savedCmds.find((c) => c.id === item.dataset.cmdId);
        // cwd-bound commands expand to the full "cd … then run" line.
        const cmd = saved
          ? commandComboLine(saved, paneShellKind(terminals.get(ptyId)))
          : item.dataset.command;
        // Clear current input and type the command
        const backspaces = "\x7f".repeat(getInput().length);
        invoke("pty_write", { id: ptyId, data: backspaces });
        invoke("pty_write", { id: ptyId, data: cmd });
        setInput(cmd);
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
    setInput(getInput().slice(0, -1));
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    // Printable character
    setInput(getInput() + data);
  } else {
    // Control sequences — ignore for autocomplete tracking
    return;
  }

  // Show/update autocomplete
  const input = getInput();
  if (input.length >= 1) {
    showAutocomplete(input, ptyId);
  } else {
    hideAutocomplete();
  }
}

function showAutocomplete(input, ptyId) {
  const lower = input.toLowerCase();
  let matches = savedCmds.filter(
    (c) =>
      (c.alias && c.alias.toLowerCase().startsWith(lower)) ||
      c.name.toLowerCase().includes(lower) ||
      c.command.toLowerCase().includes(lower)
  );
  // Alias hits first — they are deliberate abbreviations, not substring luck.
  matches.sort((a, b) =>
    ((b.alias && b.alias.toLowerCase().startsWith(lower)) ? 1 : 0) -
    ((a.alias && a.alias.toLowerCase().startsWith(lower)) ? 1 : 0));
  const existingCommands = new Set(matches.map((c) => commandComboLine(c, paneShellKind(terminals.get(ptyId)))));
  const historyMatches = commandHistory
    .filter((h) => h.command.toLowerCase().includes(lower) && !existingCommands.has(h.command))
    .sort((a, b) => {
      const aPrefix = a.command.toLowerCase().startsWith(lower) ? 1 : 0;
      const bPrefix = b.command.toLowerCase().startsWith(lower) ? 1 : 0;
      if (aPrefix !== bPrefix) return bPrefix - aPrefix;
      if ((a.count || 1) !== (b.count || 1)) return (b.count || 1) - (a.count || 1);
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    })
    .map((h) => ({
      id: `history:${h.command}`,
      name: "History",
      command: h.command,
      description: `${h.count || 1}x`,
      alias: "",
      cwd: "",
      isHistory: true,
      historyCount: h.count || 1,
    }));
  matches = [...matches, ...historyMatches];

  if (matches.length === 0) {
    hideAutocomplete();
    return;
  }

  acList.innerHTML = "";
  acSelectedIdx = 0;

  const shellKind = paneShellKind(terminals.get(ptyId));
  matches.slice(0, 8).forEach((cmd, i) => {
    const li = document.createElement("li");
    li.className = "ac-item" + (i === 0 ? " selected" : "");
    li.dataset.command = cmd.command;
    li.dataset.cmdId = cmd.id;
    // Show what will ACTUALLY run — for cwd-bound commands that's the full
    // "cd <dir> then command" line, not just the bare command.
    const preview = commandComboLine(cmd, shellKind);
    const meta = cmd.isHistory ? ` <span class="ac-meta">${cmd.historyCount}x</span>` : "";
    li.innerHTML = `
      <span class="ac-name">${cmd.alias ? `<span class="cmd-alias">${esc(cmd.alias)}</span>` : ""}${esc(cmd.name)}${meta}</span>
      <span class="ac-cmd" title="${esc(preview)}">${esc(preview)}</span>
    `;
    li.addEventListener("click", () => {
      const line = commandComboLine(cmd, paneShellKind(terminals.get(ptyId)));
      const current = terminals.get(ptyId)?.acInput ?? currentInput;
      const backspaces = "\x7f".repeat(current.length);
      invoke("pty_write", { id: ptyId, data: backspaces + line });
      currentInput = line;
      const pane = terminals.get(ptyId);
      if (pane) pane.acInput = line;
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
    const lineTop = r.top + curY * ch;
    const lineBottom = r.top + (curY + 1) * ch;
    const gap = 12;
    acPopup.style.left = left + "px";
    // Reveal first so offsetHeight/Width are measurable (no repaint until JS yields).
    acPopup.classList.remove("hidden");
    const popupH = acPopup.offsetHeight;
    // Clamp with the ACTUAL width — the popup grows for long combo lines.
    left = Math.max(4, Math.min(left, window.innerWidth - acPopup.offsetWidth - 8));
    acPopup.style.left = left + "px";
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

    const runInstall = async () => {
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
    };

    const modal = document.getElementById("update-modal");
    const modalOk = document.getElementById("update-modal-ok");
    const modalCancel = document.getElementById("update-modal-cancel");
    const closeUpdateModal = () => {
      if (modal) modal.classList.add("hidden");
      // Restore the native browser overlay only if we're still on the browser view.
      if (browserTabActive && browserMode === "native") openNativePane();
    };
    if (modalOk) modalOk.addEventListener("click", () => { closeUpdateModal(); runInstall(); });
    if (modalCancel) modalCancel.addEventListener("click", closeUpdateModal);
    if (modal) {
      modal.addEventListener("click", (e) => { if (e.target === modal) closeUpdateModal(); });
      modal.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUpdateModal(); });
    }

    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      // With open sessions, confirm first — updating closes every session.
      if (terminals.size > 0 && modal) {
        // The native browser overlay floats above all HTML; hide it so the modal shows.
        if (browserTabActive && browserMode === "native") invoke("browser_pane_hide").catch(() => {});
        modal.classList.remove("hidden");
        if (modalOk) modalOk.focus();
        return;
      }
      runInstall();
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
