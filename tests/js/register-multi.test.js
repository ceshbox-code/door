'use strict';
/* Запуск: node tests/js/register-multi.test.js
   Регистрация нескольких видов работ за один раз (ремонт + упаковка и т.д.): очерёдность, дверь, ошибки, офлайн. */
const assert = require('assert');
const { load } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const types = [
  { id: 1, name: 'Ремонт двери', unit: 'шт', door_required: true, allow_multiple_per_door: false },
  { id: 2, name: 'Упаковка двери', unit: 'шт', door_required: true, allow_multiple_per_door: false },
  { id: 3, name: 'Монтаж наличника', unit: 'шт', door_required: false, allow_multiple_per_door: true },
];
const rec = (fd, door) => ({ door: door ? { number: door } : null, work_type: { name: 'W' + fd.get('work_type_id') }, quantity: fd.get('quantity'), unit: 'шт',
  total_amount: '100.00', completed_at: '2026-11-23T10:00:00Z', user: { full_name: 'Мастер' } });
const err = (status, code, message) => Object.assign(new Error(message || code), { status, code, full() { return this.message; } });

async function start(upload, opts) {
  const env = load({ upload });
  env.Api.get = async () => ({ items: types });
  env.run('views.js');
  env.Offline.setUser(1);
  if (opts && opts.offline) env.ctx.navigator.onLine = false;
  const root = new env.El('div');
  const ctx = { user: { id: 1 }, permissions: ['work.register'], offline: !!(opts && opts.offline) };
  await env.win.Views.register(ctx, root);
  const q = {
    root, env, ctx,
    btn: txt => root.find(e => e.tag === 'button' && e.text().includes(txt))[0],
    selects: () => root.find(e => e.tag === 'select'),
    cameras: () => root.find(e => e.tag === 'input' && e.attrs.type === 'file' && e.attrs.capture),
    // файл — Blob с именем: глобального File на старом node нет
    async photo(i, name) { const c = q.cameras()[i]; c.files = [Object.assign(new Blob([new Uint8Array(8)], { type: 'image/jpeg' }), { name: name || 'p' + i + '.jpg' })]; c.listeners.change.forEach(f => f()); },
    async submit() { q.btn(q.btn('Повторить') ? 'Повторить' : 'Зарегистрировать').click(); await sleep(40); },
    text: () => root.text(),
  };
  return q;
}
let n = 0; const T = [];
const t = (name, fn) => T.push([name, fn]);

t('ремонт + упаковка: первая работа создаёт дверь, вторая идёт на неё; у каждой свой ключ и фото', async () => {
  const q = await start((fd, h, k) => rec(fd, 'D-000001'));
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  const c = q.env.calls;
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].fd.get('new_door'), 'true'); assert.strictEqual(c[1].fd.get('new_door'), null); assert.strictEqual(c[1].fd.get('door_number'), 'D-000001');
  assert.deepStrictEqual(c.map(x => x.fd.get('work_type_id')), ['1', '2']);
  assert.notStrictEqual(c[0].hdr['Idempotency-Key'], c[1].hdr['Idempotency-Key']);
  assert.strictEqual(c[0].fd.getAll('photos[]').length, 1); assert.strictEqual(c[1].fd.getAll('photos[]').length, 1);
  assert(q.text().includes('Все работы зарегистрированы'));
});

t('виды в наборе не повторяются; кнопка «Добавить» скрывается, когда виды закончились', async () => {
  const q = await start(() => ({}));
  q.btn('Добавить вид работы').click(); q.btn('Добавить вид работы').click();
  const sels = q.selects();
  assert.strictEqual(new Set(sels.map(s => s.value)).size, 3, 'у трёх строк три разных вида');
  sels.forEach(s => { const others = sels.filter(x => x !== s).map(x => x.value); s.children.forEach(o => assert(!others.includes(o.value) , 'вид уже выбран в другой строке: ' + o.value)); });
  assert(q.btn('Добавить вид работы').classList.contains('hidden'));
});

t('без фото хотя бы в одной работе ничего не отправляется', async () => {
  const q = await start(() => rec(new FormData(), 'D-1'));
  q.btn('Добавить вид работы').click();
  await q.photo(0);
  await q.submit();
  assert.strictEqual(q.env.calls.length, 0);
  assert(q.text().includes('Добавьте хотя бы одну фотографию'));
});

t('ошибка по второй работе: первая не пересылается, повтор идёт только по второй на ту же дверь', async () => {
  let fail = true;
  const q = await start((fd) => { if (fail && fd.get('work_type_id') === '2') throw err(422, 'RATE_NOT_FOUND', 'Для исполнителя не назначена расценка'); return rec(fd, 'D-000002'); });
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  assert.strictEqual(q.env.calls.length, 2);
  assert(q.text().includes('Зарегистрировано работ: 1 из 2')); assert(q.text().includes('не назначена расценка'));
  fail = false;
  const key1 = q.env.calls[1].hdr['Idempotency-Key'];
  await q.submit();
  assert.strictEqual(q.env.calls.length, 3, 'повторно отправлена только вторая работа');
  assert.strictEqual(q.env.calls[2].fd.get('work_type_id'), '2'); assert.strictEqual(q.env.calls[2].fd.get('door_number'), 'D-000002'); assert.strictEqual(q.env.calls[2].fd.get('new_door'), null);
  assert.notStrictEqual(q.env.calls[2].hdr['Idempotency-Key'], key1, 'после ответа сервера с ошибкой запрос считается новым');
  assert(q.text().includes('Все работы зарегистрированы'));
});

t('ошибка по первой работе: вторая сама создаёт дверь, первая потом идёт на неё', async () => {
  let fail = true;
  const q = await start((fd) => { if (fail && fd.get('work_type_id') === '1') throw err(422, 'RATE_NOT_FOUND'); return rec(fd, 'D-000003'); });
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  assert.strictEqual(q.env.calls[1].fd.get('new_door'), 'true');
  fail = false; await q.submit();
  assert.strictEqual(q.env.calls[2].fd.get('door_number'), 'D-000003'); assert.strictEqual(q.env.calls[2].fd.get('new_door'), null);
});

t('работа без обязательной двери не создаёт дверь: идёт после работы, для которой дверь обязательна', async () => {
  const q = await start((fd) => rec(fd, 'D-000004'));
  q.selects()[0].value = '3'; q.selects()[0].listeners.change.forEach(f => f());     // первая строка — монтаж наличника (дверь не обязательна)
  q.btn('Добавить вид работы').click();                                              // вторая получит «Ремонт двери»
  await q.photo(0); await q.photo(1);
  await q.submit();
  assert.deepStrictEqual(q.env.calls.map(c => c.fd.get('work_type_id')), ['1', '3']);
  assert.strictEqual(q.env.calls[0].fd.get('new_door'), 'true'); assert.strictEqual(q.env.calls[1].fd.get('door_number'), 'D-000004');
});

t('обрыв связи на первой работе: оба набора — черновики, первый создаёт дверь с тем же ключом, второй ждёт', async () => {
  const q = await start((fd) => { throw err(0, 'NETWORK'); });
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  const ds = await q.env.Offline.listDrafts(1);
  assert.strictEqual(ds.length, 2);
  assert.deepStrictEqual(ds.map(d => d.fields.door_mode), ['new', 'follow']);
  assert.strictEqual(ds[0].fields.group, ds[1].fields.group);
  assert.strictEqual(ds[0].key, q.env.calls[0].hdr['Idempotency-Key'], 'тот же ключ — повтор не создаст дубль');
  assert.notStrictEqual(ds[0].attemptedAt, null);
  assert(q.text().includes('Сохранено на телефоне'));
});

t('обрыв связи на второй работе: первая уже на сервере, вторая — черновик на эту же дверь', async () => {
  const q = await start((fd) => { if (fd.get('work_type_id') === '2') throw err(0, 'NETWORK'); return rec(fd, 'D-000005'); });
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  const ds = await q.env.Offline.listDrafts(1);
  assert.strictEqual(ds.length, 1); assert.strictEqual(ds[0].fields.door_mode, 'existing'); assert.strictEqual(ds[0].fields.door_number, 'D-000005');
  assert(q.text().includes('Уже зарегистрировано на сервере'));
});

t('сразу без связи: все работы становятся черновиками одной группы, на сервер ничего не уходит', async () => {
  const q = await start(() => { throw new Error('не должно вызываться'); }, { offline: true });
  q.btn('Добавить вид работы').click();
  await q.photo(0); await q.photo(1);
  await q.submit();
  assert.strictEqual(q.env.calls.length, 0);
  const ds = await q.env.Offline.listDrafts(1);
  assert.deepStrictEqual(ds.map(d => d.fields.door_mode), ['new', 'follow']);
});

t('существующая дверь: номер обязателен и уходит во все работы набора', async () => {
  const q = await start((fd) => rec(fd, 'D-000099'));
  q.btn('Добавить вид работы').click();
  q.root.find(e => e.tag === 'input' && e.attrs.type === 'radio' && e.value === 'existing')[0].listeners.change.forEach(f => f());
  await q.photo(0); await q.photo(1);
  await q.submit();
  assert.strictEqual(q.env.calls.length, 0); assert(q.text().includes('Укажите номер двери'));
  q.root.find(e => e.tag === 'input' && e.attrs.id === 'dn')[0].value = 'D-000099';
  await q.submit();
  q.env.calls.forEach(c => { assert.strictEqual(c.fd.get('door_number'), 'D-000099'); assert.strictEqual(c.fd.get('new_door'), null); });
});

(async () => {
  for (const [name, fn] of T) { await fn(); n++; console.log('ok  ' + name); }
  console.log('\nПройдено проверок: ' + n);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
