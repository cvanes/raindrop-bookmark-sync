// Workspaces: save/load all tabs of a window as a Raindrop sub-collection.

import { RaindropApi } from '../lib/api.js';
import { getSettings } from '../lib/settings.js';

const HTTP_URL = /^https?:\/\//i;

export async function saveWorkspace(name) {
  const settings = await getSettings();
  if (!settings.testToken) throw new Error('Test token not configured. Add one in the options page.');
  if (!settings.workspacesCollectionId) {
    throw new Error('Workspaces collection not configured. Choose one in the options page.');
  }
  const title = (name || '').trim();
  if (!title) throw new Error('A workspace name is required');

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const webTabs = tabs.filter((t) => t.url && HTTP_URL.test(t.url));
  if (webTabs.length === 0) throw new Error('This window has no http(s) tabs to save');

  const api = new RaindropApi(settings.testToken);
  const collection = await api.createCollection(title, settings.workspacesCollectionId);
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

  // The window's tabs are now safely in Raindrop, so close the window.
  await chrome.windows.remove(webTabs[0].windowId);

  return { id: collection._id, title: collection.title, count: items.length };
}

export async function listWorkspaces() {
  const settings = await getSettings();
  if (!settings.workspacesCollectionId) return [];

  const api = new RaindropApi(settings.testToken);
  const collections = await api.getAllCollections();
  return collections
    .filter((c) => c.parent && c.parent.$id === settings.workspacesCollectionId)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((c) => ({ id: c._id, title: c.title, count: c.count || 0 }));
}

// Replace an existing workspace's contents with the current window's tabs.
// The collection (and its id) survive; the old raindrops go to Trash.
export async function updateWorkspace(collectionId) {
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

  await chrome.windows.remove(webTabs[0].windowId);
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
