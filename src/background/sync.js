// Sync engine: pull reconcile (Raindrop wins) + immediate local -> Raindrop push handlers.
// The whole bookmarks bar subtree mirrors the target collection's subtree.

import { RaindropApi } from '../lib/api.js';
import {
  getSettings,
  getSyncState,
  saveSyncState,
  updateStats,
} from '../lib/settings.js';

// --- Module state ---------------------------------------------------------

let muted = false; // best-effort in-memory guard while we mutate bookmarks
let inFlight = null; // coalesces concurrent fullSync() callers
let pushQueue = Promise.resolve(); // serialises push handlers

export function isMuted() {
  return muted;
}

// --- Bookmarks bar location ----------------------------------------------

// Chrome and Edge both use node id '1' for the bar; fall back to the first
// folder child of the root if that is ever not the case.
export async function getBarNodeId() {
  const [root] = await chrome.bookmarks.getTree();
  const children = root.children || [];
  const bar = children.find((c) => c.id === '1') || children.find((c) => !c.url);
  if (!bar) throw new Error('Could not locate the bookmarks bar');
  return bar.id;
}

// --- Full sync (Raindrop wins) -------------------------------------------

export async function fullSync() {
  if (inFlight) return inFlight;
  inFlight = runFullSync();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runFullSync() {
  const settings = await getSettings();
  if (!settings.testToken || !settings.targetCollectionId) {
    await updateStats({
      lastSyncStatus: 'error',
      lastError: 'Not configured: set a test token and a target collection',
    });
    return (await getSyncState()).stats;
  }

  const api = new RaindropApi(settings.testToken);
  const prev = await getSyncState();
  const counters = newCounters();

  muted = true;
  try {
    await drainPendingDeletions(api, prev);
    const collections = await api.getAllCollections();
    const byParent = groupCollectionsByParent(collections);

    const ctx = {
      api,
      byParent,
      oldFolderMap: prev.folderMap || {},
      oldBookmarkMap: prev.bookmarkMap || {},
      newFolderMap: {},
      newBookmarkMap: {},
      counters,
    };

    const barId = await getBarNodeId();
    await reconcilePair(settings.targetCollectionId, barId, ctx);

    const stats = buildStats(prev.stats || {}, ctx, api, 'ok', null);
    // Re-read pending deletions: a push handler may have queued one mid-sync.
    const current = await getSyncState();
    await saveSyncState({
      folderMap: ctx.newFolderMap,
      bookmarkMap: ctx.newBookmarkMap,
      pendingDeletions: current.pendingDeletions,
      stats,
    });
    return stats;
  } catch (err) {
    await updateStats({ lastSyncStatus: 'error', lastError: err.message });
    throw err;
  } finally {
    muted = false;
  }
}

// Apply remote deletes that previously failed (e.g. offline). Reconciling
// without them would resurrect the deleted items locally, so abort the sync
// if any still cannot be applied.
async function drainPendingDeletions(api, state) {
  const pending = state.pendingDeletions || [];
  if (pending.length === 0) return;

  const remaining = [];
  for (const d of pending) {
    try {
      if (d.type === 'collection') await api.deleteCollection(d.id);
      else await api.deleteRaindrop(d.id);
    } catch (err) {
      if (!/status 404/.test(err.message)) remaining.push(d); // 404: already gone
    }
  }
  state.pendingDeletions = remaining;
  await saveSyncState(state);
  if (remaining.length > 0) {
    throw new Error(`Could not apply ${remaining.length} pending remote deletion(s)`);
  }
}

function buildStats(prevStats, ctx, api, status, error) {
  return {
    lastSyncAt: Date.now(),
    lastSyncStatus: status,
    lastError: error,
    syncCount: (prevStats.syncCount || 0) + 1,
    bookmarks: Object.keys(ctx.newBookmarkMap).length,
    folders: Object.keys(ctx.newFolderMap).length,
    created: (prevStats.created || 0) + ctx.counters.created,
    updated: (prevStats.updated || 0) + ctx.counters.updated,
    deleted: (prevStats.deleted || 0) + ctx.counters.deleted,
    apiCalls: (prevStats.apiCalls || 0) + api.apiCallCount,
  };
}

function groupCollectionsByParent(collections) {
  const byParent = new Map();
  for (const c of collections) {
    const pid = c.parent && c.parent.$id != null ? c.parent.$id : null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(c);
  }
  return byParent;
}

// Reconcile one (collectionId, folderNodeId) pair depth-first. Maps are
// rebuilt fresh from surviving matches, so stale entries are pruned.
async function reconcilePair(collectionId, folderNodeId, ctx) {
  const { api, byParent, oldFolderMap, oldBookmarkMap, newFolderMap, newBookmarkMap, counters } = ctx;

  const childCollections = byParent.get(collectionId) || [];
  const raindrops = await api.getRaindrops(collectionId);
  const children = await chrome.bookmarks.getChildren(folderNodeId);
  const localFolders = children.filter((c) => !c.url);
  const localBookmarks = children.filter((c) => c.url);

  await reconcileBookmarks({
    api, collectionId, folderNodeId, raindrops, localBookmarks,
    oldBookmarkMap, newBookmarkMap, counters,
  });

  await reconcileFolders({
    api, collectionId, folderNodeId, childCollections, localFolders,
    oldFolderMap, newFolderMap, counters, ctx,
  });

  await enforceOrdering(folderNodeId);
}

// Keep every synced folder sorted: folders first, then bookmarks, both
// alphabetical. Runs while muted, so these moves are never pushed.
async function enforceOrdering(folderNodeId) {
  const children = await chrome.bookmarks.getChildren(folderNodeId);
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  const desired = [
    ...children.filter((c) => !c.url).sort(byTitle),
    ...children.filter((c) => c.url).sort(byTitle),
  ];

  const current = [...children];
  for (let i = 0; i < desired.length; i++) {
    if (current[i].id === desired[i].id) continue;
    await chrome.bookmarks.move(desired[i].id, { parentId: folderNodeId, index: i });
    const from = current.findIndex((c) => c.id === desired[i].id);
    current.splice(from, 1);
    current.splice(i, 0, desired[i]);
  }
}

async function reconcileBookmarks(p) {
  const { api, collectionId, folderNodeId, raindrops, localBookmarks, oldBookmarkMap, newBookmarkMap, counters } = p;
  const available = new Set(localBookmarks.map((b) => b.id));

  for (const rd of raindrops) {
    let match = localBookmarks.find((b) => available.has(b.id) && oldBookmarkMap[b.id] === rd._id);
    if (!match) match = localBookmarks.find((b) => available.has(b.id) && b.url === rd.link);

    if (match) {
      available.delete(match.id);
      if (match.title !== rd.title || match.url !== rd.link) {
        await chrome.bookmarks.update(match.id, { title: rd.title, url: rd.link });
        counters.updated++;
      }
      newBookmarkMap[match.id] = rd._id;
    } else {
      const created = await chrome.bookmarks.create({ parentId: folderNodeId, title: rd.title, url: rd.link });
      newBookmarkMap[created.id] = rd._id;
      counters.created++;
    }
  }

  for (const b of localBookmarks) {
    if (!available.has(b.id)) continue;
    if (oldBookmarkMap[b.id]) {
      // Was mapped but its raindrop is gone -> deleted in Raindrop.
      await chrome.bookmarks.remove(b.id);
      counters.deleted++;
    } else {
      // New locally -> push it up instead of deleting.
      const item = await api.createRaindrop({ link: b.url, title: b.title, collectionId });
      newBookmarkMap[b.id] = item._id;
      counters.created++;
    }
  }
}

async function reconcileFolders(p) {
  const { api, collectionId, folderNodeId, childCollections, localFolders, oldFolderMap, newFolderMap, counters, ctx } = p;
  const available = new Set(localFolders.map((f) => f.id));

  for (const cc of childCollections) {
    let match = localFolders.find((f) => available.has(f.id) && oldFolderMap[f.id] === cc._id);
    if (!match) match = localFolders.find((f) => available.has(f.id) && f.title === cc.title);

    let childNodeId;
    if (match) {
      available.delete(match.id);
      if (match.title !== cc.title) {
        await chrome.bookmarks.update(match.id, { title: cc.title });
        counters.updated++;
      }
      childNodeId = match.id;
    } else {
      const created = await chrome.bookmarks.create({ parentId: folderNodeId, title: cc.title });
      childNodeId = created.id;
      counters.created++;
    }
    newFolderMap[childNodeId] = cc._id;
    await reconcilePair(cc._id, childNodeId, ctx);
  }

  for (const f of localFolders) {
    if (!available.has(f.id)) continue;
    if (oldFolderMap[f.id]) {
      // Was mapped but its collection is gone -> remove local folder tree.
      // Its descendants simply never get re-added to the fresh maps.
      await chrome.bookmarks.removeTree(f.id);
      counters.deleted++;
    } else {
      // New folder locally -> create the collection, then recurse as a
      // matched pair so its contents get pushed up too.
      const item = await api.createCollection(f.title, collectionId);
      newFolderMap[f.id] = item._id;
      counters.created++;
      await reconcilePair(item._id, f.id, ctx);
    }
  }
}

// --- Push handlers (local -> Raindrop) -----------------------------------

function enqueue(work) {
  pushQueue = pushQueue.then(work).catch((err) => console.error('Push handler failed:', err));
  return pushQueue;
}

export async function handleBookmarkCreated(id, node) {
  await enqueue(async () => {
    if (muted) return;
    const ctx = await pushContext();
    if (!ctx) return;
    const { api, state, barId, settings } = ctx;
    if (!(await isInBarSubtree(id, barId))) return;
    // Already mapped: this event came from our own sync mutations.
    if (state.bookmarkMap[id] || state.folderMap[id]) return;

    const parentCol = resolveParentCollectionId(node.parentId, state.folderMap, barId, settings.targetCollectionId);
    if (!parentCol) return;

    const counters = newCounters();
    try {
      await pushNode(node, parentCol, api, state, counters);
    } catch (err) {
      schedulePushRetry(err);
    } finally {
      await finishPush(state, api, counters);
    }
  });
}

export async function handleBookmarkChanged(id, changeInfo) {
  await enqueue(async () => {
    if (muted) return;
    const ctx = await pushContext();
    if (!ctx) return;
    const { api, state, barId } = ctx;
    if (!(await isInBarSubtree(id, barId))) return;

    const counters = newCounters();
    try {
      const rdId = state.bookmarkMap[id];
      if (rdId) {
        const [node] = await chrome.bookmarks.get(id);
        await api.updateRaindrop(rdId, { link: node.url, title: node.title });
        counters.updated++;
      } else {
        const colId = state.folderMap[id];
        if (colId && changeInfo.title != null) {
          await api.updateCollection(colId, { title: changeInfo.title });
          counters.updated++;
        }
      }
    } catch (err) {
      schedulePushRetry(err);
    } finally {
      await finishPush(state, api, counters);
    }
  });
}

export async function handleBookmarkMoved(id, moveInfo) {
  await enqueue(async () => {
    if (muted) return;
    if (moveInfo.parentId === moveInfo.oldParentId) return; // reorder only
    const ctx = await pushContext();
    if (!ctx) return;
    const { api, state, barId, settings } = ctx;

    const nowIn = await isInBarSubtree(moveInfo.parentId, barId);
    const wasIn = await isInBarSubtree(moveInfo.oldParentId, barId);
    if (!nowIn && !wasIn) return;

    const counters = newCounters();
    try {
      if (nowIn && !wasIn) {
        const parentCol = resolveParentCollectionId(moveInfo.parentId, state.folderMap, barId, settings.targetCollectionId);
        if (parentCol) {
          const [node] = await chrome.bookmarks.get(id);
          await pushNode(node, parentCol, api, state, counters);
        }
      } else if (!nowIn && wasIn) {
        await deleteRemoteForNode(id, api, state, counters);
      } else {
        // Moved within the subtree -> re-parent remotely.
        const parentCol = resolveParentCollectionId(moveInfo.parentId, state.folderMap, barId, settings.targetCollectionId);
        const rdId = state.bookmarkMap[id];
        const colId = state.folderMap[id];
        if (rdId && parentCol) {
          await api.updateRaindrop(rdId, { collectionId: parentCol });
          counters.updated++;
        } else if (colId && parentCol) {
          await api.updateCollection(colId, { parent: { $id: parentCol } });
          counters.updated++;
        } else if (parentCol) {
          const [node] = await chrome.bookmarks.get(id);
          await pushNode(node, parentCol, api, state, counters);
        }
      }
    } catch (err) {
      schedulePushRetry(err);
    } finally {
      await finishPush(state, api, counters);
    }
  });
}

export async function handleBookmarkRemoved(id, removeInfo) {
  await enqueue(async () => {
    if (muted) return;
    const ctx = await pushContext();
    if (!ctx) return;
    const { api, state, barId } = ctx;
    if (!(await isInBarSubtree(removeInfo.parentId, barId))) return;

    const counters = newCounters();
    await deleteRemovedNode(removeInfo.node, id, api, state, counters);
    await finishPush(state, api, counters);
  });
}

// --- Push helpers ---------------------------------------------------------

async function pushContext() {
  const settings = await getSettings();
  if (!settings.testToken || !settings.targetCollectionId) return null;
  const barId = await getBarNodeId();
  const api = new RaindropApi(settings.testToken);
  const state = await getSyncState();
  state.folderMap = state.folderMap || {};
  state.bookmarkMap = state.bookmarkMap || {};
  return { settings, barId, api, state };
}

function resolveParentCollectionId(parentNodeId, folderMap, barId, targetId) {
  if (parentNodeId === barId) return targetId;
  return folderMap[parentNodeId] || null;
}

// Walk the parentId chain up to the bar node. nodeId may be the bar itself.
async function isInBarSubtree(nodeId, barId) {
  let currentId = nodeId;
  while (currentId) {
    if (currentId === barId) return true;
    let node;
    try {
      [node] = await chrome.bookmarks.get(currentId);
    } catch {
      return false;
    }
    if (!node || !node.parentId) return false;
    currentId = node.parentId;
  }
  return false;
}

// Create a node (and, for folders, all its descendants) remotely.
async function pushNode(node, parentCollectionId, api, state, counters) {
  if (node.url) {
    const item = await api.createRaindrop({ link: node.url, title: node.title, collectionId: parentCollectionId });
    state.bookmarkMap[node.id] = item._id;
    counters.created++;
    return;
  }
  const collection = await api.createCollection(node.title, parentCollectionId);
  state.folderMap[node.id] = collection._id;
  counters.created++;
  const children = await chrome.bookmarks.getChildren(node.id);
  for (const child of children) {
    await pushNode(child, collection._id, api, state, counters);
  }
}

// Attempt a remote delete; on failure queue it durably so the next sync can
// apply it before reconciling (otherwise the item would be resurrected).
async function attemptRemoteDelete(type, remoteId, api, state, counters) {
  try {
    if (type === 'collection') await api.deleteCollection(remoteId);
    else await api.deleteRaindrop(remoteId);
    counters.deleted++;
  } catch (err) {
    state.pendingDeletions.push({ type, id: remoteId });
    schedulePushRetry(err);
  }
}

// Delete the remote for a node still present locally (used when moved out).
async function deleteRemoteForNode(id, api, state, counters) {
  const rdId = state.bookmarkMap[id];
  if (rdId) {
    await attemptRemoteDelete('raindrop', rdId, api, state, counters);
    delete state.bookmarkMap[id];
    return;
  }
  const colId = state.folderMap[id];
  if (colId) {
    // Raindrop trashes the collection's contents with it.
    await attemptRemoteDelete('collection', colId, api, state, counters);
    await dropSubtreeMaps(id, state);
    delete state.folderMap[id];
  }
}

// Delete the remote for a removed node, using removeInfo.node (which still
// carries the removed subtree) since the node is gone from the tree.
async function deleteRemovedNode(node, id, api, state, counters) {
  if (node.url) {
    const rdId = state.bookmarkMap[id];
    if (rdId) await attemptRemoteDelete('raindrop', rdId, api, state, counters);
    delete state.bookmarkMap[id];
    return;
  }
  const colId = state.folderMap[id];
  if (colId) await attemptRemoteDelete('collection', colId, api, state, counters);
  delete state.folderMap[id];
  dropMapsFromNode(node, state);
}

// Drop map entries for a live subtree (walks the bookmarks tree).
async function dropSubtreeMaps(nodeId, state) {
  const children = await chrome.bookmarks.getChildren(nodeId);
  for (const child of children) {
    delete state.bookmarkMap[child.id];
    if (!child.url) await dropSubtreeMaps(child.id, state);
    delete state.folderMap[child.id];
  }
}

// Drop map entries from a detached node object (removeInfo.node.children).
function dropMapsFromNode(node, state) {
  for (const child of node.children || []) {
    delete state.bookmarkMap[child.id];
    delete state.folderMap[child.id];
    dropMapsFromNode(child, state);
  }
}

async function finishPush(state, api, counters) {
  const s = state.stats || {};
  state.stats = {
    ...s,
    created: (s.created || 0) + counters.created,
    updated: (s.updated || 0) + counters.updated,
    deleted: (s.deleted || 0) + counters.deleted,
    apiCalls: (s.apiCalls || 0) + api.apiCallCount,
    bookmarks: Object.keys(state.bookmarkMap).length,
    folders: Object.keys(state.folderMap).length,
  };
  await saveSyncState(state);
}

function newCounters() {
  return { created: 0, updated: 0, deleted: 0 };
}

// A push failed (e.g. offline): log it and schedule a sync to converge.
// The 'retry-sync' alarm is handled by the service worker alongside the
// periodic one.
function schedulePushRetry(err) {
  console.error('Push to Raindrop failed, will retry via sync:', err);
  chrome.alarms.create('retry-sync', { delayInMinutes: 1 });
}
