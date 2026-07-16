// In-memory mock of the Raindrop.io REST API surface the extension uses.
// HTTPS :443 for the browser (via --host-resolver-rules MAP api.raindrop.io 127.0.0.1
// + --ignore-certificate-errors) and HTTP :8080 for the test script.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';

let nextId = 1000;
const collections = new Map(); // id -> {_id,title,parent?,count}
const raindrops = new Map();   // id -> {_id,link,title,collection:{$id},tags,sort,created}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function collectionOut(c) {
  const count = [...raindrops.values()].filter(r => r.collection.$id === c._id).length;
  return { ...c, count };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/rest\/v1/, '');
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const m = req.method;

  if (m === 'GET' && path === '/user') return json(res, 200, { result: true, user: { fullName: 'E2E Mock User', email: 'e2e@mock.test' } });

  if (m === 'GET' && path === '/collections')
    return json(res, 200, { result: true, items: [...collections.values()].filter(c => !c.parent).map(collectionOut) });
  if (m === 'GET' && path === '/collections/childrens') {
    // Real Raindrop can return root collections here too (sidebar groups);
    // reproduce that so the client's dedupe is exercised end-to-end.
    const children = [...collections.values()].filter(c => c.parent);
    const dupedRoots = [...collections.values()].filter(c => !c.parent);
    return json(res, 200, { result: true, items: [...children, ...dupedRoots].map(collectionOut) });
  }

  if (m === 'POST' && path === '/collection') {
    const item = { _id: ++nextId, title: body.title, ...(body.parent ? { parent: { $id: body.parent.$id } } : {}) };
    collections.set(item._id, item);
    return json(res, 200, { result: true, item: collectionOut(item) });
  }
  let match = path.match(/^\/collection\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const c = collections.get(id);
    if (!c) return json(res, 404, { result: false, errorMessage: 'collection not found' });
    if (m === 'PUT') {
      if (body.title !== undefined) c.title = body.title;
      if (body.parent !== undefined) c.parent = { $id: body.parent.$id };
      return json(res, 200, { result: true, item: collectionOut(c) });
    }
    if (m === 'DELETE') {
      collections.delete(id);
      for (const [rid, r] of raindrops) if (r.collection.$id === id) raindrops.delete(rid);
      return json(res, 200, { result: true });
    }
  }

  match = path.match(/^\/raindrops\/(-?\d+)$/);
  if (match) {
    const cid = Number(match[1]);
    if (m === 'GET') {
      const perpage = Number(url.searchParams.get('perpage') || 50);
      const page = Number(url.searchParams.get('page') || 0);
      const items = [...raindrops.values()].filter(r => r.collection.$id === cid);
      return json(res, 200, { result: true, items: items.slice(page * perpage, (page + 1) * perpage) });
    }
    if (m === 'DELETE') {
      const ids = body.ids || [];
      let n = 0;
      for (const id of ids) if (raindrops.delete(id)) n++;
      return json(res, 200, { result: true, modified: n });
    }
  }

  if (m === 'POST' && path === '/raindrop') {
    const item = mkRaindrop(body);
    return json(res, 200, { result: true, item });
  }
  if (m === 'POST' && path === '/raindrops') {
    const items = (body.items || []).map(mkRaindrop);
    return json(res, 200, { result: true, items });
  }
  match = path.match(/^\/raindrop\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const r = raindrops.get(id);
    if (!r) return json(res, 404, { result: false, errorMessage: 'raindrop not found' });
    if (m === 'PUT') {
      if (body.link !== undefined) r.link = body.link;
      if (body.title !== undefined) r.title = body.title;
      if (body.collection !== undefined) r.collection = { $id: body.collection.$id };
      if (body.tags !== undefined) r.tags = body.tags;
      if (body.order !== undefined) r.sort = body.order;
      return json(res, 200, { result: true, item: r });
    }
    if (m === 'DELETE') {
      raindrops.delete(id);
      return json(res, 200, { result: true });
    }
  }

  json(res, 404, { result: false, errorMessage: `mock: no route ${m} ${path}` });
}

function mkRaindrop(body) {
  const item = {
    _id: ++nextId,
    link: body.link,
    title: body.title || body.link,
    collection: { $id: body.collection ? body.collection.$id : -1 },
    tags: body.tags || [],
    sort: body.order !== undefined ? body.order : 0,
  };
  raindrops.set(item._id, item);
  return item;
}

const wrap = (req, res) => handle(req, res).catch(e => json(res, 500, { errorMessage: e.message }));

const cert = {
  key: readFileSync(new URL('./mock-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./mock-cert.pem', import.meta.url)),
};
https.createServer(cert, wrap).listen(8443, '127.0.0.1', () => console.log('mock https 127.0.0.1:8443'));
http.createServer(wrap).listen(8080, '127.0.0.1', () => console.log('mock http 127.0.0.1:8080'));

// Loopback-only forward proxy for the test browser: CONNECTs to
// api.raindrop.io:443 are tunnelled to the local mock; everything else goes
// to its real destination.
import net from 'node:net';
const proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
proxy.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const toMock = host === 'api.raindrop.io';
  const upstream = net.connect(toMock ? 8443 : Number(port || 443), toMock ? '127.0.0.1' : host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const drop = () => { clientSocket.destroy(); upstream.destroy(); };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});
proxy.listen(8081, '127.0.0.1', () => console.log('proxy 127.0.0.1:8081'));
