// Тест без браузера: node tests/js/review-badge.test.js
// Упрощённые заглушки DOM; проверяют логику значка, а не отрисовку в реальном браузере.
'use strict';
const assert = require('assert');

let fetchCalls = [];
let fetchImpl = null;

function el(tag, text) {
  const node = {
    tag, _text: text || '', children: [], parentNode: null, hidden: false, style: {}, attrs: {},
    className: '', id: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = v; this.children = []; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) {
        n.children.forEach(c => {
          if (sel === '[data-door-review-badge]' && c.attrs['data-door-review-badge']) out.push(c);
          walk(c);
        });
      })(this);
      return out;
    },
    cloneNode() {
      const c = el(this.tag, this._text);
      c.attrs = Object.assign({}, this.attrs);
      this.children.forEach(ch => c.appendChild(ch.cloneNode()));
      return c;
    }
  };
  return node;
}

const body = el('body');
const menuLink = el('a', 'Приёмка работ');
const other = el('a', 'Выполненные работы');
body.appendChild(other); body.appendChild(menuLink);

const doc = {
  readyState: 'complete', visibilityState: 'visible', body, head: el('head'), documentElement: el('html'),
  getElementById() { return null; },
  createElement: (t) => el(t),
  querySelectorAll(sel) {
    const res = [];
    (function walk(n) { n.children.forEach(c => { if (c.tag === 'a' || c.tag === 'button') res.push(c); walk(c); }); })(body);
    return res;
  },
  addEventListener() {}
};

global.window = global;
global.document = doc;
Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
global.location = { href: 'https://door.example.ru/' };
global.getComputedStyle = () => ({ display: 'flex' });
global.MutationObserver = undefined;
global.XMLHttpRequest = undefined;
global.AbortController = undefined;
global.addEventListener = () => {};
global.fetch = function (url, opts) { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); };
global.setTimeout = (fn, ms) => ({ fn, ms, unref() {} });   // таймеры не запускаем сами
global.clearTimeout = () => {};

const jsonRes = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });

require(process.env.BADGE_JS || '../../public/js/review-badge.js');
const B = global.DoorReviewBadge;

// --- чистые функции ---
assert.strictEqual(B._formatCount(0), '');
assert.strictEqual(B._formatCount(null), '');
assert.strictEqual(B._formatCount(5), '5');
assert.strictEqual(B._formatCount(99), '99');
assert.strictEqual(B._formatCount(100), '99+');
assert.strictEqual(B._matchesLabel('  Приёмка   работ '), true);
assert.strictEqual(B._matchesLabel('Приемка работ 7'), true);
assert.strictEqual(B._matchesLabel('Выполненные работы'), false);

(async () => {
  // --- число приходит с сервера → значок показан у нужной ссылки ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 3 } });
  await B.refresh();
  const badge = menuLink.querySelector('[data-door-review-badge]');
  assert.ok(badge, 'значок создан внутри пункта «Приёмка работ»');
  assert.strictEqual(badge.textContent, '3');
  assert.strictEqual(badge.hidden, false);
  assert.strictEqual(other.querySelector('[data-door-review-badge]'), null, 'у других пунктов значка нет');
  assert.strictEqual(fetchCalls[0].url, '/api/v1/work-records/pending-count');
  assert.strictEqual(fetchCalls[0].opts.headers['X-Door-Poll'], '1');
  assert.strictEqual(fetchCalls[0].opts.credentials, 'same-origin');

  // --- обновление без перезагрузки ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 120 } });
  await B.refresh();
  assert.strictEqual(badge.textContent, '99+');

  // --- 0 → значок скрыт ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 0 } });
  await B.refresh();
  assert.strictEqual(badge.hidden, true);

  // --- ошибка сети → последнее известное число не теряется ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 4 } });
  await B.refresh();
  assert.strictEqual(badge.textContent, '4');
  fetchImpl = () => Promise.reject(new Error('network'));
  await B.refresh();
  assert.strictEqual(badge.textContent, '4');
  assert.strictEqual(badge.hidden, false);

  // --- 403 → опрос останавливается, значок скрыт ---
  fetchImpl = () => jsonRes(403, { success: false });
  await B.refresh();
  assert.strictEqual(badge.hidden, true);
  const callsBefore = fetchCalls.length;
  await B.refresh();      // kick сбрасывает только 401; после 403 запросов больше нет
  assert.strictEqual(fetchCalls.length, callsBefore, 'после 403 запросы не отправляются');

  console.log('OK: review-badge');
})().catch(e => { console.error(e); process.exit(1); });
