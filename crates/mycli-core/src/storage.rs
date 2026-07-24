use std::fs;
use std::io::Write;
use std::path::PathBuf;

use fs2::FileExt;

use crate::error::CoreError;
use crate::models::SavedCommand;

pub struct CommandStore {
    path: PathBuf,
}

impl CommandStore {
    /// Create a new store. Creates the directory and file if they don't exist.
    pub fn new() -> Result<Self, CoreError> {
        let home = dirs::home_dir().expect("Could not determine home directory");
        let dir = home.join(".mycli");
        let path = dir.join("commands.json");

        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| CoreError::Io {
                path: dir.clone(),
                source: e,
            })?;
        }

        if !path.exists() {
            fs::write(&path, "[]").map_err(|e| CoreError::Io {
                path: path.clone(),
                source: e,
            })?;
        }

        Ok(Self { path })
    }

    /// Create a store with a custom path (for testing).
    pub fn with_path(path: PathBuf) -> Result<Self, CoreError> {
        if let Some(parent) = path.parent()
            && !parent.exists()
        {
            fs::create_dir_all(parent).map_err(|e| CoreError::Io {
                path: parent.to_path_buf(),
                source: e,
            })?;
        }
        if !path.exists() {
            fs::write(&path, "[]").map_err(|e| CoreError::Io {
                path: path.clone(),
                source: e,
            })?;
        }
        Ok(Self { path })
    }

    /// List all saved commands.
    pub fn list(&self) -> Result<Vec<SavedCommand>, CoreError> {
        let file = fs::File::open(&self.path).map_err(|e| CoreError::Io {
            path: self.path.clone(),
            source: e,
        })?;
        file.lock_shared().map_err(|e| CoreError::Io {
            path: self.path.clone(),
            source: e,
        })?;

        let content = fs::read_to_string(&self.path).map_err(|e| CoreError::Io {
            path: self.path.clone(),
            source: e,
        })?;

        file.unlock().ok();

        let commands: Vec<SavedCommand> =
            serde_json::from_str(&content).map_err(|e| CoreError::Json {
                path: self.path.clone(),
                source: e,
            })?;

        Ok(commands)
    }

    /// Add a new command.
    pub fn add(&self, cmd: SavedCommand) -> Result<(), CoreError> {
        let mut commands = self.list()?;
        commands.push(cmd);
        self.write_all(&commands)
    }

    /// Update an existing command by ID.
    pub fn update(&self, cmd: SavedCommand) -> Result<(), CoreError> {
        let mut commands = self.list()?;
        let pos = commands
            .iter()
            .position(|c| c.id == cmd.id)
            .ok_or_else(|| CoreError::NotFound(cmd.id.clone()))?;
        commands[pos] = cmd;
        self.write_all(&commands)
    }

    /// Remove a command by ID.
    pub fn remove(&self, id: &str) -> Result<(), CoreError> {
        let mut commands = self.list()?;
        let pos = commands
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
        commands.remove(pos);
        self.write_all(&commands)
    }

    /// Get a single command by ID.
    pub fn get(&self, id: &str) -> Result<SavedCommand, CoreError> {
        let commands = self.list()?;
        commands
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| CoreError::NotFound(id.to_string()))
    }

    /// Atomic write: write to temp file, then rename over original.
    fn write_all(&self, commands: &[SavedCommand]) -> Result<(), CoreError> {
        let tmp_path = self.path.with_extension("json.tmp");

        let file = fs::File::create(&tmp_path).map_err(|e| CoreError::Io {
            path: tmp_path.clone(),
            source: e,
        })?;
        file.lock_exclusive().map_err(|e| CoreError::Io {
            path: tmp_path.clone(),
            source: e,
        })?;

        let json = serde_json::to_string_pretty(commands).map_err(|e| CoreError::Json {
            path: self.path.clone(),
            source: e,
        })?;

        let mut file = file;
        file.write_all(json.as_bytes()).map_err(|e| CoreError::Io {
            path: tmp_path.clone(),
            source: e,
        })?;
        file.flush().map_err(|e| CoreError::Io {
            path: tmp_path.clone(),
            source: e,
        })?;
        file.sync_all().map_err(|e| CoreError::Io {
            path: tmp_path.clone(),
            source: e,
        })?;
        file.unlock().ok();
        drop(file);

        fs::rename(&tmp_path, &self.path).map_err(|e| CoreError::Io {
            path: self.path.clone(),
            source: e,
        })?;

        Ok(())
    }
}
