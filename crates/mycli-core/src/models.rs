use serde::{Deserialize, Serialize};

fn default_favorite_target() -> String {
    "shell".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    /// Pinned to the top of the list. `serde(default)` keeps older
    /// commands.json files (without this field) loadable.
    #[serde(default)]
    pub favorite: bool,
    /// Where a favorite shortcut is available. Older command files predate
    /// this field, so keep them as shell shortcuts by default.
    #[serde(default = "default_favorite_target")]
    pub favorite_target: String,
    /// Directory to run the command in (empty = wherever the shell is).
    #[serde(default)]
    pub cwd: String,
    /// Short abbreviation typed at a prompt to expand/run this command.
    #[serde(default)]
    pub alias: String,
}

impl SavedCommand {
    pub fn new(name: String, command: String, description: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            command,
            description,
            favorite: false,
            favorite_target: default_favorite_target(),
            cwd: String::new(),
            alias: String::new(),
        }
    }
}
