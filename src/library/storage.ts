export type LibraryTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  fileName: string;
  sourceKey: string;
  format: string;
  mimeType: string;
  duration: number;
  size: number;
  addedAt: number;
  art: string;
};

type StoredAudio = { id: string; blob: Blob };

const databaseName = "viviette-library";
const databaseVersion = 1;
let databasePromise: Promise<IDBDatabase> | undefined;

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("tracks")) database.createObjectStore("tracks", { keyPath: "id" });
      if (!database.objectStoreNames.contains("audio")) database.createObjectStore("audio", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local library."));
  });
  return databasePromise;
};

export const listTracks = async (): Promise<LibraryTrack[]> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("tracks", "readonly").objectStore("tracks").getAll();
    request.onsuccess = () => resolve((request.result as LibraryTrack[]).sort((a, b) => a.title.localeCompare(b.title)));
    request.onerror = () => reject(request.error ?? new Error("Could not read the local library."));
  });
};

export const getTrackAudio = async (id: string): Promise<Blob | null> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("audio", "readonly").objectStore("audio").get(id);
    request.onsuccess = () => resolve((request.result as StoredAudio | undefined)?.blob ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not open this local track."));
  });
};

export const saveTrack = async (track: LibraryTrack, blob?: Blob): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = blob ? ["tracks", "audio"] : ["tracks"];
    const transaction = database.transaction(stores, "readwrite");
    transaction.objectStore("tracks").put(track);
    if (blob) transaction.objectStore("audio").put({ id: track.id, blob } satisfies StoredAudio);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save this track."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving this track was cancelled."));
  });
};

export const removeTrack = async (id: string): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["tracks", "audio"], "readwrite");
    transaction.objectStore("tracks").delete(id);
    transaction.objectStore("audio").delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove this track."));
  });
};
