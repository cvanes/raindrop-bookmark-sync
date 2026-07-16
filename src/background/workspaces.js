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
  const items = webTabs.map((t) => ({
    link: t.url,
    title: t.title || t.url,
    collectionId: collection._id,
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

export async function loadWorkspace(collectionId) {
  const settings = await getSettings();
  const api = new RaindropApi(settings.testToken);
  const raindrops = await api.getRaindrops(collectionId);
  if (!raindrops || raindrops.length === 0) {
    throw new Error('This workspace has no bookmarks to open');
  }
  const urls = raindrops.map((r) => r.link).filter(Boolean);
  await chrome.windows.create({ url: urls });
}
