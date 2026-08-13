//! Where does an SFTP connection actually stall?
//!
//! `sftp_connect` can sit in "connecting" forever against a server that the
//! OpenSSH client reaches instantly. This walks the same russh steps the app
//! takes and prints how long each one took, so the stall can be pinned to a
//! single stage instead of guessed at.
//!
//! Run: cargo run -p mycli-desktop --example sftp_probe -- <host> <port> <user> [key_path]

use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;

struct ProbeHandler;

impl client::Handler for ProbeHandler {
    type Error = russh::Error;

    // A probe deliberately accepts any host key: we are diagnosing timing, and
    // rejecting here would hide the later stages we want to measure.
    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

/// Run one stage under a deadline and report what happened.
async fn stage<T, F>(name: &str, secs: u64, future: F) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    let started = Instant::now();
    print!("{name:<28}");
    use std::io::Write;
    std::io::stdout().flush().ok();
    match tokio::time::timeout(Duration::from_secs(secs), future).await {
        Ok(value) => {
            println!("ok    {:>7.2}s", started.elapsed().as_secs_f64());
            Some(value)
        }
        Err(_) => {
            println!("STALL >{secs}s  ← 여기서 멈춘다");
            None
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (host, port, user) = match args.as_slice() {
        [h, p, u, ..] => (h.clone(), p.parse::<u16>().unwrap_or(22), u.clone()),
        _ => {
            eprintln!("usage: sftp_probe <host> <port> <user> [key_path]");
            std::process::exit(2);
        }
    };
    let key_path = args.get(3).cloned();

    println!("target: {user}@{host}:{port}");
    println!("key   : {}\n", key_path.as_deref().unwrap_or("(none)"));

    // 1. TCP + version exchange + key exchange + host-key callback.
    let config = Arc::new(client::Config::default());
    let Some(connected) = stage(
        "1 client::connect",
        20,
        client::connect(config, (host.as_str(), port), ProbeHandler),
    )
    .await
    else {
        return;
    };
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(e) => {
            println!("   connect error: {e}");
            return;
        }
    };

    // 2. Read the private key from disk (pure local work).
    let Some(key_path) = key_path else {
        println!("(키 경로가 없어 인증 단계를 건너뛴다)");
        return;
    };
    let started = Instant::now();
    let key = match russh::keys::load_secret_key(&key_path, None) {
        Ok(key) => {
            println!("{:<28}ok    {:>7.2}s", "2 load_secret_key", started.elapsed().as_secs_f64());
            key
        }
        Err(e) => {
            println!("{:<28}FAIL  {e}", "2 load_secret_key");
            return;
        }
    };

    // 3. Public-key authentication.
    let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
    let Some(auth) = stage(
        "3 authenticate_publickey",
        20,
        handle.authenticate_publickey(&user, key_with_alg),
    )
    .await
    else {
        return;
    };
    match auth {
        Ok(result) if result.success() => println!("   authenticated"),
        Ok(_) => {
            println!("   rejected — 서버가 이 키를 받지 않았다");
            return;
        }
        Err(e) => {
            println!("   auth error: {e}");
            return;
        }
    }

    // 4. Open a session channel.
    let Some(channel) = stage("4 channel_open_session", 20, handle.channel_open_session()).await
    else {
        return;
    };
    let channel = match channel {
        Ok(channel) => channel,
        Err(e) => {
            println!("   channel error: {e}");
            return;
        }
    };

    // 5. Ask for the sftp subsystem.
    let Some(subsystem) = stage(
        "5 request_subsystem(sftp)",
        20,
        channel.request_subsystem(true, "sftp"),
    )
    .await
    else {
        return;
    };
    if let Err(e) = subsystem {
        println!("   subsystem error: {e}");
        return;
    }

    // 6. SFTP protocol handshake.
    let Some(session) = stage("6 SftpSession::new", 20, SftpSession::new(channel.into_stream()))
        .await
    else {
        return;
    };
    let session = match session {
        Ok(session) => session,
        Err(e) => {
            println!("   sftp session error: {e}");
            return;
        }
    };

    // 7. One real call, which is what the Explorer does first.
    match stage("7 canonicalize(.)", 20, session.canonicalize(".")).await {
        Some(Ok(path)) => println!("\n원격 홈: {path}"),
        Some(Err(e)) => println!("\ncanonicalize error: {e}"),
        None => {}
    }
}
