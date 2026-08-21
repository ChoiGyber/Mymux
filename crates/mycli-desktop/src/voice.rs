use serde::Deserialize;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};

fn key_path() -> Result<PathBuf, String> {
    let mut path = dirs::config_dir().ok_or("No config directory available")?;
    path.push("mymux");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("deepgram.key.dpapi");
    Ok(path)
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB}};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptProtectData(&mut input, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0, &mut output) == 0 { return Err("Windows DPAPI encryption failed".into()); }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB}};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptUnprotectData(&mut input, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0, &mut output) == 0 { return Err("Windows DPAPI decryption failed".into()); }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(bytes)
    }
}

#[cfg(not(windows))] fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Encrypted Deepgram keys are supported on Windows only".into()) }
#[cfg(not(windows))] fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Encrypted Deepgram keys are supported on Windows only".into()) }

#[tauri::command]
pub fn voice_store_deepgram_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() { return Err("API key is empty".into()); }
    if key.len() > 512 { return Err("API key is too long".into()); }
    let path = key_path()?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, protect(key.as_bytes())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_deepgram_token() -> Result<String, String> {
    let bytes = std::fs::read(key_path()?).map_err(|_| "No saved Deepgram API key".to_string())?;
    let key = String::from_utf8(unprotect(&bytes)?).map_err(|_| "Saved Deepgram API key is invalid".to_string())?;
    let response = reqwest::Client::new()
        .post("https://api.deepgram.com/v1/auth/grant")
        .header("Authorization", format!("Token {key}"))
        .json(&serde_json::json!({"ttl_seconds": 30}))
        .send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        let code = response.status().as_u16();
        let hint = match code {
            // /v1/auth/grant needs the API key to have at least Member permission.
            403 => " — 이 Deepgram API 키에 임시 토큰 발급 권한이 없습니다. 콘솔에서 키를 'Member' 이상 권한으로 다시 만들어 주세요.",
            401 => " — Deepgram API 키가 유효하지 않습니다(오타/만료). 콘솔에서 키를 다시 복사해 저장해 주세요.",
            _ => "",
        };
        return Err(format!("Deepgram token request failed ({code}){hint}"));
    }
    #[derive(Deserialize)] struct Grant { access_token: String }
    let token = response.json::<Grant>().await.map_err(|e| e.to_string())?.access_token;
    if token.is_empty() { return Err("Deepgram returned an empty token".into()); }
    Ok(token)
}

/// How the user runs faster-whisper locally.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LocalMode {
    /// A self-contained build from Purfview/whisper-standalone-win. No Python.
    Standalone,
    /// A Python interpreter plus the `whisper_wrapper.py` we ship.
    Python,
}

impl LocalMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "standalone" => Ok(Self::Standalone),
            "python" => Ok(Self::Python),
            _ => Err(format!("Unknown local transcription mode: {value}")),
        }
    }
}

/// Executables each mode will run. Both lists are closed: `runner_path` comes
/// from a file picker but is stored in localStorage, so it must not be able to
/// turn into "launch any program on this machine".
fn validate_runner(path: &Path, mode: LocalMode) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Local runner must be an existing absolute executable path".into());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let allowed: &[&str] = match mode {
        // Purfview ships `faster-whisper-xxl.exe`; older builds and the
        // vanilla Whisper build use the other three names.
        LocalMode::Standalone => &[
            "faster-whisper-xxl.exe",
            "faster-whisper.exe",
            "faster_whisper.exe",
            "whisper-faster.exe",
            "whisper.exe",
            "faster-whisper-xxl",
            "faster-whisper",
            "whisper-faster",
            "whisper",
        ],
        LocalMode::Python => &["python.exe", "pythonw.exe", "python3.exe", "python", "python3"],
    };
    if !allowed.contains(&name.as_str()) {
        return Err(match mode {
            LocalMode::Standalone => {
                "실행 파일이 faster-whisper 계열이 아닙니다. 압축을 푼 폴더의 \
                 faster-whisper-xxl.exe 를 골라 주세요."
                    .into()
            }
            LocalMode::Python => {
                "Python 실행 파일이 아닙니다. python.exe 를 골라 주세요.".to_string()
            }
        });
    }
    Ok(())
}

/// Model sizes and languages are pasted straight into a command line, so they
/// are matched against a closed list rather than escaped.
fn validate_model(model: &str) -> Result<(), String> {
    const MODELS: [&str; 8] = [
        "tiny", "base", "small", "medium", "large-v2", "large-v3", "turbo", "distil-large-v3",
    ];
    if MODELS.contains(&model) {
        Ok(())
    } else {
        Err(format!("Unsupported model: {model}"))
    }
}

fn validate_language(language: &str) -> Result<(), String> {
    const LANGUAGES: [&str; 6] = ["auto", "ko", "en", "ja", "zh", "es"];
    if LANGUAGES.contains(&language) {
        Ok(())
    } else {
        Err(format!("Unsupported language: {language}"))
    }
}

/// The bundled Python wrapper. Falls back to the source tree so `cargo run`
/// development builds behave like an installed one.
fn wrapper_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    if let Ok(path) = app
        .path()
        .resolve("resources/whisper_wrapper.py", tauri::path::BaseDirectory::Resource)
        && path.is_file()
    {
        return Ok(path);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/whisper_wrapper.py");
    if dev.is_file() {
        return Ok(dev);
    }
    Err("Bundled whisper_wrapper.py is missing from this installation".into())
}

#[cfg(windows)]
fn no_console() -> u32 {
    0x0800_0000 // CREATE_NO_WINDOW — never flash a console at the user
}

/// Transcribe a recording with a local faster-whisper install.
///
/// The frontend sends 16 kHz mono WAV. That is deliberate: `MediaRecorder`
/// only produces webm/opus, and reading that needs ffmpeg beside the runner —
/// the most common way a correct install still produces nothing.
#[tauri::command]
pub async fn voice_transcribe_local(
    app: tauri::AppHandle,
    audio_base64: String,
    mode: String,
    runner_path: String,
    model: String,
    language: String,
) -> Result<String, String> {
    if audio_base64.len() > 20_000_000 {
        return Err("Audio recording is too large".into());
    }
    let data = base64_decode(&audio_base64)?;
    if data.len() > 15_000_000 {
        return Err("Audio recording is too large".into());
    }
    let mode = LocalMode::parse(&mode)?;
    let runner = PathBuf::from(runner_path);
    validate_runner(&runner, mode)?;
    validate_model(&model)?;
    validate_language(&language)?;

    // One directory per run: the standalone build writes its transcript beside
    // the audio, and an empty directory makes it unambiguous which file that is.
    let work = std::env::temp_dir().join(format!("mymux-voice-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let audio = work.join("input.wav");
    let write_result = std::fs::write(&audio, data);
    if let Err(e) = write_result {
        let _ = std::fs::remove_dir_all(&work);
        return Err(e.to_string());
    }

    let mut command = tokio::process::Command::new(&runner);
    match mode {
        LocalMode::Standalone => {
            command.args([
                audio.to_string_lossy().as_ref(),
                "--model",
                &model,
                "--language",
                if language == "auto" { "auto" } else { &language },
                "--task",
                "transcribe",
                "--output_format",
                "txt",
                "--output_dir",
                work.to_string_lossy().as_ref(),
            ]);
        }
        LocalMode::Python => {
            let script = match wrapper_script(&app) {
                Ok(script) => script,
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&work);
                    return Err(e);
                }
            };
            command.args([
                script.to_string_lossy().as_ref(),
                audio.to_string_lossy().as_ref(),
                "--model",
                &model,
                "--language",
                &language,
            ]);
        }
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(no_console());

    let result = tokio::time::timeout(Duration::from_secs(90), command.output()).await;
    let outcome = (|| {
        let output = result
            .map_err(|_| "Local transcription timed out".to_string())?
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr: String = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect();
            return Err(if stderr.trim().is_empty() {
                format!("Transcription failed ({})", output.status)
            } else {
                stderr
            });
        }
        match mode {
            LocalMode::Python => {
                if output.stdout.len() > 32_000 {
                    return Err("Transcription output is too large".into());
                }
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            }
            // The standalone build writes a file and prints only progress.
            LocalMode::Standalone => read_transcript_dir(&work),
        }
    })();
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

/// Pick the transcript out of the run directory. `-f txt` is requested, but a
/// build that ignores it still leaves a subtitle file, and stripping the
/// timestamp lines out of that beats reporting "no output".
fn read_transcript_dir(work: &Path) -> Result<String, String> {
    let mut best: Option<PathBuf> = None;
    for entry in std::fs::read_dir(work).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "txt" => {
                best = Some(path);
                break;
            }
            "srt" | "vtt" => best.get_or_insert(path),
            _ => continue,
        };
    }
    let Some(path) = best else {
        return Err(
            "실행은 됐지만 결과 파일이 없습니다. [설치 확인] 으로 실행 파일을 점검해 주세요."
                .into(),
        );
    };
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    if raw.len() > 200_000 {
        return Err("Transcription output is too large".into());
    }
    let text = String::from_utf8_lossy(&raw);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.eq_ignore_ascii_case("txt") {
        return Ok(text.trim().to_string());
    }
    // Subtitle: drop the cue numbers, the "00:00:01,000 --> …" lines and WEBVTT.
    let body = text
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.contains("-->")
                && !line.eq_ignore_ascii_case("WEBVTT")
                && !line.chars().all(|c| c.is_ascii_digit())
        })
        .collect::<Vec<_>>()
        .join(" ");
    Ok(body.trim().to_string())
}

/// Run the configured setup and report what it is. Called by the popover's
/// [설치 확인] button so a broken install names its own missing piece instead
/// of failing silently the next time the user holds the mic button.
#[tauri::command]
pub async fn voice_check_local(mode: String, runner_path: String) -> Result<String, String> {
    let mode = LocalMode::parse(&mode)?;
    let runner = PathBuf::from(runner_path);
    validate_runner(&runner, mode)?;

    let mut command = tokio::process::Command::new(&runner);
    match mode {
        LocalMode::Standalone => {
            command.arg("--help");
        }
        LocalMode::Python => {
            command.args([
                "-c",
                "import faster_whisper as f; print('faster-whisper', f.__version__)",
            ]);
        }
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(no_console());

    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "확인이 20초 안에 끝나지 않았습니다.".to_string())?
        .map_err(|e| format!("실행할 수 없습니다: {e}"))?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        return Ok(match mode {
            LocalMode::Python => first.to_string(),
            LocalMode::Standalone => {
                if first.is_empty() { "실행 파일 확인됨".into() } else { first.chars().take(120).collect() }
            }
        });
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if mode == LocalMode::Python && stderr.contains("ModuleNotFoundError") {
        return Err(
            "faster-whisper 가 설치돼 있지 않습니다. `pip install faster-whisper` 를 실행하세요."
                .into(),
        );
    }
    Err(stderr.trim().chars().take(400).collect::<String>())
}

/// Native picker for the runner executable, so the path is never typed by hand.
#[tauri::command]
pub fn voice_pick_runner(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .add_filter("실행 파일", &["exe"])
        .blocking_pick_file()
        .map(|f| f.to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut value = 0u32; let mut bits = 0u8;
    for c in input.bytes().filter(|c| !b"=\r\n".contains(c)) {
        let n = table.iter().position(|x| *x == c).ok_or("Invalid base64")? as u32;
        value = (value << 6) | n; bits += 6;
        if bits >= 8 { bits -= 8; out.push((value >> bits) as u8); value &= (1 << bits) - 1; }
    }
    Ok(out)
}
