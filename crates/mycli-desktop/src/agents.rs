//! Claude Code subagent activity, read out of the session transcript.
//!
//! Claude Code writes one JSONL transcript per session under
//! `~/.claude/projects/<slugged cwd>/<session id>.jsonl`, and every subagent it
//! launches lands there as an `Agent` tool call (older builds named the tool
//! `Task`) carrying the agent type, the one-line description and the full
//! prompt. When the agent finishes, the matching `tool_result` adds the
//! duration, the token total and how many tools it used. That is strictly
//! better than scraping the pane: a TUI repaint can truncate or re-wrap the
//! `● agent(description)` line it prints, whereas the transcript states each
//! field exactly once and makes completion unambiguous.
//!
//! What the transcript does NOT record is which Mymux pane it belongs to.
//! Claude Code hands that out in the payload it sends to its **statusline**
//! command, but a user whose statusline is already taken — oh-my-claudecode's
//! HUD, for one — never installs Mymux as that statusline, so the mapping is
//! reconstructed here instead:
//!
//! * the project directory pins the pane down to its working directory, and
//! * among the transcripts in that directory the pane claims the one whose
//!   session began closest after the moment its AI CLI came up.
//!
//! Every pane is resolved in ONE call so a transcript already claimed by one
//! pane is never handed to a second one. That is what keeps two Claude sessions
//! running in the same folder apart. Two sessions started in the same folder
//! within the same second are the one case this cannot separate; they may show
//! each other's agents until one of them is restarted.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// A pane that currently has a Claude CLI in it, as the frontend sees it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneQuery {
    pane_id: i64,
    /// The pane's working directory — what the project slug is built from.
    cwd: Option<String>,
    /// Epoch ms when the pane's AI CLI was first detected. Used to pick the
    /// transcript that started with it rather than an older one in the folder.
    since_ms: Option<i64>,
    /// Transcript this pane resolved to on an earlier poll. Kept sticky so the
    /// answer cannot drift between polls while the session keeps running.
    transcript: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    /// The `tool_use` id. Stable for the life of the agent, so the UI can
    /// update a row in place instead of rebuilding it.
    id: String,
    /// Agent type (`issue-merge-critic`, `general-purpose`, …).
    name: String,
    description: String,
    prompt: String,
    background: bool,
    /// `running` | `done` | `failed` | `cancelled` | `ended`.
    /// `ended` means the transcript never recorded an outcome and the
    /// session that owned the agent is gone, so it is over but no result
    /// is known — the usual fate of an agent-team teammate.
    status: String,
    model: Option<String>,
    started_at: Option<String>,
    started_ms: Option<i64>,
    finished_ms: Option<i64>,
    duration_ms: Option<i64>,
    total_tokens: Option<u64>,
    tool_uses: Option<u64>,
    /// Completion note for a background agent, taken from its task
    /// notification. Empty for foreground agents, which report numbers instead.
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAgents {
    pane_id: i64,
    /// The transcript this pane resolved to. The frontend sends it back on the
    /// next poll as `PaneQuery::transcript`.
    transcript: Option<String>,
    session_id: Option<String>,
    agents: Vec<AgentEntry>,
}

/// Newest agents to report per pane. A session list row is not the place for a
/// hundred entries, and this bounds what crosses the IPC boundary.
const MAX_AGENTS_PER_PANE: usize = 60;

/// How much of a transcript to read on first sight — every poll after that only
/// reads what was appended. Real sessions in a busy project measure 5-10 MB, and
/// the agents a user wants to see include the ones from the start of the
/// session, so this has to be generous enough to swallow a whole transcript;
/// it is a guard against a pathological file, not a working limit. Starting
/// mid-file is safe on its own: the first line read is then a fragment, which
/// fails to parse and is skipped like any torn line.
const MAX_INITIAL_READ: u64 = 64 * 1024 * 1024;

/// A transcript that has not been written to for this long has gone quiet, so a
/// `/clear` in that pane (which starts a brand new transcript) may be assumed.
const STALE_TRANSCRIPT_MS: i64 = 60_000;

/// Transcripts to keep parse state for. Scans are cheap to rebuild, so the cap
/// only exists to stop a long-lived app from holding every session it ever saw.
const MAX_CACHED_SCANS: usize = 64;

// ── incremental transcript scanning ─────────────────────────────────────────

/// Parse state for one transcript file, kept between polls so each poll only
/// reads the bytes that were appended since the last one.
#[derive(Default)]
struct FileScan {
    /// Bytes consumed so far.
    offset: u64,
    /// Trailing bytes that did not end in a newline — Claude Code appends a
    /// line at a time, so a poll can land mid-write.
    partial: String,
    /// Agent ids in the order they were launched.
    order: Vec<String>,
    agents: HashMap<String, AgentEntry>,
    session_id: Option<String>,
}

fn scans() -> &'static Mutex<HashMap<PathBuf, FileScan>> {
    static SCANS: OnceLock<Mutex<HashMap<PathBuf, FileScan>>> = OnceLock::new();
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read whatever was appended to `path` and fold it into `scan`.
fn scan_file(path: &Path, scan: &mut FileScan) -> std::io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    // A shorter file than last time is a different file under the same name.
    if len < scan.offset {
        *scan = FileScan::default();
    }
    if scan.offset == 0 && len > MAX_INITIAL_READ {
        scan.offset = len - MAX_INITIAL_READ;
    }
    if len == scan.offset {
        return Ok(());
    }
    file.seek(SeekFrom::Start(scan.offset))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    scan.offset += buf.len() as u64;

    let mut text = std::mem::take(&mut scan.partial);
    text.push_str(&String::from_utf8_lossy(&buf));
    // Hold an unterminated last line back for the next poll.
    let complete = match text.rfind('\n') {
        Some(i) => {
            let rest = text[i + 1..].to_string();
            let head = text[..i].to_string();
            scan.partial = rest;
            head
        }
        None => {
            scan.partial = text;
            String::new()
        }
    };
    for line in complete.lines() {
        ingest_line(line, scan);
    }
    Ok(())
}

/// Fold one transcript line into the scan. Anything unparseable is skipped:
/// this reads a file another process is actively appending to, so a torn line
/// is normal and must never be an error.
fn ingest_line(line: &str, scan: &mut FileScan) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    // Cheap pre-filter — three shapes of line matter and a transcript is mostly
    // made of the other kinds, so this skips the JSON parse for most of it.
    let wants_parse = line.contains("\"tool_use\"")
        || line.contains("\"tool_result\"")
        || line.contains("<task-notification>");
    if !wants_parse && scan.session_id.is_some() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if scan.session_id.is_none()
        && let Some(sid) = v.get("sessionId").and_then(Value::as_str)
    {
        scan.session_id = Some(sid.to_string());
    }
    let ts_ms = v
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(iso_to_epoch_ms);

    // A background agent's finish arrives as a queued task notification rather
    // than as its tool_result — the result only says "launched".
    if v.get("type").and_then(Value::as_str) == Some("queue-operation") {
        if let Some(content) = v.get("content").and_then(Value::as_str) {
            finish_from_notification(content, ts_ms, scan);
        }
        return;
    }

    let Some(items) = v.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let tool = item.get("name").and_then(Value::as_str).unwrap_or("");
                if tool != "Agent" && tool != "Task" {
                    continue;
                }
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if scan.agents.contains_key(id) {
                    continue;
                }
                let empty = Value::Null;
                let input = item.get("input").unwrap_or(&empty);
                let str_field = |key: &str| {
                    input
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                };
                let mut name = str_field("subagent_type");
                if name.is_empty() {
                    name = "agent".to_string();
                }
                scan.order.push(id.to_string());
                scan.agents.insert(
                    id.to_string(),
                    AgentEntry {
                        id: id.to_string(),
                        name,
                        description: str_field("description"),
                        prompt: str_field("prompt"),
                        background: input
                            .get("run_in_background")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        status: "running".to_string(),
                        started_at: v
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        started_ms: ts_ms,
                        ..AgentEntry::default()
                    },
                );
            }
            Some("tool_result") => {
                let Some(id) = item.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                if !scan.agents.contains_key(id) {
                    continue;
                }
                let is_error = item
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let empty = Value::Null;
                let result = v.get("toolUseResult").unwrap_or(&empty);
                let reported = result
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let model = result
                    .get("resolvedModel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let agent_type = result
                    .get("agentType")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let tokens = result.get("totalTokens").and_then(Value::as_u64);
                let tool_uses = result.get("totalToolUseCount").and_then(Value::as_u64);
                let reported_ms = result.get("totalDurationMs").and_then(Value::as_i64);

                let Some(agent) = scan.agents.get_mut(id) else {
                    continue;
                };
                if model.is_some() {
                    agent.model = model;
                }
                if let Some(t) = agent_type {
                    agent.name = t;
                }
                if tokens.is_some() {
                    agent.total_tokens = tokens;
                }
                if tool_uses.is_some() {
                    agent.tool_uses = tool_uses;
                }
                // Some results only say the agent was HANDED OFF, never that it
                // finished: `async_launched` for a background agent,
                // `teammate_spawned` for a member of an agent team. Both keep
                // running; a background agent's finish arrives later as a task
                // notification, and a teammate's often never arrives at all.
                // Matched by suffix so a later build's third spelling of "I
                // started it" is not mistaken for a result.
                let handed_off =
                    reported.ends_with("_launched") || reported.ends_with("_spawned");
                if !is_error && handed_off {
                    agent.background = true;
                    continue;
                }
                agent.status = if is_error {
                    "failed".to_string()
                } else {
                    normalize_status(&reported)
                };
                agent.finished_ms = ts_ms;
                agent.duration_ms = reported_ms.or(match (agent.started_ms, ts_ms) {
                    (Some(start), Some(end)) => Some(end - start),
                    _ => None,
                });
            }
            _ => {}
        }
    }
}

/// Close out a background agent from its `<task-notification>` block. The same
/// notification shape is used for background shell commands, so an id that is
/// not a known agent is simply ignored.
fn finish_from_notification(content: &str, ts_ms: Option<i64>, scan: &mut FileScan) {
    if !content.contains("<task-notification>") {
        return;
    }
    let Some(id) = xml_tag(content, "tool-use-id") else {
        return;
    };
    let status = xml_tag(content, "status").unwrap_or_default();
    let summary = xml_tag(content, "summary");
    let Some(agent) = scan.agents.get_mut(&id) else {
        return;
    };
    // A notification is enqueued and then removed, so the same finish is seen
    // twice; the first one already carries the numbers.
    if agent.status != "running" {
        return;
    }
    agent.status = normalize_status(&status);
    agent.finished_ms = ts_ms;
    if let (Some(start), Some(end)) = (agent.started_ms, ts_ms) {
        agent.duration_ms = Some(end - start);
    }
    if summary.as_deref().is_some_and(|s| !s.is_empty()) {
        agent.summary = summary;
    }
}

/// Map Claude Code's own status word onto the ones the UI draws.
///
/// Only an explicit failure word counts as a failure. An unrecognized status
/// arrived WITHOUT an error flag, which means the call came back fine and the
/// agent is finished — calling it a failure instead would be a confident wrong
/// answer, and that is exactly how an unknown `teammate_spawned` once painted a
/// whole session's agents red.
fn normalize_status(reported: &str) -> String {
    match reported {
        "cancelled" | "canceled" | "aborted" | "killed" | "interrupted" => "cancelled",
        "failed" | "failure" | "error" | "timeout" | "timed_out" => "failed",
        _ => "done",
    }
    .to_string()
}

/// `<name>value</name>` → `value`.
fn xml_tag(text: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

// ── transcript discovery ────────────────────────────────────────────────────

/// One transcript that a pane could be the owner of.
#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    /// Epoch ms of the session's first entry, i.e. when it began.
    start_ms: i64,
    /// Epoch ms of the file's last write — how we tell a live session from one
    /// that has gone quiet.
    mtime_ms: i64,
}

/// Claude Code's own project-directory name for a working directory: every
/// character that is not an ASCII letter or digit becomes `-`.
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The `~/.claude/projects/<slug>` directory for a working directory, if Claude
/// Code has ever run there.
fn project_dir(cwd: &str) -> Option<PathBuf> {
    let slug = project_slug(cwd);
    if slug.is_empty() {
        return None;
    }
    let root = crate::statusline::claude_config_dir().ok()?.join("projects");
    let exact = root.join(&slug);
    if exact.is_dir() {
        return Some(exact);
    }
    // Older Claude Code builds lower-cased the slug, and a pane that was
    // launched from a differently-cased spelling of the same path keeps that
    // directory for the life of the session.
    for entry in std::fs::read_dir(&root).ok()?.flatten() {
        if entry.file_name().to_string_lossy().eq_ignore_ascii_case(&slug)
            && entry.path().is_dir()
        {
            return Some(entry.path());
        }
    }
    None
}

/// Epoch ms of a session's first timestamped entry. Read from the head of the
/// file only, and cached: a session's start never changes.
fn session_start_ms(path: &Path) -> Option<i64> {
    static HEADS: OnceLock<Mutex<HashMap<PathBuf, Option<i64>>>> = OnceLock::new();
    let cache = HEADS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hit) = guard.get(path) {
        return *hit;
    }
    let mut file = std::fs::File::open(path).ok()?;
    // Enough for the handful of preamble lines Claude Code writes before the
    // first timestamped entry.
    let mut buf = vec![0u8; 64 * 1024];
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    let text = String::from_utf8_lossy(&buf);
    let found = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|v| {
            v.get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_to_epoch_ms)
        });
    if guard.len() > MAX_CACHED_SCANS * 4 {
        guard.clear();
    }
    guard.insert(path.to_path_buf(), found);
    found
}

fn candidates(dir: &Path) -> Vec<Candidate> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // A transcript with no timestamped entry yet sorts by its mtime, which
        // for a brand-new file is its creation moment.
        let start_ms = session_start_ms(&path).unwrap_or(mtime_ms);
        out.push(Candidate {
            path,
            start_ms,
            mtime_ms,
        });
    }
    out
}

// ── the command ─────────────────────────────────────────────────────────────

/// Decide which transcript each pane owns.
///
/// Split out from the command so the claiming rules — the part of this module
/// most likely to be subtly wrong — can be exercised without a `~/.claude` tree.
/// `pane_dirs[i]` is the project directory resolved for `panes[i]`, and `by_dir`
/// holds the transcripts found in each of those directories.
fn assign_transcripts(
    panes: &[PaneQuery],
    pane_dirs: &[Option<PathBuf>],
    by_dir: &HashMap<PathBuf, Vec<Candidate>>,
    now_ms: i64,
) -> Vec<Option<PathBuf>> {
    let mut claimed: HashSet<PathBuf> = HashSet::new();
    let mut chosen: Vec<Option<PathBuf>> = vec![None; panes.len()];

    // Pass 1 — every pane keeps the transcript it already resolved to, as long
    // as that file is still there. Sticky first, so a new transcript appearing
    // in the folder can never pull a working pane off its own session.
    for (i, pane) in panes.iter().enumerate() {
        let Some(dir) = &pane_dirs[i] else { continue };
        let Some(previous) = pane.transcript.as_deref().map(PathBuf::from) else {
            continue;
        };
        let known = by_dir
            .get(dir)
            .is_some_and(|list| list.iter().any(|c| c.path == previous));
        if known && claimed.insert(previous.clone()) {
            chosen[i] = Some(previous);
        }
    }

    // Pass 2 — a pane whose transcript has gone quiet has most likely been
    // `/clear`ed, which starts a fresh one. Move it to the next transcript that
    // began after its own and that no other pane has claimed. The staleness
    // gate is what makes this safe: a session being actively written to is
    // never moved, so this cannot steal the file another pane just started.
    for i in 0..panes.len() {
        let (Some(dir), Some(current)) = (pane_dirs[i].clone(), chosen[i].clone()) else {
            continue;
        };
        let Some(list) = by_dir.get(&dir) else { continue };
        let Some(current_c) = list.iter().find(|c| c.path == current) else {
            continue;
        };
        if now_ms - current_c.mtime_ms < STALE_TRANSCRIPT_MS {
            continue;
        }
        let successor = list
            .iter()
            .filter(|c| {
                !claimed.contains(&c.path)
                    && c.start_ms > current_c.start_ms
                    && c.mtime_ms > current_c.mtime_ms
            })
            .min_by_key(|c| c.start_ms)
            .map(|c| c.path.clone());
        if let Some(next) = successor {
            claimed.remove(&current);
            claimed.insert(next.clone());
            chosen[i] = Some(next);
        }
    }

    // Pass 3 — a pane with nothing resolved yet takes the earliest unclaimed
    // transcript that began around the time its AI CLI came up. The fallback to
    // the most recently written file covers `claude --resume`, which appends to
    // a transcript that began long before this pane existed.
    for i in 0..panes.len() {
        if chosen[i].is_some() {
            continue;
        }
        let Some(dir) = &pane_dirs[i] else { continue };
        let Some(list) = by_dir.get(dir) else { continue };
        // One minute of slack: the pane notices its AI CLI from the first status
        // footer it prints, which is after Claude Code opened the transcript.
        // With no launch time to go on, skip straight to the newest transcript
        // rather than letting a `0` anchor match the oldest one in the folder.
        let since = panes[i].since_ms.map(|ms| ms - 60_000);
        let pick = list
            .iter()
            .filter(|c| {
                !claimed.contains(&c.path) && since.is_some_and(|since| c.start_ms >= since)
            })
            .min_by_key(|c| c.start_ms)
            .or_else(|| {
                list.iter()
                    .filter(|c| !claimed.contains(&c.path))
                    .max_by_key(|c| c.mtime_ms)
            })
            .map(|c| c.path.clone());
        if let Some(path) = pick {
            claimed.insert(path.clone());
            chosen[i] = Some(path);
        }
    }
    chosen
}

/// Resolve every AI pane to a transcript and report the subagents in it.
///
/// Panes are answered together on purpose: the claim set built here is what
/// stops two panes in the same folder from being handed the same transcript.
///
/// `async` only to keep it OFF the UI thread: the first poll after a session is
/// picked up reads the whole transcript, which is megabytes, and a plain sync
/// command would stall the window for that read. The body itself stays
/// synchronous — there is no runtime to nest here.
#[tauri::command(async)]
pub fn claude_agent_activity(panes: Vec<PaneQuery>) -> Result<Vec<PaneAgents>, String> {
    // Project directory per pane, plus the candidate list for each distinct
    // directory (read once even when several panes share a folder).
    let mut pane_dirs: Vec<Option<PathBuf>> = Vec::with_capacity(panes.len());
    let mut by_dir: HashMap<PathBuf, Vec<Candidate>> = HashMap::new();
    for pane in &panes {
        let dir = pane.cwd.as_deref().and_then(project_dir);
        if let Some(dir) = &dir {
            by_dir.entry(dir.clone()).or_insert_with(|| candidates(dir));
        }
        pane_dirs.push(dir);
    }
    let chosen = assign_transcripts(&panes, &pane_dirs, &by_dir, now_epoch_ms());
    let claimed: HashSet<PathBuf> = chosen.iter().flatten().cloned().collect();

    let mut guard = scans().lock().unwrap_or_else(|e| e.into_inner());
    // Drop parse state for transcripts nobody is watching any more.
    if guard.len() > MAX_CACHED_SCANS {
        guard.retain(|path, _| claimed.contains(path));
    }
    let mut out = Vec::with_capacity(panes.len());
    for (i, pane) in panes.iter().enumerate() {
        let mut row = PaneAgents {
            pane_id: pane.pane_id,
            transcript: None,
            session_id: None,
            agents: Vec::new(),
        };
        if let Some(path) = &chosen[i] {
            let scan = guard.entry(path.clone()).or_default();
            // A read error (file replaced mid-poll, say) leaves whatever was
            // already parsed in place rather than blanking the pane's list.
            let _ = scan_file(path, scan);
            row.transcript = Some(path.to_string_lossy().to_string());
            row.session_id = scan.session_id.clone().or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
            });
            let start = scan.order.len().saturating_sub(MAX_AGENTS_PER_PANE);
            row.agents = scan.order[start..]
                .iter()
                .filter_map(|id| scan.agents.get(id).cloned())
                .collect();
            // An agent launched BEFORE this pane's Claude came up cannot still
            // be running in it — the process that owned it is gone. Without
            // this, `claude --resume` on an old session shows days-old agents
            // as live, because a handed-off agent (a teammate especially) is
            // usually never closed out in the transcript at all.
            if let Some(since) = pane.since_ms {
                for agent in &mut row.agents {
                    if agent.status == "running" && agent.started_ms.is_some_and(|s| s < since) {
                        agent.status = "ended".to_string();
                    }
                }
            }
        }
        out.push(row);
    }
    Ok(out)
}

// ── time helpers ────────────────────────────────────────────────────────────

fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `2026-08-27T02:13:07.664Z` → epoch milliseconds.
///
/// Transcript timestamps are always UTC with a trailing `Z`, so no zone
/// handling is needed; anything else returns `None` and the caller falls back
/// to the file's mtime.
fn iso_to_epoch_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let field = |range: std::ops::Range<usize>| -> Option<i64> {
        text.get(range).and_then(|s| s.parse::<i64>().ok())
    };
    let year = field(0..4)?;
    let month = field(5..7)?;
    let day = field(8..10)?;
    let hour = field(11..13)?;
    let minute = field(14..16)?;
    let second = field(17..19)?;
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        field(20..23).unwrap_or(0)
    } else {
        0
    };
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

/// Days from 1970-01-01 to the given civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_a_path_the_way_claude_code_does() {
        assert_eq!(project_slug(r"D:\Project\Mymux"), "D--Project-Mymux");
        assert_eq!(project_slug("/home/me/proj"), "-home-me-proj");
        // A dot directory contributes two dashes: the separator and the dot.
        assert_eq!(
            project_slug(r"D:\Project\App\.issue-worktrees\11"),
            "D--Project-App--issue-worktrees-11"
        );
    }

    #[test]
    fn parses_transcript_timestamps() {
        assert_eq!(iso_to_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_to_epoch_ms("2026-08-27T02:13:07.664Z"), Some(1_787_796_787_664));
        // Seconds-only form (no fractional part) still parses.
        assert_eq!(iso_to_epoch_ms("2026-08-27T02:13:07Z"), Some(1_787_796_787_000));
        assert_eq!(iso_to_epoch_ms("not a timestamp"), None);
    }

    #[test]
    fn reads_a_tag_out_of_a_task_notification() {
        let content = "<task-notification>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>";
        assert_eq!(xml_tag(content, "tool-use-id"), Some("toolu_1".into()));
        assert_eq!(xml_tag(content, "status"), Some("completed".into()));
        assert_eq!(xml_tag(content, "missing"), None);
    }

    /// A foreground agent: launched, then completed with its own numbers.
    #[test]
    fn folds_a_foreground_agent_from_launch_to_completion() {
        let mut scan = FileScan::default();
        ingest_line(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"review the plan","subagent_type":"critic","prompt":"do it","run_in_background":false}}]}}"#,
            &mut scan,
        );
        assert_eq!(scan.order, vec!["toolu_1"]);
        let agent = &scan.agents["toolu_1"];
        assert_eq!(agent.status, "running");
        assert_eq!(agent.name, "critic");
        assert_eq!(agent.description, "review the plan");
        assert!(!agent.background);

        ingest_line(
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-08-27T02:01:00.000Z","toolUseResult":{"status":"completed","agentType":"critic","resolvedModel":"claude-haiku-4-5","totalDurationMs":60000,"totalTokens":81269,"totalToolUseCount":23},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1"}]}}"#,
            &mut scan,
        );
        let agent = &scan.agents["toolu_1"];
        assert_eq!(agent.status, "done");
        assert_eq!(agent.duration_ms, Some(60_000));
        assert_eq!(agent.total_tokens, Some(81_269));
        assert_eq!(agent.tool_uses, Some(23));
        assert_eq!(agent.model.as_deref(), Some("claude-haiku-4-5"));
    }

    /// A background agent stays running through its `async_launched` result and
    /// is only closed out by the task notification that follows.
    #[test]
    fn background_agent_finishes_on_its_task_notification() {
        let mut scan = FileScan::default();
        ingest_line(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Agent","input":{"description":"code review","subagent_type":"reviewer","prompt":"p","run_in_background":true}}]}}"#,
            &mut scan,
        );
        ingest_line(
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-08-27T02:00:01.000Z","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a1","resolvedModel":"claude-opus-5"},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2"}]}}"#,
            &mut scan,
        );
        assert_eq!(scan.agents["toolu_2"].status, "running");
        assert!(scan.agents["toolu_2"].background);

        ingest_line(
            r#"{"type":"queue-operation","operation":"enqueue","sessionId":"s1","timestamp":"2026-08-27T02:05:00.000Z","content":"<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_2</tool-use-id>\n<status>completed</status>\n<summary>review done</summary>\n</task-notification>"}"#,
            &mut scan,
        );
        let agent = &scan.agents["toolu_2"];
        assert_eq!(agent.status, "done");
        assert_eq!(agent.duration_ms, Some(300_000));
        assert_eq!(agent.summary.as_deref(), Some("review done"));
    }

    /// An agent-team teammate reports `teammate_spawned` — "I started it", not
    /// "it finished". Reading that as a result marked a whole session's agents
    /// as failed in one second each, which is what this guards against.
    #[test]
    fn a_spawned_teammate_is_still_running_not_finished() {
        let mut scan = FileScan::default();
        ingest_line(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-09-14T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_t","name":"Agent","input":{"description":"배치 A","subagent_type":"exec-A-css","prompt":"p"}}]}}"#,
            &mut scan,
        );
        ingest_line(
            r#"{"type":"user","sessionId":"s1","timestamp":"2026-09-14T02:00:01.000Z","toolUseResult":{"status":"teammate_spawned","prompt":"..."},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_t"}]}}"#,
            &mut scan,
        );
        let agent = &scan.agents["toolu_t"];
        assert_eq!(agent.status, "running");
        assert!(agent.background);
        assert_eq!(agent.finished_ms, None, "a spawn is not a finish");
    }

    /// A status word this build has never seen is not evidence of failure.
    #[test]
    fn an_unknown_status_is_not_reported_as_a_failure() {
        assert_eq!(normalize_status("something_new"), "done");
        assert_eq!(normalize_status(""), "done");
        assert_eq!(normalize_status("completed"), "done");
        assert_eq!(normalize_status("failed"), "failed");
        assert_eq!(normalize_status("cancelled"), "cancelled");
    }

    /// Notifications are enqueued and then removed, so the same finish arrives
    /// twice — the second one must not overwrite the first.
    #[test]
    fn a_repeated_notification_does_not_change_a_finished_agent() {
        let mut scan = FileScan::default();
        ingest_line(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_3","name":"Agent","input":{"description":"d","subagent_type":"x","prompt":"p","run_in_background":true}}]}}"#,
            &mut scan,
        );
        let notification = r#"{"type":"queue-operation","sessionId":"s1","timestamp":"TS","content":"<task-notification>\n<tool-use-id>toolu_3</tool-use-id>\n<status>completed</status>\n</task-notification>"}"#;
        ingest_line(&notification.replace("TS", "2026-08-27T02:01:00.000Z"), &mut scan);
        ingest_line(&notification.replace("TS", "2026-08-27T02:09:00.000Z"), &mut scan);
        assert_eq!(scan.agents["toolu_3"].duration_ms, Some(60_000));
    }

    /// Tool calls that are not subagents must not appear in the list.
    #[test]
    fn ignores_tool_calls_that_are_not_agents() {
        let mut scan = FileScan::default();
        ingest_line(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls"}}]}}"#,
            &mut scan,
        );
        assert!(scan.order.is_empty());
    }

    // ── transcript claiming ──
    // A pane is (cwd, when its AI CLI came up, what it resolved to last time);
    // a candidate is (file, when the session began, when it was last written).
    // `NOW` stands in for the clock so staleness is exact rather than timed.
    const NOW: i64 = 1_000_000;

    fn pane(id: i64, since_ms: Option<i64>, transcript: Option<&str>) -> PaneQuery {
        PaneQuery {
            pane_id: id,
            cwd: Some("D:\\Project\\App".into()),
            since_ms,
            transcript: transcript.map(str::to_string),
        }
    }

    fn candidate(name: &str, start_ms: i64, mtime_ms: i64) -> Candidate {
        Candidate {
            path: PathBuf::from(name),
            start_ms,
            mtime_ms,
        }
    }

    /// Run the claim passes over one project directory shared by every pane.
    fn assign(panes: &[PaneQuery], list: Vec<Candidate>) -> Vec<Option<String>> {
        let dir = PathBuf::from("project-dir");
        let dirs = vec![Some(dir.clone()); panes.len()];
        let by_dir = HashMap::from([(dir, list)]);
        assign_transcripts(panes, &dirs, &by_dir, NOW)
            .into_iter()
            .map(|p| p.map(|p| p.to_string_lossy().to_string()))
            .collect()
    }

    /// The whole point of resolving every pane in one call: two Claude sessions
    /// in the same folder must not be handed the same transcript.
    #[test]
    fn two_panes_in_one_folder_take_different_transcripts() {
        let panes = [pane(1, Some(NOW - 9_000), None), pane(2, Some(NOW - 3_000), None)];
        let got = assign(
            &panes,
            vec![
                candidate("old.jsonl", NOW - 500_000, NOW - 500_000),
                candidate("first.jsonl", NOW - 9_100, NOW - 100),
                candidate("second.jsonl", NOW - 3_100, NOW - 100),
            ],
        );
        assert_eq!(
            got,
            vec![Some("first.jsonl".into()), Some("second.jsonl".into())]
        );
    }

    /// A pane that already resolved keeps its transcript, even when a newer one
    /// shows up — that newer file belongs to whoever just started a session.
    #[test]
    fn a_working_pane_is_never_pulled_off_its_own_transcript() {
        let panes = [pane(1, Some(NOW - 9_000), Some("first.jsonl"))];
        let got = assign(
            &panes,
            vec![
                candidate("first.jsonl", NOW - 9_100, NOW - 200), // still being written
                candidate("fresh.jsonl", NOW - 1_000, NOW - 100),
            ],
        );
        assert_eq!(got, vec![Some("first.jsonl".into())]);
    }

    /// `/clear` starts a new transcript and leaves the old one silent, so a pane
    /// whose file has gone quiet follows the successor.
    #[test]
    fn a_quiet_transcript_hands_the_pane_to_its_successor() {
        let stale = NOW - STALE_TRANSCRIPT_MS - 1;
        let panes = [pane(1, Some(NOW - 900_000), Some("before-clear.jsonl"))];
        let got = assign(
            &panes,
            vec![
                candidate("before-clear.jsonl", NOW - 900_000, stale),
                candidate("after-clear.jsonl", NOW - 800_000, NOW - 100),
            ],
        );
        assert_eq!(got, vec![Some("after-clear.jsonl".into())]);
    }

    /// …but only when the successor is free. A transcript another pane is on
    /// must never be taken away from it.
    #[test]
    fn a_quiet_transcript_does_not_steal_another_panes_session() {
        let stale = NOW - STALE_TRANSCRIPT_MS - 1;
        let panes = [
            pane(1, Some(NOW - 900_000), Some("quiet.jsonl")),
            pane(2, Some(NOW - 800_000), Some("busy.jsonl")),
        ];
        let got = assign(
            &panes,
            vec![
                candidate("quiet.jsonl", NOW - 900_000, stale),
                candidate("busy.jsonl", NOW - 800_000, NOW - 100),
            ],
        );
        assert_eq!(got, vec![Some("quiet.jsonl".into()), Some("busy.jsonl".into())]);
    }

    /// `claude --resume` appends to a transcript that began long before the pane
    /// did, so nothing matches on start time and the newest file wins.
    #[test]
    fn a_resumed_session_falls_back_to_the_most_recently_written_file() {
        let panes = [pane(1, Some(NOW - 1_000), None)];
        let got = assign(
            &panes,
            vec![
                candidate("ancient.jsonl", NOW - 900_000, NOW - 900_000),
                candidate("resumed.jsonl", NOW - 500_000, NOW - 100),
            ],
        );
        assert_eq!(got, vec![Some("resumed.jsonl".into())]);
    }

    /// With no launch time to anchor on, the newest transcript is the better
    /// guess than the oldest one in the folder.
    #[test]
    fn without_a_launch_time_the_newest_transcript_wins() {
        let panes = [pane(1, None, None)];
        let got = assign(
            &panes,
            vec![
                candidate("oldest.jsonl", NOW - 900_000, NOW - 900_000),
                candidate("newest.jsonl", NOW - 500_000, NOW - 100),
            ],
        );
        assert_eq!(got, vec![Some("newest.jsonl".into())]);
    }

    /// A transcript that was deleted between polls cannot stay claimed.
    #[test]
    fn a_vanished_transcript_is_resolved_again() {
        let panes = [pane(1, Some(NOW - 9_000), Some("deleted.jsonl"))];
        let got = assign(&panes, vec![candidate("only.jsonl", NOW - 9_100, NOW - 100)]);
        assert_eq!(got, vec![Some("only.jsonl".into())]);
    }

    /// A folder Claude Code has never run in resolves to nothing at all.
    #[test]
    fn a_pane_with_no_project_directory_gets_no_transcript() {
        let panes = vec![pane(1, Some(NOW), None)];
        let dirs = vec![None];
        let got = assign_transcripts(&panes, &dirs, &HashMap::new(), NOW);
        assert_eq!(got, vec![None]);
    }

    /// Hand-written JSON proves the shapes this code expects; a genuine
    /// transcript proves those shapes are the ones Claude Code actually writes.
    /// Point `MYMUX_TEST_TRANSCRIPT` at one (`~/.claude/projects/<slug>/<id>.jsonl`)
    /// to run this; without it there is nothing to read and the test is a no-op.
    #[test]
    fn parses_a_real_transcript_when_one_is_supplied() {
        let Some(path) = std::env::var_os("MYMUX_TEST_TRANSCRIPT") else {
            return;
        };
        let path = PathBuf::from(path);
        let mut scan = FileScan::default();
        scan_file(&path, &mut scan).expect("transcript should be readable");
        assert!(
            scan.session_id.is_some(),
            "every transcript entry carries a sessionId"
        );
        assert!(
            !scan.order.is_empty(),
            "this transcript was chosen because it launched agents"
        );
        for id in &scan.order {
            let agent = &scan.agents[id];
            assert!(!agent.name.is_empty(), "{id} has no agent type");
            assert!(agent.started_ms.is_some(), "{id} has no start time");
            println!(
                "{id} {:>9} {:<24} {} ({}ms, {:?} tokens)",
                agent.status,
                agent.name,
                agent.description,
                agent.duration_ms.unwrap_or(-1),
                agent.total_tokens
            );
        }
    }

    /// A line written half-way through must be held back, not parsed as junk.
    #[test]
    fn holds_back_a_torn_last_line_until_it_is_complete() {
        let dir = std::env::temp_dir().join("mymux-agent-scan-torn");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let first = r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_a","name":"Agent","input":{"description":"one","subagent_type":"t","prompt":"p"}}]}}"#;
        // Second record arrives cut in half, with no newline of its own yet.
        let torn = r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-27T02:01:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_b","#;
        std::fs::write(&path, format!("{first}\n{torn}")).unwrap();

        let mut scan = FileScan::default();
        scan_file(&path, &mut scan).unwrap();
        assert_eq!(scan.order, vec!["toolu_a"]);

        // The rest of the record lands: the second agent shows up now.
        let tail = r#""name":"Agent","input":{"description":"two","subagent_type":"t","prompt":"p"}}]}}"#;
        std::fs::write(&path, format!("{first}\n{torn}{tail}\n")).unwrap();
        scan_file(&path, &mut scan).unwrap();
        assert_eq!(scan.order, vec!["toolu_a", "toolu_b"]);
        assert_eq!(scan.agents["toolu_b"].description, "two");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
