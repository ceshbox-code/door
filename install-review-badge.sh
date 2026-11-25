#!/bin/bash
# Установка счётчика работ, ожидающих приёмки (значок у пункта меню «Приёмка работ», директор).
# Запуск на Synology:  sudo bash install-review-badge.sh [/volume1/docker/door]
#
# Добавляет:  app/Repositories/ReviewQueueRepository.php, app/Controllers/ReviewCountController.php,
#             public/js/review-badge.js, tests/js/review-badge.test.js
# Меняет:     app/routes.php   — одна строка: GET /api/v1/work-records/pending-count (право work.review)
#             app/Core/Session.php — фоновый опрос (заголовок X-Door-Poll: 1) не продлевает сессию
#             точку входа public/*.html|php — подключение скрипта (один раз)
# БД, миграции, .env, контейнеры, тома и данные не затрагиваются. Резервных копий скрипт не делает
# (откат через git, см. в конце). Пересборку контейнера вы запускаете сами.

set -euo pipefail

PROJECT="${1:-/volume1/docker/door}"
VER="1"

say()  { printf '%s\n' "$*"; }
warn() { printf '[!] %s\n' "$*"; }
die()  { printf '[ОШИБКА] %s\n' "$*" >&2; exit 1; }

# ---------- проверки до любых изменений ----------
[ -d "$PROJECT/app" ] && [ -d "$PROJECT/public" ] && [ -f "$PROJECT/docker-compose.yml" ] \
  || die "$PROJECT не похож на корень проекта «Дверь» (нужны app/, public/, docker-compose.yml)"
ROUTES="$PROJECT/app/routes.php"
SESSION="$PROJECT/app/Core/Session.php"
[ -f "$ROUTES" ]  || die "Не найден $ROUTES"
[ -f "$SESSION" ] || die "Не найден $SESSION"
[ -d "$PROJECT/app/Controllers" ] && [ -d "$PROJECT/app/Repositories" ] || die "Нет app/Controllers или app/Repositories"

NEEDLE="\$router->get('/api/v1/work-records/{id}',"
if ! grep -qF 'pending-count' "$ROUTES"; then
  grep -qF "$NEEDLE" "$ROUTES" || die "В routes.php не найден маршрут GET /api/v1/work-records/{id}: счётчик нужно регистрировать ПЕРЕД ним. Ничего не изменено."
fi
if ! grep -qF 'HTTP_X_DOOR_POLL' "$SESSION"; then
  grep -qF "\$_SESSION['last_activity'] = \$now;" "$SESSION" || die "В Session.php не найдена строка обновления last_activity. Ничего не изменено."
fi

if [ -d "$PROJECT/.git" ] && command -v git >/dev/null 2>&1; then
  [ -z "$(git -C "$PROJECT" status --porcelain 2>/dev/null)" ] || warn "В репозитории есть незакоммиченные изменения (скрипт тронет только перечисленные выше файлы)."
else
  warn "Это не git-репозиторий: откат придётся делать вручную."
fi

# ---------- новые файлы ----------
mkdir -p "$PROJECT/tests/js"

cat > "$PROJECT/app/Repositories/ReviewQueueRepository.php" <<'DOOR_EOF'
<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

/** Очередь приёмки работ (ТЗ 2.1): только чтение, ничего не изменяет. */
final class ReviewQueueRepository
{
    /**
     * Сколько действующих (не аннулированных) работ ждёт решения директора.
     * Условие совпадает со списком «Выполненные работы» при status=active и review_status=pending;
     * использует индекс idx_wr_review (review_status, completed_at).
     */
    public function countPending(): int
    {
        $st = Database::pdo()->query(
            "SELECT COUNT(*) FROM work_records WHERE review_status = 'pending' AND voided_at IS NULL"
        );
        return (int) $st->fetchColumn();
    }
}
DOOR_EOF

cat > "$PROJECT/app/Controllers/ReviewCountController.php" <<'DOOR_EOF'
<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\Request;
use App\Core\Response;
use App\Repositories\ReviewQueueRepository;

/**
 * Счётчик работ, ожидающих приёмки (значок у пункта меню «Приёмка работ»).
 * Право work.review проверяет Guard в routes.php (только директор).
 */
final class ReviewCountController extends BaseController
{
    private ReviewQueueRepository $queue;

    public function __construct()
    {
        $this->queue = new ReviewQueueRepository();
    }

    public function pendingCount(Request $r): Response
    {
        // Сессия здесь только читается: снимаем блокировку файла сессии, чтобы частый опрос
        // не задерживал другие запросы этого же пользователя.
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return Response::ok(['count' => $this->queue->countPending()]);
    }
}
DOOR_EOF

# --- JS: каталог по существующему скрипту точки входа ---
ENTRY=""
for f in public/index.html public/index.php public/app.html; do
  if [ -f "$PROJECT/$f" ] && grep -q '<script' "$PROJECT/$f"; then ENTRY="$f"; break; fi
done
JSDIR_URL="/js"
if [ -n "$ENTRY" ]; then
  first_src="$(grep -o 'src="/[^"?]*\.js' "$PROJECT/$ENTRY" | head -n1 | sed 's/^src="//' || true)"
  if [ -n "$first_src" ] && [ -d "$PROJECT/public$(dirname "$first_src")" ]; then JSDIR_URL="$(dirname "$first_src")"; fi
fi
JSDIR="$PROJECT/public$JSDIR_URL"
mkdir -p "$JSDIR"

cat > "$JSDIR/review-badge.js" <<'DOOR_EOF'
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
DOOR_EOF

cat > "$PROJECT/tests/js/review-badge.test.js" <<'DOOR_EOF'
// Тест без браузера: node tests/js/review-badge.test.js
// Упрощённые заглушки DOM; проверяют логику значка, а не отрисовку в реальном браузере.
'use strict';
const assert = require('assert');

let fetchCalls = [];
let fetchImpl = null;

function el(tag, text) {
  const node = {
    tag, _text: text || '', children: [], parentNode: null, hidden: false, style: {}, attrs: {},
    className: '', id: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = v; this.children = []; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) {
        n.children.forEach(c => {
          if (sel === '[data-door-review-badge]' && c.attrs['data-door-review-badge']) out.push(c);
          walk(c);
        });
      })(this);
      return out;
    },
    cloneNode() {
      const c = el(this.tag, this._text);
      c.attrs = Object.assign({}, this.attrs);
      this.children.forEach(ch => c.appendChild(ch.cloneNode()));
      return c;
    }
  };
  return node;
}

const body = el('body');
const menuLink = el('a', 'Приёмка работ');
const other = el('a', 'Выполненные работы');
body.appendChild(other); body.appendChild(menuLink);

const doc = {
  readyState: 'complete', visibilityState: 'visible', body, head: el('head'), documentElement: el('html'),
  getElementById() { return null; },
  createElement: (t) => el(t),
  querySelectorAll(sel) {
    const res = [];
    (function walk(n) { n.children.forEach(c => { if (c.tag === 'a' || c.tag === 'button') res.push(c); walk(c); }); })(body);
    return res;
  },
  addEventListener() {}
};

global.window = global;
global.document = doc;
Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
global.location = { href: 'https://door.example.ru/' };
global.getComputedStyle = () => ({ display: 'flex' });
global.MutationObserver = undefined;
global.XMLHttpRequest = undefined;
global.AbortController = undefined;
global.addEventListener = () => {};
global.fetch = function (url, opts) { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); };
global.setTimeout = (fn, ms) => ({ fn, ms, unref() {} });   // таймеры не запускаем сами
global.clearTimeout = () => {};

const jsonRes = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });

require(process.env.BADGE_JS || '../../public/js/review-badge.js');
const B = global.DoorReviewBadge;

// --- чистые функции ---
assert.strictEqual(B._formatCount(0), '');
assert.strictEqual(B._formatCount(null), '');
assert.strictEqual(B._formatCount(5), '5');
assert.strictEqual(B._formatCount(99), '99');
assert.strictEqual(B._formatCount(100), '99+');
assert.strictEqual(B._matchesLabel('  Приёмка   работ '), true);
assert.strictEqual(B._matchesLabel('Приемка работ 7'), true);
assert.strictEqual(B._matchesLabel('Выполненные работы'), false);

(async () => {
  // --- число приходит с сервера → значок показан у нужной ссылки ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 3 } });
  await B.refresh();
  const badge = menuLink.querySelector('[data-door-review-badge]');
  assert.ok(badge, 'значок создан внутри пункта «Приёмка работ»');
  assert.strictEqual(badge.textContent, '3');
  assert.strictEqual(badge.hidden, false);
  assert.strictEqual(other.querySelector('[data-door-review-badge]'), null, 'у других пунктов значка нет');
  assert.strictEqual(fetchCalls[0].url, '/api/v1/work-records/pending-count');
  assert.strictEqual(fetchCalls[0].opts.headers['X-Door-Poll'], '1');
  assert.strictEqual(fetchCalls[0].opts.credentials, 'same-origin');

  // --- обновление без перезагрузки ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 120 } });
  await B.refresh();
  assert.strictEqual(badge.textContent, '99+');

  // --- 0 → значок скрыт ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 0 } });
  await B.refresh();
  assert.strictEqual(badge.hidden, true);

  // --- ошибка сети → последнее известное число не теряется ---
  fetchImpl = () => jsonRes(200, { success: true, data: { count: 4 } });
  await B.refresh();
  assert.strictEqual(badge.textContent, '4');
  fetchImpl = () => Promise.reject(new Error('network'));
  await B.refresh();
  assert.strictEqual(badge.textContent, '4');
  assert.strictEqual(badge.hidden, false);

  // --- 403 → опрос останавливается, значок скрыт ---
  fetchImpl = () => jsonRes(403, { success: false });
  await B.refresh();
  assert.strictEqual(badge.hidden, true);
  const callsBefore = fetchCalls.length;
  await B.refresh();      // kick сбрасывает только 401; после 403 запросов больше нет
  assert.strictEqual(fetchCalls.length, callsBefore, 'после 403 запросы не отправляются');

  console.log('OK: review-badge');
})().catch(e => { console.error(e); process.exit(1); });
DOOR_EOF
chmod 644 "$PROJECT/app/Repositories/ReviewQueueRepository.php" "$PROJECT/app/Controllers/ReviewCountController.php" \
          "$JSDIR/review-badge.js" "$PROJECT/tests/js/review-badge.test.js"
say "[ок] Файлы записаны (репозиторий, контроллер, review-badge.js, тест)"

# ---------- правка routes.php (одна строка, перед маршрутом {id}) ----------
if grep -qF 'pending-count' "$ROUTES"; then
  say "[ок] routes.php: маршрут уже есть — не меняю"
else
  tmp="$(mktemp)"
  INS="    \$router->get('/api/v1/work-records/pending-count', Guard::auth([new \\App\\Controllers\\ReviewCountController(), 'pendingCount'], 'work.review'));  // счётчик приёмки (только director)" \
  NEEDLE="$NEEDLE" awk '
    BEGIN { ins = ENVIRON["INS"]; needle = ENVIRON["NEEDLE"] }
    !done && index($0, needle) > 0 { print ins; done = 1 }
    { print }
  ' "$ROUTES" > "$tmp"
  cat "$tmp" > "$ROUTES"; rm -f "$tmp"
  grep -qF 'pending-count' "$ROUTES" || die "Не удалось изменить routes.php"
  say "[ок] routes.php: добавлен GET /api/v1/work-records/pending-count"
fi

# ---------- правка Session.php ----------
if grep -qF 'HTTP_X_DOOR_POLL' "$SESSION"; then
  say "[ок] Session.php уже изменён — не меняю"
else
  tmp="$(mktemp)"
  awk '
    !done && $0 ~ /^[[:space:]]*\$_SESSION\[.last_activity.\] = \$now;[[:space:]]*$/ {
      print "        // Фоновый опрос счётчика (заголовок X-Door-Poll: 1) не продлевает сессию: иначе открытая вкладка"
      print "        // директора не давала бы сессии истечь по таймауту простоя."
      print "        if ((string) ($_SERVER[\047HTTP_X_DOOR_POLL\047] ?? \047\047) !== \0471\047) {"
      print "            $_SESSION[\047last_activity\047] = $now;"
      print "        }"
      done = 1; next
    }
    { print }
  ' "$SESSION" > "$tmp"
  grep -qF 'HTTP_X_DOOR_POLL' "$tmp" || { rm -f "$tmp"; die "Не удалось изменить Session.php"; }
  cat "$tmp" > "$SESSION"; rm -f "$tmp"
  say "[ок] Session.php: фоновый опрос не продлевает сессию"
fi

# ---------- подключение скрипта ----------
TAG="<script src=\"${JSDIR_URL}/review-badge.js?v=${VER}\"></script>"
if [ -z "$ENTRY" ]; then
  warn "Точка входа с <script> не найдена. Добавьте вручную в HTML (после остальных скриптов или до них):"
  say  "    $TAG"
elif grep -q 'review-badge.js' "$PROJECT/$ENTRY"; then
  say "[ок] $ENTRY уже подключает review-badge.js"
else
  sed -i "0,/<script/s##${TAG//#/\\#}\n    <script#" "$PROJECT/$ENTRY"
  grep -q 'review-badge.js' "$PROJECT/$ENTRY" || die "Не удалось добавить тег в $ENTRY"
  say "[ок] Тег добавлен в $ENTRY"
fi

if command -v node >/dev/null 2>&1; then
  node --check "$JSDIR/review-badge.js" && say "[ок] Синтаксис JS проверен (node --check)"
  BADGE_JS="$JSDIR/review-badge.js" node "$PROJECT/tests/js/review-badge.test.js" || warn "Тест значка не прошёл"
else
  say "[инфо] node на NAS нет — JS-тест не запускался"
fi

echo
say "=== Проверьте вручную ==="
SW="$(ls "$PROJECT"/public/sw.js "$PROJECT"/public/service-worker.js 2>/dev/null | head -n1 || true)"
if [ -n "$SW" ]; then
  warn "Service worker: добавьте review-badge.js в его список кэша и поднимите версию кэша/?v=N, иначе без связи и в установленных PWA скрипт не загрузится."
fi
say "Если в проекте есть CSP: скрипту нужны только script-src 'self' и connect-src 'self' (стили вставляются через <style>; при строгом style-src добавьте правило в ваш CSS)."
say "Классы подгружаются автозагрузчиком Composer: если после пересборки ответ 500 с «Class not found», выполните"
say "    docker compose exec door-app composer dump-autoload"

echo
say "=== Применение ==="
say "    cd $PROJECT && docker-compose up -d --build door-app      # DSM до 7.2"
say "    cd $PROJECT && docker compose up -d --build door-app      # новый Container Manager"
say "Проверка PHP внутри контейнера (php на NAS обычно нет):"
say "    docker compose exec door-app sh -c 'for f in app/Controllers/ReviewCountController.php app/Repositories/ReviewQueueRepository.php app/routes.php app/Core/Session.php; do php -l \$f; done'"
say "Проверка прав (вход директором, затем в консоли браузера):"
say "    fetch('/api/v1/work-records/pending-count').then(r=>r.json()).then(console.log)    // директор: {success:true,data:{count:N}}; мастер/админ: 403"

echo
say "=== Откат ==="
say "    git -C $PROJECT checkout -- app/routes.php app/Core/Session.php ${ENTRY:-public}"
say "    rm -f $PROJECT/app/Repositories/ReviewQueueRepository.php $PROJECT/app/Controllers/ReviewCountController.php $JSDIR/review-badge.js $PROJECT/tests/js/review-badge.test.js"
say "    затем пересоберите контейнер."
