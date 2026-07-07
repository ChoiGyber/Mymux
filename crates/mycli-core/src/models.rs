use serde::{Deserialize, Serialize};

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
            cwd: String::new(),
            alias: String::new(),
        }
    }
}
