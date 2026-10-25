#[cfg(windows)]
mod audio_output;
mod discord_presence;
mod providers;

use discord_presence::{PresenceService, PresenceUpdate};
use providers::{ProviderConfigInput, ProviderSearchResult, ProviderStatus};
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

#[tauri::command]
fn provider_save_config(config: ProviderConfigInput) -> Result<(), String> {
    providers::save_config(config)
}

#[tauri::command]
fn provider_status() -> Result<Vec<ProviderStatus>, String> {
    providers::status()
}

#[tauri::command]
async fn provider_connect(app: tauri::AppHandle, provider: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || providers::connect(&app, &provider))
        .await
        .map_err(|error| format!("Could not finish provider sign-in: {error}"))?
}

#[tauri::command]
fn provider_disconnect(provider: String) -> Result<(), String> {
    providers::disconnect(&provider)
}

#[tauri::command]
async fn provider_search(provider: String, query: String, live_performances: bool) -> Result<Vec<ProviderSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || providers::search(&provider, &query, live_performances))
        .await
        .map_err(|error| format!("Search could not finish: {error}"))?
}

#[tauri::command]
fn open_provider_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    providers::open_provider_url(&app, &url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(PresenceService::new(app.handle().clone()));
            #[cfg(windows)]
            audio_output::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_output_monitor_supported,
            discord_presence_update,
            discord_presence_clear,
            provider_save_config,
            provider_status,
            provider_connect,
            provider_disconnect,
            provider_search,
            open_provider_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Viviette");
}
