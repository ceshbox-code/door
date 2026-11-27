'use strict';
/* Экраны приложения. Права на сервере проверяются при каждом запросе; здесь они лишь определяют, что показывать. */
(function (w) {
  const { h, clear, money, qty, dt, day, errBox, alert, modal, pager, uuid, periodPicker } = UI;
  const can = (ctx, p) => ctx.permissions.includes(p);

  // ------------------------------------------------------------------ общие блоки

  function stat(label, value, cls) { return h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)); }

  function photoGallery(recordId) {
    const box = h('div', { class: 'gallery muted' }, 'Загрузка фотографий…');
    Api.get('/work-records/' + recordId + '/photos').then(list => {
      clear(box).classList.remove('muted');
      if (!list.length) { box.textContent = 'Фотографий нет'; box.classList.add('muted'); return; }
      const shots = list.map(p => ({ src: p.url, fallback: p.original_url, alt: 'Фото к работе' }));
      shots.forEach((shot, idx) => box.appendChild(h('button', { type: 'button', class: 'photo-open', 'aria-label': 'Открыть фото ' + (idx + 1) + ' из ' + shots.length, onclick: () => UI.photoViewer(shots, idx) },
        h('img', { src: shot.src, alt: shot.alt, loading: 'lazy' }))));
    }).catch(e => { clear(box).appendChild(errBox(e)); });
    return box;
  }

  /** Карточка выполненной работы (+ фотографии, аннулирование для администратора). */
  function workModal(ctx, rec, onChanged) {
    modal(close => {
      const kv = h('dl', { class: 'kv' },
        h('dt', {}, 'Вид работы'), h('dd', {}, rec.work_type.name),
        h('dt', {}, 'Дверь'), h('dd', {}, rec.door ? h('a', { href: '#/doors/' + rec.door.number, onclick: close }, rec.door.number) : '—'),
        h('dt', {}, 'Исполнитель'), h('dd', {}, rec.user.full_name),
        h('dt', {}, 'Количество'), h('dd', {}, qty(rec.quantity) + ' ' + rec.unit),
        h('dt', {}, 'Расценка'), h('dd', { class: 'money' }, money(rec.unit_price)),
        h('dt', {}, 'Начислено'), h('dd', { class: 'money' }, money(rec.total_amount)),
        h('dt', {}, 'Выполнено'), h('dd', {}, dt(rec.completed_at)),
        h('dt', {}, 'Зарегистрировано'), h('dd', {}, dt(rec.created_at) + ' · ' + rec.created_by.full_name),
        rec.comment ? [h('dt', {}, 'Комментарий'), h('dd', {}, rec.comment)] : null,
        h('dt', {}, 'Приёмка'), h('dd', {}, reviewTag(rec)),
        rec.review && rec.review.reviewed_by ? [h('dt', {}, 'Решение'), h('dd', {}, dt(rec.review.reviewed_at) + ' · ' + rec.review.reviewed_by.full_name)] : null,
        rec.review && rec.review.reject_reason ? [h('dt', {}, 'Причина отказа'), h('dd', {}, rec.review.reject_reason)] : null,
        rec.status === 'voided' ? [h('dt', {}, 'Аннулировано'), h('dd', {}, dt(rec.voided_at) + (rec.voided_by ? ' · ' + rec.voided_by.full_name : '') + ' — ' + (rec.void_reason || ''))] : null);
      const actions = h('div', { class: 'row', style: 'margin-top:1rem' });
      const reviewable = can(ctx, 'work.review') && rec.status === 'active' && rec.review && rec.review.status === 'pending';
      if (reviewable) {
        const acc = h('button', { class: 'btn', onclick: async () => {
          acc.disabled = true;
          try { await Api.post('/work-records/' + rec.id + '/accept'); close(); onChanged && onChanged(); }
          catch (e) { acc.disabled = false; actions.parentNode.insertBefore(errBox(e), actions); }
        } }, 'Принять');
        actions.appendChild(acc);
        actions.appendChild(h('button', { class: 'btn danger', onclick: () => rejectDialog(rec, () => { close(); onChanged && onChanged(); }) }, 'Не принять'));
      }
      if (canFixOwn(ctx, rec)) {
        actions.appendChild(h('button', { class: 'btn', onclick: () => fixDialog(rec, () => { close(); onChanged && onChanged(); }) }, 'Исправить'));
      }
      if (can(ctx, 'work.void') && rec.status === 'active') {
        actions.appendChild(h('button', { class: 'btn danger', onclick: () => voidDialog(rec, () => { close(); onChanged && onChanged(); }) }, 'Аннулировать'));
      }
      actions.appendChild(h('button', { class: 'btn secondary', onclick: close }, 'Закрыть'));
      return [h('h1', {}, 'Работа №' + rec.id, ' ', reviewTag(rec)),
        kv, h('h2', {}, 'Фотографии'), photoGallery(rec.id), actions];
    });
  }

  function voidDialog(rec, done) {
    modal(close => {
      const reason = h('textarea', { placeholder: 'Причина аннулирования (обязательно)' });
      const msg = h('div');
      const ok = h('button', { class: 'btn danger', onclick: async () => {
        if (reason.value.trim().length < 3) { clear(msg).appendChild(alert('err', 'Укажите причину')); return; }
        ok.disabled = true;
        try { await Api.post('/work-records/' + rec.id + '/void', { reason: reason.value.trim() }); close(); done(); }
        catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      } }, 'Аннулировать работу');
      return [h('h1', {}, 'Аннулирование работы №' + rec.id),
        h('p', { class: 'muted' }, 'Запись и фотографии сохранятся. Если работа уже оплачена, система создаст финансовую корректировку.'),
        reason, msg, h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', onclick: close }, 'Отмена'))];
    });
  }

  // ------------------------------------------------------------------ приёмка работ (ТЗ 2.1)

  const REVIEW = { pending: ['ждёт приёмки', 'wait'], accepted: ['принято', 'ok'], rejected: ['не принято', 'bad'] };
  function reviewTag(rec) {
    if (rec.status === 'voided') return h('span', { class: 'tag void' }, 'аннулирована');
    const r = rec.review || { status: 'accepted' };
    const [label, cls] = REVIEW[r.status] || [r.status, ''];
    return h('span', { class: 'tag ' + cls }, r.status === 'rejected' && r.can_fix ? label + ' · можно исправить' : label);
  }
  const canFixOwn = (ctx, rec) => can(ctx, 'work.register') && rec.status === 'active' && rec.review && rec.review.status === 'rejected'
    && rec.review.can_fix === true && rec.user.id === ctx.user.id;

  /** Директор отклоняет работу: причина обязательна, решение «можно исправить» выбирается явно. */
  function rejectDialog(rec, done) {
    modal(close => {
      const reason = h('textarea', { placeholder: 'Причина (обязательно) — её увидит мастер' });
      const fixYes = h('input', { type: 'radio', name: 'canfix', value: '1' });
      const fixNo = h('input', { type: 'radio', name: 'canfix', value: '0' });
      const msg = h('div');
      const ok = h('button', { class: 'btn danger', onclick: async () => {
        if (reason.value.trim().length < 3) { clear(msg).appendChild(alert('err', 'Укажите причину')); return; }
        if (!fixYes.checked && !fixNo.checked) { clear(msg).appendChild(alert('err', 'Выберите, можно ли исправить работу')); return; }
        ok.disabled = true;
        try { await Api.post('/work-records/' + rec.id + '/reject', { reason: reason.value.trim(), can_fix: fixYes.checked }); close(); done(); }
        catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      } }, 'Не принимать');
      return [h('h1', {}, 'Не принять работу №' + rec.id),
        h('p', { class: 'muted' }, 'Начисление не создаётся. Фотографии и запись сохранятся.'),
        reason,
        h('div', { class: 'seg', style: 'margin-top:.8rem' },
          h('label', {}, fixYes, 'Можно исправить'), h('label', {}, fixNo, 'Исправить нельзя (отказ окончательный)')),
        msg, h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', onclick: close }, 'Отмена'))];
    });
  }

  /** Мастер исправляет отклонённую работу: новые фото, количество, комментарий. */
  function fixDialog(rec, done) {
    modal(close => {
      const files = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
      const q = h('input', { type: 'text', inputmode: 'decimal', value: qty(rec.quantity) });
      const comment = h('textarea', { placeholder: 'Что исправлено' }, '');
      comment.value = rec.comment || '';
      const msg = h('div'); const prog = h('div', { class: 'muted' });
      const ok = h('button', { class: 'btn', onclick: async () => {
        const fd = new FormData();
        Array.from(files.files).forEach(f => fd.append('photos[]', f));
        fd.append('quantity', q.value.trim().replace(',', '.'));
        fd.append('comment', comment.value.trim());
        ok.disabled = true; clear(msg);
        try { await Api.upload('/work-records/' + rec.id + '/resubmit', fd, {}, p => { prog.textContent = 'Отправка: ' + Math.round(p * 100) + '%'; }); close(); done(); }
        catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      } }, 'Отправить на повторную приёмку');
      return [h('h1', {}, 'Исправление работы №' + rec.id),
        rec.review && rec.review.reject_reason ? h('div', { class: 'alert err' }, 'Причина отказа: ' + rec.review.reject_reason) : null,
        h('label', {}, 'Новые фотографии (по желанию)'), files,
        h('label', {}, 'Количество, ' + rec.unit), q,
        h('label', {}, 'Комментарий'), comment,
        h('p', { class: 'muted' }, 'Старые фото сохранятся. Расценка не меняется. Начисление появится только после приёмки.'),
        msg, prog, h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', onclick: close }, 'Отмена'))];
    });
  }

  function worksTable(ctx, items, reload) {
    return h('table', { class: 'resp' },
      h('thead', {}, h('tr', {}, ['№', 'Дата', 'Дверь', 'Вид работы', 'Исполнитель', 'Кол-во', 'Сумма', 'Статус'].map(t => h('th', {}, t)))),
      h('tbody', {}, items.map(r => h('tr', { class: 'click', onclick: () => workModal(ctx, r, reload) },
        h('td', { 'data-l': '№' }, String(r.id)),
        h('td', { 'data-l': 'Дата' }, dt(r.completed_at)),
        h('td', { 'data-l': 'Дверь' }, r.door ? r.door.number : '—'),
        h('td', { 'data-l': 'Вид' }, r.work_type.name),
        h('td', { 'data-l': 'Исполнитель' }, r.user.full_name),
        h('td', { 'data-l': 'Кол-во' }, qty(r.quantity) + ' ' + r.unit),
        h('td', { 'data-l': 'Сумма', class: 'money right' }, money(r.total_amount)),
        h('td', { 'data-l': 'Статус' }, reviewTag(r),
          r.status === 'active' && r.review && r.review.status === 'rejected' && r.review.reject_reason ? h('div', { class: 'rejnote' }, 'Причина: ' + r.review.reject_reason) : null)))));
  }

  async function loadTypes(all) {
    // Список активных видов работ запоминается на телефоне, чтобы форму регистрации можно было открыть без связи.
    if (!all && w.Offline && !Offline.Net.online) { const c = await Offline.cachedWorkTypes(); if (c) return c; }
    try {
      const d = await Api.get('/work-types', { per_page: 200, ...(all ? {} : { is_active: 1 }) });
      if (!all && w.Offline) Offline.cacheWorkTypes(d.items);
      return d.items;
    } catch (e) {
      if (!all && w.Offline && e && e.code === 'NETWORK') { const c = await Offline.cachedWorkTypes(); if (c) return c; }
      throw e;
    }
  }

  // ------------------------------------------------------------------ главная (13.1.1, 7.1)

  async function home(ctx, root) {
    root.appendChild(h('h1', {}, 'Главная'));
    await (can(ctx, 'stats.view') ? homeStats(ctx, root) : homeMaster(ctx, root));
    if (w.Offline && can(ctx, 'work.register')) { const q = await Offline.panel(ctx); if (q) root.appendChild(q); }     // неотправленные работы
    if (w.Bio && !ctx.offline) { const bio = await Bio.card(ctx).catch(() => null); if (bio) root.appendChild(bio); }   // вход по биометрии (все роли)
  }

  function homeOffline(box) {
    box.appendChild(h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Нет связи с сервером'),
      h('p', { class: 'muted' }, 'Суммы и списки работ без интернета недоступны. Вы можете зарегистрировать работу: она сохранится на телефоне и отправится, когда появится связь.'),
      h('a', { class: 'btn big', href: '#/register' }, '＋ Зарегистрировать работу')));
  }
  async function homeMaster(ctx, root) {
    const box = h('div'); root.appendChild(box);
    if (ctx.offline) return homeOffline(box);
    let d;
    try { d = await Api.get('/finance/users/' + ctx.user.id); }
    catch (e) { if (e && e.code === 'NETWORK') return homeOffline(box); throw e; }
    const t = d.totals;
    const over = t.overpayment && t.overpayment !== '0.00' && /[1-9]/.test(t.overpayment);
    box.appendChild(h('div', { class: 'grid' },
      stat('Начислено за всё время', money(t.accrued)),
      stat('Выплачено', money(t.paid)),
      over ? stat('Переплата', money(t.overpayment), 'over') : stat('Остаток к выплате', money(t.debt), 'debt'),
      stat('Выполнено работ', String(t.works_count))));
    box.appendChild(h('p', {}, h('a', { class: 'btn big', href: '#/register' }, '＋ Зарегистрировать работу')));
    box.appendChild(h('h2', {}, 'Последние работы'));
    const list = await Api.get('/work-records', { per_page: 10 });
    if (list.review_counts) {
      const rc = list.review_counts;
      box.insertBefore(h('div', { class: 'grid' }, stat('Ждёт приёмки', String(rc.pending), 'debt'), stat('Не принято', String(rc.rejected), rc.rejected ? 'over' : '')), box.children[1]);
    }
    box.appendChild(list.items.length ? worksTable(ctx, list.items, () => route()) : h('p', { class: 'muted' }, 'Пока нет зарегистрированных работ.'));
    if (list.total > 10) box.appendChild(h('p', {}, h('a', { href: '#/works' }, 'Все мои работы →')));
  }

  async function homeStats(ctx, root) {
    const out = h('div');
    const picker = periodPicker('this_month', () => load());
    root.append(h('div', { class: 'card' }, h('label', {}, 'Период'), picker.el), out);
    async function load() {
      const q = picker.get();
      if (q.date_from === '' || q.date_to === '') return;
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const [s, dl] = await Promise.all([Api.get('/stats/summary', q), Api.get('/stats/daily', q)]);
        clear(out);
        const c = s.counts, m = s.money;
        out.appendChild(h('div', { class: 'grid' },
          stat('Уникальных дверей', String(c.doors)), stat('Ремонтов', String(c.repairs)), stat('Упаковок', String(c.packings)),
          stat('Доп. работ', String(c.other_works)), stat('Всего операций', String(c.operations))));
        out.appendChild(h('h2', {}, 'Финансы'));
        out.appendChild(h('div', { class: 'grid' },
          stat('Начислено', money(m.accrued)), stat('Выплачено', money(m.paid)),
          stat('Остаток к выплате', money(m.debt), 'debt'), stat('Переплата', money(m.overpayment), 'over')));
        if (m.note) out.appendChild(h('p', { class: 'muted' }, m.note));
        const items = dl.items;
        if (items.length > 1) {
          const max = Math.max(1, ...items.map(i => i.works_count));
          out.appendChild(h('h2', {}, 'Работы по дням'));
          out.appendChild(h('div', { class: 'card' },
            h('div', { class: 'bars', role: 'img', 'aria-label': 'Количество работ по дням' },
              items.map(i => h('div', { style: 'height:' + Math.round(i.works_count / max * 100) + '%', title: day(i.date) + ': ' + i.works_count }))),
            h('div', { class: 'muted', style: 'display:flex;justify-content:space-between;font-size:.8rem' }, h('span', {}, day(items[0].date)), h('span', {}, day(items[items.length - 1].date)))));
        }
        const wt = await Api.get('/stats/work-types', q);
        if (wt.items && wt.items.length) {
          out.appendChild(h('h2', {}, 'По видам работ'));
          out.appendChild(h('table', { class: 'resp' },
            h('thead', {}, h('tr', {}, ['Вид работы', 'Работ', 'Дверей', 'Начислено'].map(t => h('th', {}, t)))),
            h('tbody', {}, wt.items.map(r => h('tr', {},
              h('td', { 'data-l': 'Вид' }, r.name || (r.work_type && r.work_type.name) || ''),
              h('td', { 'data-l': 'Работ' }, String(r.works_count ?? r.works ?? '')),
              h('td', { 'data-l': 'Дверей' }, String(r.doors_count ?? r.doors ?? '')),
              h('td', { 'data-l': 'Начислено', class: 'money right' }, money(r.amount)))))));
        }
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  // ------------------------------------------------------------------ регистрация работы (13.2)

  async function register(ctx, root) {
    root.appendChild(h('h1', {}, 'Регистрация работы'));
    const draftsBox = h('div'); root.appendChild(draftsBox);        // работы, ещё не отправленные на сервер
    async function refreshDrafts() {
      if (!draftsBox.isConnected) { unsub(); return; }
      const p = await Offline.panel(ctx);
      clear(draftsBox); if (p) draftsBox.appendChild(p);
    }
    const unsub = Offline.onChange(refreshDrafts);
    refreshDrafts();
    const holder = h('div'); root.appendChild(holder);
    let types;
    try { types = await loadTypes(false); } catch (e) { holder.appendChild(errBox(e)); return; }
    if (!types.length) { holder.appendChild(alert('err', 'Нет доступных видов работ. Обратитесь к администратору.')); return; }
    renderForm();

    /* Набор работ: на одной двери можно зарегистрировать несколько видов работ сразу (например, ремонт и упаковку).
       Каждая работа — отдельная запись на сервере со своими расценкой, фото и Idempotency-Key (ТЗ 4.1, 4.2).
       Номер новой двери присваивает сервер при регистрации первой работы набора, остальные пишутся на эту же дверь. */
    function renderForm() {
      clear(holder);
      const MAX_FILES = 10, MAX_SIZE = 15 * 1024 * 1024;
      const rows = [];
      let doorMode = 'new';
      let lockedDoor = null;                  // дверь, уже определённая набором (создана сервером или введена): менять нельзя
      let busy = false, seq = 0;

      const doorBox = h('div');
      const doorNum = h('input', { type: 'text', id: 'dn', placeholder: 'D-000123', autocapitalize: 'characters', autocomplete: 'off' });
      const rowsBox = h('div');
      const addBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => addRow() }, '＋ Добавить вид работы');
      const msg = h('div');
      const prog = h('div', { class: 'progress hidden' }, h('div'));
      const submit = h('button', { class: 'btn big', type: 'button', onclick: () => sendAll() }, 'Зарегистрировать');

      const qtyOf = r => r.qty.value.trim().replace(',', '.') || '1';
      const doneCount = () => rows.filter(r => r.status === 'done').length;

      // ---- дверь (одна на весь набор)
      function renderDoor() {
        clear(doorBox);
        doorBox.appendChild(h('label', {}, 'Дверь'));
        if (lockedDoor) {
          doorBox.appendChild(h('p', {}, h('strong', {}, lockedDoor), ' — остальные работы набора записываются на эту же дверь.'));
          return;
        }
        const anyReq = rows.some(r => r.type().door_required);
        const modes = anyReq ? [['new', 'Новая дверь'], ['existing', 'Существующая']] : [['none', 'Без двери'], ['existing', 'Привязать к двери']];
        if (!modes.some(m => m[0] === doorMode)) doorMode = modes[0][0];
        doorBox.appendChild(h('div', { class: 'seg' }, modes.map(([v, l]) => h('label', {},
          h('input', { type: 'radio', name: 'dm', value: v, checked: v === doorMode, onchange: () => { doorMode = v; renderDoor(); } }), l))));
        if (doorMode === 'existing') doorBox.append(h('label', { for: 'dn' }, 'Номер двери'), doorNum);
        else if (doorMode === 'new') doorBox.appendChild(h('p', { class: 'muted' }, 'Номер будет присвоен автоматически при регистрации первой работы; остальные работы набора пойдут на эту же дверь.'));
      }

      // ---- виды работ в наборе: один вид — не более одного раза за набор
      function refreshTypes() {
        rows.forEach(r => {
          const cur = r.sel.value;
          const taken = new Set(rows.filter(x => x !== r).map(x => x.sel.value));
          clear(r.sel);
          types.filter(t => String(t.id) === cur || !taken.has(String(t.id))).forEach(t => r.sel.appendChild(h('option', { value: t.id }, t.name)));
          if (cur) r.sel.value = cur;
          r.unit.textContent = r.type().unit;
        });
        rows.forEach((r, i) => { r.title.textContent = rows.length > 1 ? 'Работа ' + (i + 1) : ''; r.removeBtn.classList.toggle('hidden', rows.length < 2 || r.status === 'done' || busy); });
        addBtn.classList.toggle('hidden', rows.length >= types.length || busy);
        submit.textContent = busy ? submit.textContent : doneCount() ? 'Повторить для незарегистрированных' : rows.length > 1 ? 'Зарегистрировать все (' + rows.length + ')' : 'Зарегистрировать';
      }

      function makeRow(typeId) {
        const n = ++seq;
        const r = { key: uuid(), files: [], status: 'idle', rec: null };
        r.title = h('strong', {});
        r.removeBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => removeRow(r) }, 'Убрать');
        r.sel = h('select', { id: 'wt' + n }, h('option', { value: typeId }, ''));
        r.sel.value = String(typeId);
        r.qty = h('input', { type: 'text', id: 'q' + n, inputmode: 'decimal', value: '1' });
        r.unit = h('span', { class: 'muted' });
        r.comment = h('textarea', { id: 'c' + n, placeholder: 'Комментарий (необязательно)' });
        r.thumbs = h('div', { class: 'thumbs' });
        r.msg = h('div');
        r.state = h('div');
        r.camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
        r.gallery = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'hidden' });
        r.type = () => types.find(t => String(t.id) === r.sel.value);
        r.controls = h('div', {},
          h('label', { for: 'q' + n }, 'Количество'), h('div', { class: 'row', style: 'align-items:center' }, r.qty, r.unit),
          h('label', {}, 'Фотографии (обязательно, для каждой работы свои)'),
          h('div', { class: 'row' },
            h('button', { class: 'btn secondary', type: 'button', onclick: () => r.camera.click() }, '📷 Сделать фото'),
            h('button', { class: 'btn secondary', type: 'button', onclick: () => r.gallery.click() }, '🖼 Из галереи')),
          r.camera, r.gallery, r.thumbs,
          h('label', { for: 'c' + n }, 'Комментарий'), r.comment);
        r.el = h('div', { class: 'card work-row' },
          h('div', { class: 'row', style: 'align-items:center;justify-content:space-between' }, r.title, r.removeBtn),
          h('label', { for: 'wt' + n }, 'Вид работы'), r.sel, r.controls, r.msg, r.state);
        r.sel.addEventListener('change', () => { refreshTypes(); renderDoor(); });
        r.camera.addEventListener('change', () => { addFiles(r, [...r.camera.files]); r.camera.value = ''; });
        r.gallery.addEventListener('change', () => { addFiles(r, [...r.gallery.files]); r.gallery.value = ''; });
        return r;
      }
      function addRow() {
        if (busy) return;
        const free = types.find(t => !rows.some(x => x.sel.value === String(t.id)));
        if (!free) return;
        const r = makeRow(free.id);
        rows.push(r); rowsBox.appendChild(r.el);
        refreshTypes(); renderDoor();
        if (rows.length > 1) r.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      function removeRow(r) {
        if (busy || r.status === 'done' || rows.length < 2) return;
        rows.splice(rows.indexOf(r), 1); r.el.remove();
        refreshTypes(); renderDoor();
      }

      // ---- фотографии
      function addFiles(r, list) {
        const errs = [];
        for (const f of list) {
          if (r.files.length >= MAX_FILES) { errs.push('Не более ' + MAX_FILES + ' фото на одну работу'); break; }
          if (f.size > MAX_SIZE) { errs.push(f.name + ': больше 15 МБ'); continue; }
          if (!/^image\/(jpeg|png|webp)$/.test(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name)) { errs.push(f.name + ': допустимы JPEG, PNG, WebP'); continue; }
          r.files.push(f);
        }
        clear(r.msg); if (errs.length) r.msg.appendChild(alert('err', errs.join('. ')));
        drawThumbs(r);
      }
      function drawThumbs(r) {
        clear(r.thumbs);
        r.files.forEach((f, i) => {
          const url = URL.createObjectURL(f);
          r.thumbs.appendChild(h('div', { class: 't' }, h('img', { src: url, alt: f.name, onload: () => URL.revokeObjectURL(url) }),
            h('button', { type: 'button', 'aria-label': 'Убрать фото', onclick: () => { r.files.splice(i, 1); drawThumbs(r); } }, '✕')));
        });
      }

      // ---- состояние отправки
      function setBusy(v) {
        busy = v; submit.disabled = v; doorNum.disabled = v;
        rows.forEach(r => { if (r.status !== 'done') { r.sel.disabled = v; r.qty.disabled = v; r.comment.disabled = v; } });
        if (v) submit.textContent = 'Отправка…';
        refreshTypes();
      }
      function markRow(r) {
        clear(r.state);
        if (r.status === 'sending') r.state.appendChild(h('p', { class: 'muted' }, 'Отправляется…'));
        else if (r.status === 'done') {
          r.el.classList.add('done'); r.controls.classList.add('hidden'); r.sel.disabled = true;
          r.state.appendChild(alert('ok', 'Зарегистрировано: ' + r.rec.work_type.name + ', ' + qty(r.rec.quantity) + ' ' + r.rec.unit + ', начислено ' + money(r.rec.total_amount)));
        } else if (r.status === 'error') r.state.appendChild(errBox(r.err));
      }

      function buildFd(r, door) {
        const fd = new FormData();
        fd.append('work_type_id', String(r.type().id));
        if (doorMode === 'new' && !door) fd.append('new_door', 'true');     // дверь создаёт первая работа набора
        else if (door) fd.append('door_number', door);
        fd.append('quantity', qtyOf(r));
        if (r.comment.value.trim()) fd.append('comment', r.comment.value.trim());
        r.files.forEach(f => fd.append('photos[]', f, f.name));
        return fd;
      }

      // Работы без связи сохраняются черновиками на телефоне (ТЗ 10.3) и не считаются зарегистрированными.
      // Если дверь ещё не известна, первый черновик создаёт её на сервере, остальные ждут её номер.
      async function saveDrafts(list, door, firstAttempted) {
        const group = uuid();
        const items = list.map((r, i) => {
          const t = r.type();
          const mode = door ? 'existing' : doorMode === 'new' ? (i === 0 ? 'new' : 'follow') : 'none';
          return { key: r.key, files: r.files, attempted: !!firstAttempted && i === 0, fields: { work_type_id: t.id, work_type_name: t.name, unit: t.unit, quantity: qtyOf(r),
            door_mode: mode, door_number: door || '', comment: r.comment.value.trim(), group: mode === 'new' || mode === 'follow' ? group : '' } };
        });
        try { savedOffline(await Offline.addDrafts(ctx.user.id, items), rows.filter(r => r.status === 'done').map(r => r.rec)); }
        catch (e) {
          clear(msg).appendChild(alert('err', 'Не удалось сохранить работы на телефоне (возможно, нет места): ' + (e && e.message ? e.message : e)));
          setBusy(false);
        }
      }

      async function sendAll() {
        if (busy) return;
        clear(msg);
        const todo = rows.filter(r => r.status !== 'done');
        let bad = false;
        todo.forEach(r => { clear(r.msg); if (!r.files.length) { r.msg.appendChild(alert('err', 'Добавьте хотя бы одну фотографию к этой работе')); bad = true; } });
        let door = lockedDoor;
        if (!door && doorMode === 'existing') {
          door = doorNum.value.trim();
          if (!door) { msg.appendChild(alert('err', 'Укажите номер двери')); bad = true; }
        }
        if (bad) return;
        // Работа, для которой дверь обязательна, идёт первой: именно она создаёт новую дверь.
        todo.sort((a, b) => (b.type().door_required ? 1 : 0) - (a.type().door_required ? 1 : 0));
        setBusy(true);
        if (ctx.offline || !Offline.Net.online) { await saveDrafts(todo, door || null, false); return; }

        prog.classList.remove('hidden');
        for (let i = 0; i < todo.length; i++) {
          const r = todo[i];
          if (doorMode === 'new' && !door && !r.type().door_required) {       // дверь создаёт только работа, для которой она обязательна
            r.status = 'error'; r.err = new Api.ApiError('DOOR_REQUIRED', 'Эта работа записывается на дверь, но дверь ещё не создана: сначала должна зарегистрироваться работа, для которой дверь обязательна.', 0);
            markRow(r); continue;
          }
          submit.textContent = 'Отправка ' + (i + 1) + ' из ' + todo.length + '…';
          prog.firstChild.style.width = '0%';
          r.status = 'sending'; markRow(r);
          try {
            r.rec = await Api.upload('/work-records', buildFd(r, door), { 'Idempotency-Key': r.key }, p => { prog.firstChild.style.width = Math.round(p * 100) + '%'; });
            r.status = 'done';
            if (r.rec.door && r.rec.door.number) { door = r.rec.door.number; lockedDoor = door; }
            markRow(r);
          } catch (e) {
            if (e.code === 'NETWORK') {          // запрос мог дойти до сервера: этот и остальные уходят в черновики, тот же ключ защитит от дубля
              r.status = 'idle'; markRow(r); prog.classList.add('hidden');
              await saveDrafts(todo.slice(i), door || null, true);
              return;
            }
            r.status = 'error'; r.err = e;
            if (e.status) r.key = uuid();        // сервер ответил ошибкой — повтор считается новым запросом
            markRow(r);
            if (e.status === 401) break;         // сессия истекла — дальше слать нечего
          }
        }
        prog.classList.add('hidden');
        setBusy(false);
        if (rows.every(r => r.status === 'done')) return success(rows.map(r => r.rec));
        renderDoor();
        clear(msg).appendChild(alert('err', 'Зарегистрировано работ: ' + doneCount() + ' из ' + rows.length + '. Исправьте причину в отмеченных работах и нажмите «Повторить» — уже зарегистрированные повторно не отправятся.'));
        msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      addRow();
      holder.appendChild(h('div', {}, h('div', { class: 'card' }, doorBox), rowsBox,
        h('div', { class: 'row', style: 'margin-bottom:1rem' }, addBtn), msg, prog, submit));
      renderDoor();
    }

    function savedOffline(drafts, registered) {
      clear(holder).appendChild(h('div', { class: 'card', id: 'saved-offline' },
        h('div', { class: 'alert ok' }, h('strong', {}, 'Сохранено на телефоне (работ: ' + drafts.length + '). '), 'Эти работы ещё НЕ зарегистрированы на сервере и не учтены в начислениях. Они отправятся сами, когда появится интернет и приложение будет открыто.'),
        registered && registered.length ? h('div', { class: 'alert ok' }, 'Уже зарегистрировано на сервере: ' + registered.map(x => x.work_type.name + (x.door ? ' (дверь ' + x.door.number + ')' : '')).join(', ') + '.') : null,
        drafts.map(d => { const f = d.fields; return h('dl', { class: 'kv' },
          h('dt', {}, 'Вид работы'), h('dd', {}, f.work_type_name),
          h('dt', {}, 'Дверь'), h('dd', {}, f.door_mode === 'new' || f.door_mode === 'follow' ? 'номер будет присвоен после отправки' : f.door_mode === 'existing' ? f.door_number : '—'),
          h('dt', {}, 'Количество'), h('dd', {}, qty(f.quantity) + ' ' + f.unit),
          h('dt', {}, 'Фото'), h('dd', {}, String(d.photos.length)),
          h('dt', {}, 'Сохранено'), h('dd', {}, dt(new Date(d.createdAt).toISOString()))); }),
        h('p', { class: 'muted' }, 'Дата выполнения и расценка определяются сервером в момент отправки.'),
        h('button', { class: 'btn big', onclick: renderForm }, 'Зарегистрировать ещё'),
        h('p', {}, h('a', { href: '#/home' }, 'На главную'))));
      window.scrollTo(0, 0);
    }

    function success(recs) {
      // recs собирается из строк формы: каждая строка хранит ответ сервера по своей работе
      clear(holder).appendChild(h('div', { class: 'card' },
        alert('ok', 'Все работы зарегистрированы и сохранены на сервере. Они ждут приёмки директором; начисление появится после приёмки.'),
        recs.map(rec => h('dl', { class: 'kv' },
          h('dt', {}, 'Дверь'), h('dd', {}, rec.door ? rec.door.number : '—'),
          h('dt', {}, 'Вид работы'), h('dd', {}, rec.work_type.name),
          h('dt', {}, 'Дата и время'), h('dd', {}, dt(rec.completed_at)),
          h('dt', {}, 'Исполнитель'), h('dd', {}, rec.user.full_name),
          h('dt', {}, 'Количество'), h('dd', {}, qty(rec.quantity) + ' ' + rec.unit),
          h('dt', {}, 'Сумма после приёмки'), h('dd', { class: 'money' }, money(rec.total_amount)))),
        h('button', { class: 'btn big', onclick: renderForm }, 'Зарегистрировать ещё'),
        h('p', {}, h('a', { href: '#/home' }, 'На главную'))));
      window.scrollTo(0, 0);
    }
  }

  // ------------------------------------------------------------------ выполненные работы (13.1.4)

  async function works(ctx, root) {
    root.appendChild(h('h1', {}, can(ctx, 'work.view_all') ? 'Выполненные работы' : 'Мои работы'));
    const types = await loadTypes(true).catch(() => []);
    const picker = periodPicker('all', () => reset());
    const typeSel = h('select', {}, h('option', { value: '' }, 'Все виды'), types.map(t => h('option', { value: t.id }, t.name)));
    const door = h('input', { type: 'search', placeholder: 'D-000123' });
    const status = h('select', {}, [['active', 'Действующие'], ['voided', 'Аннулированные'], ['all', 'Все']].map(([v, l]) => h('option', { value: v }, l)));
    const out = h('div');
    let page = 1;
    // Вкладки по статусу приёмки (ТЗ 2.1): мастер видит три списка своих работ
    let tab = can(ctx, 'work.view_all') ? 'all' : 'accepted';
    const tabsBox = h('div', { class: 'tabs', role: 'tablist' });
    const TABS = can(ctx, 'work.view_all')
      ? [['all', 'Все'], ['pending', 'Ждёт приёмки'], ['accepted', 'Принято'], ['rejected', 'Не принято']]
      : [['accepted', 'Принято'], ['pending', 'Ждёт приёмки'], ['rejected', 'Не принято']];
    function drawTabs(counts) {
      clear(tabsBox);
      TABS.forEach(([k, label]) => tabsBox.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k),
        onclick: () => { tab = k; page = 1; load(); } },
        counts && k !== 'all' ? h('span', { class: 'n' }, String(counts[k] ?? 0)) : null, label)));
    }
    drawTabs(null);
    const periodQuery = () => { const q = picker.get(); if (q.period) return presetToDates(q.period); return q; };
    root.append(h('div', { class: 'card' },
      h('label', {}, 'Период'), picker.el,
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Вид работы'), typeSel), h('div', {}, h('label', {}, 'Номер двери'), door),
        can(ctx, 'work.void') ? h('div', {}, h('label', {}, 'Статус'), status) : null),
      h('button', { class: 'btn', style: 'margin-top:.8rem', onclick: () => reset() }, 'Показать')), tabsBox, out);

    function reset() { page = 1; load(); }
    async function load() {
      const q = periodQuery();
      if ((q.date_from === '' && q.date_to !== '') || (q.date_to === '' && q.date_from !== '')) return;
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/work-records', { ...q, work_type_id: typeSel.value, door_number: door.value.trim(),
          status: can(ctx, 'work.void') ? status.value : undefined, review_status: tab === 'all' ? undefined : tab, page, per_page: 30 });
        drawTabs(d.review_counts);
        clear(out);
        out.appendChild(d.items.length ? worksTable(ctx, d.items, load) : h('p', { class: 'muted' }, 'В этом списке ничего нет.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); window.scrollTo(0, 0); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }


  // ------------------------------------------------------------------ приёмка работ директором (ТЗ 2.1)

  async function review(ctx, root) {
    root.appendChild(h('h1', {}, 'Приёмка работ'));
    root.appendChild(h('p', { class: 'muted' }, 'Работы оплачиваются только после приёмки. Откройте работу, посмотрите фото и примите её или не принимайте с указанием причины.'));
    const out = h('div');
    root.appendChild(out);
    let page = 1;
    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/work-records', { review_status: 'pending', status: 'active', page, per_page: 30 });
        clear(out);
        out.appendChild(d.items.length ? worksTable(ctx, d.items, load) : h('div', { class: 'alert ok' }, 'Нет работ, ожидающих приёмки.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); window.scrollTo(0, 0); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  /** /work-records принимает только date_from/date_to — переводим готовые периоды в даты (недели с понедельника). */
  function presetToDates(p) {
    const now = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kaliningrad' }).format(new Date()) + 'T00:00:00');
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const mon = d => addD(d, -((d.getDay() + 6) % 7));
    switch (p) {
      case 'today': return { date_from: iso(now), date_to: iso(now) };
      case 'yesterday': { const y = addD(now, -1); return { date_from: iso(y), date_to: iso(y) }; }
      case 'this_week': return { date_from: iso(mon(now)), date_to: iso(addD(mon(now), 6)) };
      case 'prev_week': return { date_from: iso(addD(mon(now), -7)), date_to: iso(addD(mon(now), -1)) };
      case 'this_month': return { date_from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), date_to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
      case 'prev_month': return { date_from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), date_to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
      default: return {};
    }
  }

  // ------------------------------------------------------------------ двери (13.1.3, 7.4)

  async function doors(ctx, root, param) {
    if (param) return doorCard(ctx, root, decodeURIComponent(param));
    root.appendChild(h('h1', {}, 'Двери'));
    const q = h('input', { type: 'search', placeholder: 'Номер двери, например D-000123', autocomplete: 'off' });
    const out = h('div');
    const full = can(ctx, 'doors.view');
    const go = () => { const n = q.value.trim(); if (n) location.hash = '#/doors/' + encodeURIComponent(n.toUpperCase()); };
    root.append(h('div', { class: 'card' }, h('label', {}, 'Поиск по номеру'),
      h('div', { class: 'row' }, q, h('button', { class: 'btn', onclick: go }, 'Найти'))), out);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    if (!full) { out.appendChild(h('p', { class: 'muted' }, 'Введите номер двери, чтобы увидеть, какие работы по ней уже зарегистрированы.')); return; }
    let page = 1;
    async function load() {
      try {
        const d = await Api.get('/doors', { page, per_page: 30 });
        clear(out);
        out.appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Номер', 'Создана', 'Работ'].map(t => h('th', {}, t)))),
          h('tbody', {}, d.items.map(r => h('tr', { class: 'click', onclick: () => { location.hash = '#/doors/' + encodeURIComponent(r.number); } },
            h('td', { 'data-l': 'Номер' }, r.number), h('td', { 'data-l': 'Создана' }, dt(r.created_at)), h('td', { 'data-l': 'Работ' }, String(r.works_count))))))
          : h('p', { class: 'muted' }, 'Дверей пока нет.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  async function doorCard(ctx, root, number) {
    root.appendChild(h('p', {}, h('a', { href: '#/doors' }, '← К дверям')));
    let d;
    try { d = await Api.get('/doors/number/' + encodeURIComponent(number)); } catch (e) { root.appendChild(errBox(e)); return; }
    root.appendChild(h('h1', {}, 'Дверь ' + d.number));
    root.appendChild(h('p', { class: 'muted' }, 'Создана ' + dt(d.created_at)));
    if (d.history) {
      root.appendChild(h('h2', {}, 'История операций'));
      root.appendChild(d.history.length ? worksTable(ctx, d.history, () => route()) : h('p', { class: 'muted' }, 'Операций нет.'));
    } else {
      root.appendChild(h('h2', {}, 'Зарегистрированные работы'));
      root.appendChild(d.registered_work_types.length
        ? h('ul', {}, d.registered_work_types.map(t => h('li', {}, t.name))) : h('p', { class: 'muted' }, 'По этой двери работ ещё нет.'));
    }
  }

  // ------------------------------------------------------------------ отчёты (13.1.10, раздел 8)

  async function reports(ctx, root) {
    root.appendChild(h('h1', {}, 'Отчёты и экспорт'));
    const types = await loadTypes(true).catch(() => []);
    let users = [];
    if (can(ctx, 'users.manage')) { try { users = (await Api.get('/users', { per_page: 200 })).items; } catch (e) { /* список необязателен */ } }
    else if (can(ctx, 'finance.view_all')) { try { users = (await Api.get('/finance/balances')).items.map(r => r.user); } catch (e) { /* список необязателен */ } }
    const picker = periodPicker('this_month');
    const typeSel = h('select', {}, h('option', { value: '' }, 'Все виды'), types.map(t => h('option', { value: t.id }, t.name)));
    const userSel = users.length ? h('select', {}, h('option', { value: '' }, 'Все исполнители'), users.map(u => h('option', { value: u.id }, u.full_name))) : null;
    const door = h('input', { type: 'search', placeholder: 'D-000123' });
    const payStatus = h('select', {}, [['posted', 'Подтверждённые'], ['draft', 'Черновики'], ['cancelled', 'Отменённые'], ['all', 'Все']].map(([v, l]) => h('option', { value: v }, l)));
    const dsSel = h('select', {}, [['works', 'Выполненные работы'], ['payments', 'Выплаты'], ['balances', 'Остатки по исполнителям'], ['stats-users', 'Статистика по исполнителям'],
      ['stats-types', 'Статистика по видам работ'], ['stats-daily', 'Статистика по дням'], ['stats-doors', 'Статистика по дверям']].map(([v, l]) => h('option', { value: v }, l)));
    const msg = h('div');
    const payslips = h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Расчётные листы (PDF)'), h('p', { class: 'muted' }, 'Загрузка…'));

    const filters = () => {
      const q = picker.get();
      return { ...q, user_id: userSel ? userSel.value : '', work_type_id: typeSel.value, door_number: door.value.trim() };
    };
    const run = (btn, path, extra) => async () => {
      const f = filters();
      if ((f.date_from === '') !== (f.date_to === '') || (f.date_from === '' && f.date_to === '')) { clear(msg).appendChild(alert('err', 'Укажите обе даты периода')); return; }
      clear(msg); const old = btn.textContent; btn.disabled = true; btn.textContent = 'Формирование…';
      try { await Api.download(path, { ...f, ...(extra ? extra() : {}) }); } catch (e) { clear(msg).appendChild(errBox(e)); }
      btn.disabled = false; btn.textContent = old;
    };
    const dl = (label, path, extra) => { const b = h('button', { class: 'btn secondary' }, label); b.addEventListener('click', run(b, path, extra)); return b; };

    function loadPayslips(page) {
      page = page || 1;
      Api.get('/payroll-runs', { status: 'confirmed', user_id: userSel ? userSel.value : '', page, per_page: 15 }).then(d => {
        const body = clear(payslips); body.appendChild(h('h2', { style: 'margin-top:0' }, 'Расчётные листы (PDF)'));
        if (userSel) body.appendChild(h('p', { class: 'muted' }, 'Показаны подтверждённые расчёты; исполнитель берётся из фильтра выше.'));
        body.appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['№', 'Исполнитель', 'Период', 'Сумма', ''].map(t => h('th', {}, t)))),
          h('tbody', {}, d.items.map(r => { const b = h('button', { class: 'btn secondary' }, 'PDF');
            b.addEventListener('click', async () => { clear(msg); b.disabled = true; try { await Api.download('/export/pdf/payroll/' + r.id); } catch (e) { clear(msg).appendChild(errBox(e)); } b.disabled = false; });
            return h('tr', {},
            h('td', { 'data-l': '№' }, String(r.id)), h('td', { 'data-l': 'Исполнитель' }, r.user.full_name), h('td', { 'data-l': 'Период' }, day(r.period_from) + ' — ' + day(r.period_to)),
            h('td', { 'data-l': 'Сумма', class: 'money right' }, money(r.total_amount)), h('td', {}, b)); })))
          : h('p', { class: 'muted' }, 'Подтверждённых расчётов нет.'));
        body.appendChild(pager(d.page, d.per_page, d.total, p => loadPayslips(p)));
      }).catch(e => { clear(payslips).appendChild(errBox(e)); });
    }
    if (userSel) userSel.addEventListener('change', () => loadPayslips(1));
    root.append(
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Фильтры'), h('label', {}, 'Период'), picker.el,
        h('div', { class: 'row' }, userSel ? h('div', {}, h('label', {}, 'Исполнитель'), userSel) : null,
          h('div', {}, h('label', {}, 'Вид работы'), typeSel), h('div', {}, h('label', {}, 'Номер двери'), door))),
      msg,
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'PDF-отчёты'),
        h('div', { class: 'row' },
          dl('Производственный отчёт', '/export/pdf/production'),
          dl('Общий финансовый отчёт', '/export/pdf/finance'),
          dl('Фотоотчёт', '/export/pdf/photos')),
        h('label', {}, 'Отчёт по выплатам: статус'), h('div', { class: 'row' }, payStatus, dl('Отчёт по выплатам', '/export/pdf/payments', () => ({ status: payStatus.value }))),
        h('p', { class: 'muted' }, 'Фотоотчёт — не более 100 работ за раз; сузьте период или фильтры. Расчётный лист исполнителя формируется из карточки расчёта.')),
      payslips,
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Таблицы CSV и XLSX'), h('label', {}, 'Набор данных'), dsSel,
        h('div', { class: 'row', style: 'margin-top:.8rem' },
          dl('Скачать CSV', '/export/csv', () => ({ dataset: dsSel.value })),
          dl('Скачать XLSX', '/export/xlsx', () => ({ dataset: dsSel.value })))));
  }


  // ------------------------------------------------------------------ пользователи (13.1.11, 12.2) — только администратор

  const ROLE_NAMES = { owner: 'Администратор', master: 'Мастер', director: 'Директор' };

  async function users(ctx, root) {
    root.appendChild(h('h1', {}, 'Пользователи'));
    const q = h('input', { type: 'search', placeholder: 'Поиск по ФИО или логину' });
    const role = h('select', {}, h('option', { value: '' }, 'Все роли'), Object.entries(ROLE_NAMES).map(([v, l]) => h('option', { value: v }, l)));
    const act = h('select', {}, [['', 'Все'], ['1', 'Активные'], ['0', 'Отключённые']].map(([v, l]) => h('option', { value: v, selected: v === '1' }, l)));
    const out = h('div');
    let page = 1;
    root.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Поиск'), q), h('div', {}, h('label', {}, 'Роль'), role), h('div', {}, h('label', {}, 'Статус'), act)),
      h('div', { class: 'row', style: 'margin-top:.8rem' },
        h('button', { class: 'btn secondary', onclick: () => { page = 1; load(); } }, 'Показать'),
        h('button', { class: 'btn', onclick: () => userDialog(ctx, null, load) }, '＋ Добавить пользователя'))), out);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; load(); } });
    role.addEventListener('change', () => { page = 1; load(); });
    act.addEventListener('change', () => { page = 1; load(); });

    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/users', { q: q.value.trim(), role: role.value, is_active: act.value, page, per_page: 50 });
        clear(out);
        out.appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['ФИО', 'Логин', 'Роль', 'Статус', 'Создан'].map(t => h('th', {}, t)))),
          h('tbody', {}, d.items.map(u => h('tr', { class: 'click', onclick: () => userDialog(ctx, u, load) },
            h('td', { 'data-l': 'ФИО' }, u.full_name), h('td', { 'data-l': 'Логин' }, u.username),
            h('td', { 'data-l': 'Роль' }, ROLE_NAMES[u.role] || u.role),
            h('td', { 'data-l': 'Статус' }, h('span', { class: 'tag ' + (u.is_active ? '' : 'void') }, u.is_active ? 'активен' : 'отключён')),
            h('td', { 'data-l': 'Создан' }, dt(u.created_at))))))
          : h('p', { class: 'muted' }, 'Пользователи не найдены.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); window.scrollTo(0, 0); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  /** Создание (u === null) и редактирование пользователя. Логин после создания не меняется (правило сервера). */
  function userDialog(ctx, u, onDone) {
    const isNew = u === null;
    const self = !isNew && u.id === ctx.user.id;
    modal(close => {
      const name = h('input', { type: 'text', value: isNew ? '' : u.full_name, autocomplete: 'off' });
      const login = h('input', { type: 'text', value: isNew ? '' : u.username, autocomplete: 'off', autocapitalize: 'none', disabled: !isNew });
      const roleSel = h('select', { disabled: self }, Object.entries(ROLE_NAMES).map(([v, l]) => h('option', { value: v, selected: !isNew && u.role === v }, l)));
      if (isNew) roleSel.value = 'master';
      const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? 'Не менее 10 символов' : 'Оставьте пустым, чтобы не менять' });
      const show = h('button', { class: 'btn secondary', type: 'button', onclick: () => { const t = pass.type === 'password'; pass.type = t ? 'text' : 'password'; show.textContent = t ? 'Скрыть' : 'Показать'; } }, 'Показать');
      const msg = h('div');
      const save = h('button', { class: 'btn', type: 'button' }, isNew ? 'Создать' : 'Сохранить');
      save.addEventListener('click', async () => {
        clear(msg); save.disabled = true;
        try {
          if (isNew) {
            await Api.post('/users', { full_name: name.value.trim(), username: login.value.trim(), role: roleSel.value, password: pass.value });
          } else {
            const patch = {};                                     // отправляем только изменённое
            if (name.value.trim() !== u.full_name) patch.full_name = name.value.trim();
            if (!self && roleSel.value !== u.role) patch.role = roleSel.value;
            if (pass.value !== '') patch.password = pass.value;
            if (!Object.keys(patch).length) { clear(msg).appendChild(alert('err', 'Нет изменений')); save.disabled = false; return; }
            await Api.patch('/users/' + u.id, patch);
          }
          close(); onDone();
        } catch (e) { clear(msg).appendChild(errBox(e)); save.disabled = false; }
      });

      const toggle = isNew ? null : h('button', { class: 'btn ' + (u.is_active ? 'danger' : 'secondary'), type: 'button', disabled: self && u.is_active }, u.is_active ? 'Отключить доступ' : 'Включить доступ');
      if (toggle) toggle.addEventListener('click', async () => {
        clear(msg); toggle.disabled = true;
        try { await Api.post('/users/' + u.id + (u.is_active ? '/deactivate' : '/activate')); close(); onDone(); }
        catch (e) { clear(msg).appendChild(errBox(e)); toggle.disabled = false; }
      });

      return [h('h1', {}, isNew ? 'Новый пользователь' : u.full_name),
        h('label', {}, 'ФИО'), name,
        h('label', {}, 'Логин'), login,
        isNew ? null : h('p', { class: 'muted' }, 'Логин после создания не меняется.'),
        h('label', {}, 'Роль'), roleSel,
        self ? h('p', { class: 'muted' }, 'Собственную роль и доступ изменить нельзя.') : null,
        h('label', {}, isNew ? 'Пароль' : 'Новый пароль'), h('div', { class: 'row', style: 'align-items:center' }, pass, show),
        msg,
        h('div', { class: 'row', style: 'margin-top:1rem' }, save, toggle, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть'))];
    });
  }


  // ------------------------------------------------------------------ виды работ (12.4) — администратор

  const CATS = { repair: 'Ремонт', packing: 'Упаковка', other: 'Дополнительные работы' };

  async function workTypes(ctx, root) {
    root.appendChild(h('h1', {}, 'Виды работ'));
    const out = h('div');
    const manage = can(ctx, 'work_types.manage');
    root.append(manage ? h('p', {}, h('button', { class: 'btn', onclick: () => typeDialog(null, load) }, '＋ Добавить вид работы')) : h('p', { class: 'muted' }, 'Справочник доступен для просмотра. Виды работ создаёт и изменяет директор.'), out);
    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const items = await loadTypes(true);
        clear(out).appendChild(h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Название', 'Категория', 'Ед.', 'Дверь', 'Повтор на дверь', 'Статус'].map(t => h('th', {}, t)))),
          h('tbody', {}, items.map(t => h('tr', { class: manage ? 'click' : '', onclick: manage ? () => typeDialog(t, load) : null },
            h('td', { 'data-l': 'Название' }, t.name), h('td', { 'data-l': 'Категория' }, CATS[t.category] || t.category),
            h('td', { 'data-l': 'Ед.' }, t.unit), h('td', { 'data-l': 'Дверь' }, t.door_required ? 'обязательна' : 'не нужна'),
            h('td', { 'data-l': 'Повтор' }, t.allow_multiple_per_door ? 'разрешён' : 'запрещён'),
            h('td', { 'data-l': 'Статус' }, h('span', { class: 'tag ' + (t.is_active ? '' : 'void') }, t.is_active ? 'активен' : 'отключён')))))));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  function typeDialog(t, onDone) {
    const isNew = t === null;
    modal(close => {
      const name = h('input', { type: 'text', value: isNew ? '' : t.name });
      const descr = h('textarea', {}, isNew ? '' : (t.description || ''));
      const unit = h('input', { type: 'text', value: isNew ? 'шт' : t.unit, list: 'units' });
      const units = h('datalist', { id: 'units' }, ['шт', 'компл', 'пог.м', 'м²', 'ч', 'операция'].map(u => h('option', { value: u })));
      const cat = h('select', {}, Object.entries(CATS).map(([v, l]) => h('option', { value: v, selected: (isNew ? 'other' : t.category) === v }, l)));
      const door = h('input', { type: 'checkbox', checked: isNew ? true : t.door_required });
      const multi = h('input', { type: 'checkbox', checked: isNew ? false : t.allow_multiple_per_door });
      const msg = h('div');
      const save = h('button', { class: 'btn', type: 'button' }, isNew ? 'Создать' : 'Сохранить');
      save.addEventListener('click', async () => {
        clear(msg); save.disabled = true;
        const v = { name: name.value.trim(), description: descr.value.trim() || null, unit: unit.value.trim(), category: cat.value,
          door_required: door.checked, allow_multiple_per_door: multi.checked };
        try {
          if (isNew) await Api.post('/work-types', v);
          else {
            const patch = {};
            for (const k of Object.keys(v)) if (v[k] !== (k === 'description' ? (t.description || null) : t[k])) patch[k] = v[k];
            if (!Object.keys(patch).length) { clear(msg).appendChild(alert('err', 'Нет изменений')); save.disabled = false; return; }
            await Api.patch('/work-types/' + t.id, patch);
          }
          close(); onDone();
        } catch (e) { clear(msg).appendChild(errBox(e)); save.disabled = false; }
      });
      const toggle = isNew ? null : h('button', { class: 'btn ' + (t.is_active ? 'danger' : 'secondary'), type: 'button' }, t.is_active ? 'Отключить' : 'Включить');
      if (toggle) toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { await Api.post('/work-types/' + t.id + (t.is_active ? '/deactivate' : '/activate')); close(); onDone(); }
        catch (e) { clear(msg).appendChild(errBox(e)); toggle.disabled = false; }
      });
      return [h('h1', {}, isNew ? 'Новый вид работы' : t.name),
        h('label', {}, 'Название'), name, h('label', {}, 'Описание'), descr,
        h('label', {}, 'Единица измерения'), unit, units,
        h('label', {}, 'Категория (для статистики)'), cat,
        h('label', { style: 'display:flex;gap:.6rem;align-items:center;font-weight:400' }, door, 'Требуется привязка к двери'),
        h('label', { style: 'display:flex;gap:.6rem;align-items:center;font-weight:400' }, multi, 'Несколько записей на одну дверь'),
        isNew ? null : h('p', { class: 'muted' }, 'Изменения действуют на новые записи. Ранее зарегистрированные работы и суммы не меняются.'),
        msg, h('div', { class: 'row', style: 'margin-top:1rem' }, save, toggle, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть'))];
    });
  }

  // ------------------------------------------------------------------ расценки (12.5, раздел 5) — администратор

  async function rates(ctx, root) {
    root.appendChild(h('h1', {}, 'Расценки'));
    const manage = can(ctx, 'rates.manage');
    let execs, types;
    try {
      if (can(ctx, 'users.manage')) {
        const [mu, ou] = await Promise.all([Api.get('/users', { role: 'master', is_active: 1, per_page: 200 }), Api.get('/users', { role: 'owner', is_active: 1, per_page: 200 })]);
        execs = [...mu.items, ...ou.items];
      } else {                                         // директору список /users недоступен — берём исполнителей из финансовых остатков
        execs = (await Api.get('/finance/balances')).items.filter(r => r.user.is_active).map(r => r.user);
      }
      types = await loadTypes(true);
    } catch (e) { root.appendChild(errBox(e)); return; }
    if (!execs.length) { root.appendChild(alert('err', 'Нет активных исполнителей. Мастеров создаёт администратор в разделе «Пользователи».')); return; }
    const sel = h('select', {}, execs.map(u => h('option', { value: u.id }, u.full_name + (u.role === 'owner' ? ' (администратор)' : ''))));
    const out = h('div');
    root.append(h('div', { class: 'card' }, h('label', {}, 'Исполнитель'), sel), out);
    sel.addEventListener('change', load);

    async function load() {
      const uid = Number(sel.value);
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const cur = new Map();
        let page = 1, total = 0;
        do {                                            // действующие расценки исполнителя (все страницы)
          const d = await Api.get('/rates', { user_id: uid, current: 1, per_page: 200, page });
          d.items.forEach(r => cur.set(r.work_type_id, r)); total = d.total; page++;
        } while ((page - 1) * 200 < total);
        const rows = types.filter(t => t.is_active || cur.has(t.id));
        clear(out).appendChild(h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Вид работы', 'Расценка', 'Действует с', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, rows.map(t => {
            const r = cur.get(t.id);
            return h('tr', {},
              h('td', { 'data-l': 'Вид' }, t.name, ' ', h('span', { class: 'muted' }, '(за ' + t.unit + ')')),
              h('td', { 'data-l': 'Расценка', class: 'money' }, r ? money(r.unit_price) : h('span', { class: 'tag void' }, 'не назначена')),
              h('td', { 'data-l': 'С' }, r ? dt(r.valid_from) : '—'),
              h('td', {}, manage ? h('button', { class: 'btn secondary', onclick: () => rateDialog(uid, sel.options[sel.selectedIndex].text, t, r, load, false) }, r ? 'Изменить' : 'Назначить')
                : h('button', { class: 'btn secondary', onclick: () => rateDialog(uid, sel.options[sel.selectedIndex].text, t, r, load, true) }, 'История')));
          }))));
        out.appendChild(h('p', { class: 'muted' }, manage ? 'Новая расценка действует только на работы, зарегистрированные после её начала. Начисления по ранее выполненным работам не пересчитываются.' : 'Расценки доступны для просмотра. Устанавливает и изменяет их директор.'));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  function rateDialog(uid, userName, type, rate, onDone, readonly) {
    modal(close => {
      const price = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', value: rate ? rate.unit_price.replace('.', ',') : '' });
      const from = h('input', { type: 'datetime-local' });
      const msg = h('div');
      const save = h('button', { class: 'btn', type: 'button' }, rate ? 'Установить новую расценку' : 'Назначить расценку');
      save.addEventListener('click', async () => {
        clear(msg); save.disabled = true;
        const body = { user_id: uid, work_type_id: type.id, unit_price: price.value.trim().replace(',', '.') };
        if (from.value) body.valid_from = UI.localToIso(from.value);
        try { await Api.post('/rates', body); close(); onDone(); }
        catch (e) { clear(msg).appendChild(errBox(e)); save.disabled = false; }
      });
      const closeBtn = rate ? h('button', { class: 'btn danger', type: 'button', onclick: () => closeRateDialog(rate, () => { close(); onDone(); }) }, 'Завершить действие') : null;
      const hist = h('div', { class: 'muted' }, 'Загрузка истории…');
      Api.get('/rates/history', { user_id: uid, work_type_id: type.id, per_page: 50 }).then(d => {
        clear(hist);
        if (!d.items.length) { hist.textContent = 'Расценок ещё не было.'; return; }
        hist.appendChild(h('table', {}, h('thead', {}, h('tr', {}, ['Цена', 'С', 'По'].map(x => h('th', {}, x)))),
          h('tbody', {}, d.items.map(r => h('tr', {}, h('td', { class: 'money' }, money(r.unit_price)), h('td', {}, dt(r.valid_from)), h('td', {}, r.valid_to ? dt(r.valid_to) : 'действует'))))));
      }).catch(e => { clear(hist).appendChild(errBox(e)); });
      if (readonly) {
        return [h('h1', {}, type.name), h('p', { class: 'muted' }, userName + ' · цена за ' + type.unit),
          h('p', {}, 'Действующая расценка: ', h('strong', {}, rate ? money(rate.unit_price) : 'не назначена')),
          h('h2', {}, 'История расценок'), hist,
          h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть'))];
      }
      return [h('h1', {}, type.name), h('p', { class: 'muted' }, userName + ' · цена за ' + type.unit),
        h('label', {}, 'Новая цена, ₽'), price,
        h('label', {}, 'Действует с (необязательно)'), from,
        h('p', { class: 'muted' }, 'Если дату не указывать, расценка начинает действовать сразу. Прошедшей датой назначить нельзя.'),
        msg, h('div', { class: 'row', style: 'margin-top:1rem' }, save, closeBtn, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть')),
        h('h2', {}, 'История расценок'), hist];
    });
  }

  function closeRateDialog(rate, done) {
    modal(close => {
      const msg = h('div');
      const ok = h('button', { class: 'btn danger', type: 'button' }, 'Завершить действие');
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        try { await Api.post('/rates/' + rate.id + '/close', {}); close(); done(); }
        catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      });
      return [h('h1', {}, 'Завершить действие расценки?'),
        h('p', {}, 'После этого исполнитель не сможет регистрировать этот вид работы, пока вы не назначите новую расценку. Прежние начисления не изменятся.'),
        msg, h('div', { class: 'row' }, ok, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
    });
  }

  w.Views = { home, register, works, review, doors, reports, users, workTypes, rates, presetToDates, workModal, worksTable };
})(window);
