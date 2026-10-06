// Browser-only replacement for the Netlify functions, so the site works on
// static hosting such as GitHub Pages. Two storage modes:
//  - local (default): localStorage + IndexedDB, this browser only.
//  - GitHub sync (when a token is saved via the Sync button): data is kept in
//    the `data` branch of the repo (data/*.json, data/images/*) so every
//    device sees the same promotions.
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

  // ---- GitHub sync backend ----
  const TOKEN_KEY = 'cheapskate.ghToken';
  const REPO_KEY = 'cheapskate.ghRepo';
  const DATA_BRANCH = 'data';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  const token = () => lsGet(TOKEN_KEY);
  function repo() {
    const saved = lsGet(REPO_KEY);
    if (saved) return saved;
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const name = location.pathname.split('/').filter(Boolean)[0];
    return m && name ? m[1] + '/' + name : 'tmmrtns/cheapskatecheatsheet';
  }
  const syncing = () => !!token();

  async function gh(path, opts) {
    opts = opts || {};
    const res = await fetch('https://api.github.com/repos/' + repo() + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: Object.assign({
        'Authorization': 'Bearer ' + token(),
        'Accept': 'application/vnd.github+json',
      }, opts.headers || {}),
      body: opts.body,
    });
    if (res.status === 401 || res.status === 403) throw fail('GitHub rejected the token (check it has Contents: read & write on this repo).', res.status);
    return res;
  }
  let branchReady = false;
  async function ensureBranch() {
    if (branchReady) return;
    if ((await gh('/git/ref/heads/' + DATA_BRANCH)).ok) { branchReady = true; return; }
    const info = await (await gh('')).json();
    const base = await (await gh('/git/ref/heads/' + info.default_branch)).json();
    const created = await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + DATA_BRANCH, sha: base.object.sha }) });
    if (!created.ok && created.status !== 422) throw fail('Could not create the data branch.', created.status);
    branchReady = true;
  }
  const b64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
  const fromB64 = str => Uint8Array.from(atob(str.replace(/\s/g, '')), c => c.charCodeAt(0));
  const enc = encodeURIComponent;

  async function ghRead(file) { // -> { data, sha }
    await ensureBranch();
    const res = await gh('/contents/' + file + '?ref=' + DATA_BRANCH);
    if (res.status === 404) return { data: [], sha: null };
    if (!res.ok) throw fail('GitHub error ' + res.status, res.status);
    const body = await res.json();
    try { const v = JSON.parse(new TextDecoder().decode(fromB64(body.content))); return { data: Array.isArray(v) ? v : [], sha: body.sha }; }
    catch (e) { return { data: [], sha: body.sha }; }
  }
  async function ghPut(file, bytes, sha, message) {
    const res = await gh('/contents/' + file, { method: 'PUT', body: JSON.stringify({ message, content: b64(bytes), branch: DATA_BRANCH, sha: sha || undefined }) });
    if (res.status === 409 || res.status === 422) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!res.ok) throw fail('GitHub error ' + res.status, res.status);
  }
  // Read-modify-write with retry when another device saved in between.
  async function ghMutate(file, fn, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await ghRead(file);
      const [next, result] = fn(data);
      if (next === data) return result;
      try { await ghPut(file, new TextEncoder().encode(JSON.stringify(next, null, 1)), sha, message); return result; }
      catch (e) { if (!e.conflict) throw e; }
    }
    throw fail('Could not save: GitHub data changed too often. Try again.', 409);
  }

  // Run fn(list) -> [newList, result] against whichever store is active.
  async function mutate(kind, fn) {
    const key = kind === 'promos' ? PROMOS_KEY : CHECKS_KEY;
    if (syncing()) return ghMutate(kind === 'promos' ? 'data/promotions.json' : 'data/price-checks.json', fn, 'Update ' + kind);
    const list = read(key);
    const [next, result] = fn(list);
    if (next !== list) write(key, next);
    return result;
  }

  // ---- screenshots (IndexedDB locally, GitHub files when syncing) ----
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
    await idbRun('readwrite', s => s.put(blob, key)); // also acts as a local cache when syncing
    if (syncing()) {
      try { await ensureBranch(); await ghPut('data/images/' + key, new Uint8Array(await blob.arrayBuffer()), null, 'Add screenshot'); }
      catch (e) { await idbRun('readwrite', s => s.delete(key)); throw e; }
    }
    return key;
  }
  async function getImage(key) {
    let blob = await idbRun('readonly', s => s.get(key));
    if (!blob && syncing()) {
      await ensureBranch();
      const res = await gh('/contents/data/images/' + enc(key) + '?ref=' + DATA_BRANCH, { headers: { 'Accept': 'application/vnd.github.raw+json' } });
      if (!res.ok) throw fail('Not found', 404);
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[key.split('.').pop()] || 'image/jpeg';
      blob = new Blob([await res.arrayBuffer()], { type });
      await idbRun('readwrite', s => s.put(blob, key));
    }
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
      if (syncing()) {
        try {
          const res = await gh('/contents/data/images/' + enc(key) + '?ref=' + DATA_BRANCH);
          if (res.ok) { const { sha } = await res.json(); await gh('/contents/data/images/' + enc(key), { method: 'DELETE', body: JSON.stringify({ message: 'Remove screenshot', sha, branch: DATA_BRANCH }) }); }
        } catch (e) { /* orphaned file is harmless */ }
      }
    }
  }

  // ---- promotions ----
  async function promotions(method, id, body, query) {
    const removedImages = [];
    const result = await mutate('promos', list => {
      if (method === 'GET') {
        const today = date(query.get('today')) || new Date().toISOString().slice(0, 10);
        const expired = list.filter(p => p.endDate < today);
        const kept = expired.length ? list.filter(p => p.endDate >= today) : list;
        removedImages.push(...expired.map(p => p.imageKey).filter(Boolean));
        return [kept, kept.slice().sort((a, b) => b.createdAt - a.createdAt)];
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
        return [list.concat([p]), p];
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
        if (existing.imageKey && existing.imageKey !== next.imageKey) removedImages.push(existing.imageKey);
        return [list.map(p => p.id === id ? next : p), next];
      }
      if (method === 'DELETE') {
        const removed = id ? list.filter(p => p.id === id) : list;
        if (id && !removed.length) throw fail('Promotion not found.', 404);
        removedImages.push(...removed.map(p => p.imageKey).filter(Boolean));
        return [id ? list.filter(p => p.id !== id) : [], null];
      }
      throw fail('Method not allowed.', 405);
    });
    if (removedImages.length) await deleteImages(removedImages);
    return result;
  }

  // ---- price checks ----
  function priceChecks(method, id, body) {
    return mutate('checks', list => {
      if (method === 'GET') return [list, list.slice().sort((a, b) => b.createdAt - a.createdAt)];
      if (method === 'POST') {
        const unitPrice = Number(body.unitPrice);
        const inputs = body.inputs;
        if (!CATEGORIES.includes(body.category) || !Number.isFinite(unitPrice) || unitPrice <= 0 ||
            !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw fail('Invalid price check.', 400);
        const subtype = typeof body.subtype === 'string' && body.subtype.trim() ? body.subtype.trim().slice(0, 120) : null;
        const entry = { id: uuid(), category: body.category, subtype, unitPrice, inputs, createdAt: Number(body.createdAt) > 0 ? Number(body.createdAt) : Date.now() };
        return [list.concat([entry]), entry];
      }
      if (method === 'DELETE' && id) {
        if (!list.some(e => e.id === id)) throw fail('Price check not found.', 404);
        return [list.filter(e => e.id !== id), null];
      }
      throw fail('Method not allowed.', 405);
    });
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

  // Move whatever this browser holds into GitHub (skips ids already there).
  async function uploadLocalData() {
    const localPromos = read(PROMOS_KEY), localChecks = read(CHECKS_KEY);
    for (const p of localPromos) {
      if (!p.imageKey) continue;
      const blob = await idbRun('readonly', s => s.get(p.imageKey));
      if (blob) { try { await ensureBranch(); await ghPut('data/images/' + p.imageKey, new Uint8Array(await blob.arrayBuffer()), null, 'Add screenshot'); } catch (e) { /* already there */ } }
    }
    await ghMutate('data/promotions.json', l => { const add = localPromos.filter(p => !l.some(x => x.id === p.id)); return add.length ? [l.concat(add), 0] : [l, 0]; }, 'Import local promotions');
    await ghMutate('data/price-checks.json', l => { const add = localChecks.filter(p => !l.some(x => x.id === p.id)); return add.length ? [l.concat(add), 0] : [l, 0]; }, 'Import local price checks');
    return localPromos.length + localChecks.length;
  }
  function setToken(value, repoName) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY);
      if (repoName) localStorage.setItem(REPO_KEY, repoName);
    } catch (e) { throw new Error('Browser storage is unavailable.'); }
    branchReady = false;
  }

  window.localApi = { api, getImage, imageUrl, syncing, repo, setToken, uploadLocalData };
})();
