use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::app::{substitute, App, Mode};

pub fn render(frame: &mut Frame, app: &App) {
    // Show a dedicated search row while searching or whenever a filter is set.
    let show_search = app.mode == Mode::Search || !app.filter.is_empty();

    let mut constraints = vec![Constraint::Length(3)]; // header
    if show_search {
        constraints.push(Constraint::Length(1)); // search bar
    }
    constraints.push(Constraint::Min(5)); // command list
    constraints.push(Constraint::Length(3)); // status/help bar

    let chunks = Layout::vertical(constraints).split(frame.area());

    let mut idx = 0;
    render_header(frame, chunks[idx]);
    idx += 1;
    if show_search {
        render_search_bar(frame, chunks[idx], app);
        idx += 1;
    }
    render_command_list(frame, chunks[idx], app);
    idx += 1;
    render_status_bar(frame, chunks[idx], app);

    // Overlays
    if app.mode == Mode::Add || app.mode == Mode::Edit {
        render_input_popup(frame, app);
    }
    if app.mode == Mode::Confirm {
        render_confirm_popup(frame, app);
    }
    if app.mode == Mode::Params {
        render_params_popup(frame, app);
    }
}

fn render_header(frame: &mut Frame, area: Rect) {
    let title = Paragraph::new(" Mymux — Command Manager")
        .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(title, area);
}

fn render_search_bar(frame: &mut Frame, area: Rect, app: &App) {
    let cursor = if app.mode == Mode::Search { "▎" } else { "" };
    let line = Line::from(vec![
        Span::styled(
            " Search: ",
            Style::default()
                .fg(Color::Magenta)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(&app.filter, Style::default().fg(Color::White)),
        Span::styled(cursor, Style::default().fg(Color::Magenta)),
        Span::styled(
            format!("   ({} match{})", app.visible.len(), if app.visible.len() == 1 { "" } else { "es" }),
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn render_command_list(frame: &mut Frame, area: Rect, app: &App) {
    if app.visible.is_empty() {
        let text = if app.filter.is_empty() {
            "  No commands saved. Press 'a' to add one."
        } else {
            "  No matches. Press Esc to clear the search."
        };
        let empty = Paragraph::new(text)
            .style(Style::default().fg(Color::DarkGray))
            .block(Block::default().title(" Commands ").borders(Borders::ALL));
        frame.render_widget(empty, area);
        return;
    }

    let items: Vec<ListItem> = app
        .visible
        .iter()
        .enumerate()
        .map(|(row, &ci)| {
            let cmd = &app.commands[ci];
            let is_selected = row == app.selected;
            let marker = if is_selected { "▸ " } else { "  " };

            let name_style = if is_selected {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::White)
            };
            let cmd_style = Style::default().fg(Color::Green);
            let desc_style = Style::default().fg(Color::DarkGray);

            let line = Line::from(vec![
                Span::raw(marker),
                Span::styled(&cmd.name, name_style),
                Span::raw("  "),
                Span::styled(&cmd.command, cmd_style),
                Span::raw("  "),
                Span::styled(&cmd.description, desc_style),
            ]);

            ListItem::new(line)
        })
        .collect();

    let list = List::new(items)
        .block(Block::default().title(" Commands ").borders(Borders::ALL));
    frame.render_widget(list, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let help = match app.mode {
        Mode::List => " a:Add  e:Edit  d:Delete  c:Copy  /:Search  Enter:Run  q:Quit",
        Mode::Add | Mode::Edit => " Tab:Next field  Enter:Save/Next  Esc:Cancel",
        Mode::Confirm => " y:Confirm  any:Cancel",
        Mode::Search => " Type to filter  ↑↓:Move  Enter:Done  Esc:Clear",
        Mode::Params => " Tab/↑↓:Field  Enter:Next/Run  Esc:Cancel",
    };

    let msg = app.message.as_deref().unwrap_or("");

    let status = Line::from(vec![
        Span::styled(help, Style::default().fg(Color::DarkGray)),
        Span::raw("  "),
        Span::styled(msg, Style::default().fg(Color::Yellow)),
    ]);

    let bar = Paragraph::new(status).block(Block::default().borders(Borders::TOP));
    frame.render_widget(bar, area);
}

fn render_input_popup(frame: &mut Frame, app: &App) {
    let area = centered_rect(60, 12, frame.area());
    frame.render_widget(Clear, area);

    let title = if app.mode == Mode::Add {
        " Add Command "
    } else {
        " Edit Command "
    };

    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let fields = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(2),
        Constraint::Length(2),
    ])
    .split(inner);

    let focus = app.input_focus;

    render_field(frame, fields[0], "Name", &app.input_name, focus == 0);
    render_field(frame, fields[1], "Command", &app.input_command, focus == 1);
    render_field(
        frame,
        fields[2],
        "Description",
        &app.input_description,
        focus == 2,
    );
}

fn render_field(frame: &mut Frame, area: Rect, label: &str, value: &str, focused: bool) {
    let style = if focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::White)
    };

    let cursor = if focused { "▎" } else { "" };

    let text = Line::from(vec![
        Span::styled(format!(" {}: ", label), Style::default().fg(Color::DarkGray)),
        Span::styled(value, style),
        Span::styled(cursor, Style::default().fg(Color::Cyan)),
    ]);

    frame.render_widget(Paragraph::new(text), area);
}

fn render_confirm_popup(frame: &mut Frame, app: &App) {
    let area = centered_rect(40, 5, frame.area());
    frame.render_widget(Clear, area);

    let msg = if let Some(crate::app::ConfirmAction::Delete(ref id)) = app.confirm_action {
        let name = app
            .commands
            .iter()
            .find(|c| c.id == *id)
            .map(|c| c.name.as_str())
            .unwrap_or("?");
        format!("Delete '{}'? (y/n)", name)
    } else {
        "Confirm? (y/n)".to_string()
    };

    let popup = Paragraph::new(msg)
        .style(Style::default().fg(Color::Red))
        .block(Block::default().title(" Confirm ").borders(Borders::ALL));
    frame.render_widget(popup, area);
}

fn render_params_popup(frame: &mut Frame, app: &App) {
    let Some(pe) = app.pending_exec.as_ref() else {
        return;
    };

    // title border (2) + preview (2) + one row per param (2 each)
    let height = (pe.params.len() as u16) * 2 + 4;
    let area = centered_rect(70, height, frame.area());
    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(format!(" Parameters — {} ", pe.name))
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut constraints = vec![Constraint::Length(2)]; // preview line
    for _ in &pe.params {
        constraints.push(Constraint::Length(2));
    }
    let rows = Layout::vertical(constraints).split(inner);

    // Live preview of the substituted command.
    let preview = substitute(&pe.template, &pe.params);
    let preview_line = Line::from(vec![
        Span::styled(" → ", Style::default().fg(Color::DarkGray)),
        Span::styled(preview, Style::default().fg(Color::Green)),
    ]);
    frame.render_widget(Paragraph::new(preview_line), rows[0]);

    for (i, (name, value)) in pe.params.iter().enumerate() {
        render_field(frame, rows[i + 1], name, value, i == pe.focus);
    }
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let width = area.width * percent_x / 100;
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    Rect::new(x, y, width, height.min(area.height))
}
