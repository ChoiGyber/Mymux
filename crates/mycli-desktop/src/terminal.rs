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

/// Find an executable on the PATH (Windows).
#[cfg(windows)]
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
PS1='\[\033[36m\]${__mymux_p}\[\033[0m\] \$ '

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

/// Default shell. On Windows prefer Git Bash (clean, no product banner); if it
/// isn't installed, fall back to PowerShell with `-NoLogo` so the startup
/// banner is suppressed.
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
        for exe in ["pwsh.exe", "powershell.exe"] {
            if let Some(path) = find_in_path(exe) {
                let mut c = CommandBuilder::new(path);
                c.arg("-NoLogo");
                return c;
            }
        }
    }
    CommandBuilder::new_default_prog()
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
                for exe in ["pwsh.exe", "powershell.exe"] {
                    if let Some(p) = find_in_path(exe) {
                        let mut c = CommandBuilder::new(p);
                        c.arg("-NoLogo");
                        return c;
                    }
                }
            }
            "powershell.exe" | "windows-powershell" => {
                if let Some(p) = find_in_path("powershell.exe") {
                    let mut c = CommandBuilder::new(p);
                    c.arg("-NoLogo");
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

    let mut c = CommandBuilder::new(s);
    if let Some(args) = args {
        for a in args {
            c.arg(a);
        }
    }
    c
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
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let mut out = buf_clone.lock().unwrap();
                    out.push(data);
                }
                Err(_) => break,
            }
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
