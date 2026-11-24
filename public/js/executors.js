'use strict';
/* Исполнители (ТЗ 7.3, 13.1.5): сводка по периоду и карточка исполнителя. Только просмотр; данные из /stats и /finance. */
(function (w) {
  const { h, clear, money, qty, dt, errBox, pager, periodPicker } = UI;
  const can = (ctx, p) => ctx.permissions.includes(p);
  const stat = (l, v, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
  const datesOf = picker => { const q = picker.get(); return q.period ? Views.presetToDates(q.period) : q; };
  const bad = d => (d.date_from === '') !== (d.date_to === '') && d.date_from !== undefined;     // выбрана только одна из двух дат

  /** Остаток на конец периода; переплата показывается отдельно, а не скрывается (ТЗ 6.2). */
  function restCell(r) {
    if (r.overpayment && /[1-9]/.test(r.overpayment)) return h('span', { class: 'tag void' }, 'переплата ' + money(r.overpayment));
    return money(r.debt);
  }

  async function executors(ctx, root, param) {
    if (param) return card(ctx, root, Number(param));
    root.appendChild(h('h1', {}, 'Исполнители'));
    const picker = periodPicker('this_month', () => load());
    const out = h('div');
    root.append(h('div', { class: 'card' }, h('label', {}, 'Период'), picker.el), out);
    async function load() {
      const d0 = datesOf(picker); if (bad(d0)) return;
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/stats/users', d0);
        clear(out);
        const row = r => h('tr', { class: 'click', onclick: () => { location.hash = '#/executors/' + r.user.id; } },
          h('td', { 'data-l': 'Исполнитель' }, r.user.full_name, r.user.is_active ? null : h('span', { class: 'tag void', style: 'margin-left:.4rem' }, 'отключён')),
          h('td', { 'data-l': 'Работ' }, String(r.works_count)),
          h('td', { 'data-l': 'Дверей' }, String(r.doors_count)),
          h('td', { 'data-l': 'Начислено', class: 'money right' }, money(r.accrued)),
          h('td', { 'data-l': 'Выплачено', class: 'money right' }, money(r.paid)),
          h('td', { 'data-l': 'Остаток', class: 'money right' }, restCell(r)));
        const total = h('tr', {},
          h('th', {}, 'Итого'), h('th', {}, String(d.totals.works_count)), h('th', {}),
          h('th', { class: 'money right' }, money(d.totals.accrued)), h('th', { class: 'money right' }, money(d.totals.paid)), h('th', {}));
        const head = h('tr', {}, ['Исполнитель', 'Работ', 'Дверей', 'Начислено', 'Выплачено', 'Остаток'].map(x => h('th', {}, x)));
        out.appendChild(d.items.length
          ? h('table', { class: 'resp' }, h('thead', {}, head), h('tbody', {}, d.items.map(row)), h('tfoot', {}, total))
          : h('p', { class: 'muted' }, 'За выбранный период работ нет.'));
        out.appendChild(h('p', { class: 'muted' }, 'Остаток показан на конец периода и включает начальные остатки и корректировки.'));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  async function card(ctx, root, uid) {
    root.appendChild(h('p', {}, h('a', { href: '#/executors' }, '← К исполнителям')));
    const head = h('div'), periodBox = h('div'), recent = h('div'), ratesBox = h('div');
    root.append(head, periodBox, recent, ratesBox);

    // Итоги за всё время (нужны право просмотра финансов)
    let fin;
    try { fin = await Api.get('/finance/users/' + uid); } catch (e) { head.appendChild(errBox(e)); return; }
    const t = fin.totals;
    head.append(h('h1', {}, fin.user.full_name),
      h('div', { class: 'grid' }, stat('Начислено за всё время', money(t.accrued)), stat('Выплачено', money(t.paid)),
        t.overpayment !== '0.00' ? stat('Переплата', money(t.overpayment), 'over') : stat('Остаток к выплате', money(t.debt), 'debt'), stat('Работ', String(t.works_count))),
      h('p', {}, h('a', { class: 'btn secondary', href: '#/finance/user/' + uid }, 'Финансы, расчёты и выплаты →')));

    // Статистика за период по видам работ
    const picker = periodPicker('this_month', () => loadPeriod());
    periodBox.append(h('h2', {}, 'Работы за период'), h('div', { class: 'card' }, picker.el));
    const pOut = h('div'); periodBox.appendChild(pOut);
    async function loadPeriod() {
      const d0 = datesOf(picker); if (bad(d0)) return;
      clear(pOut).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/stats/users', { ...d0, user_id: uid });
        const u = d.items[0];
        clear(pOut);
        if (!u) { pOut.appendChild(h('p', { class: 'muted' }, 'За выбранный период работ нет.')); return; }
        pOut.appendChild(h('div', { class: 'grid' }, stat('Работ', String(u.works_count)), stat('Дверей', String(u.doors_count)), stat('Начислено', money(u.accrued)), stat('Выплачено', money(u.paid))));
        pOut.appendChild(h('table', { class: 'resp', style: 'margin-top:1rem' },
          h('thead', {}, h('tr', {}, ['Вид работы', 'Работ', 'Количество', 'Начислено'].map(x => h('th', {}, x)))),
          h('tbody', {}, u.by_work_type.map(r => h('tr', {}, h('td', { 'data-l': 'Вид' }, r.name), h('td', { 'data-l': 'Работ' }, String(r.works_count)),
            h('td', { 'data-l': 'Кол-во' }, qty(r.quantity) + ' ' + r.unit), h('td', { 'data-l': 'Начислено', class: 'money right' }, money(r.amount)))))));
      } catch (e) { clear(pOut).appendChild(errBox(e)); }
    }
    loadPeriod();

    // Последние работы
    recent.appendChild(h('h2', {}, 'Последние работы'));
    try {
      const d = await Api.get('/work-records', { user_id: uid, per_page: 10 });
      recent.appendChild(d.items.length ? Views.worksTable(ctx, d.items, () => route()) : h('p', { class: 'muted' }, 'Работ ещё нет.'));
    } catch (e) { recent.appendChild(errBox(e)); }

    // Действующие расценки — только тем, у кого есть право на управление расценками
    if (can(ctx, 'rates.view')) {
      ratesBox.appendChild(h('h2', {}, 'Действующие расценки'));
      try {
        const [rt, ty] = await Promise.all([Api.get('/rates', { user_id: uid, current: 1, per_page: 200 }), Api.get('/work-types', { per_page: 200 })]);
        const names = new Map(ty.items.map(x => [x.id, x]));
        ratesBox.appendChild(rt.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Вид работы', 'Расценка', 'Действует с'].map(x => h('th', {}, x)))),
          h('tbody', {}, rt.items.map(r => { const wt = names.get(r.work_type_id); return h('tr', {},
            h('td', { 'data-l': 'Вид' }, wt ? wt.name : '№' + r.work_type_id), h('td', { 'data-l': 'Расценка', class: 'money' }, money(r.unit_price) + (wt ? ' за ' + wt.unit : '')), h('td', { 'data-l': 'С' }, dt(r.valid_from))); })))
          : h('p', { class: 'muted' }, 'Расценок нет — исполнитель не сможет регистрировать работы.'));
        ratesBox.appendChild(h('p', {}, h('a', { href: '#/rates' }, can(ctx, 'rates.manage') ? 'Изменить расценки →' : 'Все расценки →')));
      } catch (e) { ratesBox.appendChild(errBox(e)); }
    }
  }

  w.Views.executors = executors;
})(window);
