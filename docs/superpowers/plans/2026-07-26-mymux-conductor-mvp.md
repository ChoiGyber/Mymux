# Mymux Conductor (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Conductor" mode where Claude Code decomposes a goal into distinct subtasks and Mymux dispatches them to Codex workers, gating dispatch on each subscription's remaining usage limit.

**Architecture:** Mymux's Rust backend is the scheduler/control point. A **planner** command shells out to `claude -p --output-format json` to get a structured subtask list. A **worker** command shells out to `codex exec` to execute one subtask non-interactively and capture its answer. A **budget** command reuses Mymux's existing usage parsers (`claude_account_usage`, `codex_rollout_tail`) so the frontend loop only dispatches while remaining limit is above a floor. Phase 1 is **read-only analysis only** — no file edits, no git worktrees (those are Phase 2). All CLI process I/O lives in one new module `conductor.rs`; the orchestration loop + UI live in the existing `app.js`/`index.html`/`style.css`.

**Tech Stack:** Rust (Tauri commands, `std::process::Command`, `serde`/`serde_json` — all already dependencies), vanilla JS frontend (matches existing `app.js` style), `cargo test` for unit tests.

## Global Constraints

- Windows-first; build via PowerShell (`npm run build` / `cargo build`). CI also compiles on macOS + Linux, so **no platform-only APIs** in `conductor.rs` without `#[cfg]`.
- Test command: `cargo test` (run from `crates/mycli-desktop` or repo root).
- **No new crates.** Only `serde`, `serde_json`, `dirs`, `tauri` (all already in `Cargo.toml`).
- Executable resolution must not assume a bare name works on Windows: `claude`/`codex` are often `.cmd`/`.ps1` shims. Resolve the real path via PATH search (mirror `tools.rs::tool_installed` candidate logic) before spawning.
- Frontend is plain ES (no framework, no build step for JS). Match the naming/idiom in `app.js` (e.g. `invoke(...)`, `document.getElementById`, `esc(...)` for HTML-escaping).
- Phase 1 scope is **read-only**: the planner is instructed to produce analysis/Q&A subtasks only; workers run `codex exec` in its default sandbox. File-editing + worktree isolation + `codex apply` are explicitly **out of scope** (Phase 2 plan).

**Reusable anchors (already in the codebase — read before starting):**
- `crates/mycli-desktop/src/commands.rs` — `claude_account_usage() -> Result<ClaudeUsage,String>` where `ClaudeUsage { five_h: Option<u8>, wk: Option<u8>, .. }` are **percent USED**; `codex_rollout_tail(max_bytes: Option<u64>) -> Result<String,String>` returns the tail (JSONL) of the newest Codex rollout.
- `crates/mycli-desktop/src/tools.rs` — `tool_installed(name) -> bool` + private `candidates(name)` PATH-extension logic to mirror.
- `crates/mycli-desktop/src/main.rs:25-81` — `invoke_handler![...]` command registration list.
- `crates/mycli-desktop/frontend/app.js` — `invoke`, `toast(msg, isError)`, `esc(str)` helpers; explorer/commands side-panels for UI patterns.

---

## File Structure

- **Create** `crates/mycli-desktop/src/conductor.rs` — all Conductor logic: types, pure parsers (unit-tested), and the async Tauri command wrappers that spawn `claude`/`codex`.
- **Modify** `crates/mycli-desktop/src/main.rs` — add `mod conductor;` and register the 3 new commands.
- **Modify** `crates/mycli-desktop/frontend/index.html` — add the Conductor side-panel markup.
- **Modify** `crates/mycli-desktop/frontend/app.js` — add the Conductor controller (goal input → plan → budget-gated dispatch loop → render results).
- **Modify** `crates/mycli-desktop/frontend/style.css` — Conductor panel styles.

---

### Task 1: Conductor types + `parse_plan` (pure parser)

**Files:**
- Create: `crates/mycli-desktop/src/conductor.rs`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `Subtask { id: String, title: String, prompt: String, kind: String }`, `parse_plan(stdout: &str) -> Result<Vec<Subtask>, String>`

`parse_plan` must tolerate three shapes of `claude -p --output-format json` output: (a) a raw JSON array, (b) the print-mode envelope `{"result":"<text>", ...}` whose `result` string contains the array, and (c) the array wrapped in a Markdown ```json fence.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_raw_array() {
        let s = r#"[{"id":"t1","title":"Audit deps","prompt":"List outdated deps","kind":"analysis"}]"#;
        let v = parse_plan(s).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "t1");
        assert_eq!(v[0].title, "Audit deps");
    }

    #[test]
    fn parses_print_envelope() {
        let s = r#"{"type":"result","subtype":"success","result":"[{\"id\":\"a\",\"title\":\"T\",\"prompt\":\"P\",\"kind\":\"analysis\"}]","session_id":"x"}"#;
        let v = parse_plan(s).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].prompt, "P");
    }

    #[test]
    fn parses_fenced_array_in_envelope() {
        let inner = "```json\n[{\"id\":\"a\",\"title\":\"T\",\"prompt\":\"P\",\"kind\":\"analysis\"}]\n```";
        let env = serde_json::json!({"result": inner}).to_string();
        let v = parse_plan(&env).unwrap();
        assert_eq!(v[0].id, "a");
    }

    #[test]
    fn kind_defaults_to_analysis() {
        let v = parse_plan(r#"[{"id":"a","title":"T","prompt":"P"}]"#).unwrap();
        assert_eq!(v[0].kind, "analysis");
    }

    #[test]
    fn empty_or_garbage_errors() {
        assert!(parse_plan("not json at all").is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p mycli-desktop conductor::tests`
Expected: FAIL — `parse_plan` / `Subtask` not found.

- [ ] **Step 3: Write the types + parser**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subtask {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub prompt: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "analysis".to_string()
}

/// Strip a leading/trailing Markdown code fence (```json ... ``` or ``` ... ```).
fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // Drop the optional language tag on the first line.
        let after_lang = rest.splitn(2, '\n').nth(1).unwrap_or("");
        return after_lang.trim_end().trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// Parse `claude -p --output-format json` output into a subtask list.
/// Tolerates a raw array, the print-mode `{"result": "..."}` envelope, and
/// a Markdown-fenced array inside `result`.
pub fn parse_plan(stdout: &str) -> Result<Vec<Subtask>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("empty planner output".to_string());
    }

    // Unwrap the print-mode envelope if present.
    let inner: String = match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Object(map)) => match map.get("result").and_then(|r| r.as_str()) {
            Some(text) => text.to_string(),
            None => trimmed.to_string(),
        },
        _ => trimmed.to_string(),
    };

    let cleaned = strip_code_fences(&inner);
    serde_json::from_str::<Vec<Subtask>>(&cleaned)
        .map_err(|e| format!("could not parse subtask list: {e}"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p mycli-desktop conductor::tests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/mycli-desktop/src/conductor.rs
git commit -m "feat(conductor): subtask types + tolerant plan parser"
```

---

### Task 2: `parse_codex_remaining` (pure, schema-tolerant)

**Files:**
- Modify: `crates/mycli-desktop/src/conductor.rs`
- Test: same file

**Interfaces:**
- Produces: `parse_codex_remaining(jsonl_tail: &str) -> Option<f64>` — returns remaining percent (0–100), or `None` if no rate-limit snapshot is present.

Codex rollouts contain periodic `rate_limits` snapshots. We stay schema-tolerant: take the **last** JSON line that deep-contains a `rate_limits` key, collect **every** `used_percent` number anywhere inside it, and return `100 - max(used_percent)` (the tightest window governs).

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn codex_remaining_from_snapshot() {
    let tail = r#"
{"type":"event","payload":{"foo":1}}
{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0},"secondary":{"used_percent":80.0}}}
"#;
    let r = parse_codex_remaining(tail).unwrap();
    assert!((r - 20.0).abs() < 0.001); // 100 - max(10,80)
}

#[test]
fn codex_remaining_uses_last_snapshot() {
    let tail = r#"
{"rate_limits":{"primary":{"used_percent":90.0}}}
{"rate_limits":{"primary":{"used_percent":30.0}}}
"#;
    let r = parse_codex_remaining(tail).unwrap();
    assert!((r - 70.0).abs() < 0.001);
}

#[test]
fn codex_remaining_none_when_absent() {
    assert!(parse_codex_remaining("{\"type\":\"message\"}\n").is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p mycli-desktop conductor::tests::codex`
Expected: FAIL — `parse_codex_remaining` not found.

- [ ] **Step 3: Implement**

```rust
/// Recursively collect every `used_percent` numeric value in a JSON subtree.
fn collect_used_percents(v: &serde_json::Value, out: &mut Vec<f64>) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                if k == "used_percent" {
                    if let Some(n) = val.as_f64() {
                        out.push(n);
                    }
                }
                collect_used_percents(val, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                collect_used_percents(val, out);
            }
        }
        _ => {}
    }
}

/// Remaining Codex limit (%) from the newest `rate_limits` snapshot in a
/// rollout JSONL tail. `None` when no snapshot is present.
pub fn parse_codex_remaining(jsonl_tail: &str) -> Option<f64> {
    let mut last: Option<serde_json::Value> = None;
    for line in jsonl_tail.lines() {
        let line = line.trim();
        if line.is_empty() || !line.contains("rate_limits") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            // Keep only lines that actually carry a rate_limits object.
            if find_key(&v, "rate_limits").is_some() {
                last = Some(v);
            }
        }
    }
    let snapshot = last?;
    let rl = find_key(&snapshot, "rate_limits")?;
    let mut used = Vec::new();
    collect_used_percents(rl, &mut used);
    let max_used = used.into_iter().fold(f64::NEG_INFINITY, f64::max);
    if max_used.is_finite() {
        Some((100.0 - max_used).clamp(0.0, 100.0))
    } else {
        None
    }
}

/// Depth-first search for the first value under `key`.
fn find_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(found) = map.get(key) {
                return Some(found);
            }
            for val in map.values() {
                if let Some(found) = find_key(val, key) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(|val| find_key(val, key)),
        _ => None,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p mycli-desktop conductor::tests`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/mycli-desktop/src/conductor.rs
git commit -m "feat(conductor): schema-tolerant codex remaining-limit parser"
```

> **Implementation note (not a placeholder):** the parser is deliberately schema-tolerant, so it works regardless of the exact `rate_limits` wrapper field names. During Task 9 manual verification, print a real `codex_rollout_tail` and confirm a sensible non-`None` value is produced; if Codex ever renames `used_percent`, only this one function changes.

---

### Task 3: `conductor_budget` command (reuse existing usage parsers)

**Files:**
- Modify: `crates/mycli-desktop/src/conductor.rs`

**Interfaces:**
- Consumes: `commands::claude_account_usage()` (async), `commands::codex_rollout_tail(Some(u64))`, `conductor::parse_codex_remaining`.
- Produces: `AgentBudget { agent: String, remaining_pct: Option<f64>, available: bool }`, `Budget { claude: AgentBudget, codex: AgentBudget, floor_pct: f64 }`, and Tauri command `conductor_budget() -> Result<Budget, String>`.

Claude remaining = `100 - max(five_h, wk)` (worst-case window). `available` = remaining is unknown (treat as available) OR remaining > `floor_pct` (default 5.0). Codex remaining from `parse_codex_remaining`.

- [ ] **Step 1: Add a unit test for the pure budget math**

```rust
#[test]
fn budget_available_above_floor() {
    let b = AgentBudget::from_remaining("claude", Some(40.0), 5.0);
    assert!(b.available);
    let b2 = AgentBudget::from_remaining("codex", Some(2.0), 5.0);
    assert!(!b2.available);
}

#[test]
fn budget_unknown_is_available() {
    // No data yet (e.g. Codex never run) must not hard-block dispatch.
    let b = AgentBudget::from_remaining("codex", None, 5.0);
    assert!(b.available);
    assert_eq!(b.remaining_pct, None);
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p mycli-desktop conductor::tests::budget`
Expected: FAIL — `AgentBudget` not found.

- [ ] **Step 3: Implement types, pure constructor, and the command**

```rust
const DEFAULT_FLOOR_PCT: f64 = 5.0;

#[derive(Debug, Clone, Serialize)]
pub struct AgentBudget {
    pub agent: String,
    pub remaining_pct: Option<f64>,
    pub available: bool,
}

impl AgentBudget {
    /// Pure: an agent is "available" when we either have no reading (don't
    /// hard-block) or the reading is above the floor.
    pub fn from_remaining(agent: &str, remaining_pct: Option<f64>, floor_pct: f64) -> Self {
        let available = match remaining_pct {
            Some(r) => r > floor_pct,
            None => true,
        };
        AgentBudget { agent: agent.to_string(), remaining_pct, available }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Budget {
    pub claude: AgentBudget,
    pub codex: AgentBudget,
    pub floor_pct: f64,
}

#[tauri::command]
pub async fn conductor_budget() -> Result<Budget, String> {
    // Claude: reuse the existing account-usage command (percent USED).
    let claude_remaining = match crate::commands::claude_account_usage().await {
        Ok(u) => {
            let used = [u.five_h_used(), u.wk_used()]
                .into_iter()
                .flatten()
                .fold(f64::NEG_INFINITY, f64::max);
            if used.is_finite() { Some((100.0 - used).clamp(0.0, 100.0)) } else { None }
        }
        Err(_) => None, // no credentials / offline → unknown, not blocked
    };

    // Codex: mine the newest rollout tail for its latest rate_limits snapshot.
    let codex_remaining = crate::commands::codex_rollout_tail(Some(65536))
        .ok()
        .and_then(|tail| parse_codex_remaining(&tail));

    Ok(Budget {
        claude: AgentBudget::from_remaining("claude", claude_remaining, DEFAULT_FLOOR_PCT),
        codex: AgentBudget::from_remaining("codex", codex_remaining, DEFAULT_FLOOR_PCT),
        floor_pct: DEFAULT_FLOOR_PCT,
    })
}
```

> **Prerequisite edit:** `ClaudeUsage`'s `five_h`/`wk` fields are private `Option<u8>`. Add two public accessors in `commands.rs` next to the struct so `conductor.rs` can read them as `f64` without changing serialization:
> ```rust
> impl ClaudeUsage {
>     pub fn five_h_used(&self) -> Option<f64> { self.five_h.map(|v| v as f64) }
>     pub fn wk_used(&self) -> Option<f64> { self.wk.map(|v| v as f64) }
> }
> ```
> Also ensure `claude_account_usage`, `codex_rollout_tail`, and `ClaudeUsage` are reachable from `conductor.rs` — they are `pub` in `commands.rs`; reference them as `crate::commands::...`.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p mycli-desktop conductor::tests`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/mycli-desktop/src/conductor.rs crates/mycli-desktop/src/commands.rs
git commit -m "feat(conductor): budget command reusing claude/codex usage parsers"
```

---

### Task 4: `resolve_exe` helper + `conductor_plan` command (planner)

**Files:**
- Modify: `crates/mycli-desktop/src/conductor.rs`

**Interfaces:**
- Produces: `resolve_exe(name: &str) -> Option<std::path::PathBuf>`, Tauri command `conductor_plan(goal: String, cwd: Option<String>) -> Result<Vec<Subtask>, String>`.

The planner runs `claude -p --output-format json` with a decomposition system prompt, capturing stdout, then hands it to `parse_plan`. Long-running, so wrap the blocking spawn in `tauri::async_runtime::spawn_blocking`.

- [ ] **Step 1: Write a unit test for `resolve_exe` on a known-present tool**

```rust
#[test]
fn resolve_exe_finds_cargo() {
    // cargo is always on PATH in CI/dev; proves PATH+extension resolution works.
    assert!(resolve_exe("cargo").is_some());
}

#[test]
fn resolve_exe_missing_is_none() {
    assert!(resolve_exe("definitely-not-a-real-binary-xyz").is_none());
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p mycli-desktop conductor::tests::resolve`
Expected: FAIL — `resolve_exe` not found.

- [ ] **Step 3: Implement `resolve_exe` and the planner command**

```rust
use std::path::PathBuf;
use std::process::Command;

/// Resolve an executable to a concrete path via PATH, trying platform
/// extensions (Windows: .cmd/.exe/.bat/.ps1 shims for claude/codex).
pub fn resolve_exe(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let exts: &[&str] = &["", ".cmd", ".exe", ".bat", ".ps1"];
    #[cfg(not(windows))]
    let exts: &[&str] = &[""];

    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

const PLANNER_SYSTEM: &str = "You are a task decomposition planner. Break the user's goal into 2-6 INDEPENDENT, read-only analysis subtasks (no file edits). Reply with ONLY a JSON array; each item: {\"id\":\"t1\",\"title\":\"short title\",\"prompt\":\"self-contained instruction for a worker\",\"kind\":\"analysis\"}. No prose, no code fence.";

#[tauri::command]
pub async fn conductor_plan(goal: String, cwd: Option<String>) -> Result<Vec<Subtask>, String> {
    let exe = resolve_exe("claude").ok_or("Claude Code CLI not found on PATH")?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(exe);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("json")
            .arg("--append-system-prompt")
            .arg(PLANNER_SYSTEM)
            .arg(&goal);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.output()
    })
    .await
    .map_err(|e| format!("planner join error: {e}"))?
    .map_err(|e| format!("failed to launch claude: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "claude planner exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    parse_plan(&String::from_utf8_lossy(&out.stdout))
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p mycli-desktop conductor::tests`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/mycli-desktop/src/conductor.rs
git commit -m "feat(conductor): exe resolver + claude planner command"
```

---

### Task 5: `conductor_worker` command (Codex executor)

**Files:**
- Modify: `crates/mycli-desktop/src/conductor.rs`

**Interfaces:**
- Consumes: `resolve_exe`.
- Produces: `WorkerResult { subtask_id: String, ok: bool, output: String }`, Tauri command `conductor_worker(subtask_id: String, prompt: String, cwd: Option<String>) -> Result<WorkerResult, String>`.

Runs `codex exec <prompt>` non-interactively in `cwd`, capturing stdout as the worker's answer. Read-only for Phase 1.

- [ ] **Step 1: Add the `WorkerResult` type (no separate unit test — it's an IO wrapper; behavior is covered by the manual e2e in Task 9)**

```rust
#[derive(Debug, Clone, Serialize)]
pub struct WorkerResult {
    pub subtask_id: String,
    pub ok: bool,
    pub output: String,
}
```

- [ ] **Step 2: Implement the command**

```rust
#[tauri::command]
pub async fn conductor_worker(
    subtask_id: String,
    prompt: String,
    cwd: Option<String>,
) -> Result<WorkerResult, String> {
    let exe = resolve_exe("codex").ok_or("Codex CLI not found on PATH")?;
    let id = subtask_id.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(exe);
        cmd.arg("exec").arg(&prompt);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.output()
    })
    .await
    .map_err(|e| format!("worker join error: {e}"))?
    .map_err(|e| format!("failed to launch codex: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(WorkerResult {
        subtask_id: id,
        ok: out.status.success(),
        output: if out.status.success() { stdout } else { format!("{stdout}\n{stderr}") },
    })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p mycli-desktop`
Expected: builds (commands not yet registered — that's Task 6).

- [ ] **Step 4: Commit**

```bash
git add crates/mycli-desktop/src/conductor.rs
git commit -m "feat(conductor): codex worker command (read-only exec)"
```

---

### Task 6: Register the module + commands

**Files:**
- Modify: `crates/mycli-desktop/src/main.rs:8` (mod list) and `crates/mycli-desktop/src/main.rs:25-81` (invoke_handler)

**Interfaces:**
- Consumes: `conductor::conductor_plan`, `conductor::conductor_worker`, `conductor::conductor_budget`.

- [ ] **Step 1: Add the module declaration**

In the `mod` block near the top (after `mod commands;`), add:
```rust
mod conductor;
```

- [ ] **Step 2: Register the three commands**

Inside `tauri::generate_handler![ ... ]`, after `tools::tool_installed,` add:
```rust
            conductor::conductor_plan,
            conductor::conductor_worker,
            conductor::conductor_budget,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p mycli-desktop`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add crates/mycli-desktop/src/main.rs
git commit -m "feat(conductor): register plan/worker/budget commands"
```

---

### Task 7: Conductor panel markup + styles

**Files:**
- Modify: `crates/mycli-desktop/frontend/index.html` (add panel near the explorer/commands panels)
- Modify: `crates/mycli-desktop/frontend/style.css`

**Interfaces:**
- Produces DOM ids consumed by Task 8: `#conductor-goal` (textarea), `#conductor-run` (button), `#conductor-budget` (budget gauges), `#conductor-tasks` (results list), `#conductor-status` (status line).

- [ ] **Step 1: Add the panel HTML**

Add a side-panel block (mirror the explorer panel container structure already in `index.html`):
```html
<div id="conductor-panel" class="side-panel">
  <div class="conductor-head">
    <span class="conductor-title">Conductor</span>
    <span id="conductor-budget" class="conductor-budget"></span>
  </div>
  <textarea id="conductor-goal" placeholder="목표를 입력하세요 (읽기전용 분석 작업으로 분해됩니다)…" spellcheck="false"></textarea>
  <button id="conductor-run" type="button">계획 → 실행</button>
  <div id="conductor-status" class="conductor-status"></div>
  <ul id="conductor-tasks"></ul>
</div>
```

- [ ] **Step 2: Add styles**

```css
#conductor-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.conductor-head { display: flex; justify-content: space-between; align-items: center; }
.conductor-title { font-weight: 700; font-size: 13px; }
.conductor-budget { font-size: 11px; color: var(--text-dim); }
#conductor-goal { width: 100%; min-height: 60px; resize: vertical; font-family: inherit; font-size: 12px; }
#conductor-run { padding: 5px 10px; cursor: pointer; }
.conductor-status { font-size: 11px; color: var(--text-dim); min-height: 14px; }
#conductor-tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.conductor-task { border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; font-size: 12px; }
.conductor-task .ct-title { font-weight: 600; }
.conductor-task .ct-state { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); }
.conductor-task.state-running { border-color: var(--accent); }
.conductor-task.state-done { opacity: .9; }
.conductor-task.state-blocked { border-color: var(--red); }
.conductor-task .ct-output { margin-top: 4px; white-space: pre-wrap; max-height: 180px; overflow: auto; font-family: ui-monospace, monospace; font-size: 11px; }
```

- [ ] **Step 3: Verify visually**

Run: `npm run build` then launch the app (or open the panel). Panel renders; button + textarea present. (No behavior yet.)

- [ ] **Step 4: Commit**

```bash
git add crates/mycli-desktop/frontend/index.html crates/mycli-desktop/frontend/style.css
git commit -m "feat(conductor): side-panel markup + styles"
```

---

### Task 8: Conductor controller (plan → budget-gated dispatch loop → render)

**Files:**
- Modify: `crates/mycli-desktop/frontend/app.js`

**Interfaces:**
- Consumes: Tauri commands `conductor_plan`, `conductor_worker`, `conductor_budget`; existing `invoke`, `toast`, `esc` helpers.
- Produces: `initConductor()` wired from DOMContentLoaded, and the dispatch loop.

The loop: plan → for each subtask, poll `conductor_budget` and only dispatch to Codex while `codex.available`; when blocked, show status and wait (re-poll) instead of dispatching. Dynamic concurrency: allow up to `N = clamp(floor(codex.remaining_pct / 20), 1, 3)` workers in flight (so richer budget → more parallelism), defaulting to 1 when remaining is unknown.

- [ ] **Step 1: Add the controller**

```javascript
function initConductor() {
  const runBtn = document.getElementById("conductor-run");
  if (!runBtn) return;
  runBtn.addEventListener("click", runConductor);
  refreshConductorBudget();
}

async function refreshConductorBudget() {
  const el = document.getElementById("conductor-budget");
  if (!el) return;
  try {
    const b = await invoke("conductor_budget");
    const fmt = (a) => `${a.agent}: ${a.remaining_pct == null ? "?" : Math.round(a.remaining_pct) + "%"}${a.available ? "" : " ⛔"}`;
    el.textContent = `${fmt(b.claude)}  ·  ${fmt(b.codex)}`;
    return b;
  } catch (e) {
    el.textContent = String(e);
    return null;
  }
}

function conductorConcurrency(budget) {
  const rem = budget && budget.codex ? budget.codex.remaining_pct : null;
  if (rem == null) return 1;
  return Math.max(1, Math.min(3, Math.floor(rem / 20)));
}

function renderConductorTask(t) {
  let li = document.getElementById("ct-" + t.id);
  if (!li) {
    li = document.createElement("li");
    li.id = "ct-" + t.id;
    li.className = "conductor-task";
    document.getElementById("conductor-tasks").appendChild(li);
  }
  li.className = "conductor-task state-" + t.state;
  li.innerHTML =
    `<div class="ct-state">${t.state}</div>` +
    `<div class="ct-title">${esc(t.title)}</div>` +
    (t.output ? `<div class="ct-output">${esc(t.output)}</div>` : "");
}

async function runConductor() {
  const goal = (document.getElementById("conductor-goal")?.value || "").trim();
  const status = document.getElementById("conductor-status");
  const list = document.getElementById("conductor-tasks");
  if (!goal) { toast("목표를 입력하세요.", true); return; }
  list.innerHTML = "";
  status.textContent = "계획 수립 중 (Claude)…";

  let subtasks;
  try {
    subtasks = await invoke("conductor_plan", { goal, cwd: currentExplorerPath || null });
  } catch (e) {
    status.textContent = "계획 실패: " + String(e);
    return;
  }
  if (!subtasks.length) { status.textContent = "하위작업이 없습니다."; return; }

  const queue = subtasks.map((s) => ({ ...s, state: "queued", output: "" }));
  queue.forEach(renderConductorTask);

  let idx = 0;
  let inFlight = 0;
  let done = 0;

  async function pump() {
    while (idx < queue.length) {
      const budget = await refreshConductorBudget();
      if (budget && budget.codex && !budget.codex.available) {
        status.textContent = "Codex 한도 임박 — 대기 중… (여유가 생기면 재개)";
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      const cap = conductorConcurrency(budget);
      if (inFlight >= cap) { await new Promise((r) => setTimeout(r, 400)); continue; }

      const t = queue[idx++];
      inFlight++;
      t.state = "running"; renderConductorTask(t);
      status.textContent = `실행 중 ${done}/${queue.length} (동시 ${inFlight}/${cap})`;

      invoke("conductor_worker", { subtaskId: t.id, prompt: t.prompt, cwd: currentExplorerPath || null })
        .then((res) => { t.state = res.ok ? "done" : "blocked"; t.output = res.output; })
        .catch((e) => { t.state = "blocked"; t.output = String(e); })
        .finally(() => {
          inFlight--; done++;
          renderConductorTask(t);
          status.textContent = `완료 ${done}/${queue.length}`;
        });
    }
    // Drain remaining in-flight workers.
    while (inFlight > 0) { await new Promise((r) => setTimeout(r, 300)); }
    status.textContent = `모두 완료 (${queue.length}건)`;
  }
  await pump();
}
```

- [ ] **Step 2: Wire `initConductor()` into startup**

Find the `DOMContentLoaded` init block (where `renderExplorerFavorites()` and explorer wiring run, ~`app.js:218`/`432`) and add:
```javascript
  initConductor();
```

- [ ] **Step 3: Verify syntax**

Run: `node --check crates/mycli-desktop/frontend/app.js`
Expected: prints nothing / exit 0.

- [ ] **Step 4: Commit**

```bash
git add crates/mycli-desktop/frontend/app.js
git commit -m "feat(conductor): frontend orchestration loop with budget gating"
```

---

### Task 9: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build` (or `cargo build -p mycli-desktop` for the backend + the app's normal build).
Expected: clean build.

- [ ] **Step 2: Confirm the budget parser sees real data**

With Codex having run at least once on this machine, temporarily log the tail during dev, or open the panel — `#conductor-budget` must show a numeric Codex `%` (not `?`). If `?`, inspect a real rollout JSONL under `~/.codex/sessions/**` and confirm `used_percent` appears; adjust only `parse_codex_remaining` if the field was renamed.

- [ ] **Step 3: Run a read-only goal**

In the Conductor panel, enter e.g. *"이 저장소의 빌드/테스트 구성을 요약하고 개선점 3가지를 제안"*. Click 계획 → 실행. Expect: Claude produces 2-6 subtasks; each dispatches to Codex; results render per task; status ends at "모두 완료".

- [ ] **Step 4: Confirm limit gating**

Verify the concurrency label reflects budget (higher Codex % → up to 3 in flight; unknown → 1). Optionally lower `DEFAULT_FLOOR_PCT` temporarily to a value above current remaining and confirm the loop shows "Codex 한도 임박 — 대기 중…" instead of dispatching.

- [ ] **Step 5: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore(conductor): MVP verification tweaks"
```

---

## Self-Review

**Spec coverage** (against the approved design):
- Limit Monitor → Task 2 (`parse_codex_remaining`) + Task 3 (`conductor_budget`, reuses `claude_account_usage`). ✔
- Planner Adapter (Claude decomposes into distinct subtasks) → Task 4 (`conductor_plan`). ✔
- Scheduler (dynamic worker count, budget gating, wait when limit near) → Task 8 (`pump` loop, `conductorConcurrency`, blocked-wait). ✔
- Worker Adapter (Codex executes, result captured) → Task 5 (`conductor_worker`). ✔
- Conductor UI (goal → DAG progress + per-agent budget) → Tasks 7–8. ✔
- Mymux-as-scheduler (not ceding control to Claude MCP) → satisfied: all dispatch decisions live in `pump()`; Claude is only the planner. ✔
- **Out of scope (Phase 2/3, intentionally absent):** worktree isolation, `codex apply`/merge, editing tasks, Reviewer synthesis, `codex mcp-server` direct wiring, N>3 fan-out. These belong in follow-up plans.

**Placeholder scan:** No "TBD"/"add error handling later" — each IO command has explicit error branches; the one "implementation note" (codex schema) is a verification instruction, not deferred code, and the parser already works schema-tolerantly.

**Type consistency:** `Subtask{id,title,prompt,kind}` used identically in Tasks 1/4/8. `WorkerResult{subtask_id,ok,output}` (Rust) ↔ `res.ok`/`res.output` (JS, Task 8). `Budget{claude,codex,floor_pct}` + `AgentBudget{agent,remaining_pct,available}` used identically in Tasks 3/8. Command param casing: Rust `subtask_id`/`cwd` ↔ JS `{ subtaskId, cwd }` (Tauri's automatic snake↔camel mapping — matches existing calls like `sessionId`).

---

## Notes for Phase 2+ (do not implement now)
- **Editing tasks + isolation:** dispatch edit-kind subtasks in per-worker `git worktree`s; collect diffs; apply via `codex apply` or review-then-merge. Requires an Isolation Manager module.
- **Reviewer synthesis:** a final `claude -p` (or `codex review`) pass that merges/critiques worker outputs.
- **Visible hybrid:** mirror each headless worker into a real Codex pane (via existing `pty_spawn`) for user oversight, while the headless call remains the source of truth for hand-off.
- **MCP direct route:** experiment with `codex mcp-server` wired into Claude as a native tool — only if Mymux can still enforce the budget floor.
