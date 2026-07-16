# Raindrop Bookmark Sync

A Chrome/Edge extension that keeps your bookmarks bar (Chrome) / favourites bar (Edge) in
two-way sync with a [Raindrop.io](https://raindrop.io) collection, with Raindrop as the source
of truth. Nested folders on the bar map to nested collections in Raindrop.

It can also save all tabs in a window to a Raindrop "workspace" collection (closing the window
once saved) and reopen a workspace later as a new window.

## Install (unpacked)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this directory.

## Setup

1. Get a test token: [app.raindrop.io](https://app.raindrop.io) → Settings → Integrations →
   For Developers → create an app → copy the **Test token**.
2. Open the extension's options page, paste the token and press **Verify**.
3. Pick the target collection to mirror onto your bookmarks bar.
4. Optionally pick a workspaces collection (the parent for saved windows) and enable
   automatic sync (off by default) with the interval you want.

The toolbar popup offers **Sync now**, **Save collection** (all tabs in the current window →
a new workspace sub-collection, then the window closes) and **Load collection** (open a
workspace as a new window).

## How sync works

- The entire bookmarks bar mirrors the target collection: folders ↔ child collections
  (recursively), bookmarks ↔ raindrops. Other bookmark folders are never touched.
- Changes you make in the browser (add/edit/move/delete on the bar) push to Raindrop
  immediately.
- A periodic sync (opt-in, configurable interval) and **Sync now** pull from Raindrop and
  reconcile, so anything added, edited, moved or deleted in Raindrop itself (web app, mobile,
  other integrations) flows down too.
- The bar is kept sorted: folders first, then bookmarks, both alphabetical.

### Initial sync

The first sync is a union merge, so both setup styles work:

- **Existing bar, empty collection** (first-time setup): everything on the bar is pushed up
  into the collection, folders included.
- **Empty bar, existing collection** (new or secondary device): the collection is pulled down
  onto the bar.
- **Both populated**: items are matched by URL (bookmarks) or title (folders); the remainder
  is merged in both directions with nothing deleted.

Changing the target collection automatically resyncs the same way: previous matches are
forgotten and the bar merges with the new collection - nothing is deleted. The **Force
resync** button in settings triggers the same clean rebuild on demand (e.g. after syncing to
the wrong collection).

### Workspaces

**Save collection** stores every http(s) tab of the current window (order and pinned state
included) as a new sub-collection under your workspaces collection, then closes the window.
**Load collection** reopens it as a new window with pinned tabs restored, and each listed
workspace can be deleted in place (click the ✕, then confirm).

## Conflict handling

Raindrop is the source of truth; the design goal is convergence, never data loss on the
Raindrop side:

- **Both sides changed the same item** between syncs → the Raindrop version wins at the next
  reconcile; the browser copy is updated to match.
- **Deleted in Raindrop** → removed from the bar at the next sync (matched via stored id maps,
  so renames don't cause false deletes).
- **Added in the browser** while offline or before a first sync → pushed up to Raindrop at the
  next sync rather than deleted (unmapped local items are treated as new).
- **Deleted in the browser but the push fails** (offline, rate limited) → the delete is queued
  durably and applied at the start of the next sync, before reconciling. Without this the item
  would be resurrected locally; if the queued delete still cannot be applied, the sync aborts
  rather than resurrecting.
- **Any other failed push** schedules a retry sync one minute later; the reconcile converges
  the two sides (Raindrop wins for edits, local additions are pushed up).
- Deletes in Raindrop go to the Trash, so mistakes are recoverable there.

Sync runs are coalesced (concurrent triggers share one run) and local pushes are serialised,
so events cannot interleave mid-operation. The extension's own bookmark mutations are muted
so they are not echoed back to Raindrop.

## Development

Plain ES modules, no build step, no dependencies.

```
src/lib/         Raindrop API client and storage helpers
src/background/  service worker: sync engine, workspaces, message router
src/options/     settings page
src/popup/       toolbar popup
test/            end-to-end test harness
```

Run the end-to-end tests with `./test/run-e2e.sh` (requires Node 22+, openssl and Microsoft
Edge). It loads the extension into a disposable browser profile and exercises every sync,
conflict and workspace flow against a local mock of the Raindrop API - no account needed.
To run the same suite against the real API: `RD_BASE=https://api.raindrop.io
RAINDROP_TOKEN=<test token> node test/e2e.mjs` (it creates and removes `SyncTest-*`
collections in that account).
