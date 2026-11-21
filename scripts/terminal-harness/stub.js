// Tauri IPC stub: boots Mymux's real frontend in a plain browser with a fake
// PTY that echoes input back after ECHO_MS, like a line editor or a TUI input
// box does. Counts every invoke so a test can see the IPC traffic.
(function () {
  const ECHO_RAW = new URLSearchParams(location.search).get("echo");
  const ECHO_MS = ECHO_RAW === "off" ? null : Number(ECHO_RAW || 30);
  const ptys = new Map(); // id -> { chunks: [[start, text]], end }
  let nextId = 1;
  window.__ptyWrites = [];
  window.__invokeCounts = {};
  window.__invokeLog = [];
  const push = (id, text) => { const p = ptys.get(id); if (!p || !text) return; p.chunks.push([p.end, text]); p.end += text.length; };
  const readAfter = (id, offset, maxBytes) => {
    const p = ptys.get(id);
    if (!p) return { chunks: [], next: 0, exited: true, truncated: false };
    const chunks = []; let next = offset; let budget = maxBytes || Infinity;
    for (const [start, text] of p.chunks) {
      if (start + text.length <= offset || budget <= 0) continue;
      const piece = text.slice(Math.max(0, offset - start), Math.max(0, offset - start) + budget);
      chunks.push(piece); budget -= piece.length; next = Math.max(next, Math.max(start, offset) + piece.length);
    }
    return { chunks, next: chunks.length ? next : Math.max(offset, 0), exited: false, truncated: false };
  };
  const noop = () => Promise.resolve(null);
  const winObj = new Proxy({}, { get: () => () => Promise.resolve(null) });
  async function invoke(cmd, args) {
    window.__invokeCounts[cmd] = (window.__invokeCounts[cmd] || 0) + 1;
    window.__invokeLog.push([Math.round(performance.now()), cmd]);
    if (window.__invokeLog.length > 20000) window.__invokeLog.shift();
    if (window.__stubReplies && cmd in window.__stubReplies) { const r = window.__stubReplies[cmd]; return typeof r === "function" ? r(args) : r; }
    switch (cmd) {
      case "pty_spawn": { const id = nextId++; ptys.set(id, { chunks: [], end: 0 }); push(id, "> "); return id; }
      case "pty_read": return readAfter(args.id, args.offset || 0, args.maxBytes);
      case "pty_read_many": return (args.reads || []).map((r) => ({ id: r.id, ...readAfter(r.id, r.offset || 0, r.maxBytes) }));
      case "pty_write": {
        window.__ptyWrites.push({ id: args.id, data: args.data, t: performance.now() });
        const printable = args.data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "");
        if (printable && ECHO_MS !== null) setTimeout(() => push(args.id, printable.replace(/\r/g, "\r\n> ")), ECHO_MS);
        return null;
      }
      case "voice_managed_status": return { python: "C:/stub/python.exe", models: ["small"] };
      case "voice_transcribe_local": {
        window.__voiceCalls.push({ bytes: (args.audioBase64 || "").length, mode: args.mode, model: args.model });
        await new Promise((r) => setTimeout(r, 300));
        return "안녕하세요";
      }
      case "tool_installed": return true;
      case "list_commands": return [];
      case "session_load": return null;
      case "explorer_home_dir": return "C:/stub";
      default: return null;
    }
  }
  // ?voice=1: a finished local voice setup, so the mic buttons have an engine.
  // Transcription answers after VOICE_MS with a fixed sentence and logs its call.
  window.__voiceCalls = [];
  if (new URLSearchParams(location.search).get("voice")) {
    try {
      localStorage.setItem("mymux.voice.localMode", "python");
      localStorage.setItem("mymux.voice.runner.python", "C:/stub/python.exe");
    } catch {}
  }
  window.__stubPush = push; // inject raw PTY output from a test
  window.__TAURI__ = {
    core: { invoke, convertFileSrc: (p) => p },
    event: { listen: async () => () => {}, emit: noop },
    app: { getVersion: async () => "0.0.0-harness" },
    window: { getCurrentWindow: () => winObj },
    webview: { getCurrentWebview: () => winObj },
  };
})();
