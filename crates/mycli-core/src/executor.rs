use std::process::{Command, Output};

use crate::error::CoreError;

/// Execute a shell command and return its output.
pub fn run(command_text: &str) -> Result<Output, CoreError> {
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", command_text]).output()
    } else {
        Command::new("sh").args(["-c", command_text]).output()
    };

    output.map_err(|e| CoreError::Io {
        path: "<command>".into(),
        source: e,
    })
}
