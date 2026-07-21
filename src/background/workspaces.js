// Workspaces: save/load all tabs of a window as a Raindrop sub-collection.

import { RaindropApi, findCollectionIdByPath } from '../lib/api.js';
import { getSettings, saveSettings, DEFAULT_WORKSPACES_PATH } from '../lib/settings.js';

const HTTP_URL = /^https?:\/\//i;

// Explicit workspaces root wins; otherwise resolve the default path and persist
// it so a fresh machine works without reconfiguring.
async function resolveWorkspacesCollectionId(settings, collections) {
  if (settings.workspacesCollectionId) return settings.workspacesCollectionId;
  const id = findCollectionIdByPath(collections, DEFAULT_WORKSPACES_PATH);
  if (id) await saveSettings({ workspacesCollectionId: id, workspacesCollectionPath: DEFAULT_WORKSPACES_PATH });
  return id;
}

export async function saveWorkspace(name, closeWindow = true) {
  const settings = await getSettings();
  if (!settings.testToken) throw new Error('Test token not configured. Add one in the options page.');
  const title = (name || '').trim();
  if (!title) throw new Error('A workspace name is required');

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const webTabs = tabs.filter((t) => t.url && HTTP_URL.test(t.url));
  if (webTabs.length === 0) throw new Error('This window has no http(s) tabs to save');

  const api = new RaindropApi(settings.testToken);
  const parentId = await resolveWorkspacesCollectionId(settings, await api.getAllCollections());
  if (!parentId) {
    throw new Error(`Workspaces collection not configured. Choose one, or create "${DEFAULT_WORKSPACES_PATH}".`);
  }
  const collection = await api.createCollection(title, parentId);
  // Pinned state is stored as a tag and tab order via the order field, so
  // loading the workspace can restore the window faithfully.
  const items = webTabs.map((t, index) => ({
    link: t.url,
    title: t.title || t.url,
    collectionId: collection._id,
    order: index,
    tags: t.pinned ? ['pinned'] : [],
  }));
  await api.createRaindrops(items);

  if (closeWindow) await chrome.windows.remove(webTabs[0].windowId);

  return { id: collection._id, title: collection.title, count: items.length };
}

export async function listWorkspaces() {
  const settings = await getSettings();
  if (!settings.testToken) return [];

  const api = new RaindropApi(settings.testToken);
  const collections = await api.getAllCollections();
  const parentId = await resolveWorkspacesCollectionId(settings, collections);
  if (!parentId) return [];
  return collections
    .filter((c) => c.parent && c.parent.$id === parentId)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((c) => ({ id: c._id, title: c.title, count: c.count || 0 }));
}

// Replace an existing workspace's contents with the current window's tabs.
// The collection (and its id) survive; the old raindrops go to Trash.
export async function updateWorkspace(collectionId, closeWindow = true) {
  const settings = await getSettings();
  if (!settings.testToken) throw new Error('Test token not configured. Add one in the options page.');

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const webTabs = tabs.filter((t) => t.url && HTTP_URL.test(t.url));
  if (webTabs.length === 0) throw new Error('This window has no http(s) tabs to save');

  const api = new RaindropApi(settings.testToken);
  await api.deleteAllRaindrops(collectionId);
  const items = webTabs.map((t, index) => ({
    link: t.url,
    title: t.title || t.url,
    collectionId,
    order: index,
    tags: t.pinned ? ['pinned'] : [],
  }));
  await api.createRaindrops(items);

  if (closeWindow) await chrome.windows.remove(webTabs[0].windowId);
  return { id: collectionId, count: items.length };
}

export async function deleteWorkspace(collectionId) {
  const settings = await getSettings();
  const api = new RaindropApi(settings.testToken);
  await api.deleteCollection(collectionId); // its raindrops go to Raindrop's trash
}

export async function loadWorkspace(collectionId) {
  const settings = await getSettings();
  const api = new RaindropApi(settings.testToken);
  const raindrops = await api.getRaindrops(collectionId);
  if (!raindrops || raindrops.length === 0) {
    throw new Error('This workspace has no bookmarks to open');
  }
  // Restore the saved tab order and pinned state (see saveWorkspace).
  const ordered = raindrops
    .filter((r) => r.link)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const win = await chrome.windows.create({ url: ordered.map((r) => r.link) });
  await Promise.all(ordered.map((r, index) => {
    const tab = win.tabs && win.tabs[index];
    if (!tab || !(r.tags || []).includes('pinned')) return null;
    return chrome.tabs.update(tab.id, { pinned: true });
  }));
}
