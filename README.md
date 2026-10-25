# Viviette

Viviette is a compact Windows-first music player built with Tauri 2, Rust, TypeScript, and Vite. The interface uses a Riff-inspired density and a Spotify-like navigation pattern while keeping the player and library code independent from any streaming provider.

## Install

Download and launch the latest Windows installer from PowerShell with:

```powershell
$ProgressPreference = 'SilentlyContinue'; $base = 'https://github.com/tsukumivi/Viviette/releases/latest/download'; $installer = Join-Path $env:TEMP 'Viviette-Setup.exe'; $sums = Join-Path $env:TEMP 'Viviette-SHA256SUMS.txt'; Invoke-WebRequest "$base/Viviette-Setup.exe" -OutFile $installer; Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile $sums; $expected = (Get-Content $sums).Split(' ')[0]; if ((Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant() -ne $expected) { throw 'Viviette installer checksum validation failed.' }; Start-Process -FilePath $installer
```

The NSIS installer is configured for the current Windows user and does not ask for administrator access. The release also includes a SHA-256 checksum file. You can also download `Viviette-Setup.exe` from the [GitHub Releases page](https://github.com/tsukumivi/Viviette/releases).

## Working in this checkout

- Compact Riff-inspired left rail with Discover, Liked Songs, and Settings; a persistent search field and YouTube, SoundCloud, Live Performances, and Spotify source selector sit beside it.
- Responsive dark interface and compact pinned playback bar. The Settings page uses a compact section rail and grouped rows for the integrations and playback controls that exist today.
- Import local audio into an IndexedDB library. Likes and playlist track references persist locally; duplicate playlist entries are prevented.
- Play, pause, seek, volume, shuffle, previous/next, and repeat off / queue / current track are wired to local playback. Repeat is free.
- The bottom-left controls provide like, playlist, and download actions. Download feedback explains that Viviette will export MP3 only when a connected source explicitly authorizes it.
- Windows Core Audio endpoint notifications can pause the active playback adapter when the default headset or output is removed. Notifications are event-driven; there is no output polling loop.
- Discord Rich Presence uses a Rust IPC worker. Playback state changes send immediately on track, play/pause, and seek; a low-frequency refresh checks for Discord restarts while presence is active. When paused, it removes the running timestamp and displays a static paused position; resuming rebuilds the timestamp from the saved media position. IPC retries in the background without holding up the audio/UI thread. Add the numeric Discord Application ID in Settings; it is public application metadata, not a secret.
- The supplied `Hello Baby` font is applied throughout the UI. Its archive did not include redistribution terms, so verify the font license before distributing builds.

## Current playback and integration limits

Local files currently play through the Windows WebView audio decoder. Actual format support depends on that decoder and the file's codec; Viviette does not currently guarantee native FLAC/ALAC/WAV/DSD playback, exclusive WASAPI, gapless transitions, ReplayGain, or DSP/parametric EQ. DSD files can be imported into the library but may not decode. A future native audio engine is needed for those guarantees. The UI does not claim lossless quality when it cannot verify the source.

## Provider search and sign-in

The prototype can search YouTube and SoundCloud after you add your own developer app credentials in **Settings → Integrations**. Spotify search opens on Spotify's own site. Selecting a provider opens its sign-in choices; YouTube and SoundCloud OAuth authorization takes place on the provider's website in your default browser. Viviette never asks for, receives, or stores provider passwords. YouTube and SoundCloud app keys, client secrets, and returned OAuth tokens are saved through the operating system credential store. No provider credentials are bundled in this repository or installer.

- **YouTube:** Search uses the YouTube Data API with an API key, or an authorized Google account using the read-only YouTube scope. Search results only include embeddable videos and playback remains in YouTube's visible, official player, with its standard controls and ads. Background audio, extraction, and MP3 export from YouTube are not supported. Create credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable YouTube Data API v3, and register a Desktop OAuth client if you want Google sign-in. Google also requires the OAuth consent screen, support details, and privacy disclosures. The default callback is `http://127.0.0.1:47619/callback`.
- **SoundCloud:** Search uses its official API and authorized tracks are shown in the official SoundCloud widget. App registration currently requires SoundCloud Artist Pro; create an app at [Your SoundCloud Apps](https://soundcloud.com/you/apps) and add the callback URI above. Public search can run with the app credentials without connecting a personal account. [SoundCloud API app registration](https://developers.soundcloud.com/docs/api/register-app) explains the current requirements.
- **Spotify:** Search, sign-in, and playback open on Spotify itself. Viviette does not display Spotify catalog metadata alongside other provider content. This avoids the Spotify Developer Policy restriction on integrating Spotify content with another service. See the [Spotify Developer Policy](https://developer.spotify.com/policy).
- **Live Performances** is a search filter that adds concert-recording terms to whichever catalog is selected. It is not a separate provider.

YouTube and SoundCloud availability is subject to your own API credentials, quota, OAuth consent-screen status, account eligibility, regional catalog, and provider approval. YouTube and SoundCloud playback use their embedded players' own controls; provider playback is not yet linked to Viviette's bottom player or Discord presence. Spotify search and playback open externally on Spotify. The bottom bar and pause-aware Rich Presence currently control imported local tracks. No authorized MP3 export is currently available from these search providers. Viviette does not scrape streams, extract protected audio, bypass DRM, or convert lossy audio to FLAC.

Discord needs an Application ID created in the Developer Portal. Discord currently restricts RPC access for unapproved applications to listed testers, so general availability may require approval or tester enrollment. Discord documents native RPC over IPC and recommends its Social SDK for new game social integrations; Viviette uses a community Rust crate for the IPC transport. Local album artwork is not published to Discord; a provider-supplied public HTTPS artwork URL can be passed by a future provider adapter. Discord connection state is observable in Settings when that page is open. Presence data includes the current title and artist only while the setting is enabled.

The following requested features are not implemented yet: metadata tag writing, synced and unsynced lyrics, smart playlists/Smart DJ, explicit-tag parsing, not-liked filtering, play counts and Last.fm/ListenBrainz scrobbling, ReplayGain scanning, crossfeed, parametric EQ, VST3 hosting, genre hierarchy, DLNA/UPnP, web radio, Subsonic, CD playback, and native gapless/high-resolution audio. The provider adapter and local library are intended seams for those additions; no UI control claims they are available.

## Development

Requires Node.js, pnpm, Rust, and the Windows prerequisites in the [Tauri v2 guide](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Build the frontend with:

```sh
pnpm build
```

Create a Windows setup executable with:

```sh
pnpm tauri build --bundles nsis
```

Push a tag such as `v0.1.2` to create the GitHub release. The workflow emits `Viviette-Setup.exe` and `SHA256SUMS.txt`.

## Architecture

- `src/main.ts`: UI, library views, player actions, and local settings.
- `src/library/storage.ts`: IndexedDB metadata and local audio blobs.
- `src/playback/adapter.ts`: provider-neutral playback controls used by device-loss handling.
- `src-tauri/src/audio_output.rs`: Windows Core Audio device-change events.
- `src-tauri/src/discord_presence.rs`: dedicated Discord IPC worker with pause-aware timestamps.
- `src-tauri/src/providers.rs`: provider search, browser-based OAuth with PKCE, provider playback URLs, and OS credential-store access.
- `src-tauri/src/lib.rs`: Tauri command registration.
- `.github/workflows`: frontend/native verification and tagged Windows packaging.

## Notes

`pnpm-workspace.yaml` explicitly permits the esbuild install script because Vite needs its platform binary to build. No provider passwords, tokens, or API secrets are stored in frontend code.

Viviette adapts Riff's inline SVG icon artwork from [rootscripts/riff](https://github.com/rootscripts/riff), licensed under the MIT License. The copyright and license notice is included in `RIFF-LICENSE.txt` and bundled with the app as `RIFF-LICENSE.txt`.
