/**
 * Provider-neutral control surface for native device-loss events.
 * A licensed playback provider can register its controller here without
 * coupling the Windows audio monitor to provider-specific APIs.
 */
export interface PlaybackAdapter {
  isPlaying(): boolean;
  pause(): Promise<void>;
}

let activeAdapter: PlaybackAdapter | null = null;

export const registerPlaybackAdapter = (adapter: PlaybackAdapter | null): (() => void) => {
  activeAdapter = adapter;
  return () => {
    if (activeAdapter === adapter) activeAdapter = null;
  };
};

export const pauseActivePlayback = async (): Promise<boolean> => {
  if (!activeAdapter?.isPlaying()) return false;
  await activeAdapter.pause();
  return true;
};
