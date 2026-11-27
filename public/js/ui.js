'use strict';
/* Мелкие помощники интерфейса. Весь вывод данных — через textContent (защита от XSS), innerHTML не используется. */
(function (w) {
  const TZ = 'Europe/Kaliningrad';      // часовой пояс предприятия (совпадает с APP_TIMEZONE по умолчанию)

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  /** Деньги приходят строкой DECIMAL — форматируем без перевода во float. */
  function money(s) {
    if (s === null || s === undefined || s === '') return '—';
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(s));
    if (!m) return String(s);
    const int = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return (m[1] ? '−' : '') + int + ',' + ((m[3] || '') + '00').slice(0, 2) + '\u00a0₽';
  }
  function qty(s) {
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(String(s ?? ''));
    if (!m) return String(s ?? '');
    const frac = (m[2] || '').replace(/0+$/, '');
    return m[1] + (frac ? ',' + frac : '');
  }
  function dt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  function day(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : (s || '—'); }

  function alert(kind, text) { return h('div', { class: 'alert ' + (kind === 'ok' ? 'ok' : 'err'), role: 'alert' }, text); }
  function errBox(e) { return alert('err', e && e.full ? e.full() : (e && e.message) || 'Ошибка'); }

  function modal(content) {
    const close = () => { m.remove(); document.removeEventListener('keydown', esc); };
    const esc = ev => { if (ev.key === 'Escape') close(); };
    const m = h('div', { class: 'modal', onclick: ev => { if (ev.target === m) close(); } },
      h('div', { class: 'sheet', role: 'dialog' }, content(close)));
    document.addEventListener('keydown', esc);
    document.body.appendChild(m);
    return close;
  }

  /** Просмотр фотографий в модальном окне поверх приложения (без перехода на другую страницу).
   *  photos: [{ src, fallback?, alt? }]; start — номер фото. Закрытие: кнопка «Закрыть», Esc, клик по фону.
   *  Стрелки на клавиатуре и свайп листают фото. Возвращает функцию закрытия. */
  function photoViewer(photos, start) {
    const list = (photos || []).filter(p => p && p.src);
    if (!list.length) return () => {};
    let i = Math.min(Math.max(start || 0, 0), list.length - 1);
    const opener = document.activeElement;
    const many = list.length > 1;

    const img = h('img', { class: 'pv-img', alt: '' });
    const status = h('div', { class: 'pv-status', role: 'status' });
    const count = h('div', { class: 'pv-count' });
    const closeBtn = h('button', { type: 'button', class: 'pv-btn pv-close', 'aria-label': 'Закрыть просмотр фото', onclick: () => close() }, '✕ Закрыть');
    const prevBtn = many ? h('button', { type: 'button', class: 'pv-btn pv-nav pv-prev', 'aria-label': 'Предыдущее фото', onclick: () => go(-1) }, '‹') : null;
    const nextBtn = many ? h('button', { type: 'button', class: 'pv-btn pv-nav pv-next', 'aria-label': 'Следующее фото', onclick: () => go(1) }, '›') : null;
    const stage = h('div', { class: 'pv-stage' }, img, status);
    const box = h('div', { class: 'pv', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр фото',
      onclick: ev => { if (ev.target === box || ev.target === stage) close(); } },
      stage, count, closeBtn, prevBtn, nextBtn);

    function show() {
      const p = list[i];
      let triedFallback = false;
      status.textContent = 'Загрузка…';
      status.classList.remove('pv-err');
      img.classList.add('pv-loading');
      img.alt = p.alt || 'Фото';
      img.onload = () => { status.textContent = ''; img.classList.remove('pv-loading'); };
      img.onerror = () => {
        if (p.fallback && !triedFallback && img.getAttribute('src') !== p.fallback) { triedFallback = true; img.src = p.fallback; return; }
        img.classList.add('pv-loading');
        status.textContent = 'Не удалось загрузить фото';
        status.classList.add('pv-err');
      };
      img.src = p.src;
      count.textContent = many ? (i + 1) + ' / ' + list.length : '';
    }
    function go(d) { if (!many) return; i = (i + d + list.length) % list.length; show(); }

    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); return; }   // не закрываем окно под фото
      if (ev.key === 'ArrowLeft') { ev.stopPropagation(); go(-1); return; }
      if (ev.key === 'ArrowRight') { ev.stopPropagation(); go(1); return; }
      if (ev.key === 'Tab') {                                                                       // фокус остаётся внутри просмотрщика
        const f = [closeBtn, prevBtn, nextBtn].filter(Boolean);
        const at = f.indexOf(document.activeElement);
        ev.preventDefault();
        f[(at + (ev.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    }
    let x0 = null, y0 = 0;
    stage.addEventListener('touchstart', ev => { if (ev.touches.length === 1) { x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; } else x0 = null; }, { passive: true });
    stage.addEventListener('touchend', ev => {
      if (x0 === null || !ev.changedTouches.length) return;
      const dx = ev.changedTouches[0].clientX - x0, dy = ev.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    }, { passive: true });

    function close() {
      window.removeEventListener('keydown', onKey, true);
      box.remove();
      if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus(); } catch (e) { /* не критично */ } }
    }
    window.addEventListener('keydown', onKey, true);   // capture на window: срабатывает раньше обработчиков Esc у окон под фото
    document.body.appendChild(box);
    show();
    closeBtn.focus();
    return close;
  }

  function pager(page, per, total, go) {
    const pages = Math.max(1, Math.ceil(total / per));
    if (pages <= 1) return h('div');
    return h('div', { class: 'pager' },
      h('button', { class: 'btn secondary', disabled: page <= 1, onclick: () => go(page - 1) }, '← Назад'),
      h('span', { class: 'muted' }, page + ' / ' + pages + ' (всего ' + total + ')'),
      h('button', { class: 'btn secondary', disabled: page >= pages, onclick: () => go(page + 1) }, 'Далее →'));
  }

  function uuid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  const PERIODS = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['this_week', 'Текущая неделя'], ['prev_week', 'Предыдущая неделя'],
    ['this_month', 'Текущий месяц'], ['prev_month', 'Предыдущий месяц'], ['custom', 'Произвольные даты'], ['all', 'За всё время']];

  /** Блок выбора периода. get() -> query-параметры {period} | {date_from,date_to} | {}. */
  function periodPicker(initial, onChange) {
    const sel = h('select', { 'aria-label': 'Период' }, PERIODS.map(([v, l]) => h('option', { value: v, selected: v === initial }, l)));
    const from = h('input', { type: 'date', 'aria-label': 'С даты' });
    const to = h('input', { type: 'date', 'aria-label': 'По дату' });
    const dates = h('div', { class: 'row hidden' }, h('div', {}, h('label', {}, 'С'), from), h('div', {}, h('label', {}, 'По'), to));
    const sync = () => dates.classList.toggle('hidden', sel.value !== 'custom');
    sel.addEventListener('change', () => { sync(); if (sel.value !== 'custom') onChange && onChange(); });
    from.addEventListener('change', () => onChange && onChange());
    to.addEventListener('change', () => onChange && onChange());
    sync();
    return {
      el: h('div', {}, sel, dates),
      get() {
        if (sel.value === 'all') return {};
        if (sel.value === 'custom') return { date_from: from.value, date_to: to.value };
        return { period: sel.value };
      },
    };
  }

  /** 'YYYY-MM-DDTHH:mm' (время предприятия) -> ISO 8601 со смещением, как требует API. */
  function localToIso(local) {
    if (!local) return null;
    let off = '+02:00';
    try {
      const v = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(local + ':00Z'))
        .find(p => p.type === 'timeZoneName').value;                    // GMT+02:00 | GMT+2 | GMT
      const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(v);
      if (m) off = m[1] + m[2].padStart(2, '0') + ':' + (m[3] || '00'); else if (v === 'GMT') off = '+00:00';
    } catch (e) { /* остаётся значение по умолчанию */ }
    return local + ':00' + off;
  }

  w.UI = { TZ, localToIso, h, add, clear, money, qty, dt, day, alert, errBox, modal, photoViewer, pager, uuid, periodPicker, PERIODS };
})(window);
