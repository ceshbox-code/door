/*
 * Door: «Не принятые работы» для мастера.
 * Файл: public/js/my-rejected.js
 *
 * Для пользователя с правом work.register (мастер, администратор) показывает кнопку «Не принято работ: N»
 * (если есть отклонённые) или «На приёмке: M» (если есть только ожидающие). По нажатию открывается окно со списком:
 *   - вкладка «Не приняты»: причина отклонения, кто и когда отклонил, история решений и фото;
 *     если директор разрешил исправление — форма «Исправить»: количество, комментарий, новые фото;
 *     отправка идёт в POST /api/v1/work-records/{id}/resubmit, после чего работа снова ждёт приёмки;
 *   - вкладка «Ждут приёмки»: работы, отправленные директору и ещё не принятые; пока директор их не принял,
 *     мастер может изменить количество и комментарий и добавить фото (POST /work-records/{id}/edit).
 * Число обновляется без перезагрузки страницы (раз в 30 секунд, при возврате на вкладку, при появлении связи).
 * Окно не зависит от разметки приложения. Все тексты выводятся через textContent (без innerHTML).
 *
 * API: GET /auth/me, GET /work-records?review_status=..., GET /work-records/{id},
 *      POST /work-records/{id}/resubmit (исправление отклонённой), POST /work-records/{id}/edit (изменение до приёмки).
 * Сервер проверяет всё сам (владелец записи, can_fix, CSRF); скрипт только показывает и отправляет.
 * Публичный API: window.DoorRejected.open() / .refresh()
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || global.DoorRejected) { return; }

  var API = '/api/v1';
  var POLL_MS = 30000;
  var MAX_POLL_MS = 300000;
  var MAX_NEW_PHOTOS = 10;

  var S = {
    me: null,            // { id, perms[] , csrf }
    counts: { pending: 0, rejected: 0 },
    fixable: 0,
    timer: null,
    delay: POLL_MS,
    busy: false,
    panelOpen: false,
    tab: 'rejected',
    btn: null,
    overlay: null
  };

  /* ---------- вспомогательные ---------- */

  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
        var v = attrs[k];
        if (k === 'class') { el.className = v; }
        else if (k === 'text') { el.textContent = v; }
        else if (k.indexOf('on') === 0 && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
        else if (v !== null && v !== undefined && v !== false) { el.setAttribute(k, v === true ? '' : String(v)); }
      }
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) { return; }
      el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return el;
  }

  function fmtDate(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return String(iso); }
    try { return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return d.toISOString(); }
  }

  function fmtQty(q, unit) {
    var s = String(q === null || q === undefined ? '' : q);
    if (s.indexOf('.') !== -1) { s = s.replace(/0+$/, '').replace(/\.$/, ''); }   // 2.000 -> 2
    return unit ? s + ' ' + unit : s;
  }

  function errMessage(json, status) {
    if (json && json.error && json.error.message) { return json.error.message; }
    if (status === 413) { return 'Размер фото слишком велик. Уменьшите фото и повторите.'; }
    if (status === 403) { return 'Недостаточно прав или устарела страница. Обновите страницу и повторите.'; }
    if (status === 401) { return 'Сессия завершена. Войдите заново.'; }
    return 'Не удалось выполнить запрос. Проверьте связь и повторите.';
  }

  /** Запрос к API. opts.poll — фоновый запрос (не продлевает сессию на сервере). */
  function api(method, path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.poll) { headers['X-Door-Poll'] = '1'; }
    if (method !== 'GET' && S.me && S.me.csrf) { headers['X-CSRF-Token'] = S.me.csrf; }
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (opts.body) { init.body = opts.body; }
    return global.fetch(API + path, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (res.status === 401) { S.me = null; }
        if (!res.ok || !json || json.success === false) {
          var e = new Error(errMessage(json, res.status));
          e.status = res.status; e.code = json && json.error && json.error.code;
          if (e.code === 'CSRF_INVALID') { S.me = null; }     // токен устарел (например, вход другого пользователя)
          throw e;
        }
        return json.data;
      });
    });
  }

  function loadMe(poll) {
    return api('GET', '/auth/me', { poll: poll }).then(function (d) {
      var perms = (d && d.permissions) || [];
      S.me = (d && d.user && perms.indexOf('work.register') !== -1)
        ? { id: d.user.id, perms: perms, csrf: d.csrf_token || '' }
        : null;
      S.meAt = Date.now();
      return S.me;
    });
  }

  function ensureMe(poll) { return S.me ? Promise.resolve(S.me) : loadMe(!!poll); }

  /* ---------- стили ---------- */

  function ensureStyle() {
    if (doc.getElementById('door-rejected-style')) { return; }
    var css =
      ':root{--dr-bg:#fff;--dr-fg:#1f2937;--dr-muted:#6b7280;--dr-line:#e5e7eb;--dr-card:#f9fafb;' +
      '--dr-red:#d32f2f;--dr-redbg:#fdecea;--dr-ok:#2e7d32;--dr-accent:#1565c0}' +
      '@media (prefers-color-scheme:dark){:root{--dr-bg:#1b1f24;--dr-fg:#e5e7eb;--dr-muted:#9ca3af;--dr-line:#374151;' +
      '--dr-card:#242a31;--dr-redbg:#3b1f1f;--dr-accent:#64b5f6}}' +
      '.dr-btn{position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9990;' +
      'background:var(--dr-red);color:#fff;border:0;border-radius:24px;padding:12px 18px;font:600 15px system-ui,sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}' +
      '.dr-btn.info{background:var(--dr-accent)}' +
      '.dr-ov{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:stretch;justify-content:center}' +
      '.dr-pn{background:var(--dr-bg);color:var(--dr-fg);font:15px/1.4 system-ui,sans-serif;width:100%;max-width:720px;' +
      'display:flex;flex-direction:column;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px)}' +
      '.dr-hd{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dr-line)}' +
      '.dr-hd h2{flex:1;margin:0;font-size:18px}' +
      '.dr-x{background:none;border:0;color:var(--dr-fg);font-size:26px;line-height:1;cursor:pointer;padding:4px 8px}' +
      '.dr-tabs{display:flex;border-bottom:1px solid var(--dr-line)}' +
      '.dr-tab{flex:1;background:none;border:0;border-bottom:3px solid transparent;color:var(--dr-muted);padding:10px 8px;' +
      'font:600 14px system-ui,sans-serif;cursor:pointer}' +
      '.dr-tab[aria-selected=true]{color:var(--dr-fg);border-bottom-color:var(--dr-accent)}' +
      '.dr-body{flex:1;overflow:auto;padding:12px 16px;-webkit-overflow-scrolling:touch}' +
      '.dr-card{background:var(--dr-card);border:1px solid var(--dr-line);border-radius:10px;padding:12px;margin:0 0 12px}' +
      '.dr-t{font-weight:700;margin:0 0 2px}.dr-m{color:var(--dr-muted);font-size:13px}' +
      '.dr-reason{background:var(--dr-redbg);border-left:4px solid var(--dr-red);border-radius:6px;padding:8px 10px;margin:8px 0;white-space:pre-wrap;word-break:break-word}' +
      '.dr-tag{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600;margin-right:6px}' +
      '.dr-tag.fix{background:#e3f2fd;color:#0d47a1}.dr-tag.final{background:#eee;color:#444}' +
      '.dr-act{background:var(--dr-accent);color:#fff;border:0;border-radius:8px;padding:9px 14px;font:600 14px system-ui,sans-serif;cursor:pointer;margin:6px 8px 0 0}' +
      '.dr-act.sec{background:none;color:var(--dr-accent);border:1px solid var(--dr-accent)}' +
      '.dr-act[disabled]{opacity:.5;cursor:default}' +
      '.dr-form label{display:block;font-weight:600;margin:10px 0 4px}' +
      '.dr-form input[type=number],.dr-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--dr-line);border-radius:8px;' +
      'padding:8px;font:16px system-ui,sans-serif;background:var(--dr-bg);color:var(--dr-fg)}' +
      '.dr-form textarea{min-height:70px}' +
      '.dr-ph{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}' +
      '.dr-ph img{width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--dr-line)}' +
      '.dr-err{color:var(--dr-red);margin:8px 0;font-weight:600}.dr-ok{color:var(--dr-ok);font-weight:600;margin:8px 0}' +
      '.dr-hist{margin:6px 0 0;padding-left:18px;font-size:13px}' +
      '.dr-empty{color:var(--dr-muted);text-align:center;padding:32px 8px}';
    var st = h('style', { id: 'door-rejected-style' });
    st.textContent = css;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ---------- кнопка ---------- */

  function renderButton() {
    var rej = S.counts.rejected, pen = S.counts.pending;
    var show = !!S.me && (rej > 0 || pen > 0) && !S.panelOpen;
    if (!show) {
      if (S.btn && S.btn.parentNode) { S.btn.parentNode.removeChild(S.btn); }
      S.btn = null;
      return;
    }
    ensureStyle();
    var label = rej > 0 ? 'Не принято работ: ' + rej : 'На приёмке: ' + pen;
    if (!S.btn) {
      S.btn = h('button', { type: 'button', 'data-door-rejected-btn': '1', onclick: openPanel });
      doc.body.appendChild(S.btn);
    }
    var cls = 'dr-btn' + (rej > 0 ? '' : ' info');
    if (S.btn.className !== cls) { S.btn.className = cls; }
    if (S.btn.textContent !== label) { S.btn.textContent = label; }
    S.btn.setAttribute('aria-label', label + (rej > 0 && S.fixable ? ', можно исправить: ' + S.fixable : ''));
  }

  /* ---------- опрос счётчиков ---------- */

  function fetchCounts(poll) {
    return api('GET', '/work-records?review_status=rejected&user_id=' + S.me.id + '&per_page=200', { poll: poll })
      .then(function (d) {
        var c = (d && d.review_counts) || {};
        S.counts.rejected = Number(c.rejected) || 0;
        S.counts.pending = Number(c.pending) || 0;
        S.fixable = (d.items || []).filter(function (i) { return i.review && i.review.can_fix === true; }).length;
        return d;
      });
  }

  function schedule(ms) {
    if (S.timer) { global.clearTimeout(S.timer); }
    S.timer = global.setTimeout(tick, ms);
  }

  function tick() {
    S.timer = null;
    if (doc.visibilityState === 'hidden' || global.navigator.onLine === false) { schedule(S.delay); return; }
    refresh(true);
  }

  function refresh(poll) {
    if (S.busy) { return Promise.resolve(); }
    S.busy = true;
    if (S.me && Date.now() - (S.meAt || 0) > 300000) { S.me = null; }   // права и токен перечитываем раз в 5 минут
    return ensureMe(poll).then(function (me) {
      if (!me) { S.counts.rejected = 0; S.counts.pending = 0; return; }
      return fetchCounts(poll);
    }).then(function () {
      S.delay = POLL_MS;
      if (!S.panelOpen) { renderButton(); }
    }).catch(function (e) {
      if (e && e.status === 401) { S.me = null; S.counts.rejected = 0; S.counts.pending = 0; renderButton(); }
      S.delay = Math.min(MAX_POLL_MS, S.delay * 2);      // при ошибке сети оставляем последнее число
    }).then(function () {
      S.busy = false;
      schedule(S.me ? S.delay : 60000);                  // без входа/доступа проверяем реже: вход возможен без перезагрузки
    });
  }

  /* ---------- окно со списком ---------- */

  function openPanel() {
    if (S.panelOpen) { return; }
    ensureStyle();
    S.panelOpen = true;
    S.tab = S.counts.rejected > 0 ? 'rejected' : 'pending';
    renderButton();
    S.prevOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';

    var close = h('button', { type: 'button', class: 'dr-x', 'aria-label': 'Закрыть', onclick: closePanel, text: '×' });
    S.title = h('h2', { text: 'Не принятые работы' });
    S.tabs = h('div', { class: 'dr-tabs', role: 'tablist' });
    S.body = h('div', { class: 'dr-body' });
    var panel = h('div', { class: 'dr-pn', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Не принятые работы' }, [
      h('div', { class: 'dr-hd' }, [S.title, close]), S.tabs, S.body
    ]);
    S.overlay = h('div', { class: 'dr-ov', onclick: function (e) { if (e.target === S.overlay) { closePanel(); } } }, [panel]);
    doc.body.appendChild(S.overlay);
    doc.addEventListener('keydown', onKey);
    loadList();
  }

  function onKey(e) { if (e.key === 'Escape') { closePanel(); } }

  function closePanel() {
    if (!S.panelOpen) { return; }
    S.panelOpen = false;
    doc.removeEventListener('keydown', onKey);
    if (S.overlay && S.overlay.parentNode) { S.overlay.parentNode.removeChild(S.overlay); }
    S.overlay = null;
    doc.body.style.overflow = S.prevOverflow || '';
    refresh(false);
  }

  function renderTabs() {
    S.tabs.textContent = '';
    [['rejected', 'Не приняты (' + S.counts.rejected + ')'], ['pending', 'Ждут приёмки (' + S.counts.pending + ')']].forEach(function (t) {
      S.tabs.appendChild(h('button', {
        type: 'button', class: 'dr-tab', role: 'tab', 'aria-selected': S.tab === t[0] ? 'true' : 'false', text: t[1],
        onclick: function () { S.tab = t[0]; loadList(); }
      }));
    });
  }

  function loadList() {
    S.body.textContent = '';
    S.body.appendChild(h('div', { class: 'dr-empty', text: 'Загрузка…' }));
    var tab = S.tab;
    ensureMe().then(function (me) {
      if (!me) { throw new Error('Нет доступа или сессия завершена. Войдите заново.'); }
      return api('GET', '/work-records?review_status=' + tab + '&user_id=' + me.id + '&per_page=100');
    }).then(function (d) {
      if (!S.panelOpen || S.tab !== tab) { return; }
      var c = d.review_counts || {};
      S.counts.rejected = Number(c.rejected) || 0;
      S.counts.pending = Number(c.pending) || 0;
      renderTabs();
      S.body.textContent = '';
      if (!d.items.length) {
        S.body.appendChild(h('div', { class: 'dr-empty', text: tab === 'rejected' ? 'Не принятых работ нет.' : 'Работ, ожидающих приёмки, нет.' }));
        return;
      }
      d.items.forEach(function (it) { S.body.appendChild(tab === 'rejected' ? rejectedCard(it) : pendingCard(it)); });
    }).catch(function (e) {
      if (!S.panelOpen) { return; }
      S.body.textContent = '';
      S.body.appendChild(h('div', { class: 'dr-err', text: e.message }));
    });
  }

  function head(it) {
    var door = it.door ? 'Дверь ' + it.door.number : 'Без двери';
    return [
      h('div', { class: 'dr-t', text: it.work_type.name + ' — ' + door }),
      h('div', { class: 'dr-m', text: fmtQty(it.quantity, it.unit) + ' · выполнено ' + fmtDate(it.completed_at) })
    ];
  }

  function pendingCard(it) {
    var card = h('div', { class: 'dr-card' }, head(it).concat([
      h('div', { class: 'dr-m', text: 'Отправлено директору, решения пока нет. Пока работа не принята, её можно изменить.' + (it.review.resubmit_count ? ' Исправлений: ' + it.review.resubmit_count + '.' : '') })
    ]));
    var area = h('div');
    var actions = h('div');
    actions.appendChild(h('button', { type: 'button', class: 'dr-act', text: 'Изменить', onclick: function () { showForm(it, area, 'edit'); } }));
    actions.appendChild(h('button', { type: 'button', class: 'dr-act sec', text: 'История и фото', onclick: function (ev) { showHistory(it, area, ev.currentTarget); } }));
    card.appendChild(actions);
    card.appendChild(area);
    return card;
  }

  function rejectedCard(it) {
    var r = it.review;
    var by = r.reviewed_by ? r.reviewed_by.full_name : 'директор';
    var card = h('div', { class: 'dr-card' }, head(it));
    card.appendChild(h('div', {}, [
      h('span', { class: 'dr-tag ' + (r.can_fix ? 'fix' : 'final'), text: r.can_fix ? 'Можно исправить' : 'Исправление не разрешено' }),
      h('span', { class: 'dr-m', text: 'Отклонено: ' + by + ', ' + fmtDate(r.reviewed_at) })
    ]));
    card.appendChild(h('div', { class: 'dr-reason', text: r.reject_reason || 'Причина не указана' }));
    var area = h('div');
    var actions = h('div');
    if (r.can_fix) {
      actions.appendChild(h('button', { type: 'button', class: 'dr-act', text: 'Исправить и отправить', onclick: function () { showForm(it, area, 'resubmit'); } }));
    } else {
      area.appendChild(h('div', { class: 'dr-m', text: 'Директор не разрешил исправление. Зарегистрируйте работу заново.' }));
    }
    actions.appendChild(h('button', { type: 'button', class: 'dr-act sec', text: 'История и фото', onclick: function (ev) { showHistory(it, area, ev.currentTarget); } }));
    card.appendChild(actions);
    card.appendChild(area);
    return card;
  }

  function showHistory(it, area, btn) {
    if (area.__hist) { area.removeChild(area.__hist); area.__hist = null; btn.textContent = 'История и фото'; return; }
    btn.disabled = true;
    api('GET', '/work-records/' + it.id).then(function (d) {
      var box = h('div');
      if (d.photos && d.photos.length) {
        var shots = d.photos.map(function (p) { return { src: p.url, fallback: p.original_url, alt: 'Фото работы' }; });
        box.appendChild(h('div', { class: 'dr-ph' }, d.photos.map(function (p, idx) {
          // Просмотр в модальном окне; ссылка остаётся запасным вариантом, если UI.photoViewer недоступен
          return h('a', { href: p.url, target: '_blank', rel: 'noopener', 'aria-label': 'Открыть фото ' + (idx + 1), onclick: function (e) {
            if (global.UI && typeof global.UI.photoViewer === 'function') { e.preventDefault(); global.UI.photoViewer(shots, idx); }
          } }, [h('img', { src: p.url, alt: 'Фото работы', loading: 'lazy' })]);
        })));
      }
      var names = { accepted: 'принята', rejected: 'отклонена', resubmitted: 'отправлена после исправления' };
      var ul = h('ul', { class: 'dr-hist' }, (d.reviews || []).map(function (rv) {
        return h('li', { text: fmtDate(rv.created_at) + ' — ' + (names[rv.action] || rv.action) + ' (' + (rv.actor && rv.actor.full_name || '') + ')' + (rv.reason ? ': ' + rv.reason : '') });
      }));
      box.appendChild(ul);
      area.__hist = box; area.appendChild(box); btn.textContent = 'Скрыть историю';
    }).catch(function (e) { area.appendChild(h('div', { class: 'dr-err', text: e.message })); })
      .then(function () { btn.disabled = false; });
  }

  /* ---------- форма исправления ---------- */

  function showForm(it, area, mode) {
    var isEdit = mode === 'edit';
    if (area.__form) { return; }
    var qty = h('input', { type: 'number', inputmode: 'decimal', step: '0.001', min: '0.001', max: '99999.999', value: String(it.quantity).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') });
    var comment = h('textarea', { maxlength: '2000' });
    comment.value = it.comment || '';
    var files = h('input', { type: 'file', accept: 'image/*', multiple: true });
    var previews = h('div', { class: 'dr-ph' });
    var msg = h('div');
    var send = h('button', { type: 'button', class: 'dr-act', text: isEdit ? 'Сохранить изменения' : 'Отправить на приёмку' });
    var cancel = h('button', { type: 'button', class: 'dr-act sec', text: 'Отмена', onclick: function () { area.removeChild(form); area.__form = null; } });

    files.addEventListener('change', function () {
      previews.textContent = '';
      Array.prototype.slice.call(files.files || []).slice(0, MAX_NEW_PHOTOS).forEach(function (f) {
        var url = global.URL && URL.createObjectURL ? URL.createObjectURL(f) : '';
        if (url) {
          var img = h('img', { src: url, alt: 'Новое фото' });
          img.onload = function () { URL.revokeObjectURL(url); };
          previews.appendChild(img);
        }
      });
    });

    send.addEventListener('click', function () {
      msg.textContent = '';
      var list = Array.prototype.slice.call(files.files || []);
      if (list.length > MAX_NEW_PHOTOS) { msg.appendChild(h('div', { class: 'dr-err', text: 'Не более ' + MAX_NEW_PHOTOS + ' фото за раз' })); return; }
      var q = String(qty.value).trim();
      var changedQty = q !== '' && Number(q) !== Number(it.quantity);
      var changedComment = comment.value.trim() !== String(it.comment || '').trim();
      if (!list.length && !changedQty && !changedComment) {
        msg.appendChild(h('div', { class: 'dr-err', text: 'Добавьте новое фото, измените количество или комментарий.' }));
        return;
      }
      send.disabled = true; cancel.disabled = true;
      msg.appendChild(h('div', { class: 'dr-m', text: list.length ? 'Подготовка и отправка фото…' : 'Сохранение…' }));

      var prepared = Promise.all(list.map(function (f) { return global.DoorPhoto ? global.DoorPhoto.compress(f) : f; }));
      prepared.then(function (fs) {
        var fd = new global.FormData();
        if (changedQty) { fd.append('quantity', q); }
        if (changedComment) { fd.append('comment', comment.value.trim()); }
        fs.forEach(function (f) { fd.append('photos[]', f, f.name || 'photo.jpg'); });
        return ensureMe().then(function () { return api('POST', '/work-records/' + it.id + (isEdit ? '/edit' : '/resubmit'), { body: fd }); });
      }).then(function () {
        if (!isEdit) {
          S.counts.rejected = Math.max(0, S.counts.rejected - 1);
          S.counts.pending += 1;
        }
        form.textContent = '';
        form.appendChild(h('div', { class: 'dr-ok', text: isEdit ? 'Изменения сохранены. Работа остаётся на приёмке.' : 'Отправлено директору на повторную приёмку.' }));
        global.setTimeout(function () { if (S.panelOpen) { loadList(); } }, 1200);
      }).catch(function (e) {
        msg.textContent = '';
        msg.appendChild(h('div', { class: 'dr-err', text: e.message }));
        send.disabled = false; cancel.disabled = false;
      });
    });

    var form = h('div', { class: 'dr-form' }, [
      h('label', { text: 'Количество' + (it.unit ? ' (' + it.unit + ')' : '') }), qty,
      h('label', { text: 'Комментарий' }), comment,
      h('label', { text: isEdit ? 'Добавить фото' : 'Новые фото исправленной работы' }), files, previews,
      msg, send, cancel
    ]);
    area.__form = form;
    area.appendChild(form);
  }

  /* ---------- запуск ---------- */

  function start() {
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') { S.delay = POLL_MS; refresh(true); } });
    global.addEventListener('online', function () { S.delay = POLL_MS; refresh(true); });
    refresh(true);
  }

  global.DoorRejected = { open: openPanel, refresh: function () { S.delay = POLL_MS; return refresh(false); } };

  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', start); } else { start(); }
})(window);
