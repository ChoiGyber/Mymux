use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    output_buf: Arc<Mutex<Vec<String>>>,
    exited: Arc<Mutex<bool>>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

/// Find an executable on the PATH.
fn find_in_path(exe: &str) -> Option<std::path::PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// Locate Git Bash (no startup banner). Avoids System32\bash.exe (the WSL
/// launcher) and Windows Store aliases.
#[cfg(windows)]
fn find_git_bash() -> Option<std::path::PathBuf> {
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join(r"Programs\Git\bin\bash.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = find_in_path("bash.exe") {
        let s = p.to_string_lossy().to_lowercase();
        if !s.contains("system32") && !s.contains("windowsapps") {
            return Some(p);
        }
    }
    None
}

/// Write (idempotently) a Git Bash init file with a one-line `path $` prompt
/// at every width — when the path wouldn't fit, its leading components are
/// abbreviated fish-style to their first character (`/d/P/ChurchLivePro-
/// Bulletin`), with a `...tail` cut as the last resort — then returns its
/// forward-slash path for `--rcfile`. Sources the normal startup so
/// PATH/aliases still work.
///
/// The prompt readline owns must NEVER wrap. readline's SIGWINCH redisplay of
/// a WRAPPED prompt is broken twice over (verified with
/// examples/conpty_probe.rs): it repositions with a cursor-up computed for the
/// pre-resize layout — leaving stale prompt rows on screen — and it
/// over-backspaces by the byte length of the invisible color escapes, parking
/// the cursor left of the `$`. ConPTY compounds it: a width-only resize
/// delivers no winch to msys bash at all until the next keypress, so the
/// buggy redisplay fires exactly when the user starts typing. Truncating at
/// print time keeps the prompt a single row at any pane width — redisplay is
/// always a clean single-row rewrite, and history stays uniform (a
/// path-on-its-own-line variant left mismatched leftover prompts above).
/// Shrinking below an already-printed prompt's width can still leave one
/// stale row (every terminal shows that with git-bash); the next prompt
/// self-corrects. The path goes through `${__mymux_p}` (promptvars expansion
/// of a plain variable) rather than being spliced into PS1, so directory
/// names containing `$(`/backticks are never re-evaluated.
#[cfg(windows)]
fn mymux_bashrc() -> Option<String> {
    let dir = dirs::home_dir()?.join(".mycli");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("mymux.bashrc");
    let content = r#"# Mymux Git Bash init — one-line "path $" prompt; when the path is too wide
# the leading directories are abbreviated to one character (fish-style).
# The prompt readline owns must never wrap — see mymux_bashrc() in terminal.rs.
[ -f /etc/profile ] && . /etc/profile
[ -f ~/.bashrc ] && . ~/.bashrc
__mymux_prompt() {
  local __e=$?
  # OSC 133;D — previous command finished (with its exit code). Emitted here in
  # PROMPT_COMMAND (before PS1's 133;A) so the frontend can bracket command
  # output for prompt-jump / block-copy. Zero-width; consumed by the parser.
  printf '\033]133;D;%s\033\\' "$__e"
  local p="${PWD/#$HOME/\~}" cols=${COLUMNS:-80}
  if (( cols < 12 )); then __mymux_p=""; return; fi
  if (( ${#p} + 4 > cols )); then
    local IFS=/ out= i
    local -a a
    read -ra a <<< "$p"
    local n=${#a[@]}
    for (( i=0; i<n-1; i++ )); do out+="${a[i]:0:1}/"; done
    out+="${a[n-1]}"
    p=$out
    if (( ${#p} + 4 > cols )); then
      local keep=$(( cols - 8 ))
      p="...${p: -keep}"
    fi
  fi
  __mymux_p=$p
}
PROMPT_COMMAND=__mymux_prompt
# 133;A marks the prompt start, 133;B the prompt end / command-input start
# (both wrapped in \[ \] so readline counts them as zero-width — they must not
# affect the never-wrap prompt width). 133;B lets the frontend locate where the
# typed command begins, for copy/cut of the current input line.
PS1='\[\033]133;A\033\\\]\[\033[36m\]${__mymux_p}\[\033[0m\] \$ \[\033]133;B\033\\\]'

# Mymux: richer tab-completion (closer to PowerShell, where the tool supports it).
if ! shopt -oq posix; then
  for __f in /usr/share/bash-completion/bash_completion /etc/bash_completion; do
    [ -r "$__f" ] && . "$__f" && break
  done
  unset __f
fi

# Tool completions are CACHED so the prompt is never blocked by slow CLI startup
# (e.g. `claude completion bash` can take several seconds). Source the cached
# script instantly if present, then refresh it silently in the background
# (monitor mode off + disown = no "[1] 1234 / Done" job-control output).
__mymux_comp_dir="$HOME/.mycli/completions"
mkdir -p "$__mymux_comp_dir" 2>/dev/null
__mymux_bg() {
  local __m=; case $- in *m*) __m=1;; esac
  set +m
  ( "$1" completion bash >"$2.tmp" 2>/dev/null && mv -f "$2.tmp" "$2" 2>/dev/null ) >/dev/null 2>&1 &
  disown 2>/dev/null
  [ -n "$__m" ] && set -m
}
__mymux_load_completion() {
  command -v "$1" >/dev/null 2>&1 || return
  local __cache="$__mymux_comp_dir/$1.bash"
  [ -r "$__cache" ] && . "$__cache" 2>/dev/null
  # Regenerate when missing or older than a day — in the background.
  if [ ! -r "$__cache" ] || [ -n "$(find "$__cache" -mtime +1 2>/dev/null)" ]; then
    __mymux_bg "$1" "$__cache"
  fi
}
__mymux_load_completion claude
__mymux_load_completion codex
__mymux_load_completion gh
"#;
    std::fs::write(&path, content).ok()?;
    Some(path.to_string_lossy().replace('\\', "/"))
}

/// PowerShell init script (injected via `-EncodedCommand`): a one-line
/// `PS path>` prompt that NEVER wraps, the PowerShell twin of mymux_bashrc().
///
/// The stock prompt prints the FULL cwd, so in a narrow pane it wraps — and
/// PSReadLine repaints the input line from absolute coordinates captured when
/// the prompt was drawn. Any pty_resize between prompt and typing (guaranteed
/// at startup: panes spawn before flex layout/font metrics settle, then
/// refit) reflows that wrapped line, the saved coordinates go stale, and the
/// first keystrokes render at a bogus spot ("커서가 이상한 데" + the
/// `PS D:\Project\Chur      ePro-Bulletin>` gap = the old width's padding
/// merged by xterm reflow). Same disease readline had; same cure: when the
/// path wouldn't fit, abbreviate leading directories fish-style to one
/// character, then `...tail`-cut as a last resort. CJK chars are budgeted at
/// 2 cells. A short prompt line never rewraps, so PSReadLine's coordinates
/// survive resizes.
///
/// `-EncodedCommand` (not `-File`) because inline commands are exempt from
/// ExecutionPolicy — a .ps1 would die on the default `Restricted` policy —
/// and base64 sidesteps cmdline quoting. `-NoExit` keeps the session
/// interactive; the user's $PROFILE still loads first (no `-NoProfile`), our
/// `global:` definitions simply win afterwards, exactly like `--rcfile`.
#[cfg(windows)]
fn mymux_ps_init_b64() -> &'static str {
    const PS_INIT: &str = r#"function global:__mymux_vlen([string]$s) {
  $n = 0
  foreach ($c in $s.ToCharArray()) { if ([int]$c -ge 0x1100) { $n += 2 } else { $n += 1 } }
  return $n
}
function global:prompt {
  $__ok = $?; $__lec = $LASTEXITCODE
  $w = 0
  try { $w = $Host.UI.RawUI.WindowSize.Width } catch {}
  if (-not $w -or $w -lt 1) { $w = 80 }
  $p = "$PWD"
  $m = $w - 6
  if ($m -lt 6) { return '> ' }
  if ((__mymux_vlen $p) -gt $m) {
    $parts = $p -split '\\'
    for ($i = 1; $i -lt $parts.Count - 1; $i++) {
      if ($parts[$i].Length -gt 1) { $parts[$i] = $parts[$i].Substring(0, 1) }
    }
    $p = $parts -join '\'
    if ((__mymux_vlen $p) -gt $m) {
      $budget = $m - 3
      $tail = ''
      for ($i = $p.Length - 1; $i -ge 0; $i--) {
        $cw = 1; if ([int]$p[$i] -ge 0x1100) { $cw = 2 }
        if ($budget - $cw -lt 0) { break }
        $budget -= $cw
        $tail = [string]$p[$i] + $tail
      }
      $p = '...' + $tail
    }
  }
  # OSC 133 shell-integration marks (zero-width): D = previous command's exit,
  # A = prompt start, B = command-input start. Lets the frontend jump between
  # prompts, copy command output blocks, and copy/cut the current input line.
  # PSReadLine ignores OSC escapes when measuring the prompt, so these don't
  # affect the never-wrap layout (same approach Windows Terminal uses).
  $__e = if ($__ok) { 0 } elseif ($__lec) { $__lec } else { 1 }
  $__x = [char]27
  $__m = "$__x]133;D;$__e$__x\" + "$__x]133;A$__x\"
  $__b = "$__x]133;B$__x\"
  "$__m" + "PS $p$('>' * ($NestedPromptLevel + 1)) " + "$__b"
}
"#;
    static B64: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    B64.get_or_init(|| {
        let utf16le: Vec<u8> = PS_INIT
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        base64_encode(&utf16le)
    })
}

/// Standard base64 — a dozen lines beats pulling in a crate for one constant.
#[cfg(windows)]
fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}

/// PowerShell launcher: `-NoLogo` (no banner) + the never-wrapping prompt.
#[cfg(windows)]
fn powershell_builder(candidates: &[&str]) -> Option<CommandBuilder> {
    for exe in candidates {
        if let Some(p) = find_in_path(exe) {
            let mut c = CommandBuilder::new(p);
            c.arg("-NoLogo");
            c.arg("-NoExit");
            c.arg("-EncodedCommand");
            c.arg(mymux_ps_init_b64());
            return Some(c);
        }
    }
    None
}

/// Unix: launch `shell` as a LOGIN shell (`-l`). Login — not merely
/// interactive — matters on macOS: /etc/zprofile runs path_helper there, so a
/// non-login shell is missing Homebrew and user PATH entries. This mirrors
/// what Terminal.app/iTerm2 do for every new tab.
#[cfg(not(windows))]
fn login_shell(shell: std::path::PathBuf) -> CommandBuilder {
    let mut c = CommandBuilder::new(shell);
    c.arg("-l");
    c
}

/// Default shell. On Windows prefer Git Bash (clean, no product banner); if it
/// isn't installed, fall back to PowerShell with `-NoLogo` so the startup
/// banner is suppressed. On Unix (macOS/Linux) spawn the user's `$SHELL` as a
/// login shell.
fn default_shell_builder() -> CommandBuilder {
    #[cfg(windows)]
    {
        if let Some(path) = find_git_bash() {
            let mut c = CommandBuilder::new(path);
            if let Some(rc) = mymux_bashrc() {
                // Custom prompt (dir before $). --rcfile makes it non-login, so
                // the rcfile re-sources /etc/profile; CHERE_INVOKING keeps cwd.
                c.arg("--rcfile");
                c.arg(rc);
                c.arg("-i");
                c.env("CHERE_INVOKING", "1");
            } else {
                c.arg("--login");
                c.arg("-i");
            }
            return c;
        }
        if let Some(c) = powershell_builder(&["pwsh.exe", "powershell.exe"]) {
            return c;
        }
        CommandBuilder::new_default_prog()
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| "/bin/sh".into());
        login_shell(shell)
    }
}

/// Resolve a shell identifier into a launchable command. Known ids get the
/// right flags (PowerShell `-NoLogo`, Git Bash custom prompt); anything else is
/// treated as a literal executable plus the given args.
fn build_command(shell: Option<&str>, args: Option<&Vec<String>>) -> CommandBuilder {
    let Some(s) = shell else {
        return default_shell_builder();
    };

    #[cfg(windows)]
    {
        match s.to_lowercase().as_str() {
            "powershell" | "pwsh" | "pwsh.exe" => {
                if let Some(c) = powershell_builder(&["pwsh.exe", "powershell.exe"]) {
                    return c;
                }
            }
            "powershell.exe" | "windows-powershell" => {
                if let Some(c) = powershell_builder(&["powershell.exe"]) {
                    return c;
                }
            }
            "bash" | "git-bash" => {
                if let Some(path) = find_git_bash() {
                    let mut c = CommandBuilder::new(path);
                    if let Some(rc) = mymux_bashrc() {
                        c.arg("--rcfile");
                        c.arg(rc);
                        c.arg("-i");
                        c.env("CHERE_INVOKING", "1");
                    } else {
                        c.arg("--login");
                        c.arg("-i");
                    }
                    return c;
                }
            }
            _ => {}
        }
    }

    #[cfg(not(windows))]
    {
        // The UI stores Windows-centric ids ("powershell" is the shipped
        // default preference) — resolve them to something that exists here
        // instead of failing to spawn a literal "powershell"/"cmd.exe".
        match s.to_lowercase().as_str() {
            "powershell" | "pwsh" | "pwsh.exe" | "powershell.exe" | "windows-powershell" => {
                if let Some(p) = find_in_path("pwsh") {
                    let mut c = CommandBuilder::new(p);
                    c.arg("-NoLogo");
                    return c;
                }
                return default_shell_builder();
            }
            "cmd" | "cmd.exe" => return default_shell_builder(),
            "bash" | "git-bash" => {
                return login_shell(find_in_path("bash").unwrap_or_else(|| "/bin/bash".into()));
            }
            "zsh" => {
                return login_shell(find_in_path("zsh").unwrap_or_else(|| "/bin/zsh".into()));
            }
            _ => {}
        }
    }

    let mut c = CommandBuilder::new(s);
    if let Some(args) = args {
        for a in args {
            c.arg(a);
        }
    }
    c
}

/// Streaming UTF-8 decode: append `incoming` to `pending`, return the decoded
/// complete prefix, and leave an incomplete trailing sequence (≤3 bytes) in
/// `pending` for the next read. PTY reads are raw byte chunks, so a multi-byte
/// character (Hangul is 3 bytes in UTF-8) can be split across two reads;
/// decoding each chunk independently turns the split character into U+FFFD —
/// visible as randomly "broken" Korean/CJK in the terminal. Genuinely invalid
/// bytes (not mere truncation) still decode lossily as before.
fn decode_utf8_stream(pending: &mut Vec<u8>, incoming: &[u8]) -> String {
    pending.extend_from_slice(incoming);
    let chunk = std::mem::take(pending);
    match std::str::from_utf8(&chunk) {
        Ok(s) => s.to_string(),
        // error_len() == None ⇔ the only problem is an incomplete sequence at
        // the very end: decode the valid prefix now, carry the tail.
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            *pending = chunk[valid..].to_vec();
            String::from_utf8_lossy(&chunk[..valid]).into_owned()
        }
        Err(_) => String::from_utf8_lossy(&chunk).into_owned(),
    }
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, Arc<TerminalManager>>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            // Honor the caller's fitted grid; only guard against a degenerate 0.
            // Never force an 80×24 floor here — that would make a narrow pane's
            // PTY wider than the visible xterm grid, so wrapped lines and header
            // rules overflow and get truncated at the right edge instead of
            // wrapping. The frontend already sends the real fitted size.
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Start in the requested directory if it exists, else the home directory.
    let work_dir = cwd
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| ".".into()));

    let mut cmd = build_command(shell.as_deref(), args.as_ref());
    cmd.cwd(&work_dir);

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = {
        let mut next = state.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    let output_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let exited: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

    let buf_clone = Arc::clone(&output_buf);
    let exit_clone = Arc::clone(&exited);

    // Reader thread: PTY stdout -> buffer
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_utf8_stream(&mut pending, &buf[..n]);
                    if data.is_empty() {
                        continue;
                    }
                    let mut out = buf_clone.lock().unwrap();
                    out.push(data);
                }
                Err(_) => break,
            }
        }
        // EOF with a dangling partial sequence — it can't complete anymore.
        if !pending.is_empty() {
            let mut out = buf_clone.lock().unwrap();
            out.push(String::from_utf8_lossy(&pending).into_owned());
        }
        *exit_clone.lock().unwrap() = true;
    });

    // Child wait thread
    let exit_clone2 = Arc::clone(&exited);
    thread::spawn(move || {
        let _ = child.wait();
        *exit_clone2.lock().unwrap() = true;
    });

    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            id,
            PtySession {
                writer,
                master: pair.master,
                output_buf,
                exited,
            },
        );
    }

    Ok(id)
}

/// Read buffered output from the PTY. Returns all pending data.
#[tauri::command]
pub fn pty_read(
    state: tauri::State<'_, Arc<TerminalManager>>,
    id: u32,
) -> Result<(Vec<String>, bool), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("Session not found")?;

    let mut buf = session.output_buf.lock().unwrap();
    let data: Vec<String> = buf.drain(..).collect();
    let exited = *session.exited.lock().unwrap();

    Ok((data, exited))
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, Arc<TerminalManager>>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("Session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, Arc<TerminalManager>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(
    state: tauri::State<'_, Arc<TerminalManager>>,
    id: u32,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    sessions.remove(&id);
    Ok(())
}

#[cfg(test)]
mod utf8_stream_tests {
    use super::decode_utf8_stream;

    // A Hangul syllable split across two PTY reads must not become U+FFFD.
    #[test]
    fn hangul_split_across_reads() {
        let bytes = "한글".as_bytes(); // 3 bytes each
        let mut pending = Vec::new();
        let first = decode_utf8_stream(&mut pending, &bytes[..4]);
        let second = decode_utf8_stream(&mut pending, &bytes[4..]);
        assert_eq!(first, "한");
        assert_eq!(second, "글");
        assert!(pending.is_empty());
    }

    #[test]
    fn byte_at_a_time_reassembles() {
        let bytes = "가나다 abc 🙂".as_bytes();
        let mut pending = Vec::new();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&decode_utf8_stream(&mut pending, &[*b]));
        }
        assert_eq!(out, "가나다 abc 🙂");
        assert!(pending.is_empty());
    }

    // Genuinely invalid bytes must still be replaced, not carried forever.
    #[test]
    fn invalid_bytes_still_replaced() {
        let mut pending = Vec::new();
        let s = decode_utf8_stream(&mut pending, &[b'a', 0xFF, b'b']);
        assert_eq!(s, "a\u{FFFD}b");
        assert!(pending.is_empty());
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::base64_encode;

    // RFC 4648 test vectors — PowerShell decodes -EncodedCommand with
    // Convert.FromBase64String, so any padding mistake bricks the shell launch.
    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // The exact bytes PowerShell will decode: UTF-16LE of the init script.
    #[test]
    fn ps_init_b64_roundtrip() {
        let b64 = super::mymux_ps_init_b64();
        assert!(!b64.is_empty());
        assert!(b64.len() % 4 == 0);
        assert!(b64.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='));
    }
}
