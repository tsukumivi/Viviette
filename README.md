# Viviette

Viviette is a compact Windows-first music player built with Tauri 2, Rust, TypeScript, and Vite. The interface uses a Riff-inspired density and a Spotify-like navigation pattern while keeping the player and library code independent from any streaming provider.

## Install

Download and launch the latest Windows installer from PowerShell with:

```powershell
$ProgressPreference = 'SilentlyContinue'; $base = 'https://github.com/tsukumivi/Viviette/releases/latest/download'; $installer = Join-Path $env:TEMP 'Viviette-Setup.exe'; $sums = Join-Path $env:TEMP 'Viviette-SHA256SUMS.txt'; Invoke-WebRequest "$base/Viviette-Setup.exe" -OutFile $installer; Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile $sums; $expected = (Get-Content $sums).Split(' ')[0]; if ((Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant() -ne $expected) { throw 'Viviette installer checksum validation failed.' }; Start-Process -FilePath $installer
```

The NSIS installer is configured for the current Windows user and does not ask for administrator access. The release also includes a SHA-256 checksum file. You can also download `Viviette-Setup.exe` from the [GitHub Releases page](https://github.com/tsukumivi/Viviette/releases).

## Working in this checkout

- Compact Riff-inspired left rail with Discover, Liked Songs, and Settings; a persistent search field and YouTube, SoundCloud, and Live Performances source selector sit beside it. The source choice is saved locally; provider playback is not connected yet.
- Responsive dark interface and compact pinned playback bar. The Settings page uses a compact section rail and grouped rows for the integrations and playback controls that exist today.
- Import local audio into an IndexedDB library. Likes and playlist track references persist locally; duplicate playlist entries are prevented.
- Play, pause, seek, volume, shuffle, previous/next, and repeat off / queue / current track are wired to local playback. Repeat is free.
- The bottom-left controls provide like, playlist, and download actions. Download feedback explains that Viviette will export MP3 only when a connected source explicitly authorizes it.
- Windows Core Audio endpoint notifications can pause the active playback adapter when the default headset or output is removed. Notifications are event-driven; there is no output polling loop.
- Discord Rich Presence uses a Rust IPC worker. Playback state changes send immediately on track, play/pause, and seek; a low-frequency refresh checks for Discord restarts while presence is active. When paused, it removes the running timestamp and displays a static paused position; resuming rebuilds the timestamp from the saved media position. IPC retries in the background without holding up the audio/UI thread. Add the numeric Discord Application ID in Settings; it is public application metadata, not a secret.
- The supplied `Hello Baby` font is applied throughout the UI. Its archive did not include redistribution terms, so verify the font license before distributing builds.

## Current playback and integration limits

Local files currently play through the Windows WebView audio decoder. Actual format support depends on that decoder and the file's codec; Viviette does not currently guarantee native FLAC/ALAC/WAV/DSD playback, exclusive WASAPI, gapless transitions, ReplayGain, or DSP/parametric EQ. DSD files can be imported into the library but may not decode. A future native audio engine is needed for those guarantees. The UI does not claim lossless quality when it cannot verify the source.

No streaming provider is connected. Official provider playback, authentication, licensing eligibility, quality reporting, and download permissions must be established before adding a provider adapter. There is no scraping, protected-stream extraction, DRM bypass, or lossy-to-FLAC conversion.

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

Push a tag such as `v0.1.0` to create the GitHub release. The workflow emits `Viviette-Setup.exe` and `SHA256SUMS.txt`.

## Architecture

- `src/main.ts`: UI, library views, player actions, and local settings.
- `src/library/storage.ts`: IndexedDB metadata and local audio blobs.
- `src/playback/adapter.ts`: provider-neutral playback controls used by device-loss handling.
- `src-tauri/src/audio_output.rs`: Windows Core Audio device-change events.
- `src-tauri/src/discord_presence.rs`: dedicated Discord IPC worker with pause-aware timestamps.
- `src-tauri/src/lib.rs`: Tauri command registration.
- `.github/workflows`: frontend/native verification and tagged Windows packaging.

## Notes

`pnpm-workspace.yaml` explicitly permits the esbuild install script because Vite needs its platform binary to build. No provider passwords, tokens, or API secrets are stored in frontend code.

Viviette adapts Riff's inline SVG icon artwork from [rootscripts/riff](https://github.com/rootscripts/riff), licensed under the MIT License. The copyright and license notice is included in `RIFF-LICENSE.txt` and bundled with the app as `RIFF-LICENSE.txt`.
