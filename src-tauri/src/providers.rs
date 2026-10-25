//! Provider search and OAuth live in the native process. Provider passwords are
//! entered only on provider websites; tokens and app credentials are kept in the
//! operating-system credential store.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use keyring::Entry;
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "app.viviette.providers";
const OAUTH_PORT: u16 = 47619;
const OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:47619/callback";
const SOUNDCLOUD_REDIRECT_URI: &str = "viviette://soundcloud/callback";
static SOUNDCLOUD_CALLBACK: OnceLock<Mutex<Option<mpsc::Sender<String>>>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    provider: String,
    configured: bool,
    connectable: bool,
    connected: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSearchResult {
    provider: String,
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    duration_seconds: Option<u64>,
    artwork_url: Option<String>,
    external_url: String,
    embed_url: Option<String>,
    explicit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn valid_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "youtube" => Ok("youtube"),
        "soundcloud" => Ok("soundcloud"),
        "spotify" => Ok("spotify"),
        _ => Err("Unknown music provider.".to_string()),
    }
}

fn credential(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key)
        .map_err(|error| format!("Could not access the system credential store: {error}"))
}

fn read_secret(key: &str) -> Result<Option<String>, String> {
    match credential(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read a saved provider setting: {error}")),
    }
}

fn write_secret(key: &str, value: &str) -> Result<(), String> {
    credential(key)?.set_password(value).map_err(|error| {
        format!("Could not save a provider setting to the system credential store: {error}")
    })
}

fn remove_secret(key: &str) -> Result<(), String> {
    match credential(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove a provider credential: {error}")),
    }
}

fn config_value(provider: &str, field: &str) -> Result<String, String> {
    let build_value = match (provider, field) {
        ("youtube", "client_id") => option_env!("VIVIETTE_YOUTUBE_CLIENT_ID"),
        ("youtube", "client_secret") => option_env!("VIVIETTE_YOUTUBE_CLIENT_SECRET"),
        ("soundcloud", "client_id") => option_env!("VIVIETTE_SOUNDCLOUD_CLIENT_ID"),
        ("spotify", "client_id") => option_env!("VIVIETTE_SPOTIFY_CLIENT_ID"),
        _ => None,
    };
    if let Some(value) = build_value.filter(|value| !value.is_empty()) {
        return Ok(value.to_string());
    }
    Ok(read_secret(&format!("{provider}.{field}"))?.unwrap_or_default())
}

pub fn status() -> Result<Vec<ProviderStatus>, String> {
    let mut results = Vec::new();
    for provider in ["youtube", "soundcloud", "spotify"] {
        let connected = read_secret(&format!("{provider}.user_token"))?.is_some();
        let (configured, connectable, detail) = match provider {
            "youtube" => {
                let has_oauth = !config_value(provider, "client_id")?.is_empty();
                (
                    has_oauth,
                    has_oauth,
                    if connected {
                        "Google account connected".to_string()
                    } else if has_oauth {
                        "Log in with Google to search YouTube".to_string()
                    } else {
                        "YouTube sign-in is not configured for this build".to_string()
                    },
                )
            }
            "soundcloud" => {
                let configured = !config_value(provider, "client_id")?.is_empty()
                    && !config_value(provider, "client_secret")?.is_empty();
                (
                    configured,
                    configured,
                    if connected {
                        "SoundCloud account connected".to_string()
                    } else if configured {
                        "Log in to SoundCloud to search tracks".to_string()
                    } else {
                        "SoundCloud sign-in is not configured for this build".to_string()
                    },
                )
            }
            "spotify" => {
                let configured = !config_value(provider, "client_id")?.is_empty();
                (
                    configured,
                    configured,
                    if connected {
                        "Spotify account connected".to_string()
                    } else if configured {
                        "Log in to Spotify to search its catalog".to_string()
                    } else {
                        "Spotify sign-in is not configured for this build".to_string()
                    },
                )
            }
            _ => (false, false, "Unknown provider".to_string()),
        };
        results.push(ProviderStatus {
            provider: provider.to_string(),
            configured,
            connectable,
            connected,
            detail,
        });
    }
    Ok(results)
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Viviette/0.1.6 provider integration")
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|error| format!("Could not initialize provider networking: {error}"))
}

fn oauth_url(
    provider: &str,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let base = match provider {
        "youtube" => "https://accounts.google.com/o/oauth2/v2/auth",
        "soundcloud" => "https://secure.soundcloud.com/authorize",
        "spotify" => "https://accounts.spotify.com/authorize",
        _ => return Err("Unknown music provider.".to_string()),
    };
    let mut url = Url::parse(base).map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("state", state)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", challenge);
        match provider {
            "youtube" => {
                query
                    .append_pair("scope", "https://www.googleapis.com/auth/youtube.readonly")
                    .append_pair("access_type", "offline")
                    .append_pair("prompt", "select_account");
            }
            _ => {}
        }
    }
    Ok(url.into())
}

fn random_verifier() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn callback_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the local sign-in callback: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Some(code) = read_callback(&mut stream, expected_state)? {
                    return Ok(code);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(error) => {
                return Err(format!(
                    "Could not receive the provider sign-in response: {error}"
                ))
            }
        }
    }
    Err("Provider sign-in timed out. Try connecting again.".to_string())
}

fn respond_to_browser(stream: &mut TcpStream, title: &str, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>body{{font:16px Segoe UI,sans-serif;background:#111217;color:#eee;display:grid;place-items:center;height:90vh}}main{{max-width:520px;padding:30px;border:1px solid #333;border-radius:16px;background:#1b1c23}}p{{color:#bbb}}</style></head><body><main><h2>{title}</h2><p>{message}</p><p>You can return to Viviette.</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn read_callback(stream: &mut TcpStream, expected_state: &str) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];
    let length = stream
        .read(&mut buffer)
        .map_err(|error| format!("Could not read the provider sign-in response: {error}"))?;
    let request = String::from_utf8_lossy(&buffer[..length]);
    let Some(target) = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
    else {
        return Ok(None);
    };
    let callback = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|error| format!("Provider returned an invalid sign-in response: {error}"))?;
    if callback.path() != "/callback" {
        respond_to_browser(
            stream,
            "Return to Viviette",
            "This local address is only used to complete provider sign-in.",
        );
        return Ok(None);
    }
    let query: std::collections::HashMap<String, String> =
        callback.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(expected_state) {
        respond_to_browser(
            stream,
            "Sign-in did not match",
            "For your security, this sign-in response was rejected.",
        );
        return Ok(None);
    }
    if let Some(error) = query.get("error") {
        respond_to_browser(
            stream,
            "Sign-in cancelled",
            "The provider declined or cancelled the authorization request.",
        );
        return Err(format!("Provider sign-in failed: {error}"));
    }
    let Some(code) = query.get("code") else {
        respond_to_browser(
            stream,
            "Sign-in incomplete",
            "The provider did not return an authorization code.",
        );
        return Err("Provider did not return an authorization code.".to_string());
    };
    respond_to_browser(
        stream,
        "Sign-in complete",
        "Your account was connected securely.",
    );
    Ok(Some(code.clone()))
}

fn exchange_code(
    provider: &str,
    code: &str,
    verifier: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<OAuthToken, String> {
    let endpoint = match provider {
        "youtube" => "https://oauth2.googleapis.com/token",
        "soundcloud" => "https://secure.soundcloud.com/oauth/token",
        "spotify" => "https://accounts.spotify.com/api/token",
        _ => return Err("Unknown music provider.".to_string()),
    };
    let mut fields = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
    ];
    if !client_secret.is_empty() {
        fields.push(("client_secret", client_secret.to_string()));
    }
    let response = http_client()?
        .post(endpoint)
        .form(&fields)
        .send()
        .map_err(|error| format!("Could not exchange the provider sign-in code: {error}"))?;
    parse_token_response(response)
}

fn parse_token_response(response: Response) -> Result<OAuthToken, String> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Could not read the provider token response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Provider authorization failed ({status}). The provider app may need configuration or approval."));
    }
    let token: TokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Provider returned an unreadable token response: {error}"))?;
    Ok(OAuthToken {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: now_seconds().saturating_add(token.expires_in.unwrap_or(3600)),
    })
}

fn clear_soundcloud_callback() {
    if let Some(callback) = SOUNDCLOUD_CALLBACK.get() {
        if let Ok(mut callback) = callback.lock() {
            *callback = None;
        }
    }
}

fn wait_for_soundcloud_callback(
    app: &tauri::AppHandle,
    auth_url: &str,
    expected_state: &str,
) -> Result<String, String> {
    let callback = SOUNDCLOUD_CALLBACK.get_or_init(|| Mutex::new(None));
    let (sender, receiver) = mpsc::channel();
    {
        let mut active = callback
            .lock()
            .map_err(|_| "SoundCloud sign-in could not start.".to_string())?;
        if active.is_some() {
            return Err("A provider sign-in is already in progress.".to_string());
        }
        *active = Some(sender);
    }
    if let Err(error) = app.opener().open_url(auth_url, None::<&str>) {
        clear_soundcloud_callback();
        return Err(format!("Could not open the provider sign-in page: {error}"));
    }
    let callback_url = match receiver.recv_timeout(Duration::from_secs(180)) {
        Ok(url) => url,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            clear_soundcloud_callback();
            return Err("SoundCloud sign-in timed out. Try connecting again.".to_string());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            clear_soundcloud_callback();
            return Err("SoundCloud sign-in was interrupted. Try again.".to_string());
        }
    };
    clear_soundcloud_callback();
    let callback = Url::parse(&callback_url)
        .map_err(|_| "SoundCloud returned an invalid sign-in link.".to_string())?;
    if callback.scheme() != "viviette"
        || callback.host_str() != Some("soundcloud")
        || callback.path() != "/callback"
    {
        return Err("SoundCloud returned an unexpected sign-in link.".to_string());
    }
    let query: std::collections::HashMap<String, String> =
        callback.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(expected_state) {
        return Err("For your security, the SoundCloud sign-in response was rejected.".to_string());
    }
    if let Some(error) = query.get("error") {
        return Err(format!("SoundCloud sign-in failed: {error}"));
    }
    query
        .get("code")
        .cloned()
        .ok_or_else(|| "SoundCloud did not return an authorization code.".to_string())
}

pub fn receive_deep_link(url: Url) {
    if url.scheme() != "viviette"
        || url.host_str() != Some("soundcloud")
        || url.path() != "/callback"
    {
        return;
    }
    if let Some(callback) = SOUNDCLOUD_CALLBACK.get() {
        if let Ok(active) = callback.lock() {
            if let Some(sender) = active.as_ref() {
                let _ = sender.send(url.to_string());
            }
        }
    }
}

pub fn connect(app: &tauri::AppHandle, provider: &str) -> Result<String, String> {
    let provider = valid_provider(provider)?;
    let client_id = config_value(provider, "client_id")?;
    let client_secret = config_value(provider, "client_secret")?;
    if client_id.is_empty() {
        return Err(format!(
            "{provider} sign-in is not configured for this build. Please try another provider."
        ));
    }
    if client_secret.is_empty() && provider == "soundcloud" {
        return Err(
            "SoundCloud sign-in is not configured for this build. Please try another provider."
                .to_string(),
        );
    }
    let redirect_uri = if provider == "soundcloud" {
        SOUNDCLOUD_REDIRECT_URI
    } else {
        OAUTH_REDIRECT_URI
    };
    let listener = if provider == "soundcloud" {
        None
    } else {
        Some(
            TcpListener::bind(("127.0.0.1", OAUTH_PORT)).map_err(|error| {
                format!("Could not start the local sign-in callback on port {OAUTH_PORT}: {error}")
            })?,
        )
    };
    let state = Uuid::new_v4().simple().to_string();
    let verifier = random_verifier();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = oauth_url(provider, &client_id, redirect_uri, &challenge, &state)?;
    let code = if provider == "soundcloud" {
        wait_for_soundcloud_callback(app, &url, &state)?
    } else {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|error| format!("Could not open the provider sign-in page: {error}"))?;
        callback_code(
            listener
                .as_ref()
                .expect("loopback listener for Google/Spotify"),
            &state,
        )?
    };
    let token = exchange_code(
        provider,
        &code,
        &verifier,
        &client_id,
        &client_secret,
        redirect_uri,
    )?;
    write_secret(
        &format!("{provider}.user_token"),
        &serde_json::to_string(&token).map_err(|error| error.to_string())?,
    )?;
    Ok(match provider {
        "youtube" => "Google account connected. YouTube search is ready.".to_string(),
        "soundcloud" => "SoundCloud account connected.".to_string(),
        "spotify" => {
            "Spotify account connected. Spotify catalog search and playback stay on Spotify."
                .to_string()
        }
        _ => "Account connected.".to_string(),
    })
}

pub fn disconnect(provider: &str) -> Result<(), String> {
    let provider = valid_provider(provider)?;
    remove_secret(&format!("{provider}.user_token"))?;
    Ok(())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn load_user_token(provider: &str) -> Result<Option<OAuthToken>, String> {
    read_secret(&format!("{provider}.user_token"))?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| format!("Saved provider token is invalid: {error}"))
        })
        .transpose()
}

fn refresh_token(
    provider: &str,
    token_key: &str,
    previous: &OAuthToken,
) -> Result<OAuthToken, String> {
    let refresh = previous
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Your provider session expired. Connect the account again.".to_string())?;
    let client_id = config_value(provider, "client_id")?;
    let client_secret = config_value(provider, "client_secret")?;
    let endpoint = match provider {
        "youtube" => "https://oauth2.googleapis.com/token",
        "soundcloud" => "https://secure.soundcloud.com/oauth/token",
        "spotify" => "https://accounts.spotify.com/api/token",
        _ => return Err("Unknown music provider.".to_string()),
    };
    let mut fields = vec![
        ("grant_type", "refresh_token".to_string()),
        ("client_id", client_id),
        ("refresh_token", refresh.to_string()),
    ];
    if !client_secret.is_empty() {
        fields.push(("client_secret", client_secret));
    }
    let mut next = parse_token_response(
        http_client()?
            .post(endpoint)
            .form(&fields)
            .send()
            .map_err(|error| format!("Could not refresh provider authorization: {error}"))?,
    )?;
    if next.refresh_token.is_none() {
        next.refresh_token = previous.refresh_token.clone();
    }
    write_secret(
        token_key,
        &serde_json::to_string(&next).map_err(|error| error.to_string())?,
    )?;
    Ok(next)
}

fn current_user_access_token(provider: &str) -> Result<String, String> {
    let token = load_user_token(provider)?
        .ok_or_else(|| format!("Connect your {provider} account before searching this catalog."))?;
    let token = if token.expires_at <= now_seconds().saturating_add(60) {
        refresh_token(provider, &format!("{provider}.user_token"), &token)?
    } else {
        token
    };
    Ok(token.access_token)
}

fn response_json(response: Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Could not read provider results: {error}"))?;
    if !status.is_success() {
        let message = if status.as_u16() == 429 {
            "The provider search limit was reached. Wait a little and try again.".to_string()
        } else {
            format!("Provider search failed ({status}). Reconnect your account or try again later.")
        };
        return Err(message);
    }
    serde_json::from_str(&body)
        .map_err(|error| format!("Provider returned invalid search results: {error}"))
}

fn text_at(value: &Value, path: &str) -> Option<String> {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn query_for(query: &str, live: bool) -> String {
    if live {
        format!("{} live concert performance", query.trim())
    } else {
        query.trim().to_string()
    }
}

fn search_youtube(query: &str, live: bool) -> Result<Vec<ProviderSearchResult>, String> {
    let token = current_user_access_token("youtube")?;
    let response = http_client()?
        .get("https://www.googleapis.com/youtube/v3/search")
        .query(&[
            ("part", "snippet"),
            ("type", "video"),
            ("videoEmbeddable", "true"),
            ("maxResults", "20"),
            ("q", query_for(query, live).as_str()),
        ])
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Could not search YouTube: {error}"))?;
    let data = response_json(response)?;
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "YouTube returned no searchable videos.".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let id = text_at(item, "/id/videoId")?;
            let title = text_at(item, "/snippet/title")?;
            let artist = text_at(item, "/snippet/channelTitle")
                .unwrap_or_else(|| "YouTube channel".to_string());
            let artwork_url = text_at(item, "/snippet/thumbnails/high/url")
                .or_else(|| text_at(item, "/snippet/thumbnails/medium/url"));
            Some(ProviderSearchResult {
                provider: "youtube".to_string(),
                id: id.clone(),
                title,
                artist,
                album: None,
                duration_seconds: None,
                artwork_url,
                external_url: format!("https://www.youtube.com/watch?v={id}"),
                embed_url: Some(format!(
                    "https://www.youtube-nocookie.com/embed/{id}?playsinline=1"
                )),
                explicit: None,
            })
        })
        .collect())
}

fn search_soundcloud(query: &str, live: bool) -> Result<Vec<ProviderSearchResult>, String> {
    let token = current_user_access_token("soundcloud")?;
    let response = http_client()?
        .get("https://api.soundcloud.com/tracks")
        .header("Authorization", format!("OAuth {token}"))
        .query(&[
            ("q", query_for(query, live)),
            ("access", "playable".to_string()),
            ("limit", "20".to_string()),
            ("linked_partitioning", "true".to_string()),
        ])
        .send()
        .map_err(|error| format!("Could not search SoundCloud: {error}"))?;
    let data = response_json(response)?;
    let items = data
        .as_array()
        .or_else(|| data.get("collection").and_then(Value::as_array))
        .ok_or_else(|| "SoundCloud returned no track results.".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string())
            })?;
            let title = text_at(item, "/title")?;
            let artist =
                text_at(item, "/user/username").unwrap_or_else(|| "SoundCloud artist".to_string());
            let external_url = text_at(item, "/permalink_url")?;
            Some(ProviderSearchResult {
                provider: "soundcloud".to_string(),
                id,
                title,
                artist,
                album: None,
                duration_seconds: item
                    .get("duration")
                    .and_then(Value::as_u64)
                    .map(|value| value / 1000),
                artwork_url: text_at(item, "/artwork_url"),
                external_url,
                embed_url: None,
                explicit: None,
            })
        })
        .collect())
}

pub fn search(
    provider: &str,
    query: &str,
    live: bool,
) -> Result<Vec<ProviderSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    match valid_provider(provider)? {
        "youtube" => search_youtube(query, live),
        "soundcloud" => search_soundcloud(query, live),
        "spotify" => Err("Spotify catalog search is handled on Spotify.".to_string()),
        _ => Err("Unknown music provider.".to_string()),
    }
}

pub fn open_provider_url(app: &tauri::AppHandle, raw_url: &str) -> Result<(), String> {
    let url = Url::parse(raw_url).map_err(|_| "This provider link is invalid.".to_string())?;
    let host = url.host_str().unwrap_or_default();
    let allowed = [
        "youtube.com",
        "youtube-nocookie.com",
        "youtu.be",
        "soundcloud.com",
        "spotify.com",
        "google.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if url.scheme() != "https" || !allowed {
        return Err("Viviette can only open verified music provider links.".to_string());
    }
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the provider link: {error}"))
}
