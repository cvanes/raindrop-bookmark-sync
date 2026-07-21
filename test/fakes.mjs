// In-memory fakes so the real sync engine can be tested in Node without a
// browser: a fake `chrome.*` (bookmarks tree + storage + alarms) and a `fetch`
// stub backed by an in-memory model of the Raindrop REST API. The production
// code (src/background/sync.js, src/lib/api.js, src/lib/settings.js) runs
// unchanged - only the globals it reaches for (`chrome`, `fetch`) are swapped.

const BASE = 'https://api.raindrop.io/rest/v1';

// --- Fake Raindrop backend -------------------------------------------------

export class FakeRaindrop {
  constructor() {
    this.cols = new Map(); // _id -> { _id, title, parent?: {$id}, count }
    this.drops = new Map(); // _id -> { _id, title, link, collectionId, tags }
    this._seq = 1000;
  }

  nextId() {
    return (this._seq += 1);
  }

  addCollection({ title, parentId = null }) {
    const _id = this.nextId();
    const col = { _id, title, count: 0 };
    if (parentId != null) col.parent = { $id: parentId };
    this.cols.set(_id, col);
    return col;
  }

  addDrop({ title, link, collectionId, tags = [], order }) {
    const _id = this.nextId();
    const drop = { _id, title, link, collectionId, tags };
    if (order !== undefined) drop.order = order;
    this.drops.set(_id, drop);
    return drop;
  }

  rootCols() {
    return [...this.cols.values()].filter((c) => !c.parent);
  }

  childCols() {
    return [...this.cols.values()].filter((c) => c.parent);
  }

  dropsIn(cid) {
    return [...this.drops.values()].filter((d) => d.collectionId === cid);
  }

  deleteCollection(id) {
    for (const c of [...this.cols.values()].filter((c) => (c.parent?.$id ?? null) === id)) {
      this.deleteCollection(c._id);
    }
    for (const d of this.dropsIn(id)) this.drops.delete(d._id);
    this.cols.delete(id);
  }
}

function jsonResponse(status, obj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(obj ?? {}),
  };
}

// Build a `fetch` implementation that routes against the model above.
export function makeFetch(rd) {
  return async function fetch(url, opts = {}) {
    const method = opts.method || 'GET';
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/rest/v1', '');
    const parts = path.split('/').filter(Boolean); // e.g. ['raindrops','1001']
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const idFrom = (i) => Number(parts[i]);

    // /user
    if (method === 'GET' && path === '/user') {
      return jsonResponse(200, { user: { _id: 1, fullName: 'Test User', email: 't@example.com' } });
    }
    // /collections and /collections/childrens
    if (method === 'GET' && path === '/collections') return jsonResponse(200, { items: rd.rootCols() });
    if (method === 'GET' && path === '/collections/childrens') return jsonResponse(200, { items: rd.childCols() });

    // /collection (create), /collection/:id (update, delete)
    if (method === 'POST' && path === '/collection') {
      const col = rd.addCollection({ title: body.title, parentId: body.parent?.$id ?? null });
      return jsonResponse(200, { item: col });
    }
    if (method === 'PUT' && parts[0] === 'collection') {
      const col = rd.cols.get(idFrom(1));
      if (!col) return jsonResponse(404, { errorMessage: 'collection not found' });
      if (body.title != null) col.title = body.title;
      if (body.parent !== undefined) col.parent = body.parent;
      return jsonResponse(200, { item: col });
    }
    if (method === 'DELETE' && parts[0] === 'collection') {
      if (!rd.cols.has(idFrom(1))) return jsonResponse(404, { errorMessage: 'collection not found' });
      rd.deleteCollection(idFrom(1));
      return jsonResponse(200, { result: true });
    }

    // /raindrops/:cid (list, delete-all), /raindrop (create), /raindrops (batch), /raindrop/:id
    if (method === 'GET' && parts[0] === 'raindrops') {
      const cid = idFrom(1);
      const perpage = Number(parsed.searchParams.get('perpage')) || 50;
      const page = Number(parsed.searchParams.get('page')) || 0;
      const all = rd.dropsIn(cid);
      return jsonResponse(200, { items: all.slice(page * perpage, page * perpage + perpage) });
    }
    if (method === 'DELETE' && parts[0] === 'raindrops') {
      for (const d of rd.dropsIn(idFrom(1))) rd.drops.delete(d._id);
      return jsonResponse(200, { result: true });
    }
    if (method === 'POST' && path === '/raindrop') {
      const drop = rd.addDrop({ title: body.title, link: body.link, collectionId: body.collection.$id });
      return jsonResponse(200, { item: drop });
    }
    if (method === 'POST' && path === '/raindrops') {
      const items = body.items.map((i) =>
        rd.addDrop({ title: i.title, link: i.link, collectionId: i.collection.$id, tags: i.tags, order: i.order })
      );
      return jsonResponse(200, { items });
    }
    if (method === 'PUT' && parts[0] === 'raindrop') {
      const drop = rd.drops.get(idFrom(1));
      if (!drop) return jsonResponse(404, { errorMessage: 'raindrop not found' });
      if (body.link != null) drop.link = body.link;
      if (body.title != null) drop.title = body.title;
      if (body.collection?.$id != null) drop.collectionId = body.collection.$id;
      return jsonResponse(200, { item: drop });
    }
    if (method === 'DELETE' && parts[0] === 'raindrop') {
      rd.drops.delete(idFrom(1));
      return jsonResponse(200, { result: true });
    }

    throw new Error(`FakeRaindrop: unhandled ${method} ${path}`);
  };
}

// --- Fake chrome.* ---------------------------------------------------------

export function makeChrome() {
  const nodes = new Map();
  nodes.set('0', { id: '0', parentId: undefined, title: 'root', children: ['1'] });
  nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] });
  let seq = 100;

  const node = (id) => nodes.get(id);
  const shallow = (n, index) => {
    const o = { id: n.id, parentId: n.parentId, title: n.title, index };
    if (n.url != null) o.url = n.url;
    return o;
  };
  const buildTree = (id) => {
    const n = node(id);
    const o = { id: n.id, parentId: n.parentId, title: n.title };
    if (n.url != null) o.url = n.url;
    o.children = n.children.map(buildTree);
    return o;
  };

  const bookmarks = {
    async getTree() {
      return [buildTree('0')];
    },
    async getSubTree(id) {
      return [buildTree(id)];
    },
    async getChildren(id) {
      return node(id).children.map((cid, i) => shallow(node(cid), i));
    },
    async get(id) {
      const n = node(id);
      if (!n) throw new Error("Can't find bookmark for id: " + id);
      return [shallow(n, 0)];
    },
    async create({ parentId, title, url, index }) {
      const id = String((seq += 1));
      const n = { id, parentId, title: title ?? '', children: [] };
      if (url != null) n.url = url;
      nodes.set(id, n);
      const siblings = node(parentId).children;
      if (index == null) siblings.push(id);
      else siblings.splice(index, 0, id);
      return shallow(n, siblings.indexOf(id));
    },
    async update(id, changes) {
      const n = node(id);
      if (changes.title != null) n.title = changes.title;
      if (changes.url != null) n.url = changes.url;
      return shallow(n, 0);
    },
    async move(id, { parentId, index }) {
      const n = node(id);
      const old = node(n.parentId).children;
      old.splice(old.indexOf(id), 1);
      n.parentId = parentId;
      const siblings = node(parentId).children;
      if (index == null) siblings.push(id);
      else siblings.splice(index, 0, id);
      return shallow(n, siblings.indexOf(id));
    },
    async remove(id) {
      const n = node(id);
      const siblings = node(n.parentId).children;
      siblings.splice(siblings.indexOf(id), 1);
      nodes.delete(id);
    },
    async removeTree(id) {
      const rm = (x) => {
        for (const c of [...node(x).children]) rm(c);
        const parent = node(node(x).parentId);
        if (parent) parent.children.splice(parent.children.indexOf(x), 1);
        nodes.delete(x);
      };
      rm(id);
    },
  };

  const store = {};
  const storage = {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]));
        return { ...store };
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    },
    onChanged: { addListener() {} },
  };

  return {
    bookmarks,
    storage,
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: { lastError: null },
    __nodes: nodes,
    __store: store,
  };
}

// --- harness + inspection helpers ------------------------------------------

// Install fresh fakes as globals and seed settings. Returns { rd, chrome }.
export function setupHarness({ settings = {}, seedRemote } = {}) {
  const rd = new FakeRaindrop();
  if (seedRemote) seedRemote(rd);
  const chrome = makeChrome();
  chrome.__store.settings = { testToken: 'test-token', ...settings };
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch(rd);
  return { rd, chrome };
}

// Create a bookmark/folder under a parent (default: the bar). Returns the id.
export async function seed(chrome, { parentId = '1', title, url } = {}) {
  const n = await chrome.bookmarks.create({ parentId, title, url });
  return n.id;
}

// Depth-first titles of everything under a node (default: the bar).
export function subtreeTitles(chrome, id = '1') {
  const walk = (nid) =>
    chrome.__nodes.get(nid).children.flatMap((cid) => {
      const c = chrome.__nodes.get(cid);
      return [c.title, ...walk(cid)];
    });
  return walk(id);
}

// Immediate child titles of a node (default: the bar).
export function childTitles(chrome, id = '1') {
  return chrome.__nodes.get(id).children.map((cid) => chrome.__nodes.get(cid).title);
}

export function getSyncStateRaw(chrome) {
  return chrome.__store.syncState;
}
