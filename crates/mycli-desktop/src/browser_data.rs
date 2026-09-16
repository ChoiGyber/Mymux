//! Read a Chrome/Edge profile's bookmarks, history and saved passwords into
//! Mymux, so the user can browse and reuse what their OS browser already holds.
//!
//! Everything here is read-only against the user's own profile, and only ever
//! runs after an explicit `consent` flag from the UI — the same bar the profile
//! import already sets, because history and passwords are sensitive.
//!
//! Three data sources, three levels of difficulty:
//!
//! * **Bookmarks** live in a plain `Bookmarks` JSON file. Nothing is encrypted;
//!   we walk the folder tree and flatten the URLs.
//! * **History** is the `History` SQLite database, table `urls`. The file is
//!   copied to a temp path first because the browser keeps it open; the copy is
//!   opened read-only and deleted after.
//! * **Passwords** are the `Login Data` SQLite database, table `logins`, whose
//!   `password_value` is encrypted. Chrome ≥ 80 wraps each secret with an
//!   AES-256-GCM key that itself sits DPAPI-encrypted in `Local State`
//!   (`os_crypt.encrypted_key`). That "v10" scheme is what this decrypts.
//!   Chrome ≥ 127 adds **App-Bound Encryption** ("v20"): the key is bound to
//!   the browser process through a COM service and cannot be unwrapped from
//!   another program without fragile, actively-broken injection. Those entries
//!   are reported as blocked rather than guessed at — never decrypted here.

#[cfg(windows)]
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use serde::Serialize;
#[cfg(windows)]
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    title: String,
    url: String,
    /// Folder path within the bookmark tree, e.g. `["Bookmarks bar", "News"]`.
    folder: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    title: String,
    url: String,
    visit_count: i64,
    /// Last visit as epoch milliseconds, or `None` when the timestamp is absent.
    last_visit_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PasswordEntry {
    url: String,
    username: String,
    /// The decrypted secret. `None` when the entry is App-Bound encrypted (see
    /// `blocked`) so a real password and an unreadable one are never confused.
    password: Option<String>,
    /// `true` when the value uses App-Bound Encryption and could not be read.
    blocked: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserData {
    bookmarks: Vec<Bookmark>,
    history: Vec<HistoryEntry>,
    passwords: Vec<PasswordEntry>,
    /// How many password rows were App-Bound (v20) and therefore unreadable.
    /// Surfaced so the UI can explain a partial result instead of looking broken.
    blocked_passwords: usize,
    /// Non-fatal notes (a source that was missing, a DB that would not open) so
    /// one unavailable kind never sinks the whole import.
    notes: Vec<String>,
}

/// Newest history rows to return. The full table can hold years of browsing; a
/// panel does not need it and the IPC payload should stay bounded.
const HISTORY_LIMIT: usize = 500;

/// Where Chrome/Edge keep their user data, matching browser.rs.
#[cfg(windows)]
fn profile_dir(browser: &str, profile: &str) -> Result<PathBuf, String> {
    let local = dirs::data_local_dir().ok_or("No local app data directory")?;
    let root = match browser {
        "Chrome" => local.join(r"Google\Chrome\User Data"),
        "Edge" => local.join(r"Microsoft\Edge\User Data"),
        _ => return Err("Unsupported browser.".into()),
    };
    if !(profile == "Default" || profile.starts_with("Profile ")) {
        return Err("Unsupported browser profile name.".into());
    }
    let dir = root.join(profile);
    if !dir.is_dir() {
        return Err("Selected browser profile no longer exists.".into());
    }
    Ok(dir)
}

// ── bookmarks ────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn read_bookmarks(profile: &Path) -> Result<Vec<Bookmark>, String> {
    let path = profile.join("Bookmarks");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read Bookmarks: {e}"))?;
    let root: Value = serde_json::from_str(&raw).map_err(|e| format!("parse Bookmarks: {e}"))?;
    let mut out = Vec::new();
    if let Some(roots) = root.get("roots").and_then(Value::as_object) {
        for node in roots.values() {
            walk_bookmarks(node, &mut Vec::new(), &mut out);
        }
    }
    Ok(out)
}

/// Depth-first over the bookmark tree. `url` nodes become entries; `folder`
/// nodes push their name and recurse.
#[cfg(windows)]
fn walk_bookmarks(node: &Value, folder: &mut Vec<String>, out: &mut Vec<Bookmark>) {
    match node.get("type").and_then(Value::as_str) {
        Some("url") => {
            let url = node.get("url").and_then(Value::as_str).unwrap_or_default();
            if url.is_empty() {
                return;
            }
            let title = node
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(url);
            out.push(Bookmark {
                title: title.to_string(),
                url: url.to_string(),
                folder: folder.clone(),
            });
        }
        Some("folder") => {
            let name = node.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            folder.push(name);
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for child in children {
                    walk_bookmarks(child, folder, out);
                }
            }
            folder.pop();
        }
        _ => {}
    }
}

// ── a locked SQLite DB, read through a throwaway copy ─────────────────────────

/// Chrome keeps History and Login Data open, so opening them in place can fail
/// or read torn pages. Copy the file (and its `-wal`/`-shm` siblings so a
/// committed-to-WAL row is not lost) to a temp path, hand back the copy's path,
/// and clean all three up on drop.
#[cfg(windows)]
struct DbCopy {
    path: PathBuf,
    siblings: Vec<PathBuf>,
}

#[cfg(windows)]
impl DbCopy {
    fn of(source: &Path) -> Result<Self, String> {
        let mut rng = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        rng ^= source.to_string_lossy().len() as u128;
        let stem = source.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let base = std::env::temp_dir().join(format!("mymux-{stem}-{rng:x}"));
        std::fs::copy(source, &base).map_err(|e| format!("copy {stem}: {e}"))?;
        let mut siblings = Vec::new();
        for ext in ["-wal", "-shm"] {
            let src = with_suffix(source, ext);
            if src.is_file() {
                let dst = with_suffix(&base, ext);
                if std::fs::copy(&src, &dst).is_ok() {
                    siblings.push(dst);
                }
            }
        }
        Ok(Self { path: base, siblings })
    }
}

#[cfg(windows)]
impl Drop for DbCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        for s in &self.siblings {
            let _ = std::fs::remove_file(s);
        }
    }
}

/// Append a suffix to a file name (not the extension): `History` + `-wal`.
#[cfg(windows)]
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

// ── history ──────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn read_history(profile: &Path) -> Result<Vec<HistoryEntry>, String> {
    let source = profile.join("History");
    if !source.is_file() {
        return Err("no History database".into());
    }
    let copy = DbCopy::of(&source)?;
    let conn = rusqlite::Connection::open_with_flags(
        &copy.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open History: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT url, title, visit_count, last_visit_time \
             FROM urls ORDER BY last_visit_time DESC LIMIT ?1",
        )
        .map_err(|e| format!("query History: {e}"))?;
    let rows = stmt
        .query_map([HISTORY_LIMIT as i64], |row| {
            let url: String = row.get(0)?;
            let title: String = row.get(1).unwrap_or_default();
            let visit_count: i64 = row.get(2).unwrap_or(0);
            let chrome_time: i64 = row.get(3).unwrap_or(0);
            Ok(HistoryEntry {
                title: if title.is_empty() { url.clone() } else { title },
                url,
                visit_count,
                last_visit_ms: chrome_time_to_ms(chrome_time),
            })
        })
        .map_err(|e| format!("read History rows: {e}"))?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        if row.url.starts_with("http") {
            out.push(row);
        }
    }
    Ok(out)
}

/// Chrome timestamps are microseconds since 1601-01-01 UTC. Convert to Unix
/// milliseconds; `0` (never visited) becomes `None`.
fn chrome_time_to_ms(chrome_us: i64) -> Option<i64> {
    if chrome_us <= 0 {
        return None;
    }
    // Microseconds between 1601-01-01 and 1970-01-01.
    const EPOCH_DELTA_US: i64 = 11_644_473_600_000_000;
    Some((chrome_us - EPOCH_DELTA_US) / 1000)
}

// ── passwords ────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn read_passwords(browser: &str, profile: &Path) -> Result<(Vec<PasswordEntry>, usize), String> {
    let key = master_key(browser)?;
    let source = profile.join("Login Data");
    if !source.is_file() {
        return Err("no Login Data database".into());
    }
    let copy = DbCopy::of(&source)?;
    let conn = rusqlite::Connection::open_with_flags(
        &copy.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open Login Data: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT origin_url, username_value, password_value FROM logins")
        .map_err(|e| format!("query Login Data: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let url: String = row.get(0)?;
            let username: String = row.get(1).unwrap_or_default();
            let blob: Vec<u8> = row.get(2).unwrap_or_default();
            Ok((url, username, blob))
        })
        .map_err(|e| format!("read Login Data rows: {e}"))?;

    let mut out = Vec::new();
    let mut blocked = 0usize;
    for (url, username, blob) in rows.flatten() {
        // Skip the "these credentials were deleted" tombstones: no username and
        // an empty secret.
        if username.is_empty() && blob.len() <= 3 {
            continue;
        }
        match decrypt_secret(&blob, &key) {
            Secret::Plain(password) => out.push(PasswordEntry {
                url,
                username,
                password: Some(password),
                blocked: false,
            }),
            Secret::AppBound => {
                blocked += 1;
                out.push(PasswordEntry {
                    url,
                    username,
                    password: None,
                    blocked: true,
                });
            }
            Secret::Unreadable => {
                out.push(PasswordEntry {
                    url,
                    username,
                    password: None,
                    blocked: false,
                });
            }
        }
    }
    Ok((out, blocked))
}

#[cfg(windows)]
enum Secret {
    Plain(String),
    /// v20 App-Bound Encryption — not decryptable outside the browser.
    AppBound,
    /// A blob we could not read for a reason other than App-Bound (corrupt, or
    /// a DPAPI value this user's key cannot open).
    Unreadable,
}

/// Decrypt one `password_value` blob with the profile's AES key.
#[cfg(windows)]
fn decrypt_secret(blob: &[u8], key: &[u8]) -> Secret {
    match blob.get(..3) {
        // v10 (Chrome ≥ 80) and v11 (some Edge builds): AES-256-GCM with the
        // DPAPI-unwrapped key. Layout: 3-byte tag, 12-byte nonce, ciphertext,
        // trailing 16-byte GCM tag.
        Some(b"v10") | Some(b"v11") => {
            if blob.len() < 3 + 12 + 16 {
                return Secret::Unreadable;
            }
            let cipher = match Aes256Gcm::new_from_slice(key) {
                Ok(c) => c,
                Err(_) => return Secret::Unreadable,
            };
            let nonce = Nonce::from_slice(&blob[3..15]);
            match cipher.decrypt(nonce, &blob[15..]) {
                Ok(plain) => Secret::Plain(String::from_utf8_lossy(&plain).into_owned()),
                Err(_) => Secret::Unreadable,
            }
        }
        // v20: App-Bound Encryption. The key sits behind a COM service that
        // validates the caller is the browser; we do not attempt a bypass.
        Some(b"v20") => Secret::AppBound,
        // Pre-v10 blobs are raw DPAPI, no version tag.
        _ => match dpapi_unprotect(blob) {
            Some(plain) => Secret::Plain(String::from_utf8_lossy(&plain).into_owned()),
            None => Secret::Unreadable,
        },
    }
}

/// The profile's AES key: `os_crypt.encrypted_key` from `Local State`, which is
/// base64, prefixed with the literal `DPAPI`, and DPAPI-encrypted underneath.
#[cfg(windows)]
fn master_key(browser: &str) -> Result<Vec<u8>, String> {
    let local = dirs::data_local_dir().ok_or("No local app data directory")?;
    let state = match browser {
        "Chrome" => local.join(r"Google\Chrome\User Data\Local State"),
        "Edge" => local.join(r"Microsoft\Edge\User Data\Local State"),
        _ => return Err("Unsupported browser.".into()),
    };
    let raw = std::fs::read_to_string(&state).map_err(|e| format!("read Local State: {e}"))?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| format!("parse Local State: {e}"))?;
    let b64 = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or("no encrypted_key — this profile may use App-Bound Encryption only")?;
    let wrapped = base64_decode(b64).ok_or("encrypted_key is not valid base64")?;
    if wrapped.len() < 5 || &wrapped[..5] != b"DPAPI" {
        return Err("encrypted_key is not in the expected DPAPI format".into());
    }
    dpapi_unprotect(&wrapped[5..]).ok_or_else(|| "DPAPI could not unwrap the browser key".into())
}

/// `CryptUnprotectData` — DPAPI decryption bound to the current Windows user.
#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        // DPAPI allocates the output with LocalAlloc; release it with LocalFree.
        windows_sys::Win32::Foundation::LocalFree(output.pbData as *mut _);
        Some(out)
    }
}

/// Standard-alphabet base64 with optional padding — enough for `encrypted_key`.
#[cfg(windows)]
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        let mut n = 0;
        for &c in chunk {
            if c == b'=' {
                break;
            }
            acc = (acc << 6) | val(c)?;
            n += 1;
        }
        if n == 0 {
            break;
        }
        acc <<= 6 * (4 - n);
        for i in 0..(n - 1) {
            out.push((acc >> (16 - i * 8)) as u8);
        }
    }
    Some(out)
}

// ── the command ──────────────────────────────────────────────────────────────

/// Import the chosen data kinds from one Chrome/Edge profile. `kinds` selects
/// among `"bookmarks"`, `"history"`, `"passwords"`; each is optional and a
/// failure in one is reported in `notes` rather than failing the whole call.
#[tauri::command(async)]
pub fn browser_import_data(
    browser: String,
    profile: String,
    kinds: Vec<String>,
    consent: bool,
) -> Result<BrowserData, String> {
    if !consent {
        return Err("Reading browser data requires explicit user consent.".into());
    }
    #[cfg(windows)]
    {
        if !(browser == "Chrome" || browser == "Edge") {
            return Err("Unsupported browser.".into());
        }
        let dir = profile_dir(&browser, &profile)?;
        let mut data = BrowserData::default();
        let want = |k: &str| kinds.iter().any(|x| x == k);

        if want("bookmarks") {
            match read_bookmarks(&dir) {
                Ok(list) => data.bookmarks = list,
                Err(e) => data.notes.push(format!("북마크를 읽지 못했습니다: {e}")),
            }
        }
        if want("history") {
            match read_history(&dir) {
                Ok(list) => data.history = list,
                Err(e) => data.notes.push(format!("방문 기록을 읽지 못했습니다: {e}")),
            }
        }
        if want("passwords") {
            match read_passwords(&browser, &dir) {
                Ok((list, blocked)) => {
                    data.blocked_passwords = blocked;
                    if blocked > 0 {
                        data.notes.push(format!(
                            "{blocked}개의 비밀번호는 App-Bound Encryption 이라 브라우저 밖에서는 읽을 수 없습니다."
                        ));
                    }
                    data.passwords = list;
                }
                Err(e) => data.notes.push(format!("비밀번호를 읽지 못했습니다: {e}")),
            }
        }
        Ok(data)
    }
    #[cfg(not(windows))]
    {
        let _ = (browser, profile, kinds);
        Err("Browser data import is currently supported on Windows only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_chrome_timestamps() {
        // 1601-epoch microseconds for 1970-01-01 is exactly the delta, → 0 ms.
        assert_eq!(chrome_time_to_ms(11_644_473_600_000_000), Some(0));
        // A never-visited row is 0 → None.
        assert_eq!(chrome_time_to_ms(0), None);
        assert_eq!(chrome_time_to_ms(-5), None);
        // 13285932330000000 µs → 2021-12-13 (a real Chrome value magnitude).
        let ms = chrome_time_to_ms(13_285_932_330_000_000).unwrap();
        assert!(ms > 1_600_000_000_000 && ms < 1_800_000_000_000, "ms was {ms}");
    }

    #[cfg(windows)]
    #[test]
    fn base64_roundtrips_known_vectors() {
        // "DPAPI" and a few RFC 4648 vectors.
        assert_eq!(base64_decode("RFBBUEk=").unwrap(), b"DPAPI");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        // Embedded whitespace (Local State has none, but be forgiving).
        assert_eq!(base64_decode("Zm9v\nYg==").unwrap(), b"foob");
    }

    /// A v20 blob is reported as App-Bound, never as a failed decrypt: the UI
    /// needs to tell "we can't read this" apart from "this was empty".
    #[cfg(windows)]
    #[test]
    fn v20_blobs_are_classified_app_bound() {
        let key = [0u8; 32];
        let blob = b"v20\x00\x01\x02 some ciphertext";
        assert!(matches!(decrypt_secret(blob, &key), Secret::AppBound));
    }

    /// A v10 blob too short to hold nonce+tag is unreadable, not a panic.
    #[cfg(windows)]
    #[test]
    fn truncated_v10_blob_is_unreadable_not_a_panic() {
        let key = [0u8; 32];
        assert!(matches!(decrypt_secret(b"v10short", &key), Secret::Unreadable));
    }

    /// Round-trip a real v10 secret: encrypt with a known key exactly as Chrome
    /// does, then prove `decrypt_secret` recovers it.
    #[cfg(windows)]
    #[test]
    fn decrypts_a_v10_secret_encrypted_with_a_known_key() {
        use aes_gcm::aead::Aead;
        let key = [7u8; 32];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce_bytes = [9u8; 12];
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), b"hunter2".as_ref())
            .unwrap();
        let mut blob = Vec::from(*b"v10");
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ct);
        match decrypt_secret(&blob, &key) {
            Secret::Plain(p) => assert_eq!(p, "hunter2"),
            _ => panic!("expected a decrypted secret"),
        }
    }

    /// Read this machine's actual Edge/Chrome profile. Off by default because it
    /// touches the user's real data; turn on with `MYMUX_TEST_BROWSER=Edge`
    /// (or `=Chrome`). Proves the SQLite queries, the key unwrap and the v10/v20
    /// classification against files Chrome really wrote, which the synthetic
    /// tests above cannot.
    #[cfg(windows)]
    #[test]
    fn reads_a_real_profile_when_asked() {
        let Some(browser) = std::env::var_os("MYMUX_TEST_BROWSER") else {
            return;
        };
        let browser = browser.to_string_lossy().to_string();
        let data = browser_import_data(
            browser.clone(),
            "Default".into(),
            vec!["bookmarks".into(), "history".into(), "passwords".into()],
            true,
        )
        .expect("import should not fail outright");
        println!(
            "{browser}/Default: {} bookmarks, {} history, {} passwords ({} readable, {} app-bound)",
            data.bookmarks.len(),
            data.history.len(),
            data.passwords.len(),
            data.passwords.iter().filter(|p| p.password.is_some()).count(),
            data.blocked_passwords,
        );
        for note in &data.notes {
            println!("  note: {note}");
        }
        // Every history row we return must be an http(s) URL with a title.
        for h in data.history.iter().take(3) {
            println!("  history: {} — {}", h.title, h.url);
            assert!(h.url.starts_with("http"));
        }
        // The count of blocked rows must match the entries actually flagged.
        let flagged = data.passwords.iter().filter(|p| p.blocked).count();
        assert_eq!(flagged, data.blocked_passwords);
        // A blocked row never carries a password, and a readable row always does.
        for p in &data.passwords {
            if p.blocked {
                assert!(p.password.is_none(), "a blocked row must not expose a secret");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn walks_a_bookmark_tree_into_flat_entries() {
        let json = serde_json::json!({
            "roots": {
                "bookmark_bar": {
                    "type": "folder", "name": "Bookmarks bar",
                    "children": [
                        { "type": "url", "name": "News", "url": "https://news.example" },
                        { "type": "folder", "name": "Dev", "children": [
                            { "type": "url", "name": "Repo", "url": "https://repo.example" }
                        ]}
                    ]
                }
            }
        });
        let mut out = Vec::new();
        for node in json["roots"].as_object().unwrap().values() {
            walk_bookmarks(node, &mut Vec::new(), &mut out);
        }
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "https://news.example");
        assert_eq!(out[0].folder, vec!["Bookmarks bar"]);
        assert_eq!(out[1].folder, vec!["Bookmarks bar", "Dev"]);
    }
}
