import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fullSync, resetSyncMappings, handleBookmarkCreated } from '../src/background/sync.js';
import { getSyncState, getSettings } from '../src/lib/settings.js';
import { setupHarness, seed, childTitles, subtreeTitles } from './fakes.mjs';

const colByTitle = (rd, title) => [...rd.cols.values()].find((c) => c.title === title);
const dropByLink = (rd, link) => [...rd.drops.values()].find((d) => d.link === link);

// Configure the harness with an explicit, already-existing target collection.
function withTarget(extraSettings = {}) {
  const { rd, chrome } = setupHarness();
  const target = rd.addCollection({ title: 'Bookmarks' });
  chrome.__store.settings = { testToken: 'test-token', targetCollectionId: target._id, ...extraSettings };
  return { rd, chrome, target };
}

test('initial sync pushes the existing local bar up as a union merge (nothing deleted)', async () => {
  const { rd, chrome, target } = withTarget();
  await seed(chrome, { title: 'Local BM', url: 'https://example.com/a' });
  const folder = await seed(chrome, { title: 'Folder' });
  await seed(chrome, { parentId: folder, title: 'Nested', url: 'https://example.com/n' });

  const stats = await fullSync();

  assert.ok(dropByLink(rd, 'https://example.com/a'), 'root bookmark pushed up');
  const folderCol = colByTitle(rd, 'Folder');
  assert.ok(folderCol && folderCol.parent.$id === target._id, 'local folder became a child collection');
  assert.ok(rd.dropsIn(folderCol._id).some((d) => d.link === 'https://example.com/n'), 'nested bookmark pushed');
  assert.equal(stats.deleted, 0, 'a first sync never deletes');
  assert.deepEqual(childTitles(chrome).sort(), ['Folder', 'Local BM'], 'local bar untouched');
});

test('remote additions are pulled down onto the bar (incl. nested)', async () => {
  const { rd, chrome, target } = withTarget();
  rd.addDrop({ title: 'Remote One', link: 'https://example.com/r1', collectionId: target._id });
  const sub = rd.addCollection({ title: 'Remote Sub', parentId: target._id });
  rd.addDrop({ title: 'Remote Nested', link: 'https://example.com/rn', collectionId: sub._id });

  await fullSync();

  const titles = subtreeTitles(chrome);
  assert.ok(titles.includes('Remote One'), 'remote bookmark pulled down');
  assert.ok(titles.includes('Remote Sub'), 'remote child collection pulled as a folder');
  assert.ok(titles.includes('Remote Nested'), 'nested remote bookmark pulled down');
});

test('remote edits and deletes win locally on reconcile', async () => {
  const { rd, chrome, target } = withTarget();
  const keep = rd.addDrop({ title: 'Old Title', link: 'https://example.com/keep', collectionId: target._id });
  const gone = rd.addDrop({ title: 'Doomed', link: 'https://example.com/gone', collectionId: target._id });
  await fullSync(); // establish the id maps

  keep.title = 'New Title';
  rd.drops.delete(gone._id);
  await fullSync();

  const titles = subtreeTitles(chrome);
  assert.ok(titles.includes('New Title'), 'remote rename applied locally');
  assert.ok(!titles.includes('Doomed'), 'remote delete removed the local bookmark');
});

test('empty local folders are never pushed up; pruned when deleteEmptyFolders is on', async () => {
  const { rd, chrome } = withTarget({ deleteEmptyFolders: true });
  await seed(chrome, { title: 'Empty' });
  await seed(chrome, { title: 'Real', url: 'https://example.com/real' });

  await fullSync();

  assert.equal(colByTitle(rd, 'Empty'), undefined, 'no collection created for the empty folder');
  assert.ok(!childTitles(chrome).includes('Empty'), 'empty folder pruned from the bar');
  assert.ok(dropByLink(rd, 'https://example.com/real'), 'the real bookmark still synced up');
});

test('empty local folders are guarded but kept when deleteEmptyFolders is off', async () => {
  const { rd, chrome } = withTarget({ deleteEmptyFolders: false });
  await seed(chrome, { title: 'Empty' });

  await fullSync();

  assert.equal(colByTitle(rd, 'Empty'), undefined, 'still never pushed up as a collection');
  assert.ok(childTitles(chrome).includes('Empty'), 'left in place when pruning is disabled');
});

test('a collection emptied remotely is pruned on both sides', async () => {
  const { rd, chrome, target } = withTarget({ deleteEmptyFolders: true });
  const sub = rd.addCollection({ title: 'Sub', parentId: target._id });
  const drop = rd.addDrop({ title: 'S1', link: 'https://example.com/s1', collectionId: sub._id });
  await fullSync();
  assert.ok(childTitles(chrome).includes('Sub'), 'precondition: Sub folder present');

  drop.collectionId = target._id; // move the only child out of Sub, up to the target
  await fullSync();

  assert.ok(!rd.cols.has(sub._id), 'emptied Sub collection deleted remotely');
  assert.ok(!childTitles(chrome).includes('Sub'), 'emptied Sub folder pruned from the bar');
  assert.ok(childTitles(chrome).includes('S1'), 'the moved bookmark now sits at the bar root');
});

test('an unset target resolves to the default path and persists it', async () => {
  const { rd, chrome } = setupHarness(); // testToken only, no targetCollectionId
  const chromeCol = rd.addCollection({ title: 'Chrome' });
  const bookmarks = rd.addCollection({ title: 'Bookmarks', parentId: chromeCol._id });
  rd.addDrop({ title: 'Default BM', link: 'https://example.com/def', collectionId: bookmarks._id });

  await fullSync();

  const settings = await getSettings();
  assert.equal(settings.targetCollectionId, bookmarks._id, 'default Chrome/Bookmarks resolved and persisted');
  assert.equal(settings.targetCollectionPath, 'Chrome/Bookmarks');
  assert.ok(subtreeTitles(chrome).includes('Default BM'), 'synced against the resolved default target');
});

test('a successful sync records ok status, clears the error and stamps the time', async () => {
  const { chrome } = withTarget();
  await fullSync();

  const { stats } = await getSyncState();
  assert.equal(stats.lastSyncStatus, 'ok');
  assert.equal(stats.lastError, null);
  assert.equal(typeof stats.lastSyncAt, 'number');
  assert.ok(stats.lastSyncAt > 0);
});

test('a failed sync still records the error and stamps the time', async () => {
  const { chrome } = withTarget();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await assert.rejects(fullSync(), /Failed to fetch/);

  const { stats } = await getSyncState();
  assert.equal(stats.lastSyncStatus, 'error');
  assert.match(stats.lastError, /Failed to fetch/);
  assert.equal(typeof stats.lastSyncAt, 'number', 'timestamp updated even on failure');
});

test('resetSyncMappings clears the id maps and pending deletions', async () => {
  const { rd, chrome, target } = withTarget();
  rd.addDrop({ title: 'X', link: 'https://example.com/x', collectionId: target._id });
  await fullSync();
  assert.ok(Object.keys((await getSyncState()).bookmarkMap).length > 0, 'precondition: maps populated');

  await resetSyncMappings();

  const state = await getSyncState();
  assert.deepEqual(state.bookmarkMap, {});
  assert.deepEqual(state.folderMap, {});
  assert.deepEqual(state.pendingDeletions, []);
});

test('creating a local bookmark pushes it straight up (push handler)', async () => {
  const { rd, chrome } = withTarget();
  const node = await chrome.bookmarks.create({ parentId: '1', title: 'Live', url: 'https://example.com/live' });

  await handleBookmarkCreated(node.id, node);

  assert.ok(dropByLink(rd, 'https://example.com/live'), 'new local bookmark created remotely');
});

test('a folder gets a collection only once real content lands (lazy parent)', async () => {
  const { rd, chrome } = withTarget();
  const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Later' });

  await handleBookmarkCreated(folder.id, folder);
  assert.equal(colByTitle(rd, 'Later'), undefined, 'empty folder create is ignored');

  const child = await chrome.bookmarks.create({ parentId: folder.id, title: 'Deep', url: 'https://example.com/deep' });
  await handleBookmarkCreated(child.id, child);

  const laterCol = colByTitle(rd, 'Later');
  assert.ok(laterCol, 'collection created lazily when a bookmark lands inside');
  assert.ok(rd.dropsIn(laterCol._id).some((d) => d.link === 'https://example.com/deep'), 'bookmark pushed into it');
});
