# Raindrop Bookmark Sync

Chrome/Edge MV3 extension: two-way sync between the bookmarks bar (Chrome) / favourites bar
(Edge) and a Raindrop.io collection, plus saving/loading a window's tabs as a Raindrop
"workspace" collection. See README.md for user-facing behaviour.

## Architecture

Plain ES modules, no build step, no dependencies. UK spelling in user-facing text.

- `src/lib/api.js` - Raindrop REST client (`RaindropApi`) + `buildCollectionTree`/
  `collectionPath` helpers. Handles pagination (perpage 50), batch chunking (100), one retry
  on HTTP 429 and dedupes `/collections` + `/collections/childrens` (both can return the
  same collection).
- `src/lib/settings.js` - settings and sync state in `chrome.storage.local`. Sync state holds
  the id maps (`folderMap`: bookmark folder node id → collection id, `bookmarkMap`: bookmark
  node id → raindrop id), `pendingDeletions` and stats.
- `src/background/sync.js` - the sync engine. `fullSync()` pull-reconciles the bar against
  the target collection subtree; push handlers mirror native bookmark events to Raindrop
  immediately. `src/background/workspaces.js` - save/load window tabs. 
  `src/background/service-worker.js` - event wiring, alarms, message router.
- `src/options/`, `src/popup/` - UI, talking to the background via `chrome.runtime.sendMessage`
  (`{ ok, data } | { ok: false, error }` responses). Both stylesheets share the same palette
  variables and support light/dark via `prefers-color-scheme`.

## Sync invariants (do not break these)

- Raindrop is the source of truth: on reconcile, remote edits/deletes win locally.
- Deletes only apply to nodes present in the id maps. Unmapped local items are pushed UP,
  never deleted - this makes the first sync (and any resync) a union merge.
- Remote deletes that fail are queued in `pendingDeletions` and applied before the next
  reconcile, otherwise deleted items would be resurrected locally.
- Changing `targetCollectionId` must reset the id maps (the service worker does this on
  storage change); reconciling a new target against stale maps deletes the whole bar.
- All programmatic bookmark mutations happen while `muted` is set so push handlers ignore
  the extension's own events; push handlers also skip already-mapped nodes on create.
- New local bookmarks are batch-created (100/request) during reconcile - individual creates
  blow the 120 req/min rate limit on large bars.
- Only the bookmarks bar subtree (node id '1') is ever touched.
- Synced folders are kept sorted: folders first, then bookmarks, alphabetical.

## Testing

- Syntax check: `node --check` each changed `.js` file.
- Full e2e: `./test/run-e2e.sh` - loads the extension into a disposable Microsoft Edge
  profile (branded Chrome stable ignores `--load-extension`) and drives it over raw CDP
  against a local mock of the Raindrop API (`test/mock-raindrop.mjs`, reached via a loopback
  proxy so `https://api.raindrop.io` resolves to the mock). All phases must pass.
- To run the e2e against the real API instead: `RD_BASE=https://api.raindrop.io
  RAINDROP_TOKEN=<test token> node test/e2e.mjs` (creates and cleans up `SyncTest-*`
  collections in that account).
