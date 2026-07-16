// Minimal CDP driver for testing the extension in a disposable Chrome instance.
// Node 22+ (global WebSocket, fetch).
const PORT = process.env.CDP_PORT || '9223';
const BASE = `http://127.0.0.1:${PORT}`;

export async function waitForBrowser(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome debug port not reachable');
}

export async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  return res.json();
}

export async function findTarget(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const hit = targets.find(predicate);
    if (hit) return hit;
    await sleep(300);
  }
  throw new Error('Target not found: ' + String(predicate));
}

export async function openPage(url) {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return res.json();
}

export async function closeTarget(id) {
  await fetch(`${BASE}/json/close/${id}`);
}

export class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = () => err(new Error('ws error')); });
    const s = new Session(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { resolve, reject } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        s.events.push(msg);
      }
    };
    return s;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 30000);
    });
  }

  // Evaluate an expression; awaits promises; throws on JS exceptions; returns the value.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('JS exception: ' + (d.exception?.description || d.text));
    }
    return r.result.value;
  }

  async screenshot(path) {
    const { writeFile } = await import('node:fs/promises');
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(r.data, 'base64'));
  }

  close() { this.ws.close(); }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
