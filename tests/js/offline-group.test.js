'use strict';
/* Запуск: node tests/js/offline-group.test.js
   Набор из нескольких работ без связи: первая работа создаёт дверь, остальные ждут её номер и идут на ту же дверь. */
const assert = require('assert');
const { load } = require('./harness');
let n = 0; const results = [];
const t = (name, fn) => results.push([name, fn]);
const blob = (name) => Object.assign(new Blob(['x'], { type: 'image/jpeg' }), { name });
const mk = (wt, mode, group, num) => ({ key: 'k' + wt, files: [blob('a.jpg')], attempted: false,
  fields: { work_type_id: wt, work_type_name: 'W' + wt, unit: 'шт', quantity: '1', door_mode: mode, door_number: num || '', comment: '', group: group || '' } });
const ctx = u => ({ user: { id: u }, offline: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));

t('группа: лидер создаёт дверь, остальные идут на неё; очередь и номер группы очищаются', async () => {
  const env = load({ upload: (fd) => ({ door: { number: 'D-000007' } }) });
  env.Offline.setUser(1);
  await env.Offline.addDrafts(1, [mk(1, 'new', 'g1'), mk(2, 'follow', 'g1'), mk(3, 'follow', 'g1')]);
  const r = await env.Offline.sync(ctx(1));
  assert.strictEqual(r.sent, 3); assert.strictEqual(r.left, 0);
  assert.deepStrictEqual(env.calls.map(c => c.fd.get('work_type_id')), ['1', '2', '3']);
  assert.strictEqual(env.calls[0].fd.get('new_door'), 'true'); assert.strictEqual(env.calls[0].fd.get('door_number'), null);
  [1, 2].forEach(i => { assert.strictEqual(env.calls[i].fd.get('door_number'), 'D-000007'); assert.strictEqual(env.calls[i].fd.get('new_door'), null); });
  assert.strictEqual(new Set(env.calls.map(c => c.hdr['Idempotency-Key'])).size, 3, 'у каждой работы свой ключ');
});

t('лидер отклонён сервером: остальные ждут и не создают другие двери', async () => {
  let fail = true;
  const env = load({ upload: (fd, h, k) => { if (fail && fd.get('work_type_id') === '1') { const e = new Error('Нет расценки'); e.status = 422; e.code = 'RATE_NOT_FOUND'; throw e; } return { door: { number: 'D-000009' } }; } });
  env.Offline.setUser(1);
  await env.Offline.addDrafts(1, [mk(1, 'new', 'g2'), mk(2, 'follow', 'g2')]);
  await env.Offline.sync(ctx(1));
  assert.strictEqual(env.calls.length, 1, 'отправлена только первая работа');
  let ds = await env.Offline.listDrafts(1);
  assert.deepStrictEqual(ds.map(d => d.status), ['rejected', 'pending']);
  fail = false;
  await env.Offline.retry(ds[0]);
  const r = await env.Offline.sync(ctx(1));
  assert.strictEqual(r.left, 0);
  assert.strictEqual(env.calls[env.calls.length - 1].fd.get('door_number'), 'D-000009');
  assert.strictEqual(env.calls.filter(c => c.fd.get('new_door') === 'true').length, 2, 'новая дверь создавалась только лидером (его первая попытка отклонена)');
});

t('лидер удалён пользователем: остальные отклоняются с пояснением и ничего не отправляют', async () => {
  const env = load({ upload: () => ({ door: { number: 'D-000010' } }) });
  env.Offline.setUser(1);
  const [lead] = await env.Offline.addDrafts(1, [mk(1, 'new', 'g3'), mk(2, 'follow', 'g3')]);
  await env.Offline.deleteDraft(lead.id);
  await env.Offline.sync(ctx(1));
  assert.strictEqual(env.calls.length, 0);
  const ds = await env.Offline.listDrafts(1);
  assert.strictEqual(ds.length, 1); assert.strictEqual(ds[0].status, 'rejected'); assert(/дверь/.test(ds[0].error));
});

t('обрыв связи в середине группы: остаток остаётся в очереди и уходит позже на ту же дверь', async () => {
  let down = false;
  const env = load({ upload: (fd) => { if (down && fd.get('work_type_id') === '2') { const e = new Error('сеть'); e.code = 'NETWORK'; throw e; } return { door: { number: 'D-000011' } }; } });
  env.Offline.setUser(1);
  await env.Offline.addDrafts(1, [mk(1, 'new', 'g4'), mk(2, 'follow', 'g4'), mk(3, 'follow', 'g4')]);
  down = true;
  let r = await env.Offline.sync(ctx(1));
  assert.strictEqual(r.sent, 1); assert.strictEqual(r.left, 2);
  down = false;
  r = await env.Offline.sync(ctx(1));
  assert.strictEqual(r.left, 0);
  const last = env.calls.slice(-2);
  last.forEach(c => assert.strictEqual(c.fd.get('door_number'), 'D-000011'));
});

t('черновики разных пользователей не смешиваются', async () => {
  const env = load({ upload: () => ({ door: { number: 'D-000012' } }) });
  await env.Offline.addDrafts(1, [mk(1, 'new', 'g5')]); await env.Offline.addDrafts(2, [mk(1, 'new', 'g6')]);
  await env.Offline.setUser(1); await env.Offline.sync(ctx(1));
  assert.strictEqual((await env.Offline.listDrafts(2)).length, 1);
});

(async () => {
  for (const [name, fn] of results) { await fn(); n++; console.log('ok  ' + name); }
  console.log('\nПройдено проверок: ' + n);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
