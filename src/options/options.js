import { getSettings, saveSettings } from '../lib/settings.js';
import { buildCollectionTree, collectionPath } from '../lib/api.js';

const DEBOUNCE_MS = 600;

const els = {
  tokenInput: document.getElementById('token-input'),
  tokenToggle: document.getElementById('token-toggle-visibility'),
  verifyBtn: document.getElementById('verify-token-btn'),
  accountStatus: document.getElementById('account-status'),

  targetTree: document.getElementById('target-tree'),
  targetSelectedPath: document.getElementById('target-selected-path'),
  targetTreeStatus: document.getElementById('target-tree-status'),
  refreshCollectionsBtn: document.getElementById('refresh-collections-btn'),

  autoSyncToggle: document.getElementById('auto-sync-toggle'),
  syncIntervalInput: document.getElementById('sync-interval-input'),

  workspacesTree: document.getElementById('workspaces-tree'),
  workspacesSelectedPath: document.getElementById('workspaces-selected-path'),
  workspacesTreeStatus: document.getElementById('workspaces-tree-status'),
  refreshWorkspacesBtn: document.getElementById('refresh-workspaces-collections-btn'),

  statsGrid: document.getElementById('stats-grid'),
  lastSyncDot: document.getElementById('last-sync-dot'),
  lastSyncValue: document.getElementById('stat-last-sync-value'),
  lastSyncError: document.getElementById('stat-last-sync-error'),
  statBookmarks: document.getElementById('stat-bookmarks'),
  statFolders: document.getElementById('stat-folders'),
  statCreated: document.getElementById('stat-created'),
  statUpdated: document.getElementById('stat-updated'),
  statDeleted: document.getElementById('stat-deleted'),
  statSyncs: document.getElementById('stat-syncs'),
  statApiCalls: document.getElementById('stat-api-calls'),
  syncNowBtn: document.getElementById('sync-now-btn'),
  syncNowSpinner: document.getElementById('sync-now-spinner'),
  syncNowLabel: document.getElementById('sync-now-label'),
  syncNowStatus: document.getElementById('sync-now-status'),
  forceResyncBtn: document.getElementById('force-resync-btn'),
  forceResyncLabel: document.getElementById('force-resync-label'),

  toast: document.getElementById('toast'),
};

/** @type {{settings: object, collections: Array<object>}} */
const state = {
  settings: null,
  collections: [],
};

let intervalDebounceTimer = null;
let toastTimer = null;

init();

async function init() {
  wireStaticControls();
  await loadSettings();
  await refreshStatus();
}

async function loadSettings() {
  try {
    state.settings = await getSettings();
    populateControls(state.settings);
  } catch (err) {
    showToast(describeError(err), true);
  }
}

function populateControls(settings) {
  els.tokenInput.value = settings.testToken || '';
  els.autoSyncToggle.checked = !!settings.autoSyncEnabled;
  els.syncIntervalInput.value = settings.syncIntervalMinutes || 1;
  els.targetSelectedPath.textContent = settings.targetCollectionPath || 'None';
  els.workspacesSelectedPath.textContent = settings.workspacesCollectionPath || 'None';
}

function wireStaticControls() {
  els.tokenToggle.addEventListener('click', onToggleTokenVisibility);
  els.verifyBtn.addEventListener('click', onVerifyToken);
  els.tokenInput.addEventListener('change', onTokenChange);

  els.refreshCollectionsBtn.addEventListener('click', () => fetchCollections('target'));
  els.refreshWorkspacesBtn.addEventListener('click', () => fetchCollections('workspaces'));

  els.autoSyncToggle.addEventListener('change', onAutoSyncToggle);
  els.syncIntervalInput.addEventListener('input', onSyncIntervalInput);

  els.syncNowBtn.addEventListener('click', () => runSync('sync-now'));
  els.forceResyncBtn.addEventListener('click', () => runSync('force-resync'));
}

/* ---------------- Account / token ---------------- */

function onToggleTokenVisibility() {
  const showing = els.tokenInput.type === 'text';
  els.tokenInput.type = showing ? 'password' : 'text';
  els.tokenToggle.setAttribute('aria-pressed', String(!showing));
  els.tokenToggle.setAttribute('aria-label', showing ? 'Show token' : 'Hide token');
}

async function onTokenChange() {
  const testToken = els.tokenInput.value.trim();
  await persistSettings({ testToken });
}

async function onVerifyToken() {
  const token = els.tokenInput.value.trim();
  if (!token) {
    setStatusLine(els.accountStatus, 'Enter a test token first.', true);
    return;
  }
  els.verifyBtn.disabled = true;
  setStatusLine(els.accountStatus, 'Verifying…', false);
  try {
    const response = await sendMessage({ type: 'validate-token', token });
    if (!response.ok) {
      setStatusLine(els.accountStatus, response.error || 'Verification failed.', true);
      return;
    }
    const user = response.data || {};
    const label = user.fullName || user.email || 'Account verified';
    setStatusLine(els.accountStatus, `✓ ${label}`, false, true);
    await persistSettings({ testToken: token });
    await fetchCollections('target');
    await fetchCollections('workspaces');
  } catch (err) {
    setStatusLine(els.accountStatus, describeError(err), true);
  } finally {
    els.verifyBtn.disabled = false;
  }
}

/* ---------------- Collection pickers ---------------- */

async function fetchCollections(which) {
  const statusEl = which === 'target' ? els.targetTreeStatus : els.workspacesTreeStatus;
  setStatusLine(statusEl, 'Loading collections…', false);
  try {
    const response = await sendMessage({ type: 'get-collections' });
    if (!response.ok) {
      setStatusLine(statusEl, response.error || 'Could not load collections.', true);
      return;
    }
    state.collections = response.data || [];
    renderTargetTree();
    renderWorkspacesTree();
    setStatusLine(statusEl, '', false);
  } catch (err) {
    setStatusLine(statusEl, describeError(err), true);
  }
}

function renderTargetTree() {
  const tree = buildCollectionTree(state.collections);
  els.targetTree.innerHTML = '';
  if (tree.length === 0) {
    els.targetTree.appendChild(emptyTreeMessage());
    return;
  }
  const selectedId = state.settings?.targetCollectionId ?? null;
  appendTreeNodes(els.targetTree, tree, selectedId, 0, (node) => onSelectTarget(node));
}

function renderWorkspacesTree() {
  const tree = buildCollectionTree(state.collections);
  els.workspacesTree.innerHTML = '';
  const selectedId = state.settings?.workspacesCollectionId ?? null;
  els.workspacesTree.appendChild(
    treeRow({ id: null, title: 'None' }, 0, selectedId === null, () => onSelectWorkspaces(null))
  );
  if (tree.length === 0) {
    els.workspacesTree.appendChild(emptyTreeMessage());
    return;
  }
  appendTreeNodes(els.workspacesTree, tree, selectedId, 0, (node) => onSelectWorkspaces(node.id));
}

function appendTreeNodes(container, nodes, selectedId, depth, onSelect) {
  for (const node of nodes) {
    container.appendChild(treeRow(node, depth, node.id === selectedId, () => onSelect(node)));
    if (node.children && node.children.length > 0) {
      appendTreeNodes(container, node.children, selectedId, depth + 1, onSelect);
    }
  }
}

function treeRow(node, depth, isSelected, onClick) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'tree-row';
  row.setAttribute('role', 'radio');
  row.setAttribute('aria-checked', String(isSelected));
  row.style.paddingLeft = `${10 + depth * 18}px`;

  const icon = document.createElement('span');
  icon.className = 'tree-row-icon';
  icon.innerHTML =
    node.id === null
      ? ''
      : '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H2v16h20V6H12z"/></svg>';

  const title = document.createElement('span');
  title.className = 'tree-row-title';
  title.textContent = node.title;

  row.appendChild(icon);
  row.appendChild(title);

  if (typeof node.count === 'number') {
    const count = document.createElement('span');
    count.className = 'tree-row-count';
    count.textContent = String(node.count);
    row.appendChild(count);
  }

  row.addEventListener('click', onClick);
  return row;
}

function emptyTreeMessage() {
  const p = document.createElement('p');
  p.className = 'tree-empty';
  p.textContent = 'No collections found. Verify your token and refresh.';
  return p;
}

async function onSelectTarget(node) {
  const path = collectionPath(state.collections, node.id);
  els.targetSelectedPath.textContent = path || node.title;
  await persistSettings({ targetCollectionId: node.id, targetCollectionPath: path || node.title });
  renderTargetTree();
}

async function onSelectWorkspaces(id) {
  const path = id === null ? '' : collectionPath(state.collections, id);
  els.workspacesSelectedPath.textContent = id === null ? 'None' : path;
  await persistSettings({ workspacesCollectionId: id, workspacesCollectionPath: path });
  renderWorkspacesTree();
}

/* ---------------- Automatic sync ---------------- */

async function onAutoSyncToggle() {
  await persistSettings({ autoSyncEnabled: els.autoSyncToggle.checked });
}

function onSyncIntervalInput() {
  clearTimeout(intervalDebounceTimer);
  intervalDebounceTimer = setTimeout(async () => {
    const minutes = Math.max(1, parseInt(els.syncIntervalInput.value, 10) || 1);
    els.syncIntervalInput.value = minutes;
    await persistSettings({ syncIntervalMinutes: minutes });
  }, DEBOUNCE_MS);
}

/* ---------------- Statistics / sync now ---------------- */

async function refreshStatus() {
  try {
    const response = await sendMessage({ type: 'get-status' });
    if (!response.ok) {
      setStatusLine(els.syncNowStatus, response.error || 'Could not load status.', true);
      return;
    }
    const { settings, stats } = response.data || {};
    if (settings) {
      state.settings = settings;
      populateControls(settings);
    }
    renderStats(stats || {});
  } catch (err) {
    setStatusLine(els.syncNowStatus, describeError(err), true);
  }
}

function renderStats(stats) {
  els.statBookmarks.textContent = stats.bookmarks ?? 0;
  els.statFolders.textContent = stats.folders ?? 0;
  els.statCreated.textContent = stats.created ?? 0;
  els.statUpdated.textContent = stats.updated ?? 0;
  els.statDeleted.textContent = stats.deleted ?? 0;
  els.statSyncs.textContent = stats.syncCount ?? 0;
  els.statApiCalls.textContent = stats.apiCalls ?? 0;

  els.lastSyncValue.textContent = formatRelativeTime(stats.lastSyncAt);
  els.lastSyncDot.classList.remove('is-ok', 'is-error');
  if (stats.lastSyncStatus === 'ok') {
    els.lastSyncDot.classList.add('is-ok');
  } else if (stats.lastSyncStatus === 'error') {
    els.lastSyncDot.classList.add('is-error');
  }
  els.lastSyncError.textContent = stats.lastSyncStatus === 'error' ? stats.lastError || '' : '';
}

async function runSync(type) {
  els.syncNowBtn.disabled = true;
  els.forceResyncBtn.disabled = true;
  els.syncNowSpinner.hidden = false;
  els.syncNowLabel.textContent = 'Syncing…';
  setStatusLine(els.syncNowStatus, '', false);
  try {
    const response = await sendMessage({ type });
    if (!response.ok) {
      setStatusLine(els.syncNowStatus, response.error || 'Sync failed.', true);
    }
  } catch (err) {
    setStatusLine(els.syncNowStatus, describeError(err), true);
  } finally {
    els.syncNowBtn.disabled = false;
    els.forceResyncBtn.disabled = false;
    els.syncNowSpinner.hidden = true;
    els.syncNowLabel.textContent = 'Sync now';
    await refreshStatus();
  }
}

/* ---------------- Shared helpers ---------------- */

async function persistSettings(patch) {
  try {
    await saveSettings(patch);
    state.settings = { ...state.settings, ...patch };
    showToast('Settings saved', false);
  } catch (err) {
    showToast(describeError(err), true);
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response || { ok: false, error: 'No response from background script.' });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function setStatusLine(el, message, isError, isSuccess) {
  el.textContent = message;
  el.classList.toggle('is-error', !!isError);
  el.classList.toggle('is-success', !!isSuccess);
}

function showToast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', !!isError);
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
  }, 2200);
}

function describeError(err) {
  return err && err.message ? err.message : 'Something went wrong.';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}
