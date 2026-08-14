// ConPTY probe for the Codex CLI TUI — spawns codex.exe under the app's exact
// PTY stack (portable-pty + sideloaded conpty.dll/OpenConsole.exe) and captures
// the raw VT bytes of its first paint, to verify what the footer
// ("NN% context left") actually looks like on the wire after ConPTY re-encoding
// — the input scanCtxUsage/CODEX_CTX_RE really see. Run:
//   cargo run -p mycli-desktop --example conpty_codex_probe [log] [raw] [secs]
// (copy conpty.dll + OpenConsole.exe next to the example exe first, same as
// the app; cwd is the home dir — a codex-trusted folder, so the TUI paints the
// composer/footer immediately instead of a trust prompt.)
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::{Arc, Mutex};

fn main() {
    let log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let raw: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let secs: u64 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(15);
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .unwrap();

    let codex = r"C:\Users\ChoiGyber\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe";
    let mut cmd = CommandBuilder::new(codex);
    let home = dirs::home_dir().unwrap();
    cmd.cwd(home);

    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();

    let start = std::time::Instant::now();
    {
        let log = log.clone();
        let raw = raw.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        raw.lock().unwrap().extend_from_slice(&buf[..n]);
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

    // The 0.144.3 TUI opens on an "Update available" chooser before the
    // composer; "2" activates Skip. Then submit ONE minimal prompt so we can
    // measure the TUI's output cadence DURING a working turn (does the
    // "(Ns · esc to interrupt)" timer tick?) and whether the "% context left"
    // footer appears once tokens have been used.
    use std::io::Write;
    std::thread::sleep(std::time::Duration::from_secs(6));
    writer.write_all(b"2").unwrap();
    writer.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));
    writer.write_all(b"reply with exactly: ok").unwrap();
    writer.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1500));
    writer.write_all(b"\r").unwrap();
    writer.flush().unwrap();
    let waited = 6 + 2 + 2; // seconds consumed above (approx)
    std::thread::sleep(std::time::Duration::from_secs(secs.saturating_sub(waited).max(5)));

    let out = log.lock().unwrap().clone();
    let log_path = std::env::args().nth(1).unwrap_or_else(|| "conpty_codex_log.txt".into());
    std::fs::write(&log_path, &out).unwrap();
    let raw_path = std::env::args().nth(2).unwrap_or_else(|| "conpty_codex_raw.bin".into());
    std::fs::write(&raw_path, raw.lock().unwrap().as_slice()).unwrap();
    println!("log written: {log_path} / raw: {raw_path}");
    let _ = child.kill();
}
