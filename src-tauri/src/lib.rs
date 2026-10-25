#[cfg(windows)]
mod audio_output;
mod discord_presence;

use discord_presence::{PresenceService, PresenceUpdate};
use tauri::{Manager, State};

#[tauri::command]
fn audio_output_monitor_supported() -> bool {
    cfg!(windows)
}

#[tauri::command]
fn discord_presence_update(update: PresenceUpdate, presence: State<'_, PresenceService>) -> Result<(), String> {
    presence.update(update)
}

#[tauri::command]
fn discord_presence_clear(presence: State<'_, PresenceService>) -> Result<(), String> {
    presence.clear()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(PresenceService::new(app.handle().clone()));
            #[cfg(windows)]
            audio_output::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_output_monitor_supported,
            discord_presence_update,
            discord_presence_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running Viviette");
}
