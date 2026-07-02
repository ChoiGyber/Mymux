// ConPTY resize emission probe — reproduces the app's exact PTY stack
// (portable-pty + sideloaded conpty.dll/OpenConsole.exe + git-bash with the
// Mymux rcfile) to capture the raw VT bytes ConPTY emits when the terminal
// resizes while a prompt is on screen, then after an Enter. Run:
//   cargo run -p mycli-desktop --example conpty_probe \
//       [cwd] [log] [rcfile] [start_cols] [end_cols]
// (copy conpty.dll + OpenConsole.exe next to the example exe first so the
// sideloaded ConPTY is the one being measured, same as the app).
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

fn main() {
    let log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let start_cols: u16 = std::env::args().nth(4).and_then(|s| s.parse().ok()).unwrap_or(26);
    let end_cols: u16 = std::env::args().nth(5).and_then(|s| s.parse().ok()).unwrap_or(100);
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 12, cols: start_cols, pixel_width: 0, pixel_height: 0 })
        .unwrap();

    let bash = r"C:\Program Files\Git\bin\bash.exe";
    let rc = std::env::args().nth(3).unwrap_or_else(|| {
        dirs::home_dir().unwrap().join(".mycli").join("mymux.bashrc").to_string_lossy().into_owned()
    });
    let mut cmd = CommandBuilder::new(bash);
    cmd.arg("--rcfile");
    cmd.arg(rc.replace('\\', "/"));
    cmd.arg("-i");
    cmd.env("CHERE_INVOKING", "1");
    let cwd = std::env::args().nth(1).unwrap_or_else(|| r"D:\Project\Mymux\crates\mycli-desktop".into());
    cmd.cwd(cwd);

    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();

    let start = std::time::Instant::now();
    {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut s = format!("\n[{:>6}ms] ", start.elapsed().as_millis());
                        for &b in &buf[..n] {
                            match b {
                                0x1b => s.push_str("\\e"),
                                b'\r' => s.push_str("\\r"),
                                b'\n' => s.push_str("\\n"),
                                0x07 => s.push_str("\\a"),
                                0x08 => s.push_str("\\b"),
                                0x20..=0x7e => s.push(b as char),
                                _ => s.push_str(&format!("\\x{:02x}", b)),
                            }
                        }
                        log.lock().unwrap().push_str(&s);
                    }
                }
            }
        });
    }

    let mark = |m: String| {
        log.lock().unwrap().push_str(&format!("\n\n======== {} ========", m));
    };

    std::thread::sleep(std::time::Duration::from_secs(4));
    mark(format!("RESIZE cols {} -> {} (rows 12)", start_cols, end_cols));
    pair.master.resize(PtySize { rows: 12, cols: end_cols, pixel_width: 0, pixel_height: 0 }).unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));

    mark("SEND Enter".into());
    writer.write_all(b"\r").unwrap();
    writer.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));

    let out = log.lock().unwrap().clone();
    let log_path = std::env::args().nth(2).unwrap_or_else(|| "conpty_probe_log.txt".into());
    std::fs::write(&log_path, &out).unwrap();
    println!("log written: {}", log_path);
    let _ = child.kill();
}
