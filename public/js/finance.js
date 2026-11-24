'use strict';
/* Начисления, расчёты за период и выплаты (ТЗ раздел 6, 12.8). Все суммы — строки DECIMAL с сервера;
   сложение/сравнение на клиенте — только в целых копейках, без float. Итоговые проверки выполняет сервер. */
(function (w) {
  const { h, clear, money, qty, dt, day, errBox, alert, modal, pager, uuid } = UI;
  const can = (ctx, p) => ctx.permissions.includes(p);

  const RUN_ST = { draft: 'черновик', confirmed: 'подтверждён', cancelled: 'отменён' };
  const PAY_ST = { draft: 'черновик', posted: 'проведена', cancelled: 'отменена' };
  const tag = (st, names) => h('span', { class: 'tag ' + (st === 'cancelled' ? 'void' : '') }, names[st] || st);
  const stat = (l, v, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

  // --- деньги в копейках (целые числа) ---
  function toCents(s) {
    const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(s ?? '').trim());
    return m ? Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2)) : null;
  }
  const fromCents = c => Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0');

  /** Исполнители для форм. /users доступен только администратору; директору (он управляет финансами) список берётся из остатков. */
  async function executors(ctx) {
    if (can(ctx, 'users.manage')) {
      const [a, b] = await Promise.all([Api.get('/users', { role: 'master', is_active: 1, per_page: 200 }), Api.get('/users', { role: 'owner', is_active: 1, per_page: 200 })]);
      return [...a.items, ...b.items];
    }
    return (await Api.get('/finance/balances')).items.filter(r => r.user.is_active).map(r => r.user);
  }

  function reasonDialog(title, text, label, action, done) {
    modal(close => {
      const reason = h('textarea', { placeholder: 'Причина (обязательно, от 3 символов)' });
      const msg = h('div');
      const ok = h('button', { class: 'btn danger', type: 'button' }, label);
      ok.addEventListener('click', async () => {
        if (reason.value.trim().length < 3) { clear(msg).appendChild(alert('err', 'Укажите причину')); return; }
        ok.disabled = true;
        try { await action(reason.value.trim()); close(); done(); }
        catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      });
      return [h('h1', {}, title), h('p', { class: 'muted' }, text), reason, msg,
        h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
    });
  }

  // ------------------------------------------------------------------ вкладки

  function tabs(ctx, cur) {
    const items = [[can(ctx, 'finance.view_all') ? 'balances' : 'me', can(ctx, 'finance.view_all') ? 'Остатки' : 'Мои итоги'], ['runs', 'Расчёты'], ['payments', 'Выплаты'], ['adjustments', 'Корректировки']];
    return h('div', { class: 'seg', style: 'margin-bottom:1rem' }, items.map(([k, l]) =>
      h('a', { class: 'btn ' + (k === cur ? '' : 'secondary'), href: '#/finance' + (k === 'balances' || k === 'me' ? '' : '/' + k) }, l)));
  }

  async function finance(ctx, root, param) {
    root.appendChild(h('h1', {}, 'Начисления и выплаты'));
    if (can(ctx, 'finance.view_all') && !can(ctx, 'finance.manage')) root.appendChild(h('p', { class: 'muted' }, 'Режим просмотра. Расчёты, выплаты и корректировки создаёт и изменяет директор.'));
    const p = param || '';
    if (p.startsWith('user/')) return userPage(ctx, root, Number(p.slice(5)));
    if (p === 'runs') { root.appendChild(tabs(ctx, 'runs')); return runsTab(ctx, root); }
    if (p === 'payments') { root.appendChild(tabs(ctx, 'payments')); return paymentsTab(ctx, root); }
    if (p === 'adjustments') { root.appendChild(tabs(ctx, 'adjustments')); return adjustmentsTab(ctx, root); }
    root.appendChild(tabs(ctx, can(ctx, 'finance.view_all') ? 'balances' : 'me'));
    return can(ctx, 'finance.view_all') ? balancesTab(ctx, root) : userPage(ctx, root, ctx.user.id, true);
  }

  // ------------------------------------------------------------------ остатки

  async function balancesTab(ctx, root) {
    const out = h('div'); root.appendChild(out);
    const [sum, bal] = await Promise.all([Api.get('/finance/summary'), Api.get('/finance/balances')]);
    const t = sum.totals;
    out.appendChild(h('div', { class: 'grid' },
      stat('Начислено', money(t.accrued)), stat('Выплачено', money(t.paid)),
      stat('Долг перед исполнителями', money(t.debt_total), 'debt'), stat('Переплаты', money(t.overpayment_total), 'over'),
      stat('Исполнителей с долгом', String(t.executors_with_debt))));
    out.appendChild(h('h2', {}, 'По исполнителям'));
    out.appendChild(h('table', { class: 'resp' },
      h('thead', {}, h('tr', {}, ['Исполнитель', 'Начислено', 'Выплачено', 'Корректировки', 'Остаток'].map(x => h('th', {}, x)))),
      h('tbody', {}, bal.items.map(r => h('tr', { class: 'click', onclick: () => { location.hash = '#/finance/user/' + r.user.id; } },
        h('td', { 'data-l': 'Исполнитель' }, r.user.full_name, r.user.is_active ? null : h('span', { class: 'tag void', style: 'margin-left:.4rem' }, 'отключён')),
        h('td', { 'data-l': 'Начислено', class: 'money right' }, money(r.accrued)),
        h('td', { 'data-l': 'Выплачено', class: 'money right' }, money(r.paid)),
        h('td', { 'data-l': 'Корректировки', class: 'money right' }, money(r.adjustments)),
        h('td', { 'data-l': 'Остаток', class: 'money right' }, r.overpayment !== '0.00' ? h('span', { class: 'tag void' }, 'переплата ' + money(r.overpayment)) : money(r.debt)))))));
  }

  // ------------------------------------------------------------------ финансы исполнителя

  async function userPage(ctx, root, uid, own) {
    if (!own) root.appendChild(h('p', {}, h('a', { href: '#/finance' }, '← К остаткам')));
    const out = h('div'); root.appendChild(out);
    const d = await Api.get('/finance/users/' + uid);
    const t = d.totals;
    out.appendChild(h('h2', {}, d.user.full_name));
    out.appendChild(h('div', { class: 'grid' },
      stat('Начислено', money(t.accrued)), stat('Выплачено', money(t.paid)),
      t.overpayment !== '0.00' ? stat('Переплата', money(t.overpayment), 'over') : stat('Остаток к выплате', money(t.debt), 'debt'),
      stat('Работ', String(t.works_count))));
    if (t.adjustments !== '0.00') out.appendChild(h('p', { class: 'muted' }, 'Учтены корректировки: ' + money(t.adjustments)));
    if (can(ctx, 'finance.manage')) {
      out.appendChild(h('div', { class: 'row', style: 'margin:1rem 0' },
        h('button', { class: 'btn', onclick: () => runDialog(ctx, { user_id: uid }, id => runModal(ctx, id, () => route())) }, 'Сформировать расчёт'),
        h('button', { class: 'btn secondary', onclick: () => paymentDialog(ctx, { user_id: uid }, id => paymentModal(ctx, id, () => route())) }, 'Зарегистрировать выплату')));
    }
    out.appendChild(h('h2', {}, 'Неоплаченные начисления'));
    const acc = await Api.get('/finance/accruals', { user_id: uid, payment_state: 'open', per_page: 100 });
    out.appendChild(acc.items.length ? h('table', { class: 'resp' },
      h('thead', {}, h('tr', {}, ['Дата', 'Вид работы', 'Дверь', 'Сумма', 'Оплачено', 'Остаток'].map(x => h('th', {}, x)))),
      h('tbody', {}, acc.items.map(a => h('tr', {},
        h('td', { 'data-l': 'Дата' }, dt(a.completed_at)), h('td', { 'data-l': 'Вид' }, a.work_type.name), h('td', { 'data-l': 'Дверь' }, a.door_number || '—'),
        h('td', { 'data-l': 'Сумма', class: 'money right' }, money(a.total_amount)), h('td', { 'data-l': 'Оплачено', class: 'money right' }, money(a.paid)),
        h('td', { 'data-l': 'Остаток', class: 'money right' }, money(a.outstanding))))))
      : h('p', { class: 'muted' }, 'Неоплаченных начислений нет.'));
    if (acc.total > acc.items.length) out.appendChild(h('p', { class: 'muted' }, 'Показаны первые ' + acc.items.length + ' из ' + acc.total + '.'));
  }

  // ------------------------------------------------------------------ расчёты за период

  async function runsTab(ctx, root) {
    const status = h('select', {}, [['', 'Все'], ['draft', 'Черновики'], ['confirmed', 'Подтверждённые'], ['cancelled', 'Отменённые']].map(([v, l]) => h('option', { value: v }, l)));
    const out = h('div'); let page = 1;
    const manage = can(ctx, 'finance.manage');
    root.append(h('div', { class: 'card' }, h('div', { class: 'row' },
      can(ctx, 'finance.view_all') ? h('div', {}, h('label', {}, 'Статус'), status) : null,
      manage ? h('button', { class: 'btn', onclick: () => runDialog(ctx, {}, id => runModal(ctx, id, load)) }, '＋ Сформировать расчёт') : null)), out);
    status.addEventListener('change', () => { page = 1; load(); });
    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/payroll-runs', { status: can(ctx, 'finance.view_all') ? status.value : '', page, per_page: 30 });
        clear(out).appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['№', 'Исполнитель', 'Период', 'Сумма', 'Статус'].map(x => h('th', {}, x)))),
          h('tbody', {}, d.items.map(r => h('tr', { class: 'click', onclick: () => runModal(ctx, r.id, load) },
            h('td', { 'data-l': '№' }, String(r.id)), h('td', { 'data-l': 'Исполнитель' }, r.user.full_name),
            h('td', { 'data-l': 'Период' }, day(r.period_from) + ' — ' + day(r.period_to)),
            h('td', { 'data-l': 'Сумма', class: 'money right' }, money(r.total_amount)), h('td', { 'data-l': 'Статус' }, tag(r.status, RUN_ST))))))
          : h('p', { class: 'muted' }, 'Расчётов нет.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  function runDialog(ctx, pre, onCreated) {
    modal(close => {
      const sel = h('select', {}, h('option', { value: '' }, 'Загрузка…'));
      executors(ctx).then(list => { clear(sel); list.forEach(u => sel.appendChild(h('option', { value: u.id, selected: u.id === pre.user_id }, u.full_name))); }).catch(() => {});
      const from = h('input', { type: 'date' }); const to = h('input', { type: 'date' });
      const msg = h('div');
      const ok = h('button', { class: 'btn', type: 'button' }, 'Сформировать');
      ok.addEventListener('click', async () => {
        clear(msg); ok.disabled = true;
        try {
          const r = await Api.post('/payroll-runs', { user_id: Number(sel.value), period_from: from.value, period_to: to.value });
          close(); onCreated(r.id);
        } catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
      });
      return [h('h1', {}, 'Расчёт за период'), h('label', {}, 'Исполнитель'), sel,
        h('div', { class: 'row' }, h('div', {}, h('label', {}, 'С'), from), h('div', {}, h('label', {}, 'По'), to)),
        h('p', { class: 'muted' }, 'В расчёт попадут действующие работы периода, которые ещё не входят в другой расчёт. Черновик можно проверить, затем подтвердить.'),
        msg, h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
    });
  }

  async function runModal(ctx, id, onChanged) {
    let r;
    try { r = await Api.get('/payroll-runs/' + id); } catch (e) { modal(close => [errBox(e), h('button', { class: 'btn secondary', onclick: close }, 'Закрыть')]); return; }
    const t = r.totals, manage = can(ctx, 'finance.manage');
    modal(close => {
      const msg = h('div');
      const refresh = () => { close(); runModal(ctx, id, onChanged); onChanged && onChanged(); };
      const actions = h('div', { class: 'row', style: 'margin-top:1rem' });
      if (manage && r.status === 'draft') {
        const c = h('button', { class: 'btn', type: 'button' }, 'Подтвердить расчёт');
        c.addEventListener('click', async () => { c.disabled = true; try { await Api.post('/payroll-runs/' + id + '/confirm'); refresh(); } catch (e) { clear(msg).appendChild(errBox(e)); c.disabled = false; } });
        actions.appendChild(c);
      }
      if (manage && r.status === 'confirmed') {
        actions.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => { close(); paymentDialog(ctx, { user_id: r.user.id, payroll_run_id: id, amount: t.remaining }, pid => paymentModal(ctx, pid, onChanged)); } }, 'Выплата по расчёту'));
      }
      if (r.status === 'confirmed') {
        const b = h('button', { class: 'btn secondary', type: 'button' }, 'PDF расчётный лист');
        b.addEventListener('click', async () => { b.disabled = true; try { await Api.download('/export/pdf/payroll/' + id); } catch (e) { clear(msg).appendChild(errBox(e)); } b.disabled = false; });
        actions.appendChild(b);
      }
      if (manage && r.status !== 'cancelled') {
        actions.appendChild(h('button', { class: 'btn danger', type: 'button', onclick: () => reasonDialog('Отмена расчёта №' + id, 'Работы расчёта освободятся для нового расчёта. Если по расчёту есть выплаты, сначала отмените их.', 'Отменить расчёт', reason => Api.post('/payroll-runs/' + id + '/cancel', { reason }), refresh) }, 'Отменить расчёт'));
      }
      actions.appendChild(h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть'));
      return [h('h1', {}, 'Расчёт №' + id, ' ', tag(r.status, RUN_ST)),
        h('dl', { class: 'kv' }, h('dt', {}, 'Исполнитель'), h('dd', {}, r.user.full_name), h('dt', {}, 'Период'), h('dd', {}, day(r.period_from) + ' — ' + day(r.period_to)),
          h('dt', {}, 'Сумма на момент расчёта'), h('dd', { class: 'money' }, money(t.snapshot_total)),
          t.voided_total !== '0.00' ? [h('dt', {}, 'Из них аннулировано позже'), h('dd', { class: 'money' }, money(t.voided_total))] : null,
          h('dt', {}, 'Выплачено'), h('dd', { class: 'money' }, money(t.paid)), h('dt', {}, 'Осталось выплатить'), h('dd', { class: 'money' }, money(t.remaining)),
          r.confirmed_at ? [h('dt', {}, 'Подтверждён'), h('dd', {}, dt(r.confirmed_at) + (r.confirmed_by ? ' · ' + r.confirmed_by.full_name : ''))] : null),
        t.paid_on_voided_work !== '0.00' ? alert('err', 'По аннулированным работам было выплачено ' + money(t.paid_on_voided_work) + ' — см. корректировки.') : null,
        h('h2', {}, 'Работы'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Дата', 'Вид', 'Дверь', 'Кол-во', 'Цена', 'Сумма'].map(x => h('th', {}, x)))),
          h('tbody', {}, r.items.map(i => h('tr', { style: i.voided ? 'opacity:.55;text-decoration:line-through' : '' },
            h('td', {}, day(i.completed_at ? i.completed_at.slice(0, 10) : '')), h('td', {}, i.work_type_name), h('td', {}, i.door_number || '—'),
            h('td', {}, qty(i.quantity) + ' ' + i.unit), h('td', { class: 'money' }, money(i.unit_price)), h('td', { class: 'money right' }, money(i.total_amount)))))),
        msg, actions];
    });
  }

  // ------------------------------------------------------------------ выплаты

  async function paymentsTab(ctx, root) {
    const status = h('select', {}, [['', 'Все'], ['draft', 'Черновики'], ['posted', 'Проведённые'], ['cancelled', 'Отменённые']].map(([v, l]) => h('option', { value: v }, l)));
    const out = h('div'); let page = 1;
    root.append(h('div', { class: 'card' }, h('div', { class: 'row' },
      can(ctx, 'finance.view_all') ? h('div', {}, h('label', {}, 'Статус'), status) : null,
      can(ctx, 'finance.manage') ? h('button', { class: 'btn', onclick: () => paymentDialog(ctx, {}, id => paymentModal(ctx, id, load)) }, '＋ Зарегистрировать выплату') : null)), out);
    status.addEventListener('change', () => { page = 1; load(); });
    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/payments', { status: can(ctx, 'finance.view_all') ? status.value : '', page, per_page: 30 });
        clear(out).appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['№', 'Получатель', 'Дата', 'Способ', 'Сумма', 'Статус'].map(x => h('th', {}, x)))),
          h('tbody', {}, d.items.map(p => h('tr', { class: 'click', onclick: () => paymentModal(ctx, p.id, load) },
            h('td', { 'data-l': '№' }, String(p.id)), h('td', { 'data-l': 'Получатель' }, p.user.full_name), h('td', { 'data-l': 'Дата' }, dt(p.payment_date)),
            h('td', { 'data-l': 'Способ' }, p.payment_method), h('td', { 'data-l': 'Сумма', class: 'money right' }, money(p.amount)), h('td', { 'data-l': 'Статус' }, tag(p.status, PAY_ST))))))
          : h('p', { class: 'muted' }, 'Выплат нет.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  /** Создание выплаты (черновик или сразу проведённая). pre: {user_id, payroll_run_id, amount}. */
  function paymentDialog(ctx, pre, onCreated) {
    modal(close => {
      let key = uuid();
      const sel = h('select', { disabled: !!pre.user_id }, h('option', { value: '' }, 'Загрузка…'));
      const avail = h('p', { class: 'muted' });
      const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', value: pre.amount ? pre.amount.replace('.', ',') : '' });
      const method = h('input', { type: 'text', list: 'pm', value: 'Наличные' });
      const methods = h('datalist', { id: 'pm' }, ['Наличные', 'Карта', 'Перевод'].map(x => h('option', { value: x })));
      const date = h('input', { type: 'datetime-local' });
      const ref = h('input', { type: 'text', placeholder: 'Необязательно' });
      const comment = h('textarea', { placeholder: 'Комментарий (необязательно)' });
      const post = h('input', { type: 'checkbox' });
      const msg = h('div');

      async function showAvail() {
        if (!sel.value) return;
        try {
          if (pre.payroll_run_id) { avail.textContent = 'Выплата по расчёту №' + pre.payroll_run_id + '. Осталось выплатить: ' + money(pre.amount); return; }
          const f = await Api.get('/finance/users/' + sel.value);
          avail.textContent = 'Доступно к распределению (неоплаченные начисления): ' + money(f.totals.unpaid_accruals_total);
        } catch (e) { avail.textContent = ''; }
      }
      executors(ctx).then(list => {
        clear(sel);
        list.forEach(u => sel.appendChild(h('option', { value: u.id, selected: u.id === pre.user_id }, u.full_name)));
        showAvail();
      }).catch(() => {});
      sel.addEventListener('change', showAvail);

      const ok = h('button', { class: 'btn', type: 'button' }, 'Создать выплату');
      ok.addEventListener('click', async () => {
        clear(msg);
        if (toCents(amount.value) === null || toCents(amount.value) <= 0) { msg.appendChild(alert('err', 'Укажите сумму больше нуля')); return; }
        ok.disabled = true;
        const body = { user_id: Number(sel.value), amount: fromCents(toCents(amount.value)), payment_method: method.value.trim(), post: post.checked };
        if (pre.payroll_run_id) body.payroll_run_id = pre.payroll_run_id;
        if (date.value) body.payment_date = UI.localToIso(date.value);
        if (ref.value.trim()) body.reference = ref.value.trim();
        if (comment.value.trim()) body.comment = comment.value.trim();
        try {
          const p = await Api.post('/payments', body, { 'Idempotency-Key': key });
          close(); onCreated(p.id);
        } catch (e) {
          if (e.status && e.code !== 'NETWORK') key = uuid();      // при обрыве связи ключ сохраняется: повтор не создаст вторую выплату
          clear(msg).appendChild(errBox(e)); ok.disabled = false;
        }
      });
      return [h('h1', {}, 'Выплата'), h('label', {}, 'Получатель'), sel, avail,
        h('label', {}, 'Сумма, ₽'), amount,
        h('label', {}, 'Способ выплаты'), method, methods,
        h('label', {}, 'Дата выплаты (по умолчанию — сейчас)'), date,
        h('label', {}, 'Номер операции или документа'), ref, h('label', {}, 'Комментарий'), comment,
        h('label', { style: 'display:flex;gap:.6rem;align-items:center;font-weight:400' }, post, 'Провести сразу (без проверки распределения)'),
        h('p', { class: 'muted' }, 'Сумма распределяется на самые ранние неоплаченные начисления. До проведения распределение можно изменить.'),
        msg, h('div', { class: 'row', style: 'margin-top:1rem' }, ok, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
    });
  }

  async function paymentModal(ctx, id, onChanged) {
    let p;
    try { p = await Api.get('/payments/' + id); } catch (e) { modal(close => [errBox(e), h('button', { class: 'btn secondary', onclick: close }, 'Закрыть')]); return; }
    const manage = can(ctx, 'finance.manage');
    modal(close => {
      const msg = h('div');
      const refresh = () => { close(); paymentModal(ctx, id, onChanged); onChanged && onChanged(); };
      const actions = h('div', { class: 'row', style: 'margin-top:1rem' });
      if (manage && p.status === 'draft') {
        const post = h('button', { class: 'btn', type: 'button' }, 'Провести выплату');
        post.addEventListener('click', async () => { post.disabled = true; try { await Api.post('/payments/' + id + '/post'); refresh(); } catch (e) { clear(msg).appendChild(errBox(e)); post.disabled = false; } });
        actions.append(post, h('button', { class: 'btn secondary', type: 'button', onclick: () => { close(); allocationEditor(ctx, p, () => { onChanged && onChanged(); paymentModal(ctx, id, onChanged); }); } }, 'Изменить распределение'));
      }
      if (manage && p.status !== 'cancelled') {
        actions.appendChild(h('button', { class: 'btn danger', type: 'button', onclick: () => reasonDialog('Отмена выплаты №' + id,
          p.status === 'posted' ? 'Проведённая выплата не удаляется: отмена фиксируется финансовой корректировкой, остаток исполнителя восстановится.' : 'Черновик выплаты будет отменён.',
          'Отменить выплату', reason => Api.post('/payments/' + id + '/cancel', { reason }), refresh) }, 'Отменить'));
      }
      actions.appendChild(h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Закрыть'));
      return [h('h1', {}, 'Выплата №' + id, ' ', tag(p.status, PAY_ST)),
        h('dl', { class: 'kv' }, h('dt', {}, 'Получатель'), h('dd', {}, p.user.full_name), h('dt', {}, 'Сумма'), h('dd', { class: 'money' }, money(p.amount)),
          h('dt', {}, 'Способ'), h('dd', {}, p.payment_method), h('dt', {}, 'Дата выплаты'), h('dd', {}, dt(p.payment_date)),
          p.reference ? [h('dt', {}, 'Номер операции'), h('dd', {}, p.reference)] : null,
          p.payroll_run_id ? [h('dt', {}, 'Расчёт'), h('dd', {}, '№' + p.payroll_run_id)] : null,
          p.comment ? [h('dt', {}, 'Комментарий'), h('dd', {}, p.comment)] : null,
          h('dt', {}, 'Внёс'), h('dd', {}, (p.created_by.full_name || '') + ' · ' + dt(p.created_at)),
          p.posted_at ? [h('dt', {}, 'Проведена'), h('dd', {}, dt(p.posted_at))] : null),
        h('h2', {}, 'Распределение по начислениям'),
        p.allocations.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Дата работы', 'Вид', 'Дверь', 'Сумма работы', 'Зачтено'].map(x => h('th', {}, x)))),
          h('tbody', {}, p.allocations.map(a => h('tr', {}, h('td', {}, a.completed_at ? dt(a.completed_at) : '—'), h('td', {}, a.work_type_name), h('td', {}, a.door_number || '—'),
            h('td', { class: 'money right' }, money(a.work_total)), h('td', { class: 'money right' }, money(a.amount))))),
          h('tfoot', {}, h('tr', {}, h('th', { colspan: 4 }, 'Итого распределено'), h('th', { class: 'money right' }, money(p.allocated_total)))))
          : h('p', { class: 'muted' }, 'Распределения нет.'),
        msg, actions];
    });
  }

  /** Ручное распределение черновика: сумма по строкам должна равняться сумме выплаты (проверяет и сервер). */
  async function allocationEditor(ctx, p, onDone) {
    modal(close => {
      const box = h('div', {}, h('p', { class: 'muted' }, 'Загрузка начислений…'));
      const msg = h('div');
      const total = toCents(p.amount);
      Api.get('/finance/accruals', { user_id: p.user.id, payment_state: 'open', per_page: 200 }).then(d => {
        const rows = d.items.filter(a => !p.payroll_run_id || a.payroll_run_id === p.payroll_run_id);
        const cur = new Map(p.allocations.map(a => [a.work_record_id, a.amount]));
        const inputs = rows.map(a => ({ a, el: h('input', { type: 'text', inputmode: 'decimal', value: cur.has(a.work_record_id) ? cur.get(a.work_record_id).replace('.', ',') : '', style: 'min-width:90px' }) }));
        const sumEl = h('strong', {});
        const sum = () => inputs.reduce((s, i) => s + (toCents(i.el.value) || 0), 0);
        const upd = () => { const s = sum(); sumEl.textContent = 'Распределено ' + money(fromCents(s)) + ' из ' + money(p.amount) + (s === total ? ' ✓' : ' (разница ' + money(fromCents(Math.abs(total - s))) + ')'); };
        inputs.forEach(i => i.el.addEventListener('input', upd));
        clear(box).append(
          h('p', { class: 'muted' }, 'Укажите, какую часть выплаты зачесть в каждое начисление (не больше остатка).'),
          h('table', { class: 'resp' }, h('thead', {}, h('tr', {}, ['Дата', 'Вид', 'Дверь', 'Остаток', 'Зачесть'].map(x => h('th', {}, x)))),
            h('tbody', {}, inputs.map(({ a, el }) => h('tr', {}, h('td', { 'data-l': 'Дата' }, dt(a.completed_at)), h('td', { 'data-l': 'Вид' }, a.work_type.name),
              h('td', { 'data-l': 'Дверь' }, a.door_number || '—'), h('td', { 'data-l': 'Остаток', class: 'money' }, money(a.outstanding)), h('td', { 'data-l': 'Зачесть' }, el))))),
          rows.length < d.items.length || d.total > d.items.length ? h('p', { class: 'muted' }, 'Показаны не все начисления — для длинных списков используйте автоматическое распределение.') : null,
          h('p', {}, sumEl));
        upd();
        const save = h('button', { class: 'btn', type: 'button' }, 'Сохранить распределение');
        save.addEventListener('click', async () => {
          clear(msg);
          const allocations = [];
          for (const { a, el } of inputs) {
            if (el.value.trim() === '') continue;
            const c = toCents(el.value);
            if (c === null) { msg.appendChild(alert('err', 'Некорректная сумма: ' + el.value)); return; }
            if (c > 0) allocations.push({ work_record_id: a.work_record_id, amount: fromCents(c) });
          }
          if (!allocations.length) { msg.appendChild(alert('err', 'Распределите сумму хотя бы на одно начисление')); return; }
          save.disabled = true;
          try { await Api.put('/payments/' + p.id + '/allocations', { allocations }); close(); onDone(); }
          catch (e) { clear(msg).appendChild(errBox(e)); save.disabled = false; }
        });
        box.append(msg, h('div', { class: 'row' }, save, h('button', { class: 'btn secondary', type: 'button', onclick: () => { close(); onDone(); } }, 'Назад')));
      }).catch(e => { clear(box).appendChild(errBox(e)); });
      return [h('h1', {}, 'Распределение выплаты №' + p.id), box];
    });
  }

  // ------------------------------------------------------------------ корректировки (6.1, 6.4 п.7, 6.5, 11.12)

  const ADJ_TYPES = { manual: 'Ручная корректировка', overpayment: 'Переплата', payroll_correction: 'Исправление расчёта',
    void_paid_work: 'Аннулирована оплаченная работа', cancel_payment: 'Отмена выплаты' };

  async function adjustmentsTab(ctx, root) {
    const type = h('select', {}, h('option', { value: '' }, 'Все типы'), Object.entries(ADJ_TYPES).map(([v, l]) => h('option', { value: v }, l)));
    let users = [];
    if (can(ctx, 'finance.view_all')) { try { users = await executors(ctx); } catch (e) { /* фильтр необязателен */ } }
    const user = users.length ? h('select', {}, h('option', { value: '' }, 'Все исполнители'), users.map(u => h('option', { value: u.id }, u.full_name))) : null;
    const out = h('div'); let page = 1;
    root.append(h('div', { class: 'card' }, h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Тип'), type), user ? h('div', {}, h('label', {}, 'Исполнитель'), user) : null,
      can(ctx, 'finance.manage') ? h('button', { class: 'btn', onclick: () => adjustmentDialog(ctx, users, load) }, '＋ Новая корректировка') : null),
      h('p', { class: 'muted', style: 'margin-bottom:0' }, 'Плюс увеличивает долг перед исполнителем, минус уменьшает. Записи не редактируются и не удаляются: ошибка исправляется новой корректировкой с причиной.')), out);
    type.addEventListener('change', () => { page = 1; load(); });
    if (user) user.addEventListener('change', () => { page = 1; load(); });
    async function load() {
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/finance/adjustments', { type: type.value, user_id: user ? user.value : '', page, per_page: 30 });
        clear(out).appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Дата', 'Исполнитель', 'Тип', 'Сумма', 'Основание', 'Причина'].map(x => h('th', {}, x)))),
          h('tbody', {}, d.items.map(a => h('tr', {},
            h('td', { 'data-l': 'Дата' }, dt(a.created_at)), h('td', { 'data-l': 'Исполнитель' }, a.user.full_name),
            h('td', { 'data-l': 'Тип' }, ADJ_TYPES[a.type] || a.type, a.affects_balance ? null : h('span', { class: 'tag', style: 'margin-left:.4rem', title: 'Остаток уже учтён другой операцией' }, 'справочно')),
            h('td', { 'data-l': 'Сумма', class: 'money right' }, money(a.amount)),
            h('td', { 'data-l': 'Основание' }, [a.work_record_id ? 'работа №' + a.work_record_id : null, a.payment_id ? 'выплата №' + a.payment_id : null, a.payroll_run_id ? 'расчёт №' + a.payroll_run_id : null].filter(Boolean).join(', ') || '—'),
            h('td', { 'data-l': 'Причина' }, a.reason + (a.created_by.full_name ? ' — ' + a.created_by.full_name : ''))))))
          : h('p', { class: 'muted' }, 'Корректировок нет.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  /** Создание корректировки в два шага: ввод → проверка итоговой записи → запись. */
  async function adjustmentDialog(ctx, usersPre, onDone) {
    let list = usersPre;
    if (!list.length) { try { list = await executors(ctx); } catch (e) { list = []; } }
    modal(close => {
      const sel = h('select', {}, list.map(u => h('option', { value: u.id }, u.full_name)));
      const type = h('select', {}, ['manual', 'overpayment', 'payroll_correction'].map(v => h('option', { value: v }, ADJ_TYPES[v])));
      const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'например 1500 или -300,50' });
      const reason = h('textarea', { placeholder: 'Причина (обязательно, от 3 символов)' });
      const work = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Необязательно' });
      const run = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Необязательно' });
      const msg = h('div'); const summary = h('div');
      const go = h('button', { class: 'btn', type: 'button' }, 'Проверить');
      const back = h('button', { class: 'btn secondary', type: 'button' }, 'Изменить');
      back.classList.add('hidden');
      let ready = null;

      const norm = v => v.trim().replace(',', '.').replace(/^\+/, '');
      function setEditing(on) { [sel, type, amount, reason, work, run].forEach(e => { e.disabled = !on; }); back.classList.toggle('hidden', on); go.textContent = on ? 'Проверить' : 'Записать корректировку'; if (on) { ready = null; clear(summary); } }
      back.addEventListener('click', () => setEditing(true));

      go.addEventListener('click', async () => {
        clear(msg);
        if (ready === null) {
          const a = norm(amount.value);
          if (!/^-?\d+(\.\d{1,2})?$/.test(a) || /^-?0+(\.0+)?$/.test(a)) { msg.appendChild(alert('err', 'Сумма: ненулевое число со знаком, до 2 знаков после запятой')); return; }
          if (reason.value.trim().length < 3) { msg.appendChild(alert('err', 'Укажите причину (от 3 символов)')); return; }
          for (const [el, nm] of [[work, 'работы'], [run, 'расчёта']]) if (el.value.trim() !== '' && !/^\d+$/.test(el.value.trim())) { msg.appendChild(alert('err', 'Номер ' + nm + ' — целое число')); return; }
          ready = { user_id: Number(sel.value), type: type.value, amount: a, reason: reason.value.trim() };
          if (work.value.trim()) ready.work_record_id = Number(work.value.trim());
          if (run.value.trim()) ready.payroll_run_id = Number(run.value.trim());
          const neg = a.startsWith('-');
          clear(summary).appendChild(h('div', { class: 'alert ok' }, 'Будет записано: ' + sel.options[sel.selectedIndex].text + ', ' + money(a) + '. ' +
            (neg ? 'Долг перед исполнителем уменьшится.' : 'Долг перед исполнителем увеличится.') + ' Запись нельзя изменить или удалить.'));
          setEditing(false);                                       // ready сохраняется: поля заблокированы до записи
          return;
        }
        go.disabled = true;
        try { await Api.post('/finance/adjustments', ready); close(); onDone(); }
        catch (e) { clear(msg).appendChild(errBox(e)); go.disabled = false; }
      });

      return [h('h1', {}, 'Новая корректировка'), h('label', {}, 'Исполнитель'), sel, h('label', {}, 'Тип'), type,
        h('label', {}, 'Сумма, ₽ (+ увеличивает долг, − уменьшает)'), amount, h('label', {}, 'Причина'), reason,
        h('div', { class: 'row' }, h('div', {}, h('label', {}, '№ работы'), work), h('div', {}, h('label', {}, '№ расчёта'), run)),
        summary, msg, h('div', { class: 'row', style: 'margin-top:1rem' }, go, back, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
    });
  }

  w.Views.finance = finance;
})(window);
