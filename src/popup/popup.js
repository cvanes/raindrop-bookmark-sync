// Toolbar popup logic. Talks to the background service worker only via
// chrome.runtime.sendMessage. Everything is on one screen: sync in the
// header, save-this-window at the top, and the workspace list below with
// per-row open/replace/delete actions.

const els = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusError: document.getElementById('status-error'),
  notice: document.getElementById('setup-notice'),
  noticeText: document.getElementById('setup-notice-text'),
  noticeLink: document.getElementById('setup-notice-link'),
  content: document.getElementById('content'),
  syncBtn: document.getElementById('sync-btn'),
  syncGlyph: document.getElementById('sync-glyph'),
  syncSpinner: document.getElementById('sync-spinner'),
  syncMessage: document.getElementById('sync-message'),
  saveNameInput: document.getElementById('save-name-input'),
  saveConfirm: document.getElementById('save-confirm'),
  saveMessage: document.getElementById('save-message'),
  loadSpinner: document.getElementById('load-spinner'),
  workspaceList: document.getElementById('workspace-list'),
  loadMessage: document.getElementById('load-message'),
  settingsLink: document.getElementById('settings-link'),
};

const ICONS = {
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  replace: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

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
  } catch {
    // best effort only
  }
}

// --- formatting helpers -----------------------------------------------------

function formatRelativeTime(value) {
  if (!value) return 'Never synced';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'Never synced';
  const diffMin = Math.round((Date.now() - then) / 60000);
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

function looksLikeMissingWorkspacesCollection(message) {
  return /workspace/i.test(message) && /(not configured|not set|missing)/i.test(message);
}

// --- inline message helpers -------------------------------------------------

function clearMessage(el) {
  el.hidden = true;
  el.textContent = '';
  el.className = el.classList.contains('header-message')
    ? 'inline-message header-message'
    : 'inline-message';
}

function showMessage(el, text, kind, { withSettingsLink = false } = {}) {
  clearMessage(el);
  el.classList.add(`inline-message-${kind}`);
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
    return renderStatus(data);
  } catch (err) {
    renderStatusFailure(err);
    return false;
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

  return renderSetupState(settings);
}

function renderStatusFailure(err) {
  els.statusDot.className = 'status-dot status-dot-error';
  els.statusText.textContent = 'Unable to load status';
  els.statusError.textContent = err.message;
  els.statusError.hidden = false;
  els.notice.hidden = true;
  els.content.hidden = true;
}

// Returns true when the extension is configured enough to show the actions.
function renderSetupState(settings) {
  const missingToken = !settings.testToken;
  const missingCollection = !settings.targetCollectionId;

  if (!missingToken && !missingCollection) {
    els.notice.hidden = true;
    els.content.hidden = false;
    return true;
  }

  els.content.hidden = true;
  els.notice.hidden = false;
  els.noticeText.textContent = missingToken
    ? 'Add your Raindrop test token to get started.'
    : 'Choose a collection to sync to.';
  return false;
}

// --- disabled state ----------------------------------------------------------

function setActionsDisabled(disabled) {
  els.syncBtn.disabled = disabled;
  els.content.querySelectorAll('button, input').forEach((el) => {
    el.disabled = disabled;
  });
}

// --- sync now ------------------------------------------------------------------

async function handleSyncNow() {
  clearTimeout(syncMessageTimer);
  clearMessage(els.syncMessage);
  setActionsDisabled(true);
  els.syncGlyph.hidden = true;
  els.syncSpinner.hidden = false;

  try {
    await callBackground({ type: 'sync-now' });
    await refreshStatus();
    showMessage(els.syncMessage, 'Synced', 'success');
    syncMessageTimer = setTimeout(() => clearMessage(els.syncMessage), 3000);
  } catch (err) {
    showMessage(els.syncMessage, err.message, 'error');
  } finally {
    els.syncGlyph.hidden = false;
    els.syncSpinner.hidden = true;
    setActionsDisabled(false);
  }
}

// --- save this window ----------------------------------------------------------

async function handleSaveWorkspace() {
  const name = els.saveNameInput.value.trim();
  if (!name) {
    showMessage(els.saveMessage, 'Enter a name for the collection', 'error');
    return;
  }

  clearMessage(els.saveMessage);
  setActionsDisabled(true);

  try {
    await callBackground({ type: 'save-workspace', name });
    // On success the saved window (and this popup) closes.
  } catch (err) {
    setActionsDisabled(false);
    showMessage(els.saveMessage, err.message, 'error', {
      withSettingsLink: looksLikeMissingWorkspacesCollection(err.message),
    });
  }
}

// --- workspace list --------------------------------------------------------------

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
    els.workspaceList.appendChild(workspaceRow(workspace));
  });
}

function workspaceRow(workspace) {
  const item = document.createElement('div');
  item.className = 'workspace-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'workspace-open';
  open.title = `Open “${workspace.title}” in a new window`;

  const glyph = document.createElement('span');
  glyph.className = 'workspace-glyph';
  glyph.innerHTML = ICONS.folder;

  const title = document.createElement('span');
  title.className = 'workspace-title';
  title.textContent = workspace.title;

  const count = document.createElement('span');
  count.className = 'workspace-count';
  count.textContent = String(workspace.count);

  open.appendChild(glyph);
  open.appendChild(title);
  open.appendChild(count);
  open.addEventListener('click', () => handleLoadWorkspace(workspace, open));

  const update = actionButton(ICONS.replace, `Replace “${workspace.title}” with this window's tabs`, 'workspace-update');
  update.addEventListener('click', () => handleUpdateWorkspace(workspace, update));

  const del = actionButton(ICONS.trash, `Delete “${workspace.title}”`, 'workspace-delete');
  del.addEventListener('click', () => handleDeleteWorkspace(workspace, del));

  item.appendChild(open);
  item.appendChild(update);
  item.appendChild(del);
  return item;
}

function actionButton(icon, label, extraClass) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `workspace-action ${extraClass}`;
  button.innerHTML = icon;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

// First click arms a brief confirmation; the second click runs the action.
function armConfirm(button, label) {
  if (button.classList.contains('is-confirming')) return true;
  const original = button.innerHTML;
  button.classList.add('is-confirming');
  button.textContent = label;
  setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.remove('is-confirming');
    button.innerHTML = original;
  }, 3000);
  return false;
}

async function handleLoadWorkspace(workspace, button) {
  clearMessage(els.loadMessage);
  setActionsDisabled(true);

  try {
    await callBackground({ type: 'load-workspace', collectionId: workspace.id });
    window.close();
  } catch (err) {
    setActionsDisabled(false);
    if (button) button.disabled = false;
    showMessage(els.loadMessage, err.message, 'error');
  }
}

async function handleUpdateWorkspace(workspace, button) {
  if (!armConfirm(button, 'Replace?')) return;

  button.disabled = true;
  try {
    await callBackground({ type: 'update-workspace', collectionId: workspace.id });
    // On success the saved window (and this popup) closes.
  } catch (err) {
    button.disabled = false;
    showMessage(els.loadMessage, err.message, 'error');
  }
}

async function handleDeleteWorkspace(workspace, button) {
  if (!armConfirm(button, 'Delete?')) return;

  button.disabled = true;
  try {
    await callBackground({ type: 'delete-workspace', collectionId: workspace.id });
    await loadWorkspaceList();
  } catch (err) {
    button.disabled = false;
    showMessage(els.loadMessage, err.message, 'error');
  }
}

// --- wiring ---------------------------------------------------------------------

function wireStaticEvents() {
  els.settingsLink.addEventListener('click', openOptionsPage);
  els.noticeLink.addEventListener('click', openOptionsPage);
  els.syncBtn.addEventListener('click', handleSyncNow);
  els.saveConfirm.addEventListener('click', handleSaveWorkspace);
  els.saveNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSaveWorkspace();
    }
  });
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
    els.saveNameInput.value = defaultWorkspaceName();
    const configured = await refreshStatus();
    if (configured) await loadWorkspaceList();
  } catch (err) {
    renderFatalError(err);
  }
}

init();
