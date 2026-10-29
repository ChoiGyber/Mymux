use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

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
    apply_managed_env(&mut command, &runner);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(no_console());

    let result = tokio::time::timeout(Duration::from_secs(90), command.output()).await;
    let outcome = (|| {
        let output = result
            .map_err(|_| {
                "Local transcription timed out. 처음 쓰는 모델이면 🎙 의 [자동 설치] 를 다시 눌러 모델을 미리 받아 주세요."
                    .to_string()
            })?
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr: String = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect();
            let reason = if stderr.trim().is_empty() {
                format!("Transcription failed ({})", output.status)
            } else {
                stderr
            };
            // The first local-voice release ran `<exe> <audio> <model> ko-KR`, and
            // people built their own wrapper for that. It reads the second argument
            // as the model, so our `--model` reaches WhisperModel("--model").
            return Err(if mode == LocalMode::Standalone && reason.contains("Invalid model size") {
                format!(
                    "{reason}\n\n선택한 실행 파일이 Mymux 가 호출하는 방식(Faster-Whisper-XXL)과 맞지 않습니다. 🎙 의 [자동 설치하고 바로 연결] 을 누르면 필요한 것을 모두 설치해 연결합니다."
                )
            } else {
                reason
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
    apply_managed_env(&mut command, &runner);
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

// ── One-click local setup ────────────────────────────────────────────────────
//
// Everything lives in one folder under the local app data directory: a private
// Python, faster-whisper, and the Hugging Face model cache (`HF_HOME`). Nothing
// touches the user's own Python or needs administrator rights, and removing the
// folder removes every trace.

#[cfg(windows)]
const EMBED_PYTHON_URL: &str =
    "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
#[cfg(windows)]
const GET_PIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";

/// Number of steps the popover's progress bar counts.
const SETUP_STEPS: u8 = 4;

static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);

struct SetupGuard;

impl Drop for SetupGuard {
    fn drop(&mut self) {
        SETUP_RUNNING.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
pub struct ManagedStatus {
    python: String,
    /// Models already downloaded into the private cache.
    models: Vec<String>,
}

fn runtime_dir() -> Result<PathBuf, String> {
    // Local, not roaming: the runtime and models run to hundreds of megabytes.
    let mut path = dirs::data_local_dir().ok_or("No local data directory available")?;
    // Not `mymux`: Windows paths are case-insensitive and that is where the
    // installer puts the app, so the installer's file handling would overlap.
    path.push("mymux-voice");
    Ok(path)
}

fn managed_python_path() -> Result<PathBuf, String> {
    let dir = runtime_dir()?;
    Ok(if cfg!(windows) {
        dir.join("python").join("python.exe")
    } else {
        dir.join("venv").join("bin").join("python")
    })
}

fn marker_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("ready"))
}

fn managed_status() -> Option<ManagedStatus> {
    let python = managed_python_path().ok()?;
    let marker = std::fs::read_to_string(marker_path().ok()?).ok()?;
    if !python.is_file() {
        return None;
    }
    Some(ManagedStatus {
        python: python.to_string_lossy().into_owned(),
        models: marker
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
    })
}

fn record_model(model: &str) -> Result<(), String> {
    let mut models = managed_status().map(|s| s.models).unwrap_or_default();
    if !models.iter().any(|m| m == model) {
        models.push(model.to_string());
    }
    std::fs::write(marker_path()?, models.join("\n")).map_err(|e| e.to_string())
}

/// True when `runner` is the Python this module installed.
fn is_managed(runner: &Path) -> bool {
    runtime_dir().map(|d| runner.starts_with(d)).unwrap_or(false)
}

/// A command for `program` with the private model cache and UTF-8 output.
fn managed_command(program: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    apply_managed_env(&mut command, program);
    command
}

fn apply_managed_env(command: &mut tokio::process::Command, runner: &Path) {
    if !is_managed(runner) {
        return;
    }
    if let Ok(dir) = runtime_dir() {
        command.env("HF_HOME", dir.join("hf"));
    }
    // Without Developer Mode Windows cannot make the symlinks the cache prefers
    // and huggingface_hub warns about it on every run. It works either way.
    command.env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1");
    command.env("PYTHONUTF8", "1");
    command.env("PYTHONUNBUFFERED", "1");
}

fn emit_progress(app: &tauri::AppHandle, step: u8, message: &str, detail: &str) {
    let _ = app.emit(
        "voice-setup-progress",
        serde_json::json!({
            "step": step,
            "total": SETUP_STEPS,
            "message": message,
            "detail": detail.chars().take(120).collect::<String>(),
        }),
    );
}

fn tail_chars(text: &str, count: usize) -> String {
    let text = text.trim();
    let skip = text.chars().count().saturating_sub(count);
    text.chars().skip(skip).collect()
}

/// Run a step to completion, forwarding each stdout line as progress detail.
/// stderr is only reported when the step fails.
async fn run_logged(
    app: &tauri::AppHandle,
    mut command: tokio::process::Command,
    timeout: Duration,
    step: u8,
    label: &str,
) -> Result<(), String> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(no_console());
    let mut child = command.spawn().map_err(|e| format!("{label}: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_app = app.clone();
    let out_label = label.to_string();
    let out_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if !line.is_empty() {
                    emit_progress(&out_app, step, &out_label, line);
                }
            }
        }
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status.map_err(|e| format!("{label}: {e}"))?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!("{label}: 시간이 너무 오래 걸려 중단했습니다. 네트워크를 확인하고 다시 시도해 주세요."));
        }
    };
    let _ = out_task.await;
    let stderr = err_task.await.unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let reason = tail_chars(&stderr, 600);
    Err(if reason.is_empty() {
        format!("{label} 실패 ({status})")
    } else {
        format!("{label} 실패: {reason}")
    })
}

/// Whether a quick probe command exits successfully. Never an error.
async fn succeeds(mut command: tokio::process::Command, secs: u64) -> bool {
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(no_console());
    matches!(
        tokio::time::timeout(Duration::from_secs(secs), command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

#[cfg(windows)]
async fn download(url: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("내려받을 수 없습니다 ({url}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("내려받을 수 없습니다 ({url}): HTTP {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| format!("내려받을 수 없습니다 ({url}): {e}"))?;
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())
}

/// The embeddable Python ships with `import site` commented out, which leaves
/// pip unable to install anything. Enabling it is the documented way to use it.
#[cfg(windows)]
fn enable_site(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("_pth") {
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            return std::fs::write(&path, text.replace("#import site", "import site"))
                .map_err(|e| e.to_string());
        }
    }
    Err("내려받은 Python 에서 ._pth 파일을 찾지 못했습니다.".into())
}

#[cfg(windows)]
async fn ensure_python(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let python = managed_python_path()?;
    if python.is_file() {
        return Ok(python);
    }
    if std::env::consts::ARCH != "x86_64" {
        return Err("자동 설치는 64비트 Intel/AMD Windows 에서만 지원합니다. 설치 안내를 보고 직접 설치해 주세요.".into());
    }
    let dir = python.parent().ok_or("Invalid runtime path")?.to_path_buf();
    let result = async {
        emit_progress(app, 1, "Python 실행 환경 내려받는 중", "");
        let zip = runtime_dir()?.join("python-embed.zip");
        download(EMBED_PYTHON_URL, &zip).await?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Full path: a `tar` earlier on PATH (Git's GNU tar) cannot read zip.
        let tar = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
            .join("System32")
            .join("tar.exe");
        let mut command = tokio::process::Command::new(tar);
        command.arg("-xf").arg(&zip).arg("-C").arg(&dir);
        run_logged(app, command, Duration::from_secs(120), 1, "Python 압축 해제").await?;
        let _ = std::fs::remove_file(&zip);
        enable_site(&dir)
    }
    .await;
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    if !python.is_file() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("Python 압축 해제 후에도 python.exe 가 없습니다.".into());
    }
    Ok(python)
}

#[cfg(not(windows))]
async fn ensure_python(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let python = managed_python_path()?;
    if python.is_file() {
        return Ok(python);
    }
    emit_progress(app, 1, "Python 가상환경 만드는 중", "");
    let mut system = None;
    for name in ["python3", "python"] {
        let mut probe = tokio::process::Command::new(name);
        probe.arg("--version");
        if succeeds(probe, 10).await {
            system = Some(name);
            break;
        }
    }
    let Some(system) = system else {
        return Err("Python 3 가 필요합니다. 패키지 관리자로 python3 를 설치한 뒤 다시 시도해 주세요.".into());
    };
    let venv = runtime_dir()?.join("venv");
    let mut command = tokio::process::Command::new(system);
    command.arg("-m").arg("venv").arg(&venv);
    if let Err(e) = run_logged(app, command, Duration::from_secs(120), 1, "가상환경 생성").await {
        let _ = std::fs::remove_dir_all(&venv);
        return Err(format!("{e} (Debian/Ubuntu 는 python3-venv 패키지가 필요할 수 있습니다)"));
    }
    Ok(python)
}

async fn ensure_pip(app: &tauri::AppHandle, python: &Path) -> Result<(), String> {
    emit_progress(app, 2, "pip 확인 중", "");
    let mut probe = managed_command(python);
    probe.args(["-m", "pip", "--version"]);
    if succeeds(probe, 30).await {
        return Ok(());
    }
    #[cfg(windows)]
    {
        emit_progress(app, 2, "pip 설치 중", "");
        let script = runtime_dir()?.join("get-pip.py");
        download(GET_PIP_URL, &script).await?;
        let mut command = managed_command(python);
        command
            .arg(&script)
            .args(["--no-warn-script-location", "--disable-pip-version-check"]);
        let result = run_logged(app, command, Duration::from_secs(300), 2, "pip 설치").await;
        let _ = std::fs::remove_file(&script);
        result
    }
    #[cfg(not(windows))]
    Err("가상환경에 pip 가 없습니다. python3-venv 패키지를 확인해 주세요.".into())
}

/// Install a private Python and faster-whisper, then download `model`, and
/// report where the result lives. Every step skips itself when already done,
/// so running it again is how another model is fetched or a failure is retried.
#[tauri::command]
pub async fn voice_setup_local(
    app: tauri::AppHandle,
    model: String,
) -> Result<ManagedStatus, String> {
    validate_model(&model)?;
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("이미 설치가 진행 중입니다.".into());
    }
    let _guard = SetupGuard;
    // Created here and not in runtime_dir(): the popover asks for the status every
    // time it opens, and asking must not leave a folder behind.
    std::fs::create_dir_all(runtime_dir()?).map_err(|e| e.to_string())?;

    let python = ensure_python(&app).await?;
    ensure_pip(&app, &python).await?;

    emit_progress(&app, 3, "faster-whisper 설치 중", "");
    let mut install = managed_command(&python);
    install.args([
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        "faster-whisper",
    ]);
    run_logged(&app, install, Duration::from_secs(1800), 3, "faster-whisper 설치").await?;
    // The runtime works from here on; a failed model download below leaves it
    // usable and only the retry has anything left to do.
    mark_runtime_ready()?;

    emit_progress(&app, 4, &format!("{model} 모델 내려받는 중 (수 분 걸릴 수 있습니다)"), "");
    let script = wrapper_script(&app)?;
    let mut prefetch = managed_command(&python);
    prefetch
        .arg(&script)
        .args(["--prefetch", "--model", &model]);
    run_logged(&app, prefetch, Duration::from_secs(3600), 4, "모델 내려받기").await?;
    record_model(&model)?;

    managed_status().ok_or_else(|| "설치는 끝났지만 상태를 읽을 수 없습니다.".to_string())
}

/// Create the marker, so the runtime counts as installed before any model is.
fn mark_runtime_ready() -> Result<(), String> {
    let marker = marker_path()?;
    if !marker.is_file() {
        std::fs::write(&marker, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The private install, if the one-click setup has been run.
#[tauri::command]
pub fn voice_managed_status() -> Option<ManagedStatus> {
    managed_status()
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
