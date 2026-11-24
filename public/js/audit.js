'use strict';
/* Журнал действий (ТЗ 11.11, 13.1.12). Только чтение; доступ — администратор (право audit.view, проверяется на сервере). */
(function (w) {
  const { h, clear, dt, errBox, modal, pager, periodPicker } = UI;

  const ACTIONS = {
    'auth.login': 'Вход в систему', 'auth.logout': 'Выход', 'auth.login_failed': 'Неудачная попытка входа', 'auth.login_blocked': 'Вход заблокирован (лимит попыток)', 'auth.captcha_failed': 'Неверная капча при входе',
    'auth.webauthn_register': 'Включён вход по биометрии', 'auth.webauthn_register_failed': 'Не удалось включить биометрию', 'auth.webauthn_revoke': 'Отключён вход по биометрии', 'access.denied': 'Отказ в доступе',
    'door.create': 'Создана дверь', 'work_record.create': 'Зарегистрирована работа', 'work_record.void': 'Аннулирована работа',
    'photo.upload': 'Загружено фото', 'photo.delete': 'Удалено фото',
    'work_type.create': 'Создан вид работы', 'work_type.update': 'Изменён вид работы', 'work_type.activate': 'Включён вид работы', 'work_type.deactivate': 'Отключён вид работы',
    'rate.create': 'Назначена расценка', 'rate.close': 'Завершена расценка',
    'payroll_run.create': 'Создан расчёт', 'payroll_run.confirm': 'Подтверждён расчёт', 'payroll_run.cancel': 'Отменён расчёт',
    'payment.create': 'Создана выплата', 'payment.allocations_update': 'Изменено распределение выплаты', 'payment.post': 'Проведена выплата', 'payment.cancel': 'Отменена выплата',
    'adjustment.create': 'Финансовая корректировка',
    'user.create': 'Создан пользователь', 'user.update': 'Изменён пользователь', 'user.activate': 'Включён пользователь', 'user.deactivate': 'Отключён пользователь',
    'report.export': 'Экспорт отчёта',
  };
  const ENTITIES = { user: 'пользователь', door: 'дверь', work_record: 'работа', work_type: 'вид работы', rate: 'расценка', payroll_run: 'расчёт',
    payment: 'выплата', financial_adjustment: 'корректировка', photo: 'фото' };

  const actionName = a => ACTIONS[a] || a;
  const objName = r => r.entity_id === null ? (ENTITIES[r.entity_type] || r.entity_type) : (ENTITIES[r.entity_type] || r.entity_type) + ' №' + r.entity_id;

  function valueText(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'да' : 'нет';
    return String(v);
  }
  function valuesBlock(title, obj) {
    if (!obj || !Object.keys(obj).length) return null;
    return [h('h2', {}, title), h('dl', { class: 'kv' }, Object.entries(obj).map(([k, v]) => [h('dt', {}, k), h('dd', { style: 'word-break:break-word' }, valueText(v))]))];
  }

  function detail(r) {
    modal(close => [
      h('h1', {}, actionName(r.action)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Время'), h('dd', {}, dt(r.created_at)),
        h('dt', {}, 'Пользователь'), h('dd', {}, r.user ? (r.user.full_name || '№' + r.user.id) : 'не авторизован / система'),
        h('dt', {}, 'Объект'), h('dd', {}, objName(r)),
        h('dt', {}, 'IP-адрес'), h('dd', {}, r.ip_address || '—'),
        r.reason ? [h('dt', {}, 'Причина'), h('dd', {}, r.reason)] : null,
        h('dt', {}, 'Код действия'), h('dd', {}, r.action)),
      valuesBlock('Было', r.old_values), valuesBlock('Стало', r.new_values),
      h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn secondary', onclick: close }, 'Закрыть'))]);
  }

  async function audit(ctx, root) {
    root.appendChild(h('h1', {}, 'Журнал действий'));
    let users = [];
    try { users = (await Api.get('/users', { per_page: 200 })).items; } catch (e) { /* фильтр по пользователю необязателен */ }
    const picker = periodPicker('this_month', () => reset());
    const action = h('select', {}, h('option', { value: '' }, 'Все действия'), Object.entries(ACTIONS).map(([v, l]) => h('option', { value: v }, l)));
    const user = h('select', {}, h('option', { value: '' }, 'Все пользователи'), users.map(u => h('option', { value: u.id }, u.full_name)));
    const out = h('div'); let page = 1;
    root.append(h('div', { class: 'card' }, h('label', {}, 'Период'), picker.el,
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Действие'), action), h('div', {}, h('label', {}, 'Пользователь'), user)),
      h('p', { class: 'muted', style: 'margin-bottom:0' }, 'Журнал только для чтения: записи нельзя изменить или удалить через интерфейс.')), out);
    action.addEventListener('change', () => reset()); user.addEventListener('change', () => reset());

    function dates() { const q = picker.get(); return q.period ? Views.presetToDates(q.period) : q; }
    function reset() { page = 1; load(); }
    async function load() {
      const d0 = dates();
      if ((d0.date_from === '') !== (d0.date_to === '') && (d0.date_from !== undefined)) return;     // ждём обе даты
      clear(out).appendChild(h('p', { class: 'muted' }, 'Загрузка…'));
      try {
        const d = await Api.get('/audit-log', { ...d0, action: action.value, user_id: user.value, page, per_page: 50 });
        clear(out).appendChild(d.items.length ? h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Время', 'Пользователь', 'Действие', 'Объект', 'IP'].map(x => h('th', {}, x)))),
          h('tbody', {}, d.items.map(r => h('tr', { class: 'click', onclick: () => detail(r) },
            h('td', { 'data-l': 'Время' }, dt(r.created_at)),
            h('td', { 'data-l': 'Пользователь' }, r.user ? (r.user.full_name || '№' + r.user.id) : '—'),
            h('td', { 'data-l': 'Действие' }, actionName(r.action)),
            h('td', { 'data-l': 'Объект' }, objName(r)),
            h('td', { 'data-l': 'IP' }, r.ip_address || '—')))))
          : h('p', { class: 'muted' }, 'Записей не найдено.'));
        out.appendChild(pager(d.page, d.per_page, d.total, p => { page = p; load(); window.scrollTo(0, 0); }));
      } catch (e) { clear(out).appendChild(errBox(e)); }
    }
    load();
  }

  w.Views.audit = audit;
})(window);
