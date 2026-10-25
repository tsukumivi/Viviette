//! Discord Rich Presence over Discord's local IPC connection.
//!
//! IPC work runs on one small worker thread so a missing Discord client can
//! never block playback or the Tauri command thread. Playback state and
//! metadata changes are event-driven; a low-frequency refresh checks for a
//! Discord restart while presence is active. Failed connections retry with
//! backoff.

use std::{
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

const STATUS_EVENT: &str = "discord-presence-status";
const CONNECTED_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdate {
    pub client_id: String,
    pub title: String,
    pub artist: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub playing: bool,
    pub artwork_url: Option<String>,
}

enum Message {
    Update(PresenceUpdate),
    Clear,
}

pub struct PresenceService {
    sender: Sender<Message>,
}

impl PresenceService {
    pub fn new(app: AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        let _ = thread::Builder::new()
            .name("viviette-discord-presence".into())
            .spawn(move || run_worker(app, receiver));
        Self { sender }
    }

    pub fn update(&self, update: PresenceUpdate) -> Result<(), String> {
        let client_id = update.client_id.trim();
        if !(5..=24).contains(&client_id.len()) || !client_id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("Enter the numeric Application ID from the Discord Developer Portal.".into());
        }
        if update.title.trim().is_empty() {
            return Err("A track title is required for Discord Rich Presence.".into());
        }
        self.sender
            .send(Message::Update(update))
            .map_err(|_| "The Discord Rich Presence worker is unavailable.".to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.sender
            .send(Message::Clear)
            .map_err(|_| "The Discord Rich Presence worker is unavailable.".to_string())
    }
}

fn run_worker(app: AppHandle, receiver: mpsc::Receiver<Message>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut active_update: Option<PresenceUpdate> = None;
    let mut update_received_at = Instant::now();
    let mut retry_delay = Duration::from_secs(1);
    let mut connected_status = None;

    loop {
        let wait = if active_update.is_some() {
            if client.is_some() { CONNECTED_REFRESH_INTERVAL } else { retry_delay }
        } else {
            Duration::from_secs(24 * 60 * 60)
        };

        match receiver.recv_timeout(wait) {
            Ok(Message::Update(update)) => {
                active_update = Some(update);
                update_received_at = Instant::now();
                retry_delay = Duration::from_secs(1);
                if let Some(update) = active_update.as_ref() {
                    if publish(&mut client, update).is_ok() {
                        emit_connection_status(&app, &mut connected_status, true);
                    } else {
                        emit_connection_status(&app, &mut connected_status, false);
                        retry_delay = retry_delay.saturating_mul(2).min(Duration::from_secs(60));
                    }
                }
            }
            Ok(Message::Clear) => {
                active_update = None;
                if let Some(mut connected) = client.take() {
                    let _ = connected.clear_activity();
                    let _ = connected.close();
                }
                retry_delay = Duration::from_secs(1);
                connected_status = None;
                emit_status(&app, "Rich Presence is off.");
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(update) = active_update.as_ref() {
                    let current = current_update(update, update_received_at.elapsed());
                    if publish(&mut client, &current).is_ok() {
                        emit_connection_status(&app, &mut connected_status, true);
                        retry_delay = Duration::from_secs(1);
                    } else {
                        emit_connection_status(&app, &mut connected_status, false);
                        retry_delay = retry_delay.saturating_mul(2).min(Duration::from_secs(60));
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(mut connected) = client.take() {
                    let _ = connected.clear_activity();
                    let _ = connected.close();
                }
                break;
            }
        }
    }
}

fn current_update(update: &PresenceUpdate, elapsed: Duration) -> PresenceUpdate {
    let mut current = update.clone();
    if current.playing {
        current.position_seconds += elapsed.as_secs_f64();
        if current.duration_seconds.is_finite() && current.duration_seconds > 0.0 {
            current.position_seconds = current.position_seconds.min(current.duration_seconds);
        }
    }
    current
}

fn publish(client: &mut Option<DiscordIpcClient>, update: &PresenceUpdate) -> Result<(), ()> {
    if client.as_ref().is_some_and(|connected| connected.client_id != update.client_id) {
        if let Some(mut old) = client.take() {
            let _ = old.clear_activity();
            let _ = old.close();
        }
    }

    if client.is_none() {
        let mut next = DiscordIpcClient::new(update.client_id.trim());
        next.connect().map_err(|_| ())?;
        *client = Some(next);
    }

    let title = clip_text(&update.title, 120);
    let artist = clip_text(&update.artist, 120);
    let position = finite_seconds(update.position_seconds);
    let duration = finite_seconds(update.duration_seconds);
    let state = if update.playing {
        artist
    } else {
        format!("{} · Paused · {}", artist, format_position(position))
    };

    let mut activity = Activity::new()
        .name("Viviette")
        .activity_type(ActivityType::Listening)
        .details(title)
        .state(state);

    if update.playing {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let position_ms = position.saturating_mul(1_000).min(i64::MAX as u64) as i64;
        let duration_ms = duration.saturating_mul(1_000).min(i64::MAX as u64) as i64;
        let start = now.saturating_sub(position_ms);
        let timestamps = if duration > 0 {
            Timestamps::new().start(start).end(start.saturating_add(duration_ms))
        } else {
            Timestamps::new().start(start)
        };
        activity = activity.timestamps(timestamps);
    }

    if let Some(url) = update.artwork_url.as_deref().filter(|url| url.starts_with("https://") && url.len() <= 2048) {
        activity = activity.assets(Assets::new().large_image(url).large_text(format!("{} · {}", update.title, update.artist)));
    }

    match client.as_mut().expect("client was just connected").set_activity(activity) {
        Ok(()) => Ok(()),
        Err(_) => {
            if let Some(mut disconnected) = client.take() {
                let _ = disconnected.close();
            }
            Err(())
        }
    }
}

fn emit_status(app: &AppHandle, message: &str) {
    let _ = app.emit(STATUS_EVENT, message.to_string());
}

fn emit_connection_status(app: &AppHandle, previous: &mut Option<bool>, connected: bool) {
    if *previous == Some(connected) {
        return;
    }
    *previous = Some(connected);
    emit_status(app, if connected { "Connected to Discord." } else { "Discord is unavailable. Retrying in the background." });
}

fn finite_seconds(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.min(u64::MAX as f64).round() as u64
    } else {
        0
    }
}

fn format_position(seconds: u64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

fn clip_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
