use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use mycli_core::{CommandStore, SavedCommand};
use ratatui::DefaultTerminal;

use crate::ui;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    List,
    Add,
    Edit,
    Confirm,
    Search,
    Params,
}

pub struct App {
    pub store: CommandStore,
    pub commands: Vec<SavedCommand>,
    /// Indices into `commands` that match the current filter, in display order.
    pub visible: Vec<usize>,
    /// Selection index into `visible` (not `commands`).
    pub selected: usize,
    pub mode: Mode,
    pub should_quit: bool,
    pub input_name: String,
    pub input_command: String,
    pub input_description: String,
    pub input_focus: usize, // 0=name, 1=command, 2=description
    pub editing_id: Option<String>,
    pub message: Option<String>,
    pub confirm_action: Option<ConfirmAction>,
    /// Live fuzzy filter query (matched against name/command/description).
    pub filter: String,
    /// Pending parameterized execution awaiting variable input.
    pub pending_exec: Option<PendingExec>,
}

#[derive(Debug, Clone)]
pub enum ConfirmAction {
    Delete(String),
}

/// A command awaiting `{{variable}}` substitution before it runs.
#[derive(Debug, Clone)]
pub struct PendingExec {
    pub name: String,
    pub template: String,
    /// (variable name, entered value) in first-seen order.
    pub params: Vec<(String, String)>,
    pub focus: usize,
}

impl App {
    pub fn new(store: CommandStore) -> Self {
        let commands = store.list().unwrap_or_default();
        let visible = (0..commands.len()).collect();
        Self {
            store,
            commands,
            visible,
            selected: 0,
            mode: Mode::List,
            should_quit: false,
            input_name: String::new(),
            input_command: String::new(),
            input_description: String::new(),
            input_focus: 0,
            editing_id: None,
            message: None,
            confirm_action: None,
            filter: String::new(),
            pending_exec: None,
        }
    }

    pub fn run(&mut self, terminal: &mut DefaultTerminal) -> color_eyre::Result<()> {
        while !self.should_quit {
            terminal.draw(|frame| ui::render(frame, self))?;
            self.handle_event()?;
        }
        Ok(())
    }

    fn refresh_commands(&mut self) {
        self.commands = self.store.list().unwrap_or_default();
        self.recompute_visible();
    }

    /// Recompute the filtered view and clamp the selection into range.
    fn recompute_visible(&mut self) {
        let query = self.filter.to_lowercase();
        self.visible = self
            .commands
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                if query.is_empty() {
                    return true;
                }
                let haystack =
                    format!("{} {} {}", c.name, c.command, c.description).to_lowercase();
                fuzzy_match(&haystack, &query)
            })
            .map(|(i, _)| i)
            .collect();

        if self.selected >= self.visible.len() {
            self.selected = self.visible.len().saturating_sub(1);
        }
    }

    /// The currently highlighted command, mapped through the filter.
    fn selected_command(&self) -> Option<&SavedCommand> {
        self.visible
            .get(self.selected)
            .and_then(|&i| self.commands.get(i))
    }

    fn clear_input(&mut self) {
        self.input_name.clear();
        self.input_command.clear();
        self.input_description.clear();
        self.input_focus = 0;
        self.editing_id = None;
    }

    fn handle_event(&mut self) -> color_eyre::Result<()> {
        if let Event::Key(key) = event::read()? {
            // Windows fires both Press and Release — only handle Press
            if key.kind != KeyEventKind::Press {
                return Ok(());
            }

            match self.mode {
                Mode::List => self.handle_list_keys(key.code),
                Mode::Add | Mode::Edit => self.handle_input_keys(key.code),
                Mode::Confirm => self.handle_confirm_keys(key.code),
                Mode::Search => self.handle_search_keys(key.code),
                Mode::Params => self.handle_params_keys(key.code),
            }
        }
        Ok(())
    }

    fn handle_list_keys(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Esc => {
                // Esc clears an active filter first; quits only when none.
                if self.filter.is_empty() {
                    self.should_quit = true;
                } else {
                    self.filter.clear();
                    self.recompute_visible();
                    self.message = Some("Filter cleared".to_string());
                }
            }
            KeyCode::Char('/') => {
                self.mode = Mode::Search;
                self.message = None;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.selected > 0 {
                    self.selected -= 1;
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.selected + 1 < self.visible.len() {
                    self.selected += 1;
                }
            }
            KeyCode::Char('a') => {
                self.clear_input();
                self.mode = Mode::Add;
                self.message = None;
            }
            KeyCode::Char('e') => {
                if let Some(cmd) = self.selected_command().cloned() {
                    self.input_name = cmd.name;
                    self.input_command = cmd.command;
                    self.input_description = cmd.description;
                    self.editing_id = Some(cmd.id);
                    self.input_focus = 0;
                    self.mode = Mode::Edit;
                    self.message = None;
                }
            }
            KeyCode::Char('d') => {
                if let Some(cmd) = self.selected_command().cloned() {
                    self.confirm_action = Some(ConfirmAction::Delete(cmd.id));
                    self.mode = Mode::Confirm;
                }
            }
            KeyCode::Char('c') => {
                if let Some(command) = self.selected_command().map(|c| c.command.clone()) {
                    self.message = Some(match copy_to_clipboard(&command) {
                        Ok(()) => format!("Copied: {}", command),
                        Err(e) => format!("Copy failed: {}", e),
                    });
                }
            }
            KeyCode::Enter => {
                if let Some(cmd) = self.selected_command().cloned() {
                    let template = cmd.command;
                    let name = cmd.name;
                    let params = extract_params(&template);
                    if params.is_empty() {
                        self.execute_command(&template, &name);
                    } else {
                        self.pending_exec = Some(PendingExec {
                            name,
                            template,
                            params: params.into_iter().map(|p| (p, String::new())).collect(),
                            focus: 0,
                        });
                        self.mode = Mode::Params;
                        self.message = None;
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_search_keys(&mut self, key: KeyCode) {
        match key {
            KeyCode::Esc => {
                self.filter.clear();
                self.recompute_visible();
                self.mode = Mode::List;
            }
            KeyCode::Enter => {
                // Keep the filter, return to list navigation.
                self.mode = Mode::List;
            }
            KeyCode::Up => {
                if self.selected > 0 {
                    self.selected -= 1;
                }
            }
            KeyCode::Down => {
                if self.selected + 1 < self.visible.len() {
                    self.selected += 1;
                }
            }
            KeyCode::Backspace => {
                self.filter.pop();
                self.selected = 0;
                self.recompute_visible();
            }
            KeyCode::Char(c) => {
                self.filter.push(c);
                self.selected = 0;
                self.recompute_visible();
            }
            _ => {}
        }
    }

    fn handle_params_keys(&mut self, key: KeyCode) {
        match key {
            KeyCode::Esc => {
                self.pending_exec = None;
                self.mode = Mode::List;
                self.message = Some("Cancelled".to_string());
            }
            KeyCode::Tab | KeyCode::Down => {
                if let Some(pe) = self.pending_exec.as_mut() {
                    let n = pe.params.len();
                    pe.focus = (pe.focus + 1) % n;
                }
            }
            KeyCode::BackTab | KeyCode::Up => {
                if let Some(pe) = self.pending_exec.as_mut() {
                    let n = pe.params.len();
                    pe.focus = if pe.focus == 0 { n - 1 } else { pe.focus - 1 };
                }
            }
            KeyCode::Backspace => {
                if let Some(pe) = self.pending_exec.as_mut() {
                    pe.params[pe.focus].1.pop();
                }
            }
            KeyCode::Char(c) => {
                if let Some(pe) = self.pending_exec.as_mut() {
                    pe.params[pe.focus].1.push(c);
                }
            }
            KeyCode::Enter => {
                // Advance through fields; execute once the last one is filled.
                let ready = match self.pending_exec.as_mut() {
                    Some(pe) if pe.focus + 1 < pe.params.len() => {
                        pe.focus += 1;
                        false
                    }
                    Some(_) => true,
                    None => false,
                };
                if ready && let Some(pe) = self.pending_exec.take() {
                    let command = substitute(&pe.template, &pe.params);
                    self.mode = Mode::List;
                    self.execute_command(&command, &pe.name);
                }
            }
            _ => {}
        }
    }

    /// Drop out of the TUI, run the command, wait, then restore the TUI.
    fn execute_command(&mut self, command_text: &str, name: &str) {
        ratatui::restore();
        println!(">>> Executing: {}", command_text);
        match mycli_core::executor::run(command_text) {
            Ok(output) => {
                if !output.stdout.is_empty() {
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                }
                if !output.stderr.is_empty() {
                    eprint!("{}", String::from_utf8_lossy(&output.stderr));
                }
            }
            Err(e) => eprintln!("Error: {}", e),
        }
        println!("\n--- Press Enter to return to Mymux ---");
        let _ = std::io::Read::read(&mut std::io::stdin(), &mut [0u8]);
        let _ = ratatui::init();
        self.message = Some(format!("Executed: {}", name));
    }

    fn handle_input_keys(&mut self, key: KeyCode) {
        match key {
            KeyCode::Esc => {
                self.clear_input();
                self.mode = Mode::List;
            }
            KeyCode::Tab => {
                self.input_focus = (self.input_focus + 1) % 3;
            }
            KeyCode::BackTab => {
                self.input_focus = if self.input_focus == 0 {
                    2
                } else {
                    self.input_focus - 1
                };
            }
            KeyCode::Backspace => {
                let field = self.current_field_mut();
                field.pop();
            }
            KeyCode::Enter => {
                if self.input_focus < 2 {
                    self.input_focus += 1;
                } else {
                    self.save_command();
                }
            }
            KeyCode::Char(c) => {
                let field = self.current_field_mut();
                field.push(c);
            }
            _ => {}
        }
    }

    fn handle_confirm_keys(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                if let Some(ConfirmAction::Delete(id)) = self.confirm_action.take() {
                    match self.store.remove(&id) {
                        Ok(()) => {
                            self.refresh_commands();
                            self.message = Some("Command deleted".to_string());
                        }
                        Err(e) => self.message = Some(format!("Error: {}", e)),
                    }
                }
                self.mode = Mode::List;
            }
            _ => {
                self.confirm_action = None;
                self.mode = Mode::List;
                self.message = Some("Cancelled".to_string());
            }
        }
    }

    fn current_field_mut(&mut self) -> &mut String {
        match self.input_focus {
            0 => &mut self.input_name,
            1 => &mut self.input_command,
            _ => &mut self.input_description,
        }
    }

    fn save_command(&mut self) {
        if self.input_name.trim().is_empty() || self.input_command.trim().is_empty() {
            self.message = Some("Name and command are required".to_string());
            return;
        }

        let was_edit = self.mode == Mode::Edit;
        let result = if let Some(id) = self.editing_id.take() {
            // Preserve fields the TUI edit form doesn't carry (favorite target, cwd, alias).
            let prev = self.commands.iter().find(|c| c.id == id);
            let cmd = SavedCommand {
                id: id.clone(),
                name: self.input_name.trim().to_string(),
                command: self.input_command.trim().to_string(),
                description: self.input_description.trim().to_string(),
                favorite: prev.map(|c| c.favorite).unwrap_or(false),
                favorite_target: prev
                    .map(|c| c.favorite_target.clone())
                    .unwrap_or_else(|| "shell".to_string()),
                cwd: prev.map(|c| c.cwd.clone()).unwrap_or_default(),
                alias: prev.map(|c| c.alias.clone()).unwrap_or_default(),
            };
            self.store.update(cmd)
        } else {
            let cmd = SavedCommand::new(
                self.input_name.trim().to_string(),
                self.input_command.trim().to_string(),
                self.input_description.trim().to_string(),
            );
            self.store.add(cmd)
        };

        match result {
            Ok(()) => {
                self.refresh_commands();
                self.message = Some(if was_edit {
                    "Command updated".to_string()
                } else {
                    "Command added".to_string()
                });
                self.clear_input();
                self.mode = Mode::List;
            }
            Err(e) => self.message = Some(format!("Error: {}", e)),
        }
    }
}

/// Case-insensitive subsequence match (fuzzy): every query char must appear in
/// `haystack` in order. Spaces in the query are ignored so multi-word queries
/// can span fields. Both arguments are expected to be lowercased already.
fn fuzzy_match(haystack: &str, query: &str) -> bool {
    let mut chars = haystack.chars();
    'outer: for qc in query.chars() {
        if qc == ' ' {
            continue;
        }
        for hc in chars.by_ref() {
            if hc == qc {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

/// Extract `{{variable}}` placeholder names in first-seen order, de-duplicated.
pub fn extract_params(template: &str) -> Vec<String> {
    let mut params: Vec<String> = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{'
            && bytes[i + 1] == b'{'
            && let Some(end) = template[i + 2..].find("}}")
        {
            let name = template[i + 2..i + 2 + end].trim().to_string();
            if !name.is_empty() && !params.contains(&name) {
                params.push(name);
            }
            i = i + 2 + end + 2;
            continue;
        }
        i += 1;
    }
    params
}

/// Replace each `{{name}}` placeholder with its entered value. Unmatched
/// placeholders are left untouched. Whitespace inside the braces is tolerated.
pub fn substitute(template: &str, params: &[(String, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < template.len() {
        if i + 1 < bytes.len()
            && bytes[i] == b'{'
            && bytes[i + 1] == b'{'
            && let Some(end) = template[i + 2..].find("}}")
        {
            let name = template[i + 2..i + 2 + end].trim();
            match params.iter().find(|(n, _)| n == name) {
                Some((_, value)) => out.push_str(value),
                None => out.push_str(&template[i..i + 2 + end + 2]),
            }
            i = i + 2 + end + 2;
            continue;
        }
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Best-effort clipboard copy across Windows/macOS/Linux.
fn copy_to_clipboard(text: &str) -> Result<(), arboard::Error> {
    let mut clipboard = arboard::Clipboard::new()?;
    clipboard.set_text(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_matches_subsequence() {
        assert!(fuzzy_match("git push origin", "gpush"));
        assert!(fuzzy_match("docker compose up", "dcu"));
        assert!(!fuzzy_match("git status", "xyz"));
    }

    #[test]
    fn fuzzy_ignores_query_spaces() {
        assert!(fuzzy_match("git push origin main", "push main"));
    }

    #[test]
    fn extract_params_ordered_and_deduped() {
        let params = extract_params("docker exec -it {{container}} {{shell}} {{container}}");
        assert_eq!(params, vec!["container".to_string(), "shell".to_string()]);
    }

    #[test]
    fn extract_params_trims_whitespace() {
        assert_eq!(extract_params("echo {{ name }}"), vec!["name".to_string()]);
    }

    #[test]
    fn extract_params_none_when_absent() {
        assert!(extract_params("ls -la").is_empty());
    }

    #[test]
    fn substitute_replaces_all_occurrences() {
        let params = vec![
            ("container".to_string(), "web".to_string()),
            ("shell".to_string(), "bash".to_string()),
        ];
        let out = substitute("docker exec -it {{container}} {{shell}} # {{container}}", &params);
        assert_eq!(out, "docker exec -it web bash # web");
    }

    #[test]
    fn substitute_tolerates_inner_whitespace() {
        let params = vec![("name".to_string(), "world".to_string())];
        assert_eq!(substitute("echo {{ name }}", &params), "echo world");
    }

    #[test]
    fn substitute_leaves_unknown_placeholder() {
        let params: Vec<(String, String)> = vec![];
        assert_eq!(substitute("echo {{x}}", &params), "echo {{x}}");
    }
}
