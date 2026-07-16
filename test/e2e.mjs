// End-to-end test: drives the extension in the disposable Edge instance against
// the real Raindrop API using RAINDROP_TOKEN. Creates SyncTest-* collections and
// cleans them up afterwards.
import { findTarget, openPage, Session, sleep } from './cdp.mjs';

// Defaults target the local mock; set RAINDROP_TOKEN + RD_BASE to run against
// the real API instead.
const TOKEN = process.env.RAINDROP_TOKEN || 'test-token-e2e';
const RD = (process.env.RD_BASE || 'http://127.0.0.1:8080') + '/rest/v1';
const createdRaindropIds = new Set();

async function rd(method, path, body) {
  const res = await fetch(RD + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const rdCreateCollection = async (title, parentId) =>
  (await rd('POST', '/collection', parentId ? { title, parent: { $id: parentId } } : { title })).item;
const rdRaindrops = async (cid) => (await rd('GET', `/raindrops/${cid}?perpage=50`)).items;
const rdCollections = async () => [
  ...(await rd('GET', '/collections')).items,
  ...(await rd('GET', '/collections/childrens')).items,
];

async function poll(label, fn, timeoutMs = 30000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

let step = 0;
const log = (msg) => console.log(`STEP ${++step}: ${msg}`);
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); };

async function swEval(expression) {
  // Wake the SW if needed by opening + closing an extension page.
  let target;
  try {
    target = await findTarget(t => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'), 3000);
  } catch {
    const p = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
    target = await findTarget(t => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'), 10000);
    await fetch(`http://127.0.0.1:9223/json/close/${p.id}`);
  }
  const s = await Session.connect(target.webSocketDebuggerUrl);
  try { return await s.eval(expression); } finally { s.close(); }
}

let extId;
let optSession;

const optEval = (expr) => optSession.eval(expr);
const sendBg = (msgJson) => optEval(`chrome.runtime.sendMessage(${msgJson})`);

async function barTree() {
  const json = await swEval(`chrome.bookmarks.getSubTree('1').then(r => JSON.stringify(r[0]))`);
  return JSON.parse(json);
}
const flatTitles = (node, acc = []) => {
  for (const c of node.children || []) { acc.push(c.title); flatTitles(c, acc); }
  return acc;
};

async function main() {
  // --- discover extension ---------------------------------------------------
  const sw = await findTarget(t => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'), 5000)
    .catch(async () => {
      // Service worker idle: derive the extension id from any extension page
      // (the options page auto-opens on install) and wake it via the popup.
      const anyExt = await findTarget(t => t.url.startsWith('chrome-extension://'), 5000)
        .catch(() => { throw new Error('extension not loaded - launch the browser via run-e2e.sh'); });
      const id = new URL(anyExt.url).host;
      const p = await openPage(`chrome-extension://${id}/src/popup/popup.html`);
      const t = await findTarget(x => x.type === 'service_worker' && x.url.endsWith('/src/background/service-worker.js'), 10000);
      await fetch(`http://127.0.0.1:9223/json/close/${p.id}`);
      return t;
    });
  extId = new URL(sw.url).host;
  log(`extension ${extId}`);

  // --- phase A: seed local bookmarks BEFORE configuring (initial push) ------
  await swEval(`(async () => {
    const bar = (await chrome.bookmarks.getSubTree('1'))[0];
    for (const c of bar.children || []) {
      if (c.url) await chrome.bookmarks.remove(c.id); else await chrome.bookmarks.removeTree(c.id);
    }
    return true;
  })()`);
  await swEval(`(async () => {
    await chrome.bookmarks.create({ parentId: '1', title: 'E2E Pre Local', url: 'https://example.com/pre' });
    const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Pre Folder' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'E2E Pre Nested', url: 'https://example.com/prefolder' });
    return true;
  })()`);
  log('cleared bar and seeded a bookmark plus a nested folder');

  const target = await rdCreateCollection('SyncTest-E2E');
  const wsRoot = await rdCreateCollection('SyncTest-Workspaces');
  log(`created empty raindrop collections target=${target._id} workspaces=${wsRoot._id}`);

  // --- configure via the options UI ------------------------------------------
  const opt = await openPage(`chrome-extension://${extId}/src/options/options.html`);
  const optTarget = await findTarget(t => t.id === opt.id);
  optSession = await Session.connect(optTarget.webSocketDebuggerUrl);
  await sleep(700);

  await optEval(`(() => {
    const i = document.getElementById('token-input');
    i.value = ${JSON.stringify(TOKEN)};
    i.dispatchEvent(new Event('change'));
  })()`);
  await optEval(`document.getElementById('verify-token-btn').click()`);
  await poll('token verified', () =>
    optEval(`document.getElementById('account-status').textContent`).then(t => t.includes('✓') ? t : null));
  log('token verified in options UI');

  await poll('collection tree rendered', () =>
    optEval(`document.querySelectorAll('#target-tree .tree-row').length`).then(n => n > 0 ? n : null));
  const clickedTarget = await optEval(`(() => {
    const row = [...document.querySelectorAll('#target-tree .tree-row')].find(r => r.textContent.includes('SyncTest-E2E'));
    if (!row) return false; row.click(); return true;
  })()`);
  assert(clickedTarget, 'SyncTest-E2E visible in target tree');
  const clickedWs = await optEval(`(() => {
    const row = [...document.querySelectorAll('#workspaces-tree .tree-row')].find(r => r.textContent.includes('SyncTest-Workspaces'));
    if (!row) return false; row.click(); return true;
  })()`);
  assert(clickedWs, 'SyncTest-Workspaces visible in workspaces tree');
  await sleep(500);
  log('target + workspaces collections selected via UI');
  await optSession.send('Page.enable');
  await optSession.screenshot('e2e-options.png');

  // --- phase A: sync now via the POPUP, expect initial push up ---------------
  const pop = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
  const popTarget = await findTarget(t => t.id === pop.id);
  const popSession = await Session.connect(popTarget.webSocketDebuggerUrl);
  await sleep(700);
  await popSession.eval(`document.getElementById('sync-row').click()`);
  await poll('popup shows Synced', () =>
    popSession.eval(`document.getElementById('sync-message').textContent`).then(t => t.includes('Synced') ? t : null));
  await popSession.send('Page.enable');
  await popSession.screenshot('e2e-popup.png');
  popSession.close();
  log('popup Sync now completed');

  const rootItems = await rdRaindrops(target._id);
  assert(rootItems.some(r => r.link === 'https://example.com/pre'), 'pre-existing local bookmark pushed to raindrop');
  const colsAfterA = await rdCollections();
  const preFolderCol = colsAfterA.find(c => c.title === 'Pre Folder' && c.parent?.$id === target._id);
  assert(preFolderCol, 'local folder became child collection');
  const nested = await rdRaindrops(preFolderCol._id);
  assert(nested.some(r => r.link === 'https://example.com/prefolder'), 'nested local bookmark pushed into child collection');
  rootItems.concat(nested).forEach(r => createdRaindropIds.add(r._id));
  log('PHASE A OK: initial sync pushed existing local bar into empty collection');

  // --- phase B: remote additions pull down ------------------------------------
  const remoteRd = (await rd('POST', '/raindrop', { link: 'https://example.com/remote', title: 'E2E Remote', collection: { $id: target._id } })).item;
  createdRaindropIds.add(remoteRd._id);
  const remoteSub = await rdCreateCollection('Remote Sub', target._id);
  const remoteNested = (await rd('POST', '/raindrop', { link: 'https://example.com/remotesub', title: 'E2E Remote Nested', collection: { $id: remoteSub._id } })).item;
  createdRaindropIds.add(remoteNested._id);

  let resp = await sendBg(`{ type: 'sync-now' }`);
  assert(resp.ok, 'sync-now ok: ' + JSON.stringify(resp));
  let titles = flatTitles(await barTree());
  assert(titles.includes('E2E Remote'), 'remote raindrop pulled to bar');
  assert(titles.includes('Remote Sub') && titles.includes('E2E Remote Nested'), 'remote child collection pulled as folder');
  log('PHASE B OK: remote additions pulled down (incl. nested)');

  // --- phase B2: bar sorted folders-first, alphabetical -----------------------
  let bar = await barTree();
  let order = bar.children.map(c => c.title);
  assert(JSON.stringify(order) === JSON.stringify(['Pre Folder', 'Remote Sub', 'E2E Pre Local', 'E2E Remote']),
    'bar order folders-first alphabetical, got ' + JSON.stringify(order));
  log('PHASE B2 OK: bar sorted alphabetically with folders first');

  // --- phase B3: raindrop-side move syncs down --------------------------------
  await rd('PUT', `/raindrop/${remoteNested._id}`, { collection: { $id: target._id } });
  resp = await sendBg(`{ type: 'sync-now' }`);
  assert(resp.ok, 'sync-now ok');
  bar = await barTree();
  assert(bar.children.some(c => c.title === 'E2E Remote Nested' && c.url), 'moved raindrop now at bar root');
  const remoteSubFolder = bar.children.find(c => c.title === 'Remote Sub');
  assert(remoteSubFolder && !(remoteSubFolder.children || []).some(c => c.title === 'E2E Remote Nested'),
    'moved raindrop no longer inside Remote Sub folder');
  log('PHASE B3 OK: item moved between collections in raindrop moved locally too');

  // --- phase C: native local add pushes immediately ---------------------------
  await swEval(`chrome.bookmarks.create({ parentId: '1', title: 'E2E Live', url: 'https://example.com/live' }).then(() => true)`);
  const liveItem = await poll('live bookmark pushed', async () => {
    const items = await rdRaindrops(target._id);
    return items.find(r => r.link === 'https://example.com/live') || null;
  }, 20000);
  createdRaindropIds.add(liveItem._id);
  log('PHASE C OK: native bookmark add pushed to raindrop without manual sync');

  // --- phase D: remote edit + delete win on next sync --------------------------
  await rd('PUT', `/raindrop/${remoteRd._id}`, { title: 'E2E Remote Renamed' });
  const preItem = rootItems.find(r => r.link === 'https://example.com/pre');
  await rd('DELETE', `/raindrop/${preItem._id}`);
  resp = await sendBg(`{ type: 'sync-now' }`);
  assert(resp.ok, 'sync-now ok');
  titles = flatTitles(await barTree());
  assert(titles.includes('E2E Remote Renamed'), 'remote rename applied locally');
  assert(!titles.includes('E2E Pre Local'), 'remote delete removed local bookmark');
  log('PHASE D OK: raindrop edits/deletes win locally');

  // --- phase E: local delete pushes -------------------------------------------
  await swEval(`(async () => {
    const bar = (await chrome.bookmarks.getSubTree('1'))[0];
    const node = bar.children.find(c => c.title === 'E2E Live');
    await chrome.bookmarks.remove(node.id);
    return true;
  })()`);
  await poll('live raindrop deleted remotely', async () => {
    const items = await rdRaindrops(target._id);
    return items.some(r => r.link === 'https://example.com/live') ? null : true;
  }, 20000);
  log('PHASE E OK: local delete removed raindrop');

  // --- phase F: workspaces save (closes window) + load -------------------------
  const winId = await swEval(`chrome.windows.create({ url: ['https://example.com/tab1', 'https://example.com/tab2'], focused: true }).then(w => w.id)`);
  await sleep(2500);
  // Pin the first tab so save must capture pinned state.
  await swEval(`chrome.tabs.query({ windowId: ${winId} }).then(ts => chrome.tabs.update(ts[0].id, { pinned: true })).then(() => true)`);
  const winCountBefore = await swEval(`chrome.windows.getAll().then(w => w.length)`);
  await swEval(`chrome.windows.update(${winId}, { focused: true }).then(() => true)`);
  resp = await sendBg(`{ type: 'save-workspace', name: 'E2E Workspace' }`);
  assert(resp.ok, 'save-workspace ok: ' + JSON.stringify(resp));
  assert(resp.data.count === 2, 'saved 2 tabs, got ' + JSON.stringify(resp.data));
  const winCountAfter = await swEval(`chrome.windows.getAll().then(w => w.length)`);
  assert(winCountAfter === winCountBefore - 1, `window closed after save (${winCountBefore} -> ${winCountAfter})`);
  const wsItems = await rdRaindrops(resp.data.id);
  assert(wsItems.length === 2, 'workspace collection has 2 raindrops');
  const pinnedItem = wsItems.find(r => r.link.includes('/tab1'));
  assert(pinnedItem && (pinnedItem.tags || []).includes('pinned'), 'pinned tab saved with pinned tag: ' + JSON.stringify(wsItems.map(r => ({ link: r.link, tags: r.tags }))));
  wsItems.forEach(r => createdRaindropIds.add(r._id));
  log('PHASE F1 OK: save collection stored tabs (incl. pinned tag) and closed the window');

  const list = await sendBg(`{ type: 'list-workspaces' }`);
  assert(list.ok && list.data.some(w => w.title === 'E2E Workspace'), 'workspace listed');
  resp = await sendBg(`{ type: 'load-workspace', collectionId: ${resp.data.id} }`);
  assert(resp.ok, 'load-workspace ok');
  const loaded = await poll('loaded window has 2 tabs', async () => {
    const wins = await swEval(`chrome.windows.getAll({ populate: true }).then(ws => JSON.stringify(ws.map(w => ({ id: w.id, tabs: w.tabs.map(t => ({ url: t.url, pinned: t.pinned })) }))))`);
    const win = JSON.parse(wins).find(w => w.tabs.filter(t => t.url.includes('example.com/tab')).length === 2);
    return win || null;
  }, 15000);
  const restoredPinned = loaded.tabs.find(t => t.url.includes('/tab1'));
  assert(restoredPinned && restoredPinned.pinned, 'pinned state restored on load: ' + JSON.stringify(loaded.tabs));
  await swEval(`chrome.windows.remove(${loaded.id}).then(() => true)`);
  log('PHASE F2 OK: load collection reopened the saved tabs with pinned state restored');

  // --- phase F3: delete a workspace from the popup -----------------------------
  const pop2 = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
  const pop2Target = await findTarget(t => t.id === pop2.id);
  const pop2Session = await Session.connect(pop2Target.webSocketDebuggerUrl);
  await sleep(700);

  // Enter in the save-name input must submit (empty name -> validation error,
  // which proves the key handler fired without creating anything).
  await pop2Session.eval(`document.getElementById('save-row').click()`);
  await pop2Session.eval(`(() => {
    const input = document.getElementById('save-name-input');
    input.value = '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const saveMsg = await poll('enter triggers save validation', () =>
    pop2Session.eval(`document.getElementById('save-message').textContent`).then(t => t.includes('name') ? t : null));
  assert(saveMsg.includes('Enter a name'), 'enter key submits save: ' + saveMsg);
  await pop2Session.eval(`document.getElementById('save-cancel').click()`);
  log('PHASE F0 OK: enter key submits the save panel');

  await pop2Session.eval(`document.getElementById('load-row').click()`);
  await poll('workspace listed in popup', () =>
    pop2Session.eval(`[...document.querySelectorAll('.workspace-title')].map(e => e.textContent).join(',')`)
      .then(t => t.includes('E2E Workspace') ? t : null));
  await pop2Session.eval(`document.querySelector('.workspace-delete').click()`);
  const armed = await pop2Session.eval(`document.querySelector('.workspace-delete').textContent`);
  assert(armed === 'Delete?', 'delete requires confirm click, got ' + armed);
  await pop2Session.eval(`document.querySelector('.workspace-delete').click()`);
  await poll('workspace gone from popup list', () =>
    pop2Session.eval(`document.querySelector('#workspace-list .empty-state') ? 'empty' : null`));
  const wsCols = await rdCollections();
  assert(!wsCols.some(c => c.title === 'E2E Workspace'), 'workspace collection deleted remotely');
  pop2Session.close();
  log('PHASE F3 OK: workspace deleted from the popup after confirm step');

  // --- phase G: changing the target collection resyncs without deleting ------
  const target2 = await rdCreateCollection('SyncTest-E2E-Second');
  const secondRemote = (await rd('POST', '/raindrop', { link: 'https://example.com/second', title: 'E2E Second Remote', collection: { $id: target2._id } })).item;
  createdRaindropIds.add(secondRemote._id);
  const titlesBefore = flatTitles(await barTree());
  await optEval(`(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.targetCollectionId = ${target2._id};
    settings.targetCollectionPath = 'SyncTest-E2E-Second';
    await chrome.storage.local.set({ settings });
    return true;
  })()`);
  // The background should reset mappings and auto-sync into the new target.
  await poll('bar merged with new target', async () => {
    const titles = flatTitles(await barTree());
    return titles.includes('E2E Second Remote') ? titles : null;
  }, 20000);
  const titlesAfter = flatTitles(await barTree());
  for (const t of titlesBefore) {
    assert(titlesAfter.includes(t), `nothing deleted on target change (missing ${t})`);
  }
  const pushed = await rdRaindrops(target2._id);
  assert(pushed.some(r => r.link === 'https://example.com/remote'), 'bar content pushed into new target');
  pushed.forEach(r => createdRaindropIds.add(r._id));
  log('PHASE G OK: target change auto-resynced as a union merge, nothing deleted');

  resp = await sendBg(`{ type: 'force-resync' }`);
  assert(resp.ok, 'force-resync ok: ' + JSON.stringify(resp));
  log('PHASE G2 OK: force-resync message succeeded');

  console.log('E2E_ALL_PASSED');
}

async function cleanup() {
  try {
    const cols = await rdCollections();
    const roots = cols.filter(c => ['SyncTest-E2E', 'SyncTest-E2E-Second', 'SyncTest-Workspaces'].includes(c.title));
    const rootIds = new Set(roots.map(c => c._id));
    const children = cols.filter(c => c.parent && rootIds.has(c.parent.$id));
    for (const c of [...children, ...roots]) {
      await rd('DELETE', `/collection/${c._id}`).catch(e => console.error('cleanup', e.message));
    }
    if (createdRaindropIds.size) {
      await rd('DELETE', '/raindrops/-99', { ids: [...createdRaindropIds] }).catch(() => {});
    }
    console.log('CLEANUP_DONE');
  } catch (e) {
    console.error('CLEANUP_FAILED', e.message);
  }
}

main()
  .then(async () => { await cleanup(); process.exit(0); })
  .catch(async (e) => { console.error('E2E_FAIL', e.message); await cleanup(); process.exit(1); });
