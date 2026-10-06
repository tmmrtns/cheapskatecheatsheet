// Browser-only replacement for the Netlify functions, so the site works on
// static hosting such as GitHub Pages. Data lives in this browser:
// promotions and price checks in localStorage, screenshots in IndexedDB.
(function () {
  const PROMOS_KEY = 'cheapskate.promotions';
  const CHECKS_KEY = 'cheapskate.priceChecks';
  const DB_NAME = 'cheapskate-screenshots';
  const CATEGORIES = ['diapers', 'dishwasher', 'toiletpaper', 'kitchentowels', 'wetwipes', 'detergent', 'coffeecups'];
  const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }));

  function read(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { throw new Error('Browser storage is full or unavailable.'); }
  }
  const text = (v, max, required) => {
    if (typeof v !== 'string') return required ? null : undefined;
    const c = v.trim().slice(0, max);
    return c || (required ? null : undefined);
  };
  const date = v => v === null || v === '' ? null : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const fail = (message, status) => Object.assign(new Error(message), { status });

  // ---- screenshots (IndexedDB) ----
  let dbPromise;
  function idb() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function idbRun(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const urlCache = new Map();

  async function saveImage(blob) {
    const ext = EXTENSIONS[(blob.type || '').split(';')[0].toLowerCase()];
    if (!ext) throw fail('Unsupported image format', 415);
    if (!blob.size || blob.size > 5 * 1024 * 1024) throw fail('Image must be under 5 MB', 413);
    const key = uuid() + '.' + ext;
    await idbRun('readwrite', s => s.put(blob, key));
    return key;
  }
  async function getImage(key) {
    const blob = await idbRun('readonly', s => s.get(key));
    if (!blob) throw fail('Not found', 404);
    return blob;
  }
  async function imageUrl(key) {
    if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(await getImage(key)));
    return urlCache.get(key);
  }
  async function deleteImages(keys) {
    for (const key of keys) {
      if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
      await idbRun('readwrite', s => s.delete(key));
    }
  }

  // ---- promotions ----
  async function promotions(method, id, body, query) {
    let list = read(PROMOS_KEY);
    if (method === 'GET') {
      const today = date(query.get('today')) || new Date().toISOString().slice(0, 10);
      const expired = list.filter(p => p.endDate < today);
      if (expired.length) {
        list = list.filter(p => p.endDate >= today);
        write(PROMOS_KEY, list);
        await deleteImages(expired.map(p => p.imageKey).filter(Boolean));
      }
      return list.slice().sort((a, b) => b.createdAt - a.createdAt);
    }
    if (method === 'POST') {
      const p = {
        shop: text(body.shop, 160, true), item: text(body.item, 240, true), discount: text(body.discount, 160, true),
        category: text(body.category, 120) ?? null, startDate: date(body.startDate), endDate: date(body.endDate),
        notes: text(body.notes, 2000) ?? null, imageKey: text(body.imageKey, 500) ?? null,
        redeemed: body.redeemed === true, rank: Number(body.rank),
      };
      const created = Number(body.createdAt);
      if (!p.shop || !p.item || !p.discount || !p.endDate || p.startDate === undefined ||
          !Number.isInteger(p.rank) || p.rank < 1 || p.rank > 5) throw fail('Invalid promotion.', 400);
      p.id = uuid();
      p.createdAt = Number.isFinite(created) && created > 0 ? created : Date.now();
      list.push(p);
      write(PROMOS_KEY, list);
      return p;
    }
    if (method === 'PATCH') {
      const existing = list.find(p => p.id === id);
      if (!existing) throw fail('Promotion not found.', 404);
      const has = k => body[k] !== undefined;
      const next = {
        ...existing,
        shop: has('shop') ? text(body.shop, 160, true) : existing.shop,
        item: has('item') ? text(body.item, 240, true) : existing.item,
        discount: has('discount') ? text(body.discount, 160, true) : existing.discount,
        category: has('category') ? text(body.category, 120) ?? null : existing.category,
        startDate: has('startDate') ? date(body.startDate) : existing.startDate,
        endDate: has('endDate') ? date(body.endDate) : existing.endDate,
        notes: has('notes') ? text(body.notes, 2000) ?? null : existing.notes,
        imageKey: has('imageKey') ? text(body.imageKey, 500) ?? null : existing.imageKey,
        redeemed: has('redeemed') ? body.redeemed === true : existing.redeemed,
        rank: has('rank') ? Number(body.rank) : Number(existing.rank),
      };
      if (!next.shop || !next.item || !next.discount || !next.endDate || next.startDate === undefined ||
          !Number.isInteger(next.rank) || next.rank < 1 || next.rank > 5) throw fail('Invalid promotion.', 400);
      write(PROMOS_KEY, list.map(p => p.id === id ? next : p));
      if (existing.imageKey && existing.imageKey !== next.imageKey) await deleteImages([existing.imageKey]);
      return next;
    }
    if (method === 'DELETE') {
      const removed = id ? list.filter(p => p.id === id) : list;
      if (id && !removed.length) throw fail('Promotion not found.', 404);
      write(PROMOS_KEY, id ? list.filter(p => p.id !== id) : []);
      await deleteImages(removed.map(p => p.imageKey).filter(Boolean));
      return null;
    }
    throw fail('Method not allowed.', 405);
  }

  // ---- price checks ----
  async function priceChecks(method, id, body) {
    const list = read(CHECKS_KEY);
    if (method === 'GET') return list.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (method === 'POST') {
      const unitPrice = Number(body.unitPrice);
      const inputs = body.inputs;
      if (!CATEGORIES.includes(body.category) || !Number.isFinite(unitPrice) || unitPrice <= 0 ||
          !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw fail('Invalid price check.', 400);
      const subtype = typeof body.subtype === 'string' && body.subtype.trim() ? body.subtype.trim().slice(0, 120) : null;
      const entry = { id: uuid(), category: body.category, subtype, unitPrice, inputs, createdAt: Number(body.createdAt) > 0 ? Number(body.createdAt) : Date.now() };
      list.push(entry);
      write(CHECKS_KEY, list);
      return entry;
    }
    if (method === 'DELETE' && id) {
      if (!list.some(e => e.id === id)) throw fail('Price check not found.', 404);
      write(CHECKS_KEY, list.filter(e => e.id !== id));
      return null;
    }
    throw fail('Method not allowed.', 405);
  }

  // Same call shape as the old fetch-based api(path, options).
  async function api(path, options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const url = new URL(path, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
    const id = parts[2] ? decodeURIComponent(parts[2]) : null;
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    if (parts[1] === 'promotions') return promotions(method, id, body, url.searchParams);
    if (parts[1] === 'price-checks') return priceChecks(method, id, body);
    if (parts[1] === 'screenshots' && method === 'POST') return { key: await saveImage(options.body) };
    throw fail('Not found', 404);
  }

  window.localApi = { api, getImage, imageUrl };
})();
