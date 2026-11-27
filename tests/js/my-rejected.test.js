// Тест без браузера: node tests/js/my-rejected.test.js
// Упрощённый DOM и подменённый fetch: проверяется логика интерфейса мастера, а не отрисовка в реальном браузере.
'use strict';
const assert = require('assert');

class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this.style = {}; this.className = ''; this._text = null; this._value = undefined; this.hidden = false; }
  get textContent() { return this._text !== null ? this._text : this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = v === '' ? null : String(v); }
  get value() { return this._value !== undefined ? this._value : (this.attrs.value || ''); }
  set value(v) { this._value = String(v); }
  appendChild(c) { if (this._text !== null) { this._text = null; } c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  fire(t, extra) { (this.listeners[t] || []).forEach(fn => fn(Object.assign({ target: this, currentTarget: this, key: '' }, extra))); }
  all(pred, out) { out = out || []; this.children.forEach(c => { if (c.tag) { if (pred(c)) out.push(c); c.all(pred, out); } }); return out; }
}
const text = (t) => ({ tag: null, textContent: String(t), parentNode: null });

const body = new El('body'), head = new El('head'), htmlEl = new El('html');
const doc = {
  readyState: 'complete', visibilityState: 'visible', body, head, documentElement: htmlEl,
  createElement: (t) => new El(t), createTextNode: text,
  getElementById: (id) => [head, body].map(r => r.all(e => e.id === id)[0]).find(Boolean) || null,
  addEventListener() {}, removeEventListener() {}
};
const btns = (pred) => body.all(e => e.tag === 'button' && pred(e));
const byText = (re) => btns(e => re.test(e.textContent))[0];

global.window = global;
global.document = doc;
Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
global.addEventListener = () => {};
global.setTimeout = (fn, ms) => ({ fn, ms });
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
global.FormData = class { constructor() { this.items = []; } append(k, v, n) { this.items.push([k, v, n]); } };

// ---- сервер-заглушка ----
const calls = [];
const rejectedItems = [
  { id: 11, work_type: { name: 'Ремонт двери' }, door: { number: 'D-000005' }, quantity: '1.000', unit: 'шт', comment: 'было',
    completed_at: '2026-11-20T08:00:00Z', review: { status: 'rejected', can_fix: true, reject_reason: 'Фото размыто <b>!</b>', reviewed_at: '2026-11-21T09:00:00Z', reviewed_by: { full_name: 'Директор' }, resubmit_count: 0 } },
  { id: 12, work_type: { name: 'Упаковка двери' }, door: { number: 'D-000006' }, quantity: '1.000', unit: 'шт', comment: null,
    completed_at: '2026-11-20T09:00:00Z', review: { status: 'rejected', can_fix: false, reject_reason: 'Дубликат', reviewed_at: '2026-11-21T09:10:00Z', reviewed_by: { full_name: 'Директор' }, resubmit_count: 0 } }
];
const pendingItems = [
  { id: 21, work_type: { name: 'Монтаж' }, door: null, quantity: '2.500', unit: 'час', comment: null,
    completed_at: '2026-11-22T10:00:00Z', review: { status: 'pending', can_fix: null, reject_reason: null, reviewed_at: null, reviewed_by: null, resubmit_count: 0 } }
];
const ok = (data) => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ success: true, data }) });
const fail = (status, code, message) => Promise.resolve({ status, ok: false, json: () => Promise.resolve({ success: false, error: { code, message } }) });
let postHandler = () => ok({});
global.fetch = (url, init) => {
  calls.push({ url, init });
  if (url === '/api/v1/auth/me') return ok({ user: { id: 7, role: 'master' }, permissions: ['work.register', 'work.view_own'], csrf_token: 'tok123' });
  if (init.method === 'POST') return postHandler(url, init);
  const counts = { pending: 1, accepted: 5, rejected: 2 };
  if (/review_status=rejected/.test(url)) return ok({ items: rejectedItems, review_counts: counts });
  if (/review_status=pending/.test(url)) return ok({ items: pendingItems, review_counts: counts });
  return ok({});
};
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

require(process.env.REJECTED_JS || '../../public/js/my-rejected.js');

(async () => {
  await tick();
  // --- кнопка и фоновый опрос ---
  const btn = body.all(e => e.attrs['data-door-rejected-btn'])[0];
  assert.ok(btn, 'кнопка показана');
  assert.strictEqual(btn.textContent, 'Не принято работ: 2');
  assert.strictEqual(calls[0].url, '/api/v1/auth/me');
  assert.strictEqual(calls[0].init.headers['X-Door-Poll'], '1');
  assert.ok(/review_status=rejected&user_id=7/.test(calls[1].url), 'список только своих: ' + calls[1].url);

  // --- панель: причины и возможность исправления ---
  btn.fire('click');
  await tick();
  const panelText = body.textContent;
  assert.ok(panelText.includes('Фото размыто <b>!</b>'), 'причина показана как текст, не как HTML');
  assert.ok(panelText.includes('Ремонт двери — Дверь D-000005'));
  assert.ok(panelText.includes('Директор не разрешил исправление'), 'для can_fix=false исправления нет');
  assert.strictEqual(btns(e => e.textContent === 'Исправить и отправить').length, 1, 'кнопка исправления только у разрешённой');
  assert.strictEqual(body.all(e => e.tag === 'b').length, 0, 'HTML из причины не интерпретируется');

  // --- исправление без изменений блокируется на клиенте ---
  byText(/^Исправить и отправить$/).fire('click');
  byText(/^Отправить на приёмку$/).fire('click');
  assert.ok(body.textContent.includes('Добавьте новое фото, измените количество или комментарий'));
  const postsBefore = calls.filter(c => c.init.method === 'POST').length;
  assert.strictEqual(postsBefore, 0, 'запрос не отправлен');

  // --- исправление с новым комментарием -> /resubmit с CSRF ---
  const textarea = body.all(e => e.tag === 'textarea')[0];
  textarea.value = 'Переснял, теперь резко';
  byText(/^Отправить на приёмку$/).fire('click');
  await tick();
  const post = calls.find(c => c.init.method === 'POST');
  assert.strictEqual(post.url, '/api/v1/work-records/11/resubmit');
  assert.strictEqual(post.init.headers['X-CSRF-Token'], 'tok123');
  assert.ok(post.init.body.items.some(i => i[0] === 'comment' && i[1] === 'Переснял, теперь резко'));
  assert.ok(!post.init.body.items.some(i => i[0] === 'quantity'), 'количество не менялось — не отправляется');
  assert.ok(body.textContent.includes('Отправлено директору на повторную приёмку'));

  // --- вкладка «Ждут приёмки»: изменение до приёмки -> /edit ---
  byText(/^Ждут приёмки/).fire('click');
  await tick();
  assert.ok(body.textContent.includes('Монтаж — Без двери'));
  byText(/^Изменить$/).fire('click');
  body.all(e => e.tag === 'input' && e.attrs.type === 'number')[0].value = '3';
  const photo = { name: 'a.jpg', size: 10, type: 'image/jpeg' };
  const fileInput = body.all(e => e.tag === 'input' && e.attrs.type === 'file')[0];
  fileInput.files = [photo];
  postHandler = () => ok({ id: 21 });
  byText(/^Сохранить изменения$/).fire('click');
  await tick();
  const edit = calls.filter(c => c.init.method === 'POST').pop();
  assert.strictEqual(edit.url, '/api/v1/work-records/21/edit');
  assert.ok(edit.init.body.items.some(i => i[0] === 'quantity' && i[1] === '3'));
  assert.ok(edit.init.body.items.some(i => i[0] === 'photos[]' && i[2] === 'a.jpg'));
  assert.ok(body.textContent.includes('Изменения сохранены'));

  // --- ошибка сервера показывается, кнопка снова доступна ---
  byText(/^Ждут приёмки/).fire('click');
  await tick();
  byText(/^Изменить$/).fire('click');
  body.all(e => e.tag === 'textarea')[0].value = 'другое';
  postHandler = () => fail(409, 'NOT_EDITABLE', 'Работа уже принята директором, изменить её нельзя.');
  const sendBtn = byText(/^Сохранить изменения$/);
  sendBtn.fire('click');
  await tick();
  assert.ok(body.textContent.includes('Работа уже принята директором, изменить её нельзя.'));
  assert.ok(!sendBtn.attrs.disabled, 'после ошибки кнопка снова активна');

  console.log('OK: my-rejected');
})().catch(e => { console.error(e); process.exit(1); });
