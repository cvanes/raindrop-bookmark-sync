# Raindrop Bookmark Sync – Specification

Chrome/Edge Manifest V3 extension providing two-way sync between the browser bookmarks bar
(Chrome) / favourites bar (Edge) and a Raindrop.io collection, with Raindrop as the source of
truth. Stretch: save/load all tabs in a window as a "workspace" collection in Raindrop.

Plain ES modules, no build step, no frameworks, no external dependencies. UK spelling in all
user-facing text. Code style: small functions, clear separation of concerns, no dead code.

## File layout

```
manifest.json
icons/icon16.png icon32.png icon48.png icon128.png
src/lib/api.js          Raindrop REST client
src/lib/settings.js     settings + sync-state storage helpers
src/background/service-worker.js  entry: events, alarms, message router
src/background/sync.js            sync engine (pull reconcile + push handlers)
src/background/workspaces.js      save/load workspace collections
src/options/options.html|css|js   settings UI
src/popup/popup.html|css|js       toolbar popup (Sync now / Save / Load collection)
```

## manifest.json

- `manifest_version: 3`, name "Raindrop Bookmark Sync", version 0.1.0.
- `permissions`: `bookmarks`, `storage`, `alarms`, `tabs`.
- `host_permissions`: `https://api.raindrop.io/*`.
- `background`: `{ "service_worker": "src/background/service-worker.js", "type": "module" }`.
- `action`: default_popup `src/popup/popup.html`, default_icon map.
- `options_page`: `src/options/options.html`.
- `icons` map for 16/32/48/128.

## Raindrop API (https://api.raindrop.io/rest/v1)

Auth header on every call: `Authorization: Bearer <testToken>`. Rate limit 120 req/min –
on 429 wait for `X-RateLimit-Reset` (or 60 s) and retry once. Non-OK responses throw
`Error` with a useful message.

Endpoints used:
- `GET /user` – validate token, returns `{ user }`.
- `GET /collections` – root collections. `GET /collections/childrens` – all nested ones.
  Items: `{ _id, title, parent: { $id } | undefined, count }`.
- `POST /collection` body `{ title, parent: { $id } }` → `{ item }`.
- `PUT /collection/{id}` body subset `{ title, parent }` → `{ item }`.
- `DELETE /collection/{id}`.
- `GET /raindrops/{collectionId}?perpage=50&page=N` – paginate until fewer than 50 returned.
  Items: `{ _id, link, title, collection: { $id } }`.
- `POST /raindrop` body `{ link, title, collection: { $id }, pleaseParse: {} }` → `{ item }`.
- `POST /raindrops` body `{ items: [...] }` (max 100) – used by workspace save.
- `PUT /raindrop/{id}` body subset `{ link, title, collection: { $id } }` → `{ item }`.
- `DELETE /raindrop/{id}` – moves to trash (fine).

## src/lib/api.js – exports

```js
export class RaindropApi {
  constructor(token)
  async getUser()                                  // -> user object
  async getAllCollections()                        // -> [{_id,title,parent}] root+children merged
  async createCollection(title, parentId)          // -> collection item
  async updateCollection(id, fields)               // -> collection item
  async deleteCollection(id)
  async getRaindrops(collectionId)                 // -> all items, handles pagination
  async createRaindrop({link, title, collectionId})// -> item
  async createRaindrops(items)                     // batch, chunks of 100; items: [{link,title,collectionId}]
  async updateRaindrop(id, {link, title, collectionId})
  async deleteRaindrop(id)
  get apiCallCount()                               // number of HTTP requests made (for stats)
}
export function buildCollectionTree(collections)   // -> [{id,title,children:[...]}] roots sorted by title
export function collectionPath(collections, id)    // -> "Parent / Child" display string
```

## src/lib/settings.js – exports

All persisted in `chrome.storage.local`.

```js
export const DEFAULT_SETTINGS = {
  testToken: '',
  targetCollectionId: null,        // raindrop collection mirrored onto the bookmarks bar
  targetCollectionPath: '',
  workspacesCollectionId: null,    // root collection holding workspace sub-collections
  workspacesCollectionPath: '',
  autoSyncEnabled: true,
  syncIntervalMinutes: 15,         // min 1
};
export async function getSettings()          // merged with defaults
export async function saveSettings(patch)    // shallow merge and persist

// Sync state under key 'syncState':
// {
//   folderMap:   { [bookmarkFolderNodeId]: collectionId },
//   bookmarkMap: { [bookmarkNodeId]: raindropId },
//   stats: { lastSyncAt, lastSyncStatus: 'ok'|'error'|null, lastError,
//            syncCount, bookmarks, folders, created, updated, deleted, apiCalls }
// }
export async function getSyncState()
export async function saveSyncState(state)
export async function updateStats(patch)
```

## src/background/sync.js

The entire bookmarks bar subtree mirrors the target collection's subtree:
bar root ↔ target collection; folders ↔ child collections (recursively); bookmarks ↔ raindrops.
Only the bar is synced (Chrome and Edge both use bookmark node id `'1'`; locate it via
`chrome.bookmarks.getTree()` picking the root child with id `'1'`, falling back to the first
child that is a folder).

```js
export async function fullSync()                   // pull reconcile; returns stats
export function isMuted()                          // true while fullSync mutates bookmarks
export async function handleBookmarkCreated(id, node)
export async function handleBookmarkChanged(id, changeInfo)
export async function handleBookmarkMoved(id, moveInfo)
export async function handleBookmarkRemoved(id, removeInfo)
```

### fullSync (raindrop wins)

1. Read settings; if no token or no target collection, record status and return.
2. Fetch all collections; compute descendants of target. Fetch raindrops for target and each
   descendant collection.
3. Build the desired tree, then reconcile against the bar subtree depth-first:
   - Match folders to collections and bookmarks to raindrops using the stored maps first,
     then by title (folders) or URL (bookmarks) for unmapped nodes; update maps.
   - Create/update (title, url)/move browser nodes so the bar matches Raindrop exactly.
   - Local node mapped but remote gone → remove local node (deleted in Raindrop).
   - Local node unmapped → it is new locally: push it to Raindrop (create collection/raindrop)
     instead of deleting, then map it.
4. Prune stale map entries. Save state + stats. All bookmark mutations happen while a module
   `muted` flag is set so push handlers ignore self-inflicted events.
5. Serialise: if a sync is already running, coalesce (return the in-flight promise).

### Push handlers (immediate local → Raindrop)

Ignore events while muted or for nodes outside the bar subtree; queue events through a simple
promise chain so they run serially.
- created: folder → `createCollection(title, parentCollectionId)`; bookmark → `createRaindrop`.
  Parent collection id resolved via folderMap (bar root → target collection id).
- changed: update mapped raindrop title/link or collection title.
- moved: into bar subtree → create remotely; out of subtree → delete remotely; within →
  `updateRaindrop`/`updateCollection` with new parent.
- removed: delete mapped raindrop/collection (folder removal: deleting the collection is enough,
  Raindrop trashes contents; also drop map entries for the removed subtree).
Update stats counters (created/updated/deleted) on each push.

## src/background/workspaces.js

```js
export async function saveWorkspace(name)      // tabs of current window -> new child collection
export async function listWorkspaces()         // -> [{id,title,count}] children of workspaces root
export async function loadWorkspace(collectionId) // open new window with all links as tabs
```

- save: requires workspacesCollectionId; reads `chrome.tabs.query({currentWindow: true})`,
  filters http/https, creates collection `name` under the workspaces root, batch-creates
  raindrops with tab titles.
- load: fetch raindrops of the collection, `chrome.windows.create({ url: [links...] })`.

## src/background/service-worker.js

- Registers `chrome.bookmarks.onCreated/onChanged/onMoved/onRemoved` → sync.js handlers.
- Alarm `periodic-sync`: created from settings on startup/install and whenever settings change
  (listen to `chrome.storage.onChanged`); fires `fullSync()` when autoSyncEnabled.
- `chrome.runtime.onMessage` router (all handlers return `{ ok, data }` or `{ ok:false, error }`,
  using `sendResponse` + `return true` async pattern):
  - `sync-now` → fullSync → stats
  - `get-status` → `{ settings, stats }`
  - `validate-token` `{ token }` → user `{ fullName?, email? }`
  - `get-collections` `{ token? }` → collection list (for pickers)
  - `save-workspace` `{ name }`, `list-workspaces`, `load-workspace` `{ collectionId }`

## src/options – settings page

Look and feel: modern, clean settings page in the style of a polished sync extension
(reference: floccus). Dark theme with blue accents (Raindrop brand blue #0DB4E8 on dark
#101728-ish background), max-width ~720px centred column, card sections with rounded corners
and subtle borders, clear section headings with small descriptions.

Sections:
1. **Account** – password-style input for the test token with a "Verify" button and inline
   result (name of account or error). Link text explaining where to get a test token
   (app.raindrop.io → Settings → Integrations → create app → test token).
2. **Sync target** – collection picker: an indented tree (nested `<details>`/list, or a select
   with `—` indentation showing hierarchy) populated via `get-collections`; radio-style single
   selection; shows the currently selected path. A "Refresh collections" button.
3. **Automatic sync** – toggle for autoSyncEnabled + number input (minutes, min 1) for interval.
4. **Workspaces** – same collection picker for workspacesCollectionId (optional feature).
5. **Statistics** – grid of stat tiles: last sync time + status, bookmarks synced, folders,
   created/updated/deleted totals, API calls, sync count. A "Sync now" button here too.
6. Save button (sticky footer or per-section auto-save; show a saved/error toast).

## src/popup – toolbar popup

Small (~300px wide) dark panel matching options styling:
- Header with icon + "Raindrop Sync" + last-sync line (relative time + status dot).
- Three action rows/buttons: **Sync now**, **Save collection…** (reveals inline name input,
  default = current window's active tab count hint), **Load collection…** (reveals inline list
  of workspaces fetched via `list-workspaces`; clicking one opens it).
- Busy/spinner states and inline error text; a footer link "Settings" opening the options page.

## Icons

Raindrop-style droplet: blue gradient droplet on transparent background, generated at
16/32/48/128 px as PNG.
