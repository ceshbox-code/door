/*
 * Door: значок с числом работ, ожидающих приёмки, у пункта меню «Приёмка работ» (директор).
 * Файл: public/js/review-badge.js
 *
 * - Ищет в меню ссылку/кнопку с текстом «Приёмка работ» (меню строится динамически —
 *   за появлением и перерисовкой следит MutationObserver) и добавляет справа значок.
 * - Число берётся из GET /api/v1/work-records/pending-count (только право work.review).
 * - Обновляется без перезагрузки страницы: раз в 30 секунд, сразу при возврате на вкладку,
 *   при появлении связи и после действий приёмки в этом же окне (accept/reject/void/resubmit).
 * - Скрыт при 0; больше 99 показывается как «99+». При ошибке сети остаётся последнее число.
 * - Фоновый опрос отправляет заголовок X-Door-Poll: 1: сервер не продлевает им сессию.
 * - Публичный API: window.DoorReviewBadge.refresh()
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || global.DoorReviewBadge) { return; }

  var LABEL_RE = /^при[её]мка работ/i;
  var ENDPOINT = '/api/v1/work-records/pending-count';
  var ACTION_RE = /\/api\/v1\/work-records(\/\d+\/(accept|reject|resubmit|void))?\/?$/;
  var INTERVAL_MS = 30000;
  var MAX_INTERVAL_MS = 300000;
  var TIMEOUT_MS = 10000;

  var state = {
    count: null,        // последнее известное число (null — ещё не получено)
    timer: null,
    delay: INTERVAL_MS,
    inFlight: false,
    stopped: false,     // 403: у пользователя нет права, опрос не нужен
    pausedAuth: false,  // 401: ждём нового входа
    itemSeen: false     // пункт меню «Приёмка работ» сейчас присутствует на странице
  };

  /* ---------- чистые функции (проверяются тестом) ---------- */

  function formatCount(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) { return ''; }
    n = Math.floor(n);
    return n > 99 ? '99+' : String(n);
  }

  function matchesLabel(text) {
    return LABEL_RE.test(String(text || '').replace(/\s+/g, ' ').trim());
  }

  /* ---------- поиск пункта меню и значок ---------- */

  function findMenuItem() {
    var nodes = doc.querySelectorAll('a, button, [role="menuitem"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!/при[её]мка/i.test(el.textContent || '')) { continue; }   // быстрый предфильтр
      // текст без значка, чтобы число не мешало сопоставлению
      var clone = el.cloneNode(true);
      var old = clone.querySelectorAll('[data-door-review-badge]');
      for (var j = 0; j < old.length; j++) { old[j].parentNode.removeChild(old[j]); }
      if (matchesLabel(clone.textContent)) { return el; }
    }
    return null;
  }

  function ensureStyle() {
    if (doc.getElementById('door-review-badge-style')) { return; }
    var st = doc.createElement('style');
    st.id = 'door-review-badge-style';
    st.textContent =
      '.door-review-badge{display:inline-flex;align-items:center;justify-content:center;' +
      'box-sizing:border-box;min-width:20px;height:20px;padding:0 6px;margin-left:8px;' +
      'border-radius:10px;background:#d32f2f;color:#fff;font:700 12px/20px system-ui,sans-serif;' +
      'vertical-align:middle;white-space:nowrap}' +
      '.door-review-badge[hidden]{display:none}';
    (doc.head || doc.documentElement).appendChild(st);
  }

  function getBadge(item, create) {
    var b = item.querySelector('[data-door-review-badge]');
    if (b || !create) { return b; }
    ensureStyle();
    b = doc.createElement('span');
    b.className = 'door-review-badge';
    b.setAttribute('data-door-review-badge', '1');
    b.hidden = true;
    var display = '';
    try { display = global.getComputedStyle(item).display; } catch (e) { /* ignore */ }
    if (display.indexOf('flex') !== -1) { b.style.marginLeft = 'auto'; }  // прижать вправо
    else { b.style.float = 'right'; }
    item.appendChild(b);
    return b;
  }

  function render() {
    var item = findMenuItem();
    if (!item) { return false; }
    var badge = getBadge(item, true);
    var text = formatCount(state.count);
    // DOM меняем только при изменении значения, иначе наблюдатель за DOM будет срабатывать бесконечно
    if (text === '') {
      if (badge.textContent !== '') { badge.textContent = ''; }
      badge.hidden = true;
      badge.removeAttribute('aria-label');
      badge.removeAttribute('title');
    } else {
      if (badge.textContent !== text) { badge.textContent = text; }
      var label = 'Ожидают приёмки: ' + state.count;
      badge.setAttribute('aria-label', label);
      badge.setAttribute('title', label);
      badge.hidden = false;
    }
    return true;
  }

  /* ---------- опрос сервера ---------- */

  function schedule(ms) {
    if (state.timer) { global.clearTimeout(state.timer); }
    state.timer = global.setTimeout(tick, ms);
  }

  function tick() {
    state.timer = null;
    if (state.stopped || state.pausedAuth) { return; }
    if (doc.visibilityState === 'hidden' || global.navigator.onLine === false) {
      schedule(state.delay);   // в фоне не опрашиваем; при возврате обновимся сразу
      return;
    }
    refresh();
  }

  function refresh() {
    if (state.stopped || state.inFlight) { return Promise.resolve(); }
    if (!findMenuItem()) { state.itemSeen = false; return Promise.resolve(); }   // пункта нет — не директор или вышел
    state.inFlight = true;

    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var to = ctrl ? global.setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var opts = {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json', 'X-Door-Poll': '1' }
    };
    if (ctrl) { opts.signal = ctrl.signal; }

    return global.fetch(ENDPOINT, opts).then(function (res) {
      if (res.status === 401) { state.pausedAuth = true; throw new Error('auth'); }
      if (res.status === 403) { state.stopped = true; state.count = null; render(); throw new Error('forbidden'); }
      if (!res.ok) { throw new Error('http ' + res.status); }
      return res.json();
    }).then(function (json) {
      if (json && json.success && json.data && typeof json.data.count === 'number') {
        state.count = json.data.count;
        state.delay = INTERVAL_MS;
        render();
      } else {
        throw new Error('bad payload');
      }
    }).catch(function () {
      // сеть/сервер недоступны — оставляем последнее число, увеличиваем паузу
      state.delay = Math.min(MAX_INTERVAL_MS, state.delay * 2);
    }).then(function () {
      if (to) { global.clearTimeout(to); }
      state.inFlight = false;
      if (!state.stopped && !state.pausedAuth) { schedule(state.delay); }
    });
  }

  function kick() {                       // немедленное обновление
    state.pausedAuth = false;
    state.delay = INTERVAL_MS;
    return refresh();
  }

  /* ---------- реакция на действия в этом же окне ---------- */

  function watchActions() {
    var xp = global.XMLHttpRequest && global.XMLHttpRequest.prototype;
    if (xp && !xp.__doorReviewWatch) {
      var open = xp.open, send = xp.send;
      xp.open = function (method, url) {
        try { this.__rbM = String(method).toUpperCase(); this.__rbU = String(url); } catch (e) { /* ignore */ }
        return open.apply(this, arguments);
      };
      xp.send = function () {
        var xhr = this;
        if (xhr.__rbM === 'POST' && isAction(xhr.__rbU)) {
          xhr.addEventListener('loadend', function () {
            if (xhr.status >= 200 && xhr.status < 300) { kick(); }
          });
        }
        return send.apply(xhr, arguments);
      };
      xp.__doorReviewWatch = true;
    }
    var f = global.fetch;
    if (typeof f === 'function' && !f.__doorReviewWatch) {
      var wrapped = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var p = f.apply(global, arguments);
        if (method === 'POST' && isAction(url)) {
          p.then(function (res) { if (res && res.ok) { kick(); } }, function () { /* ignore */ });
        }
        return p;
      };
      wrapped.__doorReviewWatch = true;
      global.fetch = wrapped;
    }
  }

  function isAction(url) {
    try {
      return ACTION_RE.test(new URL(String(url), global.location.href).pathname);
    } catch (e) {
      return false;
    }
  }

  /* ---------- запуск ---------- */

  var obsTimer = null;
  function onDomChange() {
    if (obsTimer) { return; }
    obsTimer = global.setTimeout(function () {
      obsTimer = null;
      var item = findMenuItem();
      if (!item) { state.itemSeen = false; return; }
      if (!state.itemSeen) {
        // пункт появился (первая загрузка или вход другого пользователя): начинаем с чистого состояния
        state.itemSeen = true;
        state.stopped = false;
        state.pausedAuth = false;
        state.count = null;
        render();
        kick();
        return;
      }
      render();                              // меню перерисовали — вернуть значок с последним числом
    }, 150);
  }

  function start() {
    watchActions();
    if (typeof global.MutationObserver === 'function') {
      new global.MutationObserver(onDomChange).observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    }
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') { kick(); }
    });
    global.addEventListener('online', kick);
    global.addEventListener('focus', function () { if (state.count !== null) { kick(); } });
    onDomChange();
  }

  global.DoorReviewBadge = {
    refresh: kick,
    _formatCount: formatCount,
    _matchesLabel: matchesLabel
  };

  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', start); }
  else { start(); }
})(typeof window !== 'undefined' ? window : this);
