import "./styles.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pauseActivePlayback, registerPlaybackAdapter } from "./playback/adapter";
import { getTrackAudio, listTracks, saveTrack, type LibraryTrack } from "./library/storage";

type Page = "home" | "browse" | "library" | "playlists" | "liked" | "settings";

type Track = LibraryTrack;

type Playlist = {
  id: string;
  name: string;
  trackIds: string[];
};

let tracks: Track[] = [];

const mainContent = document.querySelector<HTMLElement>("#mainContent")!;
const searchInput = document.querySelector<HTMLInputElement>("#searchInput")!;
const navPanel = document.querySelector<HTMLElement>("#navPanel")!;
const navToggle = document.querySelector<HTMLButtonElement>("#navToggle")!;
const drawerScrim = document.querySelector<HTMLElement>("#drawerScrim")!;
const playlistMenu = document.querySelector<HTMLElement>("#playlistMenu")!;
const playlistOptions = document.querySelector<HTMLElement>("#playlistOptions")!;
const playlistButton = document.querySelector<HTMLButtonElement>("#playlistButton")!;
const moreButton = document.querySelector<HTMLButtonElement>("#moreButton")!;
const trackMenu = document.querySelector<HTMLElement>("#trackMenu")!;
const createDialog = document.querySelector<HTMLDialogElement>("#createDialog")!;
const createForm = document.querySelector<HTMLFormElement>("#createPlaylistForm")!;
const playlistNameInput = document.querySelector<HTMLInputElement>("#playlistName")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const miniTitle = document.querySelector<HTMLElement>("#miniTitle")!;
const miniArtist = document.querySelector<HTMLElement>("#miniArtist")!;
const miniArt = document.querySelector<HTMLElement>("#miniArt")!;
const likeButton = document.querySelector<HTMLButtonElement>("#likeButton")!;
const navPlaylistList = document.querySelector<HTMLElement>("#navPlaylists")!;
const likedCount = document.querySelector<HTMLElement>("#likedCount")!;
const audioDisconnectPreferenceKey = "viviette.pauseOnOutputDisconnect.v1";
const discordClientIdKey = "viviette.discord.clientId.v1";
const discordEnabledKey = "viviette.discord.enabled.v1";
const audioElement = document.querySelector<HTMLAudioElement>("#audioElement")!;
const audioFiles = document.querySelector<HTMLInputElement>("#audioFiles")!;
const seekSlider = document.querySelector<HTMLInputElement>("#seekSlider")!;
const volumeSlider = document.querySelector<HTMLInputElement>("#volumeSlider")!;
const volumeToggle = document.querySelector<HTMLButtonElement>("#volumeToggle")!;
const elapsedTime = document.querySelector<HTMLElement>("#elapsedTime")!;
const totalTime = document.querySelector<HTMLElement>("#totalTime")!;

const emptyTrack: Track = { id: "", title: "Nothing playing", artist: "Import local music to get started", album: "", fileName: "", sourceKey: "", format: "", mimeType: "", duration: 0, size: 0, addedAt: 0, art: "art-starlight" };
const getTrack = (id: string | null): Track => tracks.find((track) => track.id === id) ?? emptyTrack;
const readStringArray = (key: string): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const readBoolean = (key: string, fallback: boolean): boolean => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
};

const readString = (key: string): string => {
  try { return localStorage.getItem(key) ?? ""; }
  catch { return ""; }
};

const readPlaylists = (): Playlist[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("viviette.playlists.v1") ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown): Playlist[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<Playlist>;
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !Array.isArray(candidate.trackIds)) return [];
      return [{
        id: candidate.id,
        name: candidate.name.slice(0, 48),
        trackIds: candidate.trackIds.filter((id): id is string => typeof id === "string"),
      }];
    });
  } catch {
    return [];
  }
};

let currentView: Page = "home";
let currentTrackId: string | null = null;
let currentPlaylistId: string | null = null;
let addCurrentTrackAfterCreate = false;
let toastTimer = 0;
let likedIds = new Set(readStringArray("viviette.likes.v1"));
let notLikedIds = new Set(readStringArray("viviette.notLiked.v1"));
let playlists = readPlaylists();
let pauseOnOutputDisconnect = readBoolean(audioDisconnectPreferenceKey, true);
let discordClientId = readString(discordClientIdKey);
let discordPresenceEnabled = readBoolean(discordEnabledKey, false);
let discordPresenceStatus = discordPresenceEnabled ? (discordClientId ? "On · starts with playback" : "Add an Application ID") : "Off";
let audioOutputMonitorSupported = false;
let repeatMode: "off" | "all" | "one" = "off";
let shuffleEnabled = false;
let currentQueue: string[] = [];
let currentObjectUrl: string | null = null;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character] ?? character);

const announce = (message: string): void => {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
};

const unavailable = (action: string): void => {
  announce(`${action} needs an authorized playback source. None is connected yet.`);
};

const persistLikes = (): void => {
  try { localStorage.setItem("viviette.likes.v1", JSON.stringify([...likedIds])); }
  catch { announce("Likes could not be saved in this session."); }
};

const persistNotLiked = (): void => {
  try { localStorage.setItem("viviette.notLiked.v1", JSON.stringify([...notLikedIds])); }
  catch { announce("Not liked choices could not be saved in this session."); }
};

const persistPlaylists = (): void => {
  try { localStorage.setItem("viviette.playlists.v1", JSON.stringify(playlists)); }
  catch { announce("Playlists could not be saved in this session."); }
};

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
};

const filteredTracks = (): Track[] => {
  const query = searchInput.value.trim().toLocaleLowerCase();
  if (!query) return tracks;
  return tracks.filter((track) => `${track.title} ${track.artist} ${track.album} ${track.fileName}`.toLocaleLowerCase().includes(query));
};

const trackCard = (track: Track): string => `
  <button class="album-card${currentTrackId === track.id ? " selected" : ""}" type="button" data-track-select="${track.id}" aria-label="Select ${escapeHtml(track.title)} by ${escapeHtml(track.artist)}">
    <span class="cover ${track.art}" aria-hidden="true"></span>
    <span class="card-title">${escapeHtml(track.title)}</span>
    <span class="card-subtitle">${escapeHtml(track.artist)}</span>
  </button>`;

const trackRow = (track: Track, index: number): string => `
  <button class="track-row${currentTrackId === track.id ? " selected" : ""}" type="button" data-track-select="${track.id}" aria-label="Select ${escapeHtml(track.title)} by ${escapeHtml(track.artist)}">
    <span class="track-number">${String(index + 1).padStart(2, "0")}</span>
    <span class="track-art ${track.art}" aria-hidden="true"></span>
    <span class="track-main"><span class="track-title">${escapeHtml(track.title)}</span><span class="track-artist">${escapeHtml(track.artist)}</span></span>
    <span class="track-album">${escapeHtml(track.album)}</span>
    <span class="track-duration">${formatTime(track.duration)}</span>
  </button>`;

const emptyState = (title: string, description: string): string => `
  <div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13M9 18c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2Zm12-2c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2Z"/></svg><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;

const pageHeading = (eyebrow: string, title: string, note = ""): string => `
  <header class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1></div>${note ? `<span class="heading-note">${escapeHtml(note)}</span>` : ""}</header>`;

const importButton = (label = "Add music"): string => `<button class="button-primary import-music" type="button" data-import-music><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>${label}</button>`;

const homeMarkup = (): string => {
  const results = filteredTracks();
  const featured = getTrack(currentTrackId ?? tracks[0]?.id ?? null);
  const cards = results.slice(0, 5).map(trackCard).join("");
  const rows = results.slice(0, 5).map(trackRow).join("");
  const feature = tracks.length ? `<section class="feature-card" aria-label="Current local track">
      <div class="feature-cover ${featured.art}" aria-hidden="true"></div>
      <div class="feature-copy"><div class="feature-label">${currentTrackId === featured.id && !audioElement.paused ? "Now playing" : "Your music"}</div><h2>${escapeHtml(featured.title)}</h2><p>${escapeHtml(featured.artist)}${featured.album ? ` · ${escapeHtml(featured.album)}` : ""}</p><div class="feature-meta"><span class="meta-chip">${escapeHtml(featured.format || "Local audio")}</span><span class="meta-chip">On this device</span></div></div>
      <button class="feature-button" type="button" data-track-select="${featured.id}" aria-label="Play ${escapeHtml(featured.title)}" title="Play this track"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg></button>
    </section>` : `<section class="welcome-card"><div class="welcome-orb" aria-hidden="true">V</div><div><p class="eyebrow">YOUR MUSIC, YOUR WAY</p><h2>Start with your own collection</h2><p>Import audio files from your device. Viviette keeps the library on this computer.</p>${importButton("Choose music")}</div></section>`;
  return `<div class="page">
    ${pageHeading("YOUR MUSIC", "Home", `${tracks.length} local ${tracks.length === 1 ? "track" : "tracks"}`)}
    ${feature}
    <section class="content-section"><div class="section-header"><h2>${searchInput.value ? "Search results" : "Recently added"}</h2><button class="text-button" type="button" data-view="library">See library <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div><div class="album-grid">${cards || emptyState(searchInput.value ? "No matches" : "Your library is empty", searchInput.value ? "Try another title, artist, album, or filename." : "Tracks you import will appear here.")}</div></section>
    ${tracks.length ? `<section class="content-section"><div class="section-header"><h2>All music</h2>${importButton()}</div><div class="track-list">${rows}</div></section>` : ""}
  </div>`;
};

const libraryMarkup = (title: string, eyebrow: string, list: Track[]): string => {
  const filtered = list.filter((track) => filteredTracks().some((result) => result.id === track.id));
  return `<div class="page">${pageHeading(eyebrow, title, `${filtered.length} ${filtered.length === 1 ? "track" : "tracks"}`)}<section class="content-section"><div class="section-header"><h2>${title}</h2>${importButton("Import music")}</div><div class="track-list">${filtered.map(trackRow).join("") || emptyState("Your collection is empty", "Import audio files from your device to start listening.")}</div></section></div>`;
};

const playlistsMarkup = (): string => {
  const selected = playlists.find((playlist) => playlist.id === currentPlaylistId);
  if (selected) {
    const playlistTracks = selected.trackIds.map((id) => getTrack(id)).filter((track) => track.id && filteredTracks().some((result) => result.id === track.id));
    return `<div class="page">${pageHeading("YOUR LIBRARY", selected.name, `${playlistTracks.length} tracks`)}<section class="content-section"><button class="text-button" id="backToPlaylists" type="button">← All playlists</button><div class="track-list">${playlistTracks.map(trackRow).join("") || emptyState("This playlist is empty", "Add a track using the compact player controls.")}</div></section></div>`;
  }
  const list = playlists.map((playlist, index) => `
    <button class="mix-card" type="button" data-playlist-open="${playlist.id}"><span class="playlist-art ${tracks[index % Math.max(1, tracks.length)]?.art ?? "art-focus"}" aria-hidden="true"></span><span class="mix-copy"><span class="mix-title">${escapeHtml(playlist.name)}</span><span class="mix-description">${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "track" : "tracks"}</span></span><span class="heading-note">Open</span></button>`).join("");
  return `<div class="page">${pageHeading("YOUR LIBRARY", "Playlists", `${playlists.length} playlists`)}<section class="content-section"><div class="section-header"><h2>Your playlists</h2><button class="text-button" type="button" id="pageCreatePlaylist">+ Create playlist</button></div><div class="mix-grid">${list || emptyState("No playlists yet", "Create one, then add tracks from the compact player bar.")}</div></section></div>`;
};

const settingsMarkup = (): string => `<div class="page">${pageHeading("PREFERENCES", "Settings", "Local app shell")}
  <section class="content-section settings-grid">
    <article class="setting-card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13M9 18c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2Zm12-2c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2Z"/></svg><span class="setting-copy"><strong>Streaming providers</strong><span>Connect an official playback provider to begin listening.</span></span><span class="setting-state">Not connected</span></article>
    <article class="setting-card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18m0-18 7 4v10l-7 4-7-4V7l7-4Z"/></svg><span class="setting-copy"><strong>Audio quality</strong><span>Quality will reflect the active source and track.</span></span><span class="setting-state">Unavailable</span></article>
    <article class="setting-card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10V7a4 4 0 0 1 8 0v3m-9 0h10a2 2 0 0 1 2 2v7H5v-7a2 2 0 0 1 2-2Z"/></svg><span class="setting-copy"><strong>Authorized downloads</strong><span>Exports appear only when a source permits them.</span></span><span class="setting-state">Unavailable</span></article>
    <article class="setting-card discord-setting"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8 8 0 0 1-3.5-.8L4 20l1.6-3.3A7.2 7.2 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3.1 8 7Z"/></svg><span class="setting-copy"><strong>Discord Rich Presence</strong><span>Uses local Discord IPC. Song and artist are shared only while enabled. Discord may require approved or test-listed RPC access.</span></span><div class="discord-controls"><label for="discordClientId">Application ID</label><div class="discord-id-row"><input id="discordClientId" inputmode="numeric" autocomplete="off" maxlength="24" value="${escapeHtml(discordClientId)}" placeholder="From the Discord Developer Portal"><button class="button-quiet" id="saveDiscordSettings" type="button">Save</button></div><div class="discord-status-row"><span id="discordPresenceState" class="setting-state">${escapeHtml(discordPresenceStatus)}</span><label class="setting-switch" title="Share the current track with Discord"><input id="discordPresenceEnabled" type="checkbox" aria-label="Enable Discord Rich Presence" ${discordPresenceEnabled ? "checked" : ""}><span aria-hidden="true"></span></label></div></div></article>
    <article class="setting-card audio-pause-setting"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6Zm-9 9v1a9 9 0 0 0 18 0v-1M12 21v-3"/></svg><span class="setting-copy"><strong>Pause on audio output change</strong><span>Pauses connected playback when Windows changes or loses the default output, including a Bluetooth headset disconnect.</span></span><span class="setting-state" id="audioOutputState">${audioOutputMonitorSupported ? (pauseOnOutputDisconnect ? "On" : "Off") : "Desktop only"}</span><label class="setting-switch" title="Pause playback when the default audio output disconnects"><input id="pauseOnOutputDisconnect" type="checkbox" aria-label="Pause playback when audio output disconnects" ${pauseOnOutputDisconnect ? "checked" : ""} ${audioOutputMonitorSupported ? "" : "disabled"}><span aria-hidden="true"></span></label></article>
  </section></div>`;

const setView = (view: Page): void => {
  currentView = view;
  currentPlaylistId = null;
  renderPage();
  closeNavigation();
};

const renderPage = (): void => {
  if (currentView === "home") mainContent.innerHTML = homeMarkup();
  if (currentView === "browse") mainContent.innerHTML = `<div class="page">${pageHeading("EXPLORE", "Browse", "Your local collection") }<section class="content-section"><div class="album-grid">${filteredTracks().slice(0, 5).map(trackCard).join("") || emptyState("Nothing to browse yet", "Import local audio files to build your library.")}</div></section><section class="content-section"><div class="section-header"><h2>All tracks</h2>${importButton()}</div><div class="track-list">${filteredTracks().map(trackRow).join("")}</div></section></div>`;
  if (currentView === "library") mainContent.innerHTML = libraryMarkup("Library", "YOUR COLLECTION", tracks);
  if (currentView === "liked") mainContent.innerHTML = libraryMarkup("Liked Songs", "YOUR LIBRARY", tracks.filter((track) => likedIds.has(track.id)));
  if (currentView === "playlists") mainContent.innerHTML = playlistsMarkup();
  if (currentView === "settings") mainContent.innerHTML = settingsMarkup();
  document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === currentView));
  updatePlayer();
  updateNavPlaylists();
};

const pageQueue = (): string[] => {
  if (currentView === "playlists" && currentPlaylistId) {
    return playlists.find((playlist) => playlist.id === currentPlaylistId)?.trackIds.filter((id) => tracks.some((track) => track.id === id)) ?? [];
  }
  if (currentView === "liked") return tracks.filter((track) => likedIds.has(track.id)).map((track) => track.id);
  return tracks.map((track) => track.id);
};

const setPlaybackTime = (): void => {
  const duration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0;
  const current = Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
  elapsedTime.textContent = formatTime(current);
  totalTime.textContent = formatTime(duration);
  seekSlider.max = String(Math.max(1, Math.round(duration * 10)));
  seekSlider.value = String(Math.min(Number(seekSlider.max), Math.round(current * 10)));
  seekSlider.disabled = !duration;
  seekSlider.style.setProperty("--seek-percent", duration ? `${(current / duration) * 100}%` : "0%");
};

const updateTransport = (): void => {
  const playButton = document.querySelector<HTMLButtonElement>('[data-transport="play"]');
  const playPath = playButton?.querySelector<SVGPathElement>("path");
  const playing = !audioElement.paused && !audioElement.ended;
  if (playButton) {
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    playButton.title = currentTrackId ? (playing ? "Pause" : "Resume") : "Choose a local track to play";
    playButton.dataset.tooltip = playing ? "Pause" : "Play";
    playButton.disabled = !currentTrackId;
  }
  if (playPath) playPath.setAttribute("d", playing ? "M7 5h3v14H7zM14 5h3v14h-3z" : "m8 5 11 7-11 7z");
  const repeatButton = document.querySelector<HTMLButtonElement>('[data-transport="repeat"]');
  if (repeatButton) {
    const repeatLabel = repeatMode === "one" ? "Repeat current track" : repeatMode === "all" ? "Repeat queue" : "Repeat off";
    repeatButton.setAttribute("aria-label", repeatLabel);
    repeatButton.dataset.tooltip = repeatLabel;
    repeatButton.classList.toggle("is-active", repeatMode !== "off");
    const repeatPath = repeatButton.querySelector<SVGPathElement>("path");
    if (repeatPath) repeatPath.setAttribute("d", repeatMode === "one" ? "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3" : "m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3");
  }
  const shuffleButton = document.querySelector<HTMLButtonElement>('[data-transport="shuffle"]');
  if (shuffleButton) {
    shuffleButton.classList.toggle("is-active", shuffleEnabled);
    shuffleButton.setAttribute("aria-pressed", String(shuffleEnabled));
    shuffleButton.dataset.tooltip = shuffleEnabled ? "Shuffle on" : "Shuffle off";
  }
};

const updatePlayer = (): void => {
  const track = getTrack(currentTrackId);
  miniTitle.textContent = track.title;
  miniArtist.textContent = track.artist;
  miniArt.className = `mini-art ${track.art}`;
  const isLiked = Boolean(track.id) && likedIds.has(track.id);
  const notLikedLabel = document.querySelector<HTMLElement>("#notLikedOption span");
  if (notLikedLabel) notLikedLabel.textContent = notLikedIds.has(track.id) ? "Remove from not liked" : "Mark as not liked";
  likeButton.disabled = !track.id;
  likeButton.classList.toggle("is-liked", isLiked);
  likeButton.setAttribute("aria-pressed", String(isLiked));
  likeButton.setAttribute("aria-label", isLiked ? "Unlike" : "Like");
  likeButton.dataset.tooltip = isLiked ? "Unlike" : "Like";
  const downloadButton = document.querySelector<HTMLButtonElement>("#downloadButton")!;
  const addButton = document.querySelector<HTMLButtonElement>("#playlistButton")!;
  downloadButton.disabled = !track.id;
  addButton.disabled = !track.id;
  moreButton.disabled = !track.id;
  document.querySelectorAll<HTMLButtonElement>("[data-transport]").forEach((button) => {
    if (button.dataset.transport !== "shuffle" && button.dataset.transport !== "repeat" && button.dataset.transport !== "play") button.disabled = !track.id;
  });
  likedCount.textContent = String(tracks.filter((item) => likedIds.has(item.id)).length);
  document.querySelectorAll<HTMLElement>("[data-track-select]").forEach((item) => item.classList.toggle("selected", item.dataset.trackSelect === currentTrackId));
  setPlaybackTime();
  updateTransport();
};

const artForName = (name: string): string => {
  const styles = ["art-starlight", "art-afterhours", "art-lofi", "art-eclipse", "art-midnight", "art-bloom", "art-focus", "art-late"];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return styles[Math.abs(hash) % styles.length]!;
};

const trackFromFile = (file: File): Track => {
  const fileName = file.name;
  const extension = fileName.split(".").pop()?.toUpperCase() ?? "AUDIO";
  const basename = fileName.replace(/\.[^.]+$/, "");
  const parts = basename.split(" - ").map((part) => part.trim());
  const hasArtist = parts.length > 1;
  const artist = hasArtist ? parts[0]! : "Unknown artist";
  const title = hasArtist ? parts.slice(1).join(" - ") : basename;
  const sourceKey = `${fileName.toLocaleLowerCase()}|${file.size}|${file.lastModified}`;
  return { id: crypto.randomUUID(), title: title || basename, artist, album: "Local files", fileName, sourceKey, format: extension, mimeType: file.type, duration: 0, size: file.size, addedAt: Date.now(), art: artForName(fileName) };
};

const importAudioFiles = async (files: FileList | File[]): Promise<void> => {
  let imported = 0;
  let duplicates = 0;
  try {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("audio/") && !/\.(flac|wav|opus|aac|m4a|alac|dsf|dff|mp3|ogg|aiff?)$/i.test(file.name)) continue;
      const track = trackFromFile(file);
      const duplicate = tracks.find((existing) => existing.sourceKey === track.sourceKey);
      if (duplicate) { duplicates += 1; continue; }
      await saveTrack(track, file);
      tracks.push(track);
      imported += 1;
    }
    tracks.sort((a, b) => a.title.localeCompare(b.title));
    renderPage();
    announce(imported ? `Added ${imported} ${imported === 1 ? "track" : "tracks"}${duplicates ? ` · skipped ${duplicates} duplicate${duplicates === 1 ? "" : "s"}` : ""}.` : duplicates ? "Those tracks are already in your library." : "No supported audio files were selected.");
  } catch (error) {
    announce(error instanceof Error ? `Import failed: ${error.message}` : "Import failed. The local library could not save these files.");
  }
};

const playTrack = async (id: string, queue = pageQueue()): Promise<void> => {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) return;
  const blob = await getTrackAudio(id);
  if (!blob) { announce("The saved audio file is missing. Remove it and import it again."); return; }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  currentTrackId = id;
  currentQueue = queue.includes(id) ? [...queue] : [id, ...queue];
  audioElement.src = currentObjectUrl;
  audioElement.load();
  updatePlayer();
  try {
    await audioElement.play();
    updatePlayer();
  } catch {
    announce(`Windows WebView could not play this ${track.format} file. Try an audio format supported by this device.`);
    updatePlayer();
  }
};

const togglePlayback = async (): Promise<void> => {
  if (!currentTrackId) {
    const firstTrack = tracks[0];
    if (firstTrack) await playTrack(firstTrack.id, pageQueue());
    return;
  }
  if (audioElement.paused) {
    try { await audioElement.play(); }
    catch { announce("This track could not be resumed by the current audio decoder."); }
  } else audioElement.pause();
  updateTransport();
};

const playAdjacent = async (direction: -1 | 1): Promise<void> => {
  if (!currentTrackId) return;
  if (!currentQueue.length) currentQueue = pageQueue();
  const currentIndex = currentQueue.indexOf(currentTrackId);
  if (direction < 0 && audioElement.currentTime > 3) {
    audioElement.currentTime = 0;
    setPlaybackTime();
    return;
  }
  if (shuffleEnabled && direction > 0 && currentQueue.length > 1) {
    const candidates = currentQueue.filter((id) => id !== currentTrackId);
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (next) { await playTrack(next, currentQueue); return; }
  }
  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < currentQueue.length) {
    const nextId = currentQueue[nextIndex];
    if (nextId) await playTrack(nextId, currentQueue);
    return;
  }
  if (direction > 0 && repeatMode === "all" && currentQueue.length) {
    const wrapId = currentQueue[0];
    if (wrapId) await playTrack(wrapId, currentQueue);
  }
};

const loadLibrary = async (): Promise<void> => {
  try {
    tracks = await listTracks();
    const available = new Set(tracks.map((track) => track.id));
    likedIds = new Set([...likedIds].filter((id) => available.has(id)));
    notLikedIds = new Set([...notLikedIds].filter((id) => available.has(id)));
    playlists = playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.filter((id) => available.has(id)) }));
    persistLikes();
    persistNotLiked();
    persistPlaylists();
    renderPage();
  } catch {
    announce("Viviette could not open its local library database.");
  }
};

const registerAudioOutputEvents = async (): Promise<void> => {
  if (!isTauri()) return;
  try {
    audioOutputMonitorSupported = await invoke<boolean>("audio_output_monitor_supported");
    const state = document.querySelector<HTMLElement>("#audioOutputState");
    if (state) state.textContent = audioOutputMonitorSupported ? (pauseOnOutputDisconnect ? "On" : "Off") : "Unsupported";
    const checkbox = document.querySelector<HTMLInputElement>("#pauseOnOutputDisconnect");
    if (checkbox) checkbox.disabled = !audioOutputMonitorSupported;
    if (!audioOutputMonitorSupported) return;

    await listen("audio-output-changed", async () => {
      if (!pauseOnOutputDisconnect) return;
      try {
        const paused = await pauseActivePlayback();
        announce(paused
          ? "Playback paused because the system audio output changed."
          : "Audio output changed. Playback is not connected, so there is nothing to pause yet.");
      } catch {
        announce("Audio output changed, but the playback source could not be paused.");
      }
    });
  } catch {
    audioOutputMonitorSupported = false;
    const state = document.querySelector<HTMLElement>("#audioOutputState");
    const checkbox = document.querySelector<HTMLInputElement>("#pauseOnOutputDisconnect");
    if (state) state.textContent = "Unavailable";
    if (checkbox) checkbox.disabled = true;
  }
};

const updateNavPlaylists = (): void => {
  navPlaylistList.innerHTML = playlists.length ? playlists.map((playlist, index) => `
    <button class="nav-playlist" type="button" data-playlist-open="${playlist.id}"><span class="playlist-art ${tracks[index % Math.max(1, tracks.length)]?.art ?? "art-focus"}" aria-hidden="true"></span><span class="playlist-copy"><span class="playlist-name">${escapeHtml(playlist.name)}</span><span class="playlist-count">${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "track" : "tracks"}</span></span></button>`).join("") : `<div class="playlist-empty">No playlists yet</div>`;
};

const syncDiscordPresence = (): void => {
  if (!isTauri() || !discordPresenceEnabled || !discordClientId || !currentTrackId) return;
  const track = getTrack(currentTrackId);
  void invoke("discord_presence_update", {
    update: {
      clientId: discordClientId,
      title: track.title,
      artist: track.artist,
      positionSeconds: audioElement.currentTime,
      durationSeconds: audioElement.duration,
      playing: !audioElement.paused && !audioElement.ended,
      artworkUrl: null,
    },
  }).catch(() => {
    discordPresenceStatus = "IPC update unavailable";
    const state = document.querySelector<HTMLElement>("#discordPresenceState");
    if (state) state.textContent = discordPresenceStatus;
  });
};

const openNavigation = (): void => {
  navPanel.classList.add("is-open");
  navPanel.removeAttribute("inert");
  navPanel.setAttribute("aria-hidden", "false");
  navToggle.setAttribute("aria-expanded", "true");
  navToggle.setAttribute("aria-label", "Close navigation");
  navToggle.title = "Close navigation";
  drawerScrim.hidden = false;
  navPanel.querySelector<HTMLButtonElement>(".nav-item.active")?.focus({ preventScroll: true });
};

const closeNavigation = (): void => {
  navPanel.classList.remove("is-open");
  navPanel.setAttribute("inert", "");
  navPanel.setAttribute("aria-hidden", "true");
  navToggle.setAttribute("aria-expanded", "false");
  navToggle.setAttribute("aria-label", "Open navigation");
  navToggle.title = "Open navigation";
  drawerScrim.hidden = true;
};

const openCreateDialog = (addCurrent: boolean): void => {
  addCurrentTrackAfterCreate = addCurrent;
  closePlaylistMenu();
  createDialog.showModal();
  window.setTimeout(() => playlistNameInput.focus(), 0);
};

const openPlaylistMenu = (): void => {
  if (!currentTrackId) return;
  closeTrackMenu();
  const track = getTrack(currentTrackId);
  playlistOptions.innerHTML = playlists.length
    ? playlists.map((playlist) => `<button class="playlist-option" type="button" data-playlist-add="${playlist.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-7-7v14"/></svg><span>${escapeHtml(playlist.name)}</span></button>`).join("")
    : `<div class="playlist-count" style="padding: 8px">No playlists yet</div>`;
  playlistMenu.setAttribute("aria-label", `Add ${track.title} to a playlist`);
  playlistMenu.hidden = false;
  playlistButton.setAttribute("aria-expanded", "true");
};

const openTrackMenu = (): void => {
  if (!currentTrackId) return;
  closePlaylistMenu();
  trackMenu.hidden = false;
  moreButton.setAttribute("aria-expanded", "true");
};

const closeTrackMenu = (): void => {
  trackMenu.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
};

const closePlaylistMenu = (): void => {
  playlistMenu.hidden = true;
  playlistButton.setAttribute("aria-expanded", "false");
};

navToggle.addEventListener("click", () => navPanel.classList.contains("is-open") ? closeNavigation() : openNavigation());
document.querySelector<HTMLButtonElement>("#closeNav")!.addEventListener("click", closeNavigation);
drawerScrim.addEventListener("click", closeNavigation);
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    closeNavigation();
    closePlaylistMenu();
    closeTrackMenu();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});

document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view as Page));
});

searchInput.addEventListener("input", renderPage);
searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && searchInput.value) {
    searchInput.value = "";
    renderPage();
  }
});

mainContent.addEventListener("click", (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trackButton = target.closest<HTMLElement>("[data-track-select]");
  if (trackButton?.dataset.trackSelect) {
    void playTrack(trackButton.dataset.trackSelect);
    renderPage();
    return;
  }
  const viewButton = target.closest<HTMLButtonElement>("[data-view]");
  if (viewButton?.dataset.view) {
    setView(viewButton.dataset.view as Page);
    return;
  }
  if (target.closest("#pageCreatePlaylist")) openCreateDialog(false);
  if (target.closest("[data-import-music]")) audioFiles.click();
  if (target.closest("#backToPlaylists")) { currentPlaylistId = null; renderPage(); }
  if (target.closest("#saveDiscordSettings")) {
    const input = document.querySelector<HTMLInputElement>("#discordClientId");
    const value = input?.value.trim() ?? "";
    if (value && !/^\d{5,24}$/.test(value)) {
      announce("Enter the numeric Application ID from the Discord Developer Portal.");
      input?.focus();
      return;
    }
    discordClientId = value;
    try { localStorage.setItem(discordClientIdKey, value); }
    catch { announce("The Discord Application ID could not be saved."); return; }
    if (!discordPresenceEnabled || !discordClientId) {
      discordPresenceStatus = discordPresenceEnabled ? "Add an Application ID" : "Off";
      void invoke("discord_presence_clear").catch(() => undefined);
    } else if (currentTrackId) {
      discordPresenceStatus = "Connecting…";
      syncDiscordPresence();
    } else discordPresenceStatus = "Saved · starts with playback";
    const state = document.querySelector<HTMLElement>("#discordPresenceState");
    if (state) state.textContent = discordPresenceStatus;
    announce(discordClientId ? "Discord settings saved." : "Discord Application ID cleared.");
  }
});

mainContent.addEventListener("change", (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== "pauseOnOutputDisconnect") return;
  pauseOnOutputDisconnect = target.checked;
  try {
    localStorage.setItem(audioDisconnectPreferenceKey, String(pauseOnOutputDisconnect));
  } catch {
    announce("This setting could not be saved.");
  }
  const state = document.querySelector<HTMLElement>("#audioOutputState");
  if (state) state.textContent = pauseOnOutputDisconnect ? "On" : "Off";
  announce(pauseOnOutputDisconnect ? "Auto-pause enabled for audio output changes." : "Auto-pause disabled.");
});

mainContent.addEventListener("change", (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== "discordPresenceEnabled") return;
  if (target.checked && !discordClientId) {
    target.checked = false;
    announce("Save a Discord Application ID before enabling Rich Presence.");
    return;
  }
  discordPresenceEnabled = target.checked;
  try { localStorage.setItem(discordEnabledKey, String(discordPresenceEnabled)); }
  catch { announce("This setting could not be saved."); }
  if (discordPresenceEnabled) {
    discordPresenceStatus = currentTrackId ? "Connecting…" : "On · starts with playback";
    syncDiscordPresence();
  } else {
    discordPresenceStatus = "Off";
    if (isTauri()) void invoke("discord_presence_clear").catch(() => undefined);
  }
  const state = document.querySelector<HTMLElement>("#discordPresenceState");
  if (state) state.textContent = discordPresenceStatus;
  announce(discordPresenceEnabled ? "Discord Rich Presence enabled." : "Discord Rich Presence disabled.");
});

document.addEventListener("click", (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("#playlistMenu") && !target.closest("#playlistButton")) closePlaylistMenu();
  if (!target.closest("#trackMenu") && !target.closest("#moreButton")) closeTrackMenu();
  const playlistOpen = target.closest<HTMLElement>("[data-playlist-open]");
  if (playlistOpen?.dataset.playlistOpen) {
    currentView = "playlists";
    currentPlaylistId = playlistOpen.dataset.playlistOpen;
    closeNavigation();
    renderPage();
  }
  const playlistAdd = target.closest<HTMLElement>("[data-playlist-add]");
  if (playlistAdd?.dataset.playlistAdd) {
    const playlist = playlists.find((item) => item.id === playlistAdd.dataset.playlistAdd);
    if (!playlist || !currentTrackId) return;
    if (playlist.trackIds.includes(currentTrackId)) {
      announce(`Already in ${playlist.name}.`);
    } else {
      playlist.trackIds.push(currentTrackId);
      persistPlaylists();
      updateNavPlaylists();
      announce(`Added to ${playlist.name}.`);
    }
    closePlaylistMenu();
  }
  if (target.closest("#notLikedOption") && currentTrackId) {
    const track = getTrack(currentTrackId);
    if (notLikedIds.has(currentTrackId)) {
      notLikedIds.delete(currentTrackId);
      announce(`Removed ${track.title} from Not Liked.`);
    } else {
      notLikedIds.add(currentTrackId);
      likedIds.delete(currentTrackId);
      persistLikes();
      announce(`Marked ${track.title} as not liked.`);
    }
    persistNotLiked();
    updatePlayer();
    if (currentView === "liked") renderPage();
    closeTrackMenu();
  }
});

likeButton.addEventListener("click", () => {
  if (!currentTrackId) return;
  if (likedIds.has(currentTrackId)) likedIds.delete(currentTrackId);
  else {
    likedIds.add(currentTrackId);
    notLikedIds.delete(currentTrackId);
    persistNotLiked();
  }
  persistLikes();
  updatePlayer();
  if (currentView === "liked") renderPage();
  announce(likedIds.has(currentTrackId) ? "Added to Liked Songs." : "Removed from Liked Songs.");
});

moreButton.addEventListener("click", () => trackMenu.hidden ? openTrackMenu() : closeTrackMenu());

document.querySelector<HTMLButtonElement>("#downloadButton")!.addEventListener("click", () => {
  announce("This track is already a local file. Viviette only exports MP3 when the source explicitly authorizes it.");
});

playlistButton.addEventListener("click", () => playlistMenu.hidden ? openPlaylistMenu() : closePlaylistMenu());
document.querySelector<HTMLButtonElement>("#createPlaylistOption")!.addEventListener("click", () => openCreateDialog(true));
document.querySelector<HTMLButtonElement>("#navCreatePlaylist")!.addEventListener("click", () => openCreateDialog(false));
document.querySelector<HTMLButtonElement>("#cancelCreate")!.addEventListener("click", () => createDialog.close());

createForm.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const name = playlistNameInput.value.trim();
  if (!name) return;
  const playlist: Playlist = { id: crypto.randomUUID(), name: name.slice(0, 48), trackIds: [] };
  if (addCurrentTrackAfterCreate && currentTrackId) playlist.trackIds.push(currentTrackId);
  playlists.unshift(playlist);
  persistPlaylists();
  updateNavPlaylists();
  playlistNameInput.value = "";
  createDialog.close();
  if (currentView === "playlists") renderPage();
  announce(addCurrentTrackAfterCreate && currentTrackId ? `Created ${playlist.name} and added ${getTrack(currentTrackId).title}.` : `Created ${playlist.name}.`);
  addCurrentTrackAfterCreate = false;
});

document.querySelectorAll<HTMLButtonElement>("[data-transport]").forEach((button) => {
  button.addEventListener("click", () => {
    switch (button.dataset.transport) {
      case "play": void togglePlayback(); break;
      case "previous": void playAdjacent(-1); break;
      case "next": void playAdjacent(1); break;
      case "shuffle": shuffleEnabled = !shuffleEnabled; updateTransport(); announce(shuffleEnabled ? "Shuffle is on." : "Shuffle is off."); break;
      case "repeat": repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off"; updateTransport(); announce(repeatMode === "one" ? "Repeating this track." : repeatMode === "all" ? "Repeating the queue." : "Repeat is off."); break;
    }
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-unavailable]").forEach((button) => {
  button.addEventListener("click", () => unavailable(button.dataset.unavailable ?? "Playback"));
});

document.querySelectorAll<HTMLButtonElement>("[data-player-extra]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.playerExtra === "lyrics") announce("Lyrics are not embedded or linked for this local track yet.");
    else announce(currentQueue.length ? `Queue contains ${currentQueue.length} tracks.` : "Choose a track to build a queue.");
  });
});

audioFiles.addEventListener("change", () => {
  if (audioFiles.files?.length) void importAudioFiles(audioFiles.files);
  audioFiles.value = "";
});

audioElement.addEventListener("loadedmetadata", () => {
  setPlaybackTime();
  syncDiscordPresence();
  if (!currentTrackId) return;
  const track = tracks.find((item) => item.id === currentTrackId);
  if (track && Number.isFinite(audioElement.duration) && audioElement.duration > 0 && track.duration !== audioElement.duration) {
    track.duration = audioElement.duration;
    void saveTrack(track);
  }
});
audioElement.addEventListener("timeupdate", setPlaybackTime);
audioElement.addEventListener("play", () => { updateTransport(); syncDiscordPresence(); });
audioElement.addEventListener("pause", () => { updateTransport(); syncDiscordPresence(); });
audioElement.addEventListener("ended", () => {
  if (repeatMode === "one") {
    audioElement.currentTime = 0;
    void audioElement.play();
  } else void playAdjacent(1);
});
audioElement.addEventListener("error", () => {
  const format = getTrack(currentTrackId).format;
  if (currentTrackId) announce(`This Windows WebView could not decode ${format || "this audio format"}. No conversion was attempted.`);
});
seekSlider.addEventListener("input", () => {
  if (!Number.isFinite(audioElement.duration) || !audioElement.duration) return;
  audioElement.currentTime = Number(seekSlider.value) / 10;
  setPlaybackTime();
});
seekSlider.addEventListener("change", syncDiscordPresence);
const storedVolume = readString("viviette.volume.v1");
const previousVolume = storedVolume.startsWith("[") ? readStringArray("viviette.volume.v1")[0] : storedVolume;
const parsedVolume = Number(previousVolume || "0.72");
volumeSlider.value = String(Number.isFinite(parsedVolume) ? Math.max(0, Math.min(1, parsedVolume)) : 0.72);
audioElement.volume = Number(volumeSlider.value);
let lastNonZeroVolume = audioElement.volume > 0 ? audioElement.volume : 0.72;
const updateVolumeControl = (): void => {
  const muted = audioElement.muted || audioElement.volume === 0;
  volumeToggle.classList.toggle("is-active", muted);
  volumeToggle.setAttribute("aria-label", muted ? "Unmute volume" : "Mute volume");
  volumeToggle.dataset.tooltip = muted ? "Unmute volume" : "Mute volume";
  volumeToggle.querySelector<SVGPathElement>("path")?.setAttribute("d", muted
    ? "M11 5 6 9H2v6h4l5 4V5Zm4 4 6 6m0-6-6 6"
    : "M11 5 6 9H2v6h4l5 4V5Zm4.54 3.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14");
  volumeSlider.style.setProperty("--seek-percent", `${audioElement.volume * 100}%`);
};
updateVolumeControl();
volumeSlider.addEventListener("input", () => {
  audioElement.volume = Number(volumeSlider.value);
  audioElement.muted = false;
  if (audioElement.volume > 0) lastNonZeroVolume = audioElement.volume;
  try { localStorage.setItem("viviette.volume.v1", volumeSlider.value); } catch { /* playback remains usable */ }
  updateVolumeControl();
});
volumeToggle.addEventListener("click", () => {
  if (audioElement.muted || audioElement.volume === 0) {
    audioElement.muted = false;
    audioElement.volume = lastNonZeroVolume;
  } else {
    lastNonZeroVolume = audioElement.volume;
    audioElement.volume = 0;
  }
  volumeSlider.value = String(audioElement.volume);
  try { localStorage.setItem("viviette.volume.v1", volumeSlider.value); } catch { /* playback remains usable */ }
  updateVolumeControl();
});

registerPlaybackAdapter({ isPlaying: () => !audioElement.paused, pause: async () => { audioElement.pause(); } });

if (isTauri()) {
  void listen<string>("discord-presence-status", (event) => {
    discordPresenceStatus = event.payload;
    const state = document.querySelector<HTMLElement>("#discordPresenceState");
    if (state) state.textContent = discordPresenceStatus;
  }).catch(() => undefined);
}

renderPage();
closeNavigation();
void loadLibrary();
void registerAudioOutputEvents();
