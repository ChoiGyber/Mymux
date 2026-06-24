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

/// Default shell. On Windows prefer PowerShell (pwsh > powershell) so commands
/// like `cd E:` switch drives as users expect; fall back to cmd.exe (COMSPEC).
fn default_shell_builder() -> CommandBuilder {
    #[cfg(windows)]
    {
        for exe in ["pwsh.exe", "powershell.exe"] {
            if let Some(path) = find_in_path(exe) {
                return CommandBuilder::new(path);
            }
        }
    }
    CommandBuilder::new_default_prog()
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
            rows: rows.max(24),
            cols: cols.max(80),
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

    let cmd = if let Some(ref shell_str) = shell {
        let mut c = CommandBuilder::new(shell_str);
        if let Some(args) = args {
            for arg in &args {
                c.arg(arg);
            }
        }
        c.cwd(&work_dir);
        c
    } else {
        let mut c = default_shell_builder();
        c.cwd(&work_dir);
        c
    };

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
