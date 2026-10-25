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
- Responsive dark interface and compact pinned playback bar. Settings uses a compact section rail with Integrations, Playback, and Accessibility sections. Accessibility zoom and font size persist between launches.
- Import local audio into an IndexedDB library. Likes and playlist track references persist locally; duplicate playlist entries are prevented.
- Play, pause, seek, volume, shuffle, previous/next, and repeat off / queue / current track are wired to local playback. Repeat is free.
- The bottom-left controls provide like, playlist, and download actions. Download feedback explains that Viviette will export MP3 only when a connected source explicitly authorizes it.
- Windows Core Audio endpoint notifications can pause the active playback adapter when the default headset or output is removed. Notifications are event-driven; there is no output polling loop.
- Discord Rich Presence uses a Rust IPC worker. Playback state changes send immediately on track, play/pause, and seek; a low-frequency refresh checks for Discord restarts while presence is active. When paused, it removes the running timestamp and displays a static paused position; resuming rebuilds the timestamp from the saved media position. IPC retries in the background without holding up the audio/UI thread. Add the numeric Discord Application ID in Settings; it is public application metadata, not a secret.
- The supplied `Hello Baby` font is applied throughout the UI. Its archive did not include redistribution terms, so verify the font license before distributing builds.

## Current playback and integration limits

Local files currently play through the Windows WebView audio decoder. Actual format support depends on that decoder and the file's codec; Viviette does not currently guarantee native FLAC/ALAC/WAV/DSD playback, exclusive WASAPI, gapless transitions, ReplayGain, or DSP/parametric EQ. DSD files can be imported into the library but may not decode. A future native audio engine is needed for those guarantees. The UI does not claim lossless quality when it cannot verify the source.

## Provider search and sign-in

People use the provider buttons in Viviette to log in or create an account. Provider passwords are entered only on the provider's official site. Viviette does not collect provider passwords. OAuth tokens are stored in the operating system credential store. The app no longer asks users to paste API keys, client IDs, or client secrets into Settings.

Provider OAuth apps still have to be registered by the Viviette maintainers. YouTube and Spotify client IDs are supplied to release builds through GitHub Actions repository variables named `VIVIETTE_YOUTUBE_CLIENT_ID` and `VIVIETTE_SPOTIFY_CLIENT_ID`. These are public app identifiers, not user credentials. Without those variables, the app reports sign-in unavailable instead of presenting a developer-setup form.

- **YouTube:** Search is available only after Google authorization and uses the YouTube Data API. Results open in YouTube's visible official player with its standard controls and ads. Viviette does not extract audio, support background playback, or export MP3 from YouTube.
- **SoundCloud:** SoundCloud OAuth uses PKCE and the desktop callback `viviette://soundcloud/callback`; Tauri deep links route it back to the running app. SoundCloud requires its client secret during code exchange, so the desktop app sends the exchange to the small HTTPS worker in `services/soundcloud-token-broker/`. The worker keeps the secret server-side and is never bundled with Viviette. Register the callback with SoundCloud, deploy the worker, then set the GitHub Actions variables `VIVIETTE_SOUNDCLOUD_CLIENT_ID` and `VIVIETTE_SOUNDCLOUD_TOKEN_BROKER_URL` (the full HTTPS URL ending in `/oauth/token`). SoundCloud's current app registration requires Artist Pro; see [SoundCloud API app registration](https://developers.soundcloud.com/docs/api/register-app) and its [OAuth guide](https://developers.soundcloud.com/docs/api/guide).
- **Spotify:** Login uses Authorization Code with PKCE in the system browser and the loopback callback `http://127.0.0.1:47619/callback`. Spotify search and playback remain on Spotify; its catalog is not combined with the other services. See the [Spotify PKCE guide](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) and [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
- **Live Performances** adds concert-recording terms to the selected provider's search. It is a filter, not a separate service, and it requires signing in to the selected provider.

### Configure provider sign-in for a release

These are maintainer-only setup steps. End users sign in on the providers' official websites; Viviette never asks them for provider passwords, API keys, or developer credentials.

**YouTube / Google:** Create a Google Cloud project, enable YouTube Data API v3, configure the OAuth consent screen, and create an OAuth client of type **Desktop app**. If the consent screen is in Testing, add the Google accounts that will test the app. A public release may require Google consent-screen verification and YouTube API quota approval. Add the resulting Client ID to GitHub **Settings → Secrets and variables → Actions → Variables** as `VIVIETTE_YOUTUBE_CLIENT_ID`. The app uses the loopback callback `http://127.0.0.1:47619/callback`. Google's YouTube API setup and credentials are documented [here](https://developers.google.com/youtube/registering_an_application) and [here](https://developers.google.com/youtube/v3/getting-started).

**Spotify:** Add the callback `http://127.0.0.1:47619/callback` in the Spotify app settings, then add its Client ID to the same GitHub Variables page as `VIVIETTE_SPOTIFY_CLIENT_ID`. Spotify Development Mode requires a Premium owner and restricts use to allowlisted test accounts; see its [quota mode guide](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

**SoundCloud:** SoundCloud app registration currently requires Artist Pro. Register `viviette://soundcloud/callback`, then deploy the worker:

```sh
cd services/soundcloud-token-broker
npx wrangler login
npx wrangler secret put SOUNDCLOUD_CLIENT_ID
npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET
npx wrangler deploy
```

The two `wrangler secret put` commands prompt securely; neither value goes into the app binary or source control. Add the app's Client ID to GitHub Actions Variables as `VIVIETTE_SOUNDCLOUD_CLIENT_ID`, and the deployed worker URL ending in `/oauth/token` as `VIVIETTE_SOUNDCLOUD_TOKEN_BROKER_URL`. Apply a Cloudflare rate limit to `/oauth/token` before broad distribution. Worker deployment requires a Cloudflare account and Node.js/npm.

Once all desired provider variables are saved and the SoundCloud worker is deployed, pushing a new `v*` tag builds a fresh installer. Existing releases do not change when variables are added.

OAuth uses the normal system browser because providers such as Google prohibit login inside an app-controlled embedded browser. YouTube and SoundCloud playback use their official players; provider playback is not yet linked to Viviette's bottom player or Discord presence. Spotify search and playback open on Spotify. The bottom bar and pause-aware Rich Presence currently control imported local tracks. No authorized MP3 export is available from these search providers. Viviette does not scrape streams, extract protected audio, bypass DRM, or convert lossy audio to FLAC.

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

Push a tag such as `v0.1.8` to create the GitHub release. The workflow emits `Viviette-Setup.exe` and `SHA256SUMS.txt`.

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
