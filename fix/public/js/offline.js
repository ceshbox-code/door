'use strict';
/* Работа без интернета (ТЗ 10.3).
   • Оболочка приложения кэшируется service worker'ом (sw.js) — приложение открывается без связи.
   • Регистрация работы без связи сохраняется ЧЕРНОВИКОМ на телефоне (IndexedDB). Черновик — не работа и не создаёт
     начисление: работа считается выполненной только после успешного сохранения на сервере.
   • При появлении связи черновики отправляются по очереди с тем же Idempotency-Key — повтор не создаёт дубль.
   • Время выполнения и расценку определяет сервер в момент отправки (правило ТЗ: completed_at задаёт только сервер).
   • Набор из нескольких видов работ на одной двери хранится группой черновиков (fields.group). Если дверь новая, номер ей
     присваивает сервер при отправке ПЕРВОГО черновика группы (door_mode 'new'); остальные (door_mode 'follow') ждут его и
     отправляются на эту же дверь. Так офлайн-набор не создаёт несколько дверей.
   • Данные других разделов (деньги, списки работ) на телефоне НЕ сохраняются: без связи они недоступны. */
(function (w) {
  const { h, clear, dt, errBox, alert, modal } = UI;
  const DB_NAME = 'door-offline', DB_VERSION = 1;
  const IDENTITY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;       // сколько дней доверяем сохранённому профилю для запуска без связи
  const KEY_SAFE_MS = 20 * 3600 * 1000;                     // сервер хранит ключ идемпотентности 24 ч; после 20 ч автоповтор неопределённой отправки не делаем
  const PROBE_MS = 15000;

  // ------------------------------------------------------------------ IndexedDB
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      if (!w.indexedDB) return reject(new Error('IndexedDB недоступна'));
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta');
        d.createObjectStore('drafts', { keyPath: 'id', autoIncrement: true }).createIndex('user', 'userId');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => { dbp = null; reject(r.error); };
    });
    return dbp;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function store(name, mode) { return (await db()).transaction(name, mode).objectStore(name); }
  const metaGet = async k => req((await store('meta', 'readonly')).get(k));
  const metaSet = async (k, v) => req((await store('meta', 'readwrite')).put(v, k));
  const metaDel = async k => req((await store('meta', 'readwrite')).delete(k));

  // ------------------------------------------------------------------ состояние сети
  const Net = {
    online: navigator.onLine !== false, listeners: [], timer: null,
    on(fn) { this.listeners.push(fn); },
    set(v) {
      if (this.online === v) return;
      this.online = v;
      this.listeners.forEach(fn => { try { fn(v); } catch (e) { /* подписчик не должен ломать остальных */ } });
      if (v) this.stopProbe(); else this.startProbe();
    },
    markOffline() { this.set(false); },
    markOnline() { this.set(true); },
    startProbe() { if (!this.timer) this.timer = setInterval(() => this.probe(), PROBE_MS); },
    stopProbe() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
    /** Лёгкая проверка связи с сервером (публичный /health). Любой HTTP-ответ означает, что сервер достижим. */
    async probe() {
      const c = new AbortController(), t = setTimeout(() => c.abort(), 6000);
      try { const r = await fetch('/api/v1/health', { cache: 'no-store', signal: c.signal }); if (r.status < 500) this.markOnline(); }
      catch (e) { /* связи нет */ } finally { clearTimeout(t); }
    },
  };
  w.addEventListener('online', () => Net.probe());
  w.addEventListener('offline', () => Net.markOffline());
  if (!Net.online) Net.startProbe();

  // ------------------------------------------------------------------ профиль и справочник для запуска без связи
  // Сохраняются только профиль и права (без CSRF-токена и без денег). Нужны, чтобы показать меню и форму регистрации.
  const saveIdentity = s => metaSet('identity', { user: s.user, permissions: s.permissions, savedAt: Date.now() }).catch(() => {});
  async function loadIdentity() {
    try { const i = await metaGet('identity'); return i && Date.now() - i.savedAt < IDENTITY_MAX_AGE_MS ? i : null; } catch (e) { return null; }
  }
  const clearIdentity = () => metaDel('identity').catch(() => {});
  let currentUserId = null;
  const setUser = id => { currentUserId = id; };
  const cacheWorkTypes = items => currentUserId && metaSet('workTypes:' + currentUserId, { items, savedAt: Date.now() }).catch(() => {});
  async function cachedWorkTypes() {
    try { const c = currentUserId && await metaGet('workTypes:' + currentUserId); return c ? c.items : null; } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ черновики
  /** Сохраняет один или несколько черновиков ОДНОЙ транзакцией: набор сохраняется целиком или не сохраняется вовсе. */
  async function addDrafts(userId, items) {
    const d = await db(), now = Date.now();
    const tx = d.transaction('drafts', 'readwrite'), st = tx.objectStore('drafts');
    const out = items.map((it, i) => {
      const rec = {
        userId, key: it.key, createdAt: now + i, status: 'pending', error: null, attemptedAt: it.attempted ? now : null,
        fields: it.fields, photos: it.files.map(f => ({ blob: f, name: f.name, type: f.type })),
      };
      st.add(rec).onsuccess = e => { rec.id = e.target.result; };
      return rec;
    });
    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error || new Error('Не удалось сохранить')); });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* необязательно */ }
    notify();
    return out;
  }
  const addDraft = async (userId, fields, files, key, attempted) => (await addDrafts(userId, [{ fields, files, key, attempted }]))[0];
  async function listDrafts(userId) {
    const all = await req((await store('drafts', 'readonly')).index('user').getAll(userId));
    return all.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }
  async function putDraft(d) { await req((await store('drafts', 'readwrite')).put(d)); notify(); }
  async function deleteDraft(id) {
    const d = await req((await store('drafts', 'readonly')).get(id));
    await req((await store('drafts', 'readwrite')).delete(id));
    // номер двери группы больше не нужен, когда в группе не осталось черновиков
    const g = d && d.fields && d.fields.group;
    if (g) {
      const rest = await req((await store('drafts', 'readonly')).getAll());
      if (!rest.some(x => x.fields && x.fields.group === g)) await metaDel('group:' + g).catch(() => {});
    }
    notify();
  }
  const countDrafts = async userId => { try { return (await listDrafts(userId)).length; } catch (e) { return 0; } };

  const subs = [];
  const onChange = fn => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; };
  function notify() { subs.forEach(fn => { try { fn(); } catch (e) { /* см. выше */ } }); }

  /** Вид работы черновика. Черновики, созданные старыми версиями приложения, могли хранить его под другим именем
      или без числового id (тогда сервер отвечал «Выберите вид работы»). Берём id из известных полей,
      а если его нет — ищем вид по названию в сохранённом на телефоне справочнике. */
  const posInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  async function resolveTypeId(d) {
    const f = d.fields || {};
    for (const k of ['work_type_id', 'workTypeId', 'type_id', 'typeId', 'work_type']) {
      const v = f[k] && typeof f[k] === 'object' ? f[k].id : f[k];
      if (posInt(v)) return posInt(v);
    }
    const name = (f.work_type_name || '').trim().toLowerCase();
    if (!name) return null;
    const list = (await cachedWorkTypes()) || [];
    const hit = list.filter(t => String(t.name).trim().toLowerCase() === name);
    return hit.length === 1 ? posInt(hit[0].id) : null;
  }

  function buildForm(d, doorNumber, typeId) {
    const f = d.fields, fd = new FormData();
    fd.append('work_type_id', String(typeId));
    if (f.door_mode === 'new') fd.append('new_door', 'true');
    if (f.door_mode === 'existing' && f.door_number) fd.append('door_number', f.door_number);
    if (f.door_mode === 'follow' && doorNumber) fd.append('door_number', doorNumber);
    fd.append('quantity', f.quantity || '1');
    const note = '[Оформлено без связи на устройстве: ' + dt(new Date(d.createdAt).toISOString()) + ']';
    fd.append('comment', (f.comment ? f.comment + '\n' : '') + note);
    d.photos.forEach(p => fd.append('photos[]', p.blob, p.name));
    return fd;
  }

  // ------------------------------------------------------------------ отправка очереди
  let syncing = false;
  /** Отправляет черновики по очереди. Возвращает {sent, left}. Не вызывать без связи и без проверенной сессии. */
  async function sync(ctx, opts) {
    opts = opts || {};
    if (syncing || !ctx.user || ctx.offline || !Net.online) return { sent: 0, left: await countDrafts(ctx.user && ctx.user.id) };
    syncing = true; let sent = 0;
    try {
      const drafts = await listDrafts(ctx.user.id);
      for (const d of drafts) {
        if (d.status === 'sending') d.status = 'pending';                            // приложение закрыли во время отправки
        if (d.status === 'rejected' || d.status === 'needs_check') continue;            // ждут решения пользователя
        // Если предыдущая попытка могла дойти до сервера, а ключ скоро истечёт — слепо повторять нельзя: возможен дубль.
        if (d.attemptedAt && Date.now() - d.attemptedAt > KEY_SAFE_MS) {
          d.status = 'needs_check'; d.error = 'Прошло больше 20 часов после неудачной отправки. Проверьте в разделе «Выполненные работы», не зарегистрирована ли эта работа, и решите: отправить или удалить.';
          await putDraft(d); continue;
        }
        // Работа набора на новой двери ждёт, пока первая работа набора получит номер двери на сервере.
        let doorNumber = null;
        if (d.fields.door_mode === 'follow') {
          doorNumber = await metaGet('group:' + d.fields.group).catch(() => null);
          if (!doorNumber) {
            if (drafts.some(x => x.id !== d.id && x.fields.group === d.fields.group && x.fields.door_mode === 'new')) continue;   // первая работа ещё в очереди
            d.status = 'rejected'; d.error = 'Первая работа этого набора, создающая дверь, удалена или не отправлена. Номер двери неизвестен: удалите эту работу и зарегистрируйте её заново с номером двери.';
            await putDraft(d); continue;
          }
        }
        const typeId = await resolveTypeId(d);
        if (!typeId) {            // без вида работы запрос заведомо будет отклонён: на сервер не отправляем
          d.status = 'rejected'; d.error = 'В этой работе не сохранён вид работы (черновик создан старой версией приложения). Удалите её и зарегистрируйте заново.';
          await putDraft(d); continue;
        }
        if (d.fields.work_type_id !== typeId) d.fields.work_type_id = typeId;
        d.status = 'sending'; d.attemptedAt = d.attemptedAt || Date.now(); await putDraft(d);
        try {
          const rec = await Api.upload('/work-records', buildForm(d, doorNumber, typeId), { 'Idempotency-Key': d.key });
          if (d.fields.door_mode === 'new' && d.fields.group && rec && rec.door && rec.door.number) await metaSet('group:' + d.fields.group, rec.door.number);
          await deleteDraft(d.id); sent++;
        } catch (e) {
          if (e.code === 'NETWORK') { d.status = 'pending'; d.error = null; await putDraft(d); break; }       // связь пропала — остальное позже
          if (e.status === 401) { d.status = 'pending'; await putDraft(d); break; }                           // сессия истекла — после входа продолжим
          if (e.status >= 500 || e.status === 429 || e.status === 409) { d.status = 'pending'; d.error = e.full ? e.full() : e.message; await putDraft(d); break; }
          d.status = 'rejected'; d.error = e.full ? e.full() : e.message; await putDraft(d);                  // сервер отклонил: сам не повторяем
        }
      }
    } finally { syncing = false; notify(); }
    return { sent, left: await countDrafts(ctx.user.id) };
  }

  /** Принудительный повтор отклонённого черновика (после исправления причины, например назначения расценки). */
  async function retry(d, newKey) {
    d.status = 'pending'; d.error = null;
    if (newKey) { d.key = newKey; d.attemptedAt = null; }          // старый ключ истёк — пользователь осознанно подтвердил отправку
    await putDraft(d);
  }

  // ------------------------------------------------------------------ интерфейс очереди
  const STATUS = { pending: 'ожидает отправки', sending: 'отправляется…', rejected: 'отклонена сервером', needs_check: 'нужна проверка' };
  const doorText = f => f.door_mode === 'new' ? 'новая дверь' : f.door_mode === 'follow' ? 'та же новая дверь, что у первой работы набора' : f.door_mode === 'existing' ? 'дверь ' + f.door_number : 'без двери';
  const mb = bytes => (bytes / 1048576).toFixed(1).replace('.', ',') + ' МБ';

  /** Список неотправленных работ. Возвращает null, если черновиков нет. */
  async function panel(ctx) {
    let drafts;
    try { drafts = await listDrafts(ctx.user.id); } catch (e) { return null; }
    if (!drafts.length) return null;
    const box = h('div', { class: 'card', id: 'drafts-panel' });
    const size = drafts.reduce((s, d) => s + d.photos.reduce((a, p) => a + (p.blob.size || 0), 0), 0);
    box.appendChild(h('h2', { style: 'margin-top:0' }, 'Не отправлено на сервер: ' + drafts.length));
    box.appendChild(h('p', { class: 'muted' }, 'Эти работы сохранены только на телефоне и ещё НЕ учтены в начислениях. ' +
      (ctx.offline ? 'Они отправятся автоматически, когда появится интернет и приложение будет открыто.' : 'Нажмите «Отправить сейчас», если отправка не началась сама.') + ' Занято: ' + mb(size) + '.'));
    drafts.forEach(d => {
      const f = d.fields, st = h('span', { class: 'tag ' + (d.status === 'rejected' || d.status === 'needs_check' ? 'void' : '') }, STATUS[d.status] || d.status);
      const row = h('div', { class: 'draft', 'data-status': d.status },
        h('div', {}, h('strong', {}, f.work_type_name), ' · ', doorText(f), ' · ', f.quantity + ' ' + (f.unit || ''), ' · фото: ' + d.photos.length),
        h('div', { class: 'muted' }, dt(new Date(d.createdAt).toISOString()), ' ', st),
        d.error ? h('div', { class: 'alert err' }, d.error) : null);
      const act = h('div', { class: 'row', style: 'margin-top:.4rem' });
      if (d.status === 'needs_check') act.appendChild(h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await retry(d, UI.uuid()); w.dispatchEvent(new Event('door-drafts-retry')); } }, 'Отправить всё равно'));
      act.appendChild(h('button', { class: 'btn secondary', type: 'button', onclick: () => confirmDelete(d) }, 'Удалить'));
      row.appendChild(act); box.appendChild(row);
    });
    if (!ctx.offline) box.appendChild(h('button', { class: 'btn', type: 'button', id: 'drafts-send', style: 'margin-top:.6rem', onclick: async () => { for (const x of await listDrafts(ctx.user.id)) if (x.status === 'rejected') await retry(x); w.dispatchEvent(new Event('door-drafts-retry')); } }, 'Отправить сейчас'));
    return box;
  }
  function confirmDelete(d) {
    modal(close => [h('h1', {}, 'Удалить неотправленную работу?'), h('p', {}, 'Она не была зарегистрирована на сервере и пропадёт безвозвратно вместе с фотографиями.'),
      h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'button', onclick: async () => { await deleteDraft(d.id); close(); } }, 'Удалить'),
        h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))]);
  }

  w.Net = Net;
  w.Offline = { Net, saveIdentity, loadIdentity, clearIdentity, setUser, cacheWorkTypes, cachedWorkTypes, addDraft, addDrafts, listDrafts, countDrafts, deleteDraft, sync, retry, panel, onChange };
})(window);
