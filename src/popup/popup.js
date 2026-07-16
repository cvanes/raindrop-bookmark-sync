// Toolbar popup logic. Talks to the background service worker only via
// chrome.runtime.sendMessage using the message contract described in SPEC.md.

const els = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusError: document.getElementById('status-error'),
  notice: document.getElementById('setup-notice'),
  noticeText: document.getElementById('setup-notice-text'),
  noticeLink: document.getElementById('setup-notice-link'),
  actions: document.getElementById('actions'),
  syncRow: document.getElementById('sync-row'),
  syncSpinner: document.getElementById('sync-spinner'),
  syncMessage: document.getElementById('sync-message'),
  saveRow: document.getElementById('save-row'),
  savePanel: document.getElementById('save-panel'),
  saveNameInput: document.getElementById('save-name-input'),
  saveCancel: document.getElementById('save-cancel'),
  saveConfirm: document.getElementById('save-confirm'),
  saveMessage: document.getElementById('save-message'),
  loadRow: document.getElementById('load-row'),
  loadPanel: document.getElementById('load-panel'),
  loadSpinner: document.getElementById('load-spinner'),
  workspaceList: document.getElementById('workspace-list'),
  loadMessage: document.getElementById('load-message'),
  settingsLink: document.getElementById('settings-link'),
};

let openPanelName = null;
let syncMessageTimer = null;

// --- messaging helpers -----------------------------------------------------

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background script'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function callBackground(message) {
  const response = await sendMessage(message);
  if (!response.ok) {
    throw new Error(response.error || 'Something went wrong');
  }
  return response.data;
}

function openOptionsPage() {
  try {
    chrome.runtime.openOptionsPage();
  } catch (err) {
    // best effort only
  }
}

// --- formatting helpers -----------------------------------------------------

function formatRelativeTime(value) {
  if (!value) return 'Never synced';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'Never synced';
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'Last sync just now';
  if (diffMin < 60) return `Last sync ${diffMin} min ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `Last sync ${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHour / 24);
  return `Last sync ${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function defaultWorkspaceName() {
  const label = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `Workspace ${label}`;
}

function extractCount(data) {
  if (!data) return null;
  if (typeof data.count === 'number') return data.count;
  if (typeof data.tabCount === 'number') return data.tabCount;
  if (typeof data.bookmarks === 'number') return data.bookmarks;
  if (Array.isArray(data.items)) return data.items.length;
  return null;
}

function looksLikeMissingWorkspacesCollection(message) {
  return /workspace/i.test(message) && /(not configured|not set|missing)/i.test(message);
}

// --- inline message helpers -------------------------------------------------

function clearMessage(el) {
  el.hidden = true;
  el.textContent = '';
  el.className = 'inline-message';
}

function showMessage(el, text, kind, { withSettingsLink = false } = {}) {
  el.innerHTML = '';
  el.className = `inline-message inline-message-${kind}`;
  el.appendChild(document.createTextNode(text));
  if (withSettingsLink) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link-button inline-settings-link';
    link.textContent = 'Open settings';
    link.addEventListener('click', openOptionsPage);
    el.appendChild(link);
  }
  el.hidden = false;
}

// --- status line -------------------------------------------------------------

async function refreshStatus() {
  try {
    const data = await callBackground({ type: 'get-status' });
    renderStatus(data);
  } catch (err) {
    renderStatusFailure(err);
  }
}

function renderStatus(data) {
  const settings = data && data.settings ? data.settings : {};
  const stats = data && data.stats ? data.stats : {};

  const status = stats.lastSyncStatus;
  els.statusDot.className =
    'status-dot ' + (status === 'ok' ? 'status-dot-ok' : status === 'error' ? 'status-dot-error' : 'status-dot-idle');
  els.statusText.textContent = formatRelativeTime(stats.lastSyncAt);

  if (status === 'error' && stats.lastError) {
    els.statusError.textContent = stats.lastError;
    els.statusError.hidden = false;
  } else {
    els.statusError.hidden = true;
    els.statusError.textContent = '';
  }

  renderSetupState(settings);
}

function renderStatusFailure(err) {
  els.statusDot.className = 'status-dot status-dot-error';
  els.statusText.textContent = 'Unable to load status';
  els.statusError.textContent = err.message;
  els.statusError.hidden = false;
  els.notice.hidden = true;
  els.actions.hidden = true;
}

function renderSetupState(settings) {
  const missingToken = !settings.testToken;
  const missingCollection = !settings.targetCollectionId;

  if (!missingToken && !missingCollection) {
    els.notice.hidden = true;
    els.actions.hidden = false;
    return;
  }

  els.actions.hidden = true;
  els.notice.hidden = false;
  els.noticeText.textContent = missingToken
    ? 'Add your Raindrop test token to get started.'
    : 'Choose a collection to sync to.';
}

// --- actions disabled state --------------------------------------------------

function setActionsDisabled(disabled) {
  document.querySelectorAll('#actions button').forEach((btn) => {
    btn.disabled = disabled;
  });
}

// --- sync now ------------------------------------------------------------------

async function handleSyncNow() {
  clearTimeout(syncMessageTimer);
  clearMessage(els.syncMessage);
  setActionsDisabled(true);
  els.syncSpinner.hidden = false;

  try {
    await callBackground({ type: 'sync-now' });
    await refreshStatus();
    showMessage(els.syncMessage, 'Synced', 'success');
    syncMessageTimer = setTimeout(() => clearMessage(els.syncMessage), 3000);
  } catch (err) {
    showMessage(els.syncMessage, err.message, 'error');
  } finally {
    els.syncSpinner.hidden = true;
    setActionsDisabled(false);
  }
}

// --- panel open/close ------------------------------------------------------

function closePanel(name) {
  if (name === 'save') {
    els.savePanel.hidden = true;
    els.saveRow.setAttribute('aria-expanded', 'false');
  } else if (name === 'load') {
    els.loadPanel.hidden = true;
    els.loadRow.setAttribute('aria-expanded', 'false');
  }
}

function togglePanel(name) {
  if (openPanelName === name) {
    closePanel(name);
    openPanelName = null;
    return;
  }
  if (openPanelName) {
    closePanel(openPanelName);
  }
  openPanelName = name;
  if (name === 'save') {
    openSavePanel();
  } else if (name === 'load') {
    openLoadPanel();
  }
}

function openSavePanel() {
  clearMessage(els.saveMessage);
  els.saveNameInput.value = defaultWorkspaceName();
  els.savePanel.hidden = false;
  els.saveRow.setAttribute('aria-expanded', 'true');
  els.saveNameInput.focus();
  els.saveNameInput.select();
}

function openLoadPanel() {
  clearMessage(els.loadMessage);
  els.loadPanel.hidden = false;
  els.loadRow.setAttribute('aria-expanded', 'true');
  loadWorkspaceList();
}

// --- save collection ---------------------------------------------------------

async function handleSaveWorkspace() {
  const name = els.saveNameInput.value.trim();
  if (!name) {
    showMessage(els.saveMessage, 'Enter a name for the collection', 'error');
    return;
  }

  clearMessage(els.saveMessage);
  els.saveConfirm.disabled = true;
  els.saveCancel.disabled = true;

  try {
    const data = await callBackground({ type: 'save-workspace', name });
    const count = extractCount(data);
    const confirmation = count === null ? `Saved “${name}”` : `Saved ${count} tab${count === 1 ? '' : 's'} to “${name}”`;
    showMessage(els.saveMessage, confirmation, 'success');
  } catch (err) {
    showMessage(els.saveMessage, err.message, 'error', {
      withSettingsLink: looksLikeMissingWorkspacesCollection(err.message),
    });
  } finally {
    els.saveConfirm.disabled = false;
    els.saveCancel.disabled = false;
  }
}

// --- load collection -----------------------------------------------------------

async function loadWorkspaceList() {
  els.workspaceList.innerHTML = '';
  clearMessage(els.loadMessage);
  els.workspaceList.hidden = true;
  els.loadSpinner.hidden = false;

  try {
    const workspaces = await callBackground({ type: 'list-workspaces' });
    renderWorkspaceList(workspaces);
  } catch (err) {
    showMessage(els.loadMessage, err.message, 'error');
  } finally {
    els.loadSpinner.hidden = true;
    els.workspaceList.hidden = false;
  }
}

function renderWorkspaceList(workspaces) {
  els.workspaceList.innerHTML = '';

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No saved collections yet';
    els.workspaceList.appendChild(empty);
    return;
  }

  workspaces.forEach((workspace) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'workspace-item';

    const title = document.createElement('span');
    title.className = 'workspace-title';
    title.textContent = workspace.title;

    const count = document.createElement('span');
    count.className = 'workspace-count';
    count.textContent = `${workspace.count} bookmark${workspace.count === 1 ? '' : 's'}`;

    item.appendChild(title);
    item.appendChild(count);
    item.addEventListener('click', () => handleLoadWorkspace(workspace.id, item));
    els.workspaceList.appendChild(item);
  });
}

async function handleLoadWorkspace(collectionId, itemEl) {
  clearMessage(els.loadMessage);
  setActionsDisabled(true);

  try {
    await callBackground({ type: 'load-workspace', collectionId });
    window.close();
  } catch (err) {
    setActionsDisabled(false);
    if (itemEl) itemEl.disabled = false;
    showMessage(els.loadMessage, err.message, 'error');
  }
}

// --- wiring ---------------------------------------------------------------------

function wireStaticEvents() {
  els.settingsLink.addEventListener('click', openOptionsPage);
  els.noticeLink.addEventListener('click', openOptionsPage);
  els.syncRow.addEventListener('click', handleSyncNow);
  els.saveRow.addEventListener('click', () => togglePanel('save'));
  els.loadRow.addEventListener('click', () => togglePanel('load'));
  els.saveCancel.addEventListener('click', () => {
    closePanel('save');
    openPanelName = null;
  });
  els.saveConfirm.addEventListener('click', handleSaveWorkspace);
}

function renderFatalError(err) {
  document.body.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'fatal-error';
  div.textContent = 'Something went wrong loading the popup.';
  document.body.appendChild(div);
  console.error(err);
}

async function init() {
  try {
    wireStaticEvents();
    await refreshStatus();
  } catch (err) {
    renderFatalError(err);
  }
}

init();
