mod app;
mod ui;

use app::App;
use mycli_core::CommandStore;

fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let store = CommandStore::new()?;
    let mut app = App::new(store);

    let mut terminal = ratatui::init();
    let result = app.run(&mut terminal);
    ratatui::restore();

    result
}
