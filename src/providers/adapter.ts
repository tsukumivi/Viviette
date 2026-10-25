/** Normalized metadata shared by licensed provider integrations. */
export type ProviderTrack = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  artworkUrl?: string;
  /** The source's actual declared quality, never a quality inferred from a container name. */
  audioQuality: "lossy" | "lossless" | "hi-res-lossless" | "unknown";
  codec?: string;
  sampleRateHz?: number;
  bitDepth?: number;
  explicit?: boolean;
};

export type ProviderCapabilities = {
  /** True only when the provider documents and authorizes playback in this client. */
  playback: boolean;
  /** True only if the provider permits exporting the original audio as MP3. */
  mp3Export: boolean;
  losslessPlayback: boolean;
  gaplessPlayback: boolean;
};

export interface ProviderPlaybackSession {
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionSeconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getPositionSeconds(): number;
  getIsPlaying(): boolean;
  stop(): Promise<void>;
}

/** Provider adapters own authentication and SDK details; secrets stay in native secure storage. */
export interface MusicProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  search(query: string): Promise<ProviderTrack[]>;
  startPlayback(track: ProviderTrack): Promise<ProviderPlaybackSession>;
  exportMp3?(track: ProviderTrack): Promise<Blob>;
}
