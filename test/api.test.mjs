import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findCollectionIdByPath, buildCollectionTree, collectionPath } from '../src/lib/api.js';

const COLLECTIONS = [
  { _id: 1, title: 'Chrome' },
  { _id: 2, title: 'Bookmarks', parent: { $id: 1 } },
  { _id: 3, title: 'Workspaces', parent: { $id: 1 } },
  { _id: 4, title: 'Personal' },
  { _id: 5, title: 'Bookmarks', parent: { $id: 4 } }, // same title, different parent
];

test('findCollectionIdByPath resolves a nested path', () => {
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Chrome/Bookmarks'), 2);
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Chrome/Workspaces'), 3);
});

test('findCollectionIdByPath disambiguates same-named collections by parent', () => {
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Personal/Bookmarks'), 5);
});

test('findCollectionIdByPath resolves a single root segment', () => {
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Chrome'), 1);
});

test('findCollectionIdByPath returns null when any segment is missing', () => {
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Nope'), null);
  assert.equal(findCollectionIdByPath(COLLECTIONS, 'Chrome/Nope'), null);
  assert.equal(findCollectionIdByPath(COLLECTIONS, ''), null);
});

test('findCollectionIdByPath treats a dangling parent as a root', () => {
  // parent $id 999 is absent from the set -> the collection counts as a root.
  const cols = [{ _id: 7, title: 'Orphan', parent: { $id: 999 } }];
  assert.equal(findCollectionIdByPath(cols, 'Orphan'), 7);
});

test('buildCollectionTree nests and sorts by title', () => {
  const tree = buildCollectionTree(COLLECTIONS);
  assert.deepEqual(tree.map((n) => n.title), ['Chrome', 'Personal']);
  const chrome = tree.find((n) => n.title === 'Chrome');
  assert.deepEqual(chrome.children.map((n) => n.title), ['Bookmarks', 'Workspaces']);
});

test('collectionPath joins ancestor titles', () => {
  assert.equal(collectionPath(COLLECTIONS, 2), 'Chrome / Bookmarks');
  assert.equal(collectionPath(COLLECTIONS, 1), 'Chrome');
});
