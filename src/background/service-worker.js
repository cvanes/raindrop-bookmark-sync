// MV3 service worker: bookmark event wiring, periodic-sync alarm, message router.

import {
  fullSync,
  resetSyncMappings,
  handleBookmarkCreated,
  handleBookmarkChanged,
  handleBookmarkMoved,
  handleBookmarkRemoved,
} from './sync.js';
import { saveWorkspace, listWorkspaces, loadWorkspace, updateWorkspace, deleteWorkspace } from './workspaces.js';
import { getSettings, getSyncState } from '../lib/settings.js';
import { RaindropApi } from '../lib/api.js';

const ALARM_NAME = 'periodic-sync';

// --- Bookmark listeners (registered at top level for MV3) -----------------

chrome.bookmarks.onCreated.addListener(handleBookmarkCreated);
chrome.bookmarks.onChanged.addListener(handleBookmarkChanged);
chrome.bookmarks.onMoved.addListener(handleBookmarkMoved);
chrome.bookmarks.onRemoved.addListener(handleBookmarkRemoved);

// --- Lifecycle & alarm ----------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  setupAlarm();
  maybeInitialSync();
  // On first install, take the user straight to setup.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  maybeInitialSync();
});

// Re-arm the alarm whenever settings change (ignore lone syncState writes).
// When the target collection changes, the stored id mappings refer to the old
// collection and would cause the next reconcile to delete the whole bar, so
// reset them and kick off a fresh union-merge sync into the new target.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === 'syncState') return;
  setupAlarm();

  const settings = changes.settings;
  const oldTarget = settings?.oldValue?.targetCollectionId;
  const newTarget = settings?.newValue?.targetCollectionId;
  if (oldTarget != null && newTarget != null && newTarget !== oldTarget) {
    resetSyncMappings()
      .then(() => fullSync())
      .catch((err) => console.error('Resync after target change failed:', err));
  }
});

// 'retry-sync' is a one-shot alarm scheduled by sync.js after a failed push.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME && alarm.name !== 'retry-sync') return;
  fullSync().catch((err) => console.error('Sync failed:', err));
});

async function setupAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.autoSyncEnabled) {
    const periodInMinutes = Math.max(1, settings.syncIntervalMinutes || 1);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes });
  }
}

async function maybeInitialSync() {
  const settings = await getSettings();
  if (settings.autoSyncEnabled && settings.testToken && settings.targetCollectionId) {
    fullSync().catch((err) => console.error('Startup sync failed:', err));
  }
}

// --- Message router -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'sync-now':
      return await fullSync();

    case 'force-resync':
      await resetSyncMappings();
      return await fullSync();

    case 'get-status': {
      const settings = await getSettings();
      const state = await getSyncState();
      return { settings, stats: state.stats };
    }

    case 'validate-token': {
      const api = new RaindropApi(message.token);
      const user = await api.getUser();
      return { fullName: user.fullName, email: user.email };
    }

    case 'get-collections': {
      const settings = await getSettings();
      const api = new RaindropApi(message.token || settings.testToken);
      return await api.getAllCollections();
    }

    case 'save-workspace':
      return await saveWorkspace(message.name, message.closeWindow !== false);

    case 'list-workspaces':
      return await listWorkspaces();

    case 'load-workspace':
      await loadWorkspace(message.collectionId);
      return { opened: true };

    case 'update-workspace':
      return await updateWorkspace(message.collectionId, message.closeWindow !== false);

    case 'delete-workspace':
      await deleteWorkspace(message.collectionId);
      return { deleted: true };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
