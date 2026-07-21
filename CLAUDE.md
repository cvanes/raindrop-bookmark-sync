# Raindrop Bookmark Sync

Chrome/Edge MV3 extension: two-way sync between the bookmarks bar (Chrome) / favourites bar
(Edge) and a Raindrop.io collection, plus saving/loading a window's tabs as a Raindrop
"workspace" collection. See README.md for user-facing behaviour.

## Architecture

Plain ES modules, no build step, no dependencies. UK spelling in user-facing text.

## Versioning

Bump the `version` in `manifest.json` on **every** change, without exception (semver-ish:
patch for fixes, minor for features) - and do it in the same commit as the change. The
version on the browser's extensions page is the only way to tell which build a machine is
running, so a reliable bump is what makes it possible to confirm every machine has picked
up a fix. Never land a code, UI or manifest change without also incrementing the version.

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
- Empty folders are never pushed up: a folder with no bookmarks anywhere in its subtree
  never gets a remote collection (guards against other bookmark-sync tools' placeholder
  folders spawning junk collections). The parent collection chain is instead created
  lazily by `ensureParentCollection` the moment real content lands inside.
- `deleteEmptyFolders` (setting, default on) prunes folders that reconcile to empty -
  both the local folder and its remote collection - during `fullSync`.
- When `targetCollectionId` / `workspacesCollectionId` are unset, they resolve by path
  against the account (`DEFAULT_TARGET_PATH` = `Chrome/Bookmarks`, `DEFAULT_WORKSPACES_PATH`
  = `Chrome/Workspaces`) and the resolved id is persisted, so a fresh machine self-configures.

## Testing

- Syntax check: `node --check` each changed `.js` file.
- No automated e2e harness (the old one required Microsoft Edge, since branded Google
  Chrome - all channels, incl. Beta - blocks `--load-extension`). Verify behaviour
  manually: load the unpacked extension into Chrome Beta (`chrome://extensions` →
  Developer mode → Load unpacked) and exercise the flows; the chrome-devtools MCP can
  drive the options page and popup.
- The extension mutates real bookmarks and the real Raindrop account, so test against a
  throwaway Raindrop collection - never point it at data you care about.
