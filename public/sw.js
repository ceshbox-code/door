'use strict';
/* Service worker: приложение открывается без интернета.
   • Оболочка (страница, скрипты, стили, иконки) лежит в кэше. Файлы с ?v=N неизменяемы: новая версия — новый адрес,
     поэтому читаем их из кэша мгновенно. Главная страница берётся из сети (таймаут 3 с), иначе из кэша.
   • Запросы /api/ не перехватываются и не кэшируются никогда: деньги, списки и фото всегда только с сервера.
   Версию (V и CACHE) нужно менять при каждом изменении файлов оболочки. */
const CACHE = 'door-shell-v19';
const V = '?v=25';
const SHELL = ['/', '/css/app.css' + V, '/js/api.js' + V, '/js/ui.js' + V, '/js/roles.js' + V, '/js/webauthn.js' + V, '/js/offline.js' + V,
  '/js/views.js' + V, '/js/finance.js' + V, '/js/audit.js' + V, '/js/executors.js' + V, '/js/app.js' + V,
  '/images/favico/site.webmanifest', '/images/favico/favicon.svg', '/images/favico/favicon-96x96.png', '/images/favico/favicon.ico',
  '/images/favico/apple-touch-icon.png', '/images/favico/web-app-manifest-192x192.png', '/images/favico/web-app-manifest-512x512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function navigate(e) {
  const cache = await caches.open(CACHE);
  const network = fetch(e.request).then(res => { if (res.ok) cache.put('/', res.clone()); return res; });
  e.waitUntil(network.catch(() => {}));                         // обновление кэша продолжается и после ответа из кэша
  try {
    return await Promise.race([network, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
  } catch (err) {
    const cached = await cache.match('/');
    return cached || network;                                    // кэша нет (первый запуск без сети) — остаётся ждать сеть
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
  catch (err) { const hit = await cache.match(req); if (hit) return hit; throw err; }
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html') { e.respondWith(navigate(e)); return; }
  if (u.search.startsWith('?v=') || u.pathname.startsWith('/images/favico/')) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(networkFirst(req));
});
