'use strict';
/* Общая заглушка окружения для тестов без браузера: упрощённые IndexedDB и DOM + настоящие offline.js и views.js.
   UI (ui.js в тест не входит) заменён минимальной реализацией; тесты проверяют логику, а не вёрстку. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const pub = path.join(__dirname, '../../public/js');

// ---------- минимальная IndexedDB
function fakeIndexedDB() {
  const dbs = {};
  const defer = fn => setTimeout(fn, 0);
  function Request() { this.onsuccess = null; this.onerror = null; }
  function makeStore(spec, data) {
    return {
      _data: data, _spec: spec,
      createIndex() { return this; },
      _op(tx, fn) {
        const r = new Request(); tx._pending++;
        defer(() => { try { r.result = fn(); } catch (e) { r.error = e; } tx._pending--;
          if (r.onsuccess && !r.error) r.onsuccess({ target: r }); if (r.onerror && r.error) r.onerror(); tx._maybeDone(); });
        return r;
      },
    };
  }
  return {
    open(name) {
      const r = new Request();
      defer(() => {
        const fresh = !dbs[name];
        if (fresh) dbs[name] = { stores: {} };
        const D = dbs[name];
        const api = {
          createObjectStore(sn, spec) { D.stores[sn] = { spec: spec || {}, rows: new Map(), seq: 0 }; return { createIndex() {} }; },
          transaction(sn) {
            const S = D.stores[sn];
            const tx = { _pending: 0, oncomplete: null, onerror: null, onabort: null, _timer: null,
              _maybeDone() { if (this._pending === 0) { clearTimeout(this._timer); this._timer = setTimeout(() => this.oncomplete && this.oncomplete(), 0); } },
              objectStore() {
                const keyPath = S.spec.keyPath;
                const o = makeStore(S.spec, S.rows);
                return {
                  get: k => o._op(tx, () => S.rows.get(k)),
                  getAll: () => o._op(tx, () => [...S.rows.values()]),
                  put: (v, k) => o._op(tx, () => { const key = keyPath ? v[keyPath] : k; S.rows.set(key, v); return key; }),
                  add: v => o._op(tx, () => { if (keyPath && S.spec.autoIncrement && v[keyPath] == null) v[keyPath] = ++S.seq; S.rows.set(v[keyPath], v); return v[keyPath]; }),
                  delete: k => o._op(tx, () => { S.rows.delete(k); }),
                  index: () => ({ getAll: uid => o._op(tx, () => [...S.rows.values()].filter(x => x.userId === uid)) }),
                };
              } };
            return tx;
          },
        };
        r.result = api;
        if (fresh && r.onupgradeneeded) r.onupgradeneeded();
        // у meta и drafts одна «база», но transaction(name) выбирает хранилище по имени
        r.onsuccess && r.onsuccess({ target: r });
      });
      return r;
    },
  };
}

// ---------- минимальный DOM
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; this.value = ''; this.textContent = ''; this.disabled = false;
    const set = new Set(); this.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); } };
    this.style = {}; this.firstChild = null; }
  _add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(x => this._add(x));
    if (typeof c === 'string' || typeof c === 'number') c = Object.assign(new El('#text'), { textContent: String(c) });
    c.parent = this; this.children.push(c); this.firstChild = this.children[0]; }
  appendChild(c) { this._add(c); return c; } append(...cs) { cs.forEach(c => this._add(c)); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { (this.listeners.click || []).forEach(f => f()); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  scrollIntoView() {}
  get isConnected() { return true; }
  text() { return this.textContent + this.children.map(c => c.text()).join(' '); }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}
function makeUI() {
  const h = (tag, attrs, ...kids) => {
    const e = new El(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (/^on[a-z]+$/.test(k)) e.addEventListener(k.slice(2), v);
      else if (k === 'class') String(v).split(' ').forEach(c => c && e.classList.add(c));
      else if (k === 'value') e.value = String(v);
      else e.attrs[k] = v;
    }
    kids.forEach(k => e._add(k)); return e;
  };
  return {
    h, clear: el => { el.children = []; el.firstChild = null; el.textContent = ''; return el; },
    money: v => String(v), qty: v => String(v), dt: v => String(v), day: v => String(v),
    errBox: e => h('div', { class: 'alert err' }, e.full ? e.full() : e.message), alert: (k, t) => h('div', { class: 'alert ' + k }, t),
    modal() {}, pager() {}, periodPicker() {}, uuid: (() => { let n = 0; return () => 'key-' + (++n); })(),
  };
}

function load({ upload } = {}) {
  const win = {};
  const UI = makeUI();
  class ApiError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } full() { return this.message; } }
  const calls = [];
  const Api = { ApiError, state: {}, get: async () => ({ items: [] }), post: async () => ({}), upload: async (p, fd, hdr) => { calls.push({ p, fd, hdr }); return upload(fd, hdr, calls.length); } };
  const ctx = vm.createContext({ window: win, navigator: { onLine: true, storage: { persist() {} } }, indexedDB: fakeIndexedDB(), UI, Api, FormData, Blob,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortController, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, console, Date, Promise });
  win.indexedDB = ctx.indexedDB; win.addEventListener = () => {}; win.scrollTo = () => {}; win.dispatchEvent = () => {}; win.Event = function () {};
  Object.assign(win, { UI, Api, navigator: ctx.navigator, document: { createElement: () => new El('x') } });
  ctx.window = win; ctx.document = win.document;
  const run = f => vm.runInContext(fs.readFileSync(path.join(pub, f), 'utf8'), ctx, { filename: f });
  win.Net = undefined;
  run('offline.js'); ctx.Offline = win.Offline; ctx.Net = win.Net;
  return { win, ctx, UI, Api, calls, run, El, Offline: win.Offline };
}
module.exports = { load, El, makeUI };
