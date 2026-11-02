// 本機測試用：模擬 Google Apps Script 後端 + 靜態網站伺服器
// 只在開發測試時使用，不會部署到 GitHub Pages。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 8787;
const WEB_PORT = 8788;
const SECRET = 'test';

let store = { deposits: [], cards: [], rev: 0, updatedAt: 0 };

function mergeStates(a, b) {
  const out = { deposits: [], cards: [] };
  for (const k of ['deposits', 'cards']) {
    const map = new Map();
    const order = [];
    for (const list of [a[k] || [], b[k] || []]) {
      for (const r of list) {
        if (!r || !r.id) continue;
        const id = String(r.id);
        const t = Number(r.updatedAt || 0);
        const prev = map.get(id);
        if (!prev) { map.set(id, r); order.push(id); }
        else if (t >= Number(prev.updatedAt || 0)) map.set(id, r);
      }
    }
    out[k] = order.map((id) => map.get(id));
  }
  return out;
}

function json(res, obj, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('k') !== SECRET) return json(res, { ok: false, error: '密鑰錯誤' });

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
    const action = payload.action || url.searchParams.get('action') || 'get';

    if (action === 'get' || action === 'ping') {
      return json(res, { ok: true, rev: store.rev, updatedAt: store.updatedAt, state: { deposits: store.deposits, cards: store.cards } });
    }
    if (action === 'merge') {
      const merged = mergeStates(store, payload.state || {});
      store = { ...merged, rev: store.rev + 1, updatedAt: Date.now() };
      // 模擬真實 Apps Script 嘅網絡延遲，用嚟重現「請求進行中」嘅競態
      const delay = Number(process.env.MOCK_DELAY || 700);
      const body = { ok: true, rev: store.rev, updatedAt: store.updatedAt, state: merged };
      return setTimeout(() => json(res, body), delay);
    }
    if (action === 'upload') {
      return json(res, { ok: true, url: 'https://example.com/fake.jpg', id: 'fake' });
    }
    return json(res, { ok: false, error: 'unknown action ' + action });
  });
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.gs': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

api.listen(API_PORT, '127.0.0.1', () => console.log(`API  http://127.0.0.1:${API_PORT}/exec?k=${SECRET}`));
web.listen(WEB_PORT, '127.0.0.1', () => console.log(`WEB  http://127.0.0.1:${WEB_PORT}/`));

export function resetStore() { store = { deposits: [], cards: [], rev: 0, updatedAt: 0 }; }
export function getStore() { return store; }
