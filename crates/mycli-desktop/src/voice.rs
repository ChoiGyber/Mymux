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

fn validate_runner(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() { return Err("Local runner must be an existing absolute executable path".into()); }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(name.as_str(), "faster-whisper.exe" | "faster_whisper.exe" | "whisper.exe") { return Err("Runner must be a faster-whisper wrapper executable".into()); }
    Ok(())
}

#[tauri::command]
pub async fn voice_transcribe_local(audio_base64: String, runner_path: String, model_path: String) -> Result<String, String> {
    if audio_base64.len() > 20_000_000 { return Err("Audio recording is too large".into()); }
    let data = base64_decode(&audio_base64)?;
    if data.len() > 15_000_000 { return Err("Audio recording is too large".into()); }
    let runner = PathBuf::from(runner_path);
    let model = PathBuf::from(model_path);
    validate_runner(&runner)?;
    if !model.is_absolute() || !model.is_dir() { return Err("Model path must be an existing absolute directory".into()); }
    let mut audio = std::env::temp_dir();
    audio.push(format!("mymux-voice-{}.webm", uuid::Uuid::new_v4()));
    std::fs::write(&audio, data).map_err(|e| e.to_string())?;

    let mut command = tokio::process::Command::new(&runner);
    command.args([audio.to_string_lossy().as_ref(), model.to_string_lossy().as_ref(), "ko-KR"])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)] { command.creation_flags(0x0800_0000); }
    let result = tokio::time::timeout(Duration::from_secs(90), command.output()).await;
    let _ = std::fs::remove_file(&audio);
    let output = result.map_err(|_| "Local transcription timed out".to_string())?.map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(2000).collect()); }
    if output.stdout.len() > 32_000 { return Err("Transcription output is too large".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
