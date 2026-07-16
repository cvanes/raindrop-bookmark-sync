// Raindrop.io REST API client (https://api.raindrop.io/rest/v1).

const BASE_URL = 'https://api.raindrop.io/rest/v1';
const PAGE_SIZE = 50;
const BATCH_SIZE = 100;
const DEFAULT_RETRY_WAIT_MS = 60_000;
const MAX_RETRY_WAIT_MS = 90_000;

export class RaindropApi {
  #token;
  #callCount = 0;

  constructor(token) {
    this.#token = token;
  }

  get apiCallCount() {
    return this.#callCount;
  }

  async getUser() {
    const { user } = await this.#request('GET', '/user');
    return user;
  }

  async getAllCollections() {
    const [roots, children] = await Promise.all([
      this.#request('GET', '/collections'),
      this.#request('GET', '/collections/childrens'),
    ]);
    // The two endpoints can both return the same collection (e.g. when it
    // sits inside a sidebar group), so dedupe by id.
    const byId = new Map();
    for (const c of [...(roots.items ?? []), ...(children.items ?? [])]) {
      byId.set(c._id, c);
    }
    return [...byId.values()];
  }

  async createCollection(title, parentId) {
    const body = { title };
    if (parentId != null) body.parent = { $id: parentId };
    const { item } = await this.#request('POST', '/collection', body);
    return item;
  }

  async updateCollection(id, fields) {
    const { item } = await this.#request('PUT', `/collection/${id}`, fields);
    return item;
  }

  async deleteCollection(id) {
    await this.#request('DELETE', `/collection/${id}`);
  }

  async getRaindrops(collectionId) {
    const items = [];
    for (let page = 0; ; page += 1) {
      const result = await this.#request(
        'GET',
        `/raindrops/${collectionId}?perpage=${PAGE_SIZE}&page=${page}`
      );
      const pageItems = result.items ?? [];
      items.push(...pageItems);
      if (pageItems.length < PAGE_SIZE) break;
    }
    return items;
  }

  async createRaindrop({ link, title, collectionId }) {
    const body = { link, title, collection: { $id: collectionId }, pleaseParse: {} };
    const { item } = await this.#request('POST', '/raindrop', body);
    return item;
  }

  async createRaindrops(items) {
    const created = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE).map(({ link, title, collectionId, tags, order }) => ({
        link,
        title,
        collection: { $id: collectionId },
        ...(tags && tags.length ? { tags } : {}),
        ...(order !== undefined ? { order } : {}),
      }));
      const result = await this.#request('POST', '/raindrops', { items: chunk });
      created.push(...(result.items ?? []));
    }
    return created;
  }

  async updateRaindrop(id, { link, title, collectionId }) {
    const body = {};
    if (link !== undefined) body.link = link;
    if (title !== undefined) body.title = title;
    if (collectionId !== undefined) body.collection = { $id: collectionId };
    const { item } = await this.#request('PUT', `/raindrop/${id}`, body);
    return item;
  }

  async deleteRaindrop(id) {
    await this.#request('DELETE', `/raindrop/${id}`);
  }

  // Removes every raindrop in the collection (they move to Trash).
  async deleteAllRaindrops(collectionId) {
    await this.#request('DELETE', `/raindrops/${collectionId}`);
  }

  async #request(method, path, body) {
    const first = await this.#fetchOnce(method, path, body);
    if (first.status === 429) {
      await sleep(retryWaitMs(first.headers.get('X-RateLimit-Reset')));
      const second = await this.#fetchOnce(method, path, body);
      return this.#parseResponse(second, method, path);
    }
    return this.#parseResponse(first, method, path);
  }

  async #fetchOnce(method, path, body) {
    this.#callCount += 1;
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async #parseResponse(response, method, path) {
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = json?.errorMessage ? `: ${json.errorMessage}` : '';
      throw new Error(`Raindrop API ${method} ${path} failed with status ${response.status}${detail}`);
    }
    return json;
  }
}

function retryWaitMs(resetHeader) {
  const resetEpochSeconds = Number(resetHeader);
  if (!Number.isFinite(resetEpochSeconds) || resetEpochSeconds <= 0) {
    return DEFAULT_RETRY_WAIT_MS;
  }
  const waitMs = resetEpochSeconds * 1000 - Date.now();
  return Math.min(Math.max(waitMs, 0), MAX_RETRY_WAIT_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildCollectionTree(collections) {
  const byId = new Map(collections.map((c) => [c._id, c]));
  const childrenByParentId = new Map();
  const roots = [];

  for (const collection of collections) {
    const parentId = collection.parent?.$id;
    if (parentId != null && byId.has(parentId)) {
      if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
      childrenByParentId.get(parentId).push(collection);
    } else {
      roots.push(collection);
    }
  }

  const toNode = (collection) => ({
    id: collection._id,
    title: collection.title,
    children: sortByTitle(childrenByParentId.get(collection._id) ?? []).map(toNode),
  });

  return sortByTitle(roots).map(toNode);
}

function sortByTitle(collections) {
  return [...collections].sort((a, b) => a.title.localeCompare(b.title));
}

export function collectionPath(collections, id) {
  const byId = new Map(collections.map((c) => [c._id, c]));
  const titles = [];
  const visited = new Set();
  let currentId = id;

  while (currentId != null && byId.has(currentId) && !visited.has(currentId)) {
    visited.add(currentId);
    const collection = byId.get(currentId);
    titles.unshift(collection.title);
    currentId = collection.parent?.$id;
  }

  return titles.join(' / ');
}
