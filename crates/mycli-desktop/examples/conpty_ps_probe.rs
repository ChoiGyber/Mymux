// ConPTY probe for the PowerShell prompt — reproduces the startup bug path:
// spawn NARROW (prompt prints), resize WIDER, then type. With the stock
// prompt the full-cwd line wraps at the narrow width and PSReadLine's saved
// absolute coordinates go stale after the resize, so the keystroke renders at
// a bogus spot (the "PS D:\Project\Chur      ePro-Bulletin>" gap). With the
// Mymux injected prompt (mymux_ps_init_b64 in terminal.rs) the prompt is
// abbreviated to fit one row, so the resize can't rewrap it. Run:
//   cargo run -p mycli-desktop --example conpty_ps_probe \
//       [b64|-] [start_cols] [end_cols] [log] [cwd]
// ("-" = plain -NoLogo control run without the injected prompt; copy
// conpty.dll + OpenConsole.exe next to the example exe first, same as the app).
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

fn main() {
    let b64 = std::env::args().nth(1).unwrap_or_else(|| "-".into());
    let start_cols: u16 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(24);
    let end_cols: u16 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(60);
    let log_path = std::env::args().nth(4).unwrap_or_else(|| "conpty_ps_probe_log.txt".into());
    let cwd = std::env::args()
        .nth(5)
        .unwrap_or_else(|| r"D:\Project\Mymux\crates\mycli-desktop".into());

    let log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 12, cols: start_cols, pixel_width: 0, pixel_height: 0 })
        .unwrap();

    let mut cmd =
        CommandBuilder::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    cmd.arg("-NoLogo");
    if b64 != "-" {
        cmd.arg("-NoExit");
        cmd.arg("-EncodedCommand");
        cmd.arg(&b64);
    }
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
    pair.master
        .resize(PtySize { rows: 12, cols: end_cols, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));

    mark("TYPE 'dir'".into());
    writer.write_all(b"dir").unwrap();
    writer.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));

    mark("SEND Enter".into());
    writer.write_all(b"\r").unwrap();
    writer.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));

    let out = log.lock().unwrap().clone();
    std::fs::write(&log_path, &out).unwrap();
    println!("log written: {}", log_path);
    let _ = child.kill();
}
