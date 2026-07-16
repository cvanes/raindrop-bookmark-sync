// Settings and sync-state persistence, backed by chrome.storage.local.

const SETTINGS_KEY = 'settings';
const SYNC_STATE_KEY = 'syncState';

export const DEFAULT_SETTINGS = {
  testToken: '',
  targetCollectionId: null, // raindrop collection mirrored onto the bookmarks bar
  targetCollectionPath: '',
  workspacesCollectionId: null, // root collection holding workspace sub-collections
  workspacesCollectionPath: '',
  autoSyncEnabled: true,
  syncIntervalMinutes: 15, // min 1
};

const DEFAULT_STATS = {
  lastSyncAt: null,
  lastSyncStatus: null,
  lastError: null,
  syncCount: 0,
  bookmarks: 0,
  folders: 0,
  created: 0,
  updated: 0,
  deleted: 0,
  apiCalls: 0,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...stored[SETTINGS_KEY] };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getSyncState() {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  const state = stored[SYNC_STATE_KEY];
  return {
    folderMap: { ...(state?.folderMap ?? {}) },
    bookmarkMap: { ...(state?.bookmarkMap ?? {}) },
    stats: { ...DEFAULT_STATS, ...state?.stats },
  };
}

export async function saveSyncState(state) {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
  return state;
}

export async function updateStats(patch) {
  const state = await getSyncState();
  const next = { ...state, stats: { ...state.stats, ...patch } };
  await saveSyncState(next);
  return next;
}
