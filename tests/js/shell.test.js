'use strict';
/* Запуск: node tests/js/shell.test.js
   Оболочка работает без интернета только если service worker закэшировал ВСЕ файлы, которые подключает index.html,
   и версии совпадают. Тест ловит забытую версию или файл. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const pub = path.join(__dirname, '../../public');
const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const refs = [...index.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]).filter(u => /^\/(js|css)\//.test(u));
const V = /const V = '(\?v=\d+)'/.exec(sw)[1];
const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1];
const shell = [...shellBlock.matchAll(/'(\/[^']*)'(?: \+ V)?/g)].map(m => m[1] + (m[0].includes('+ V') ? V : ''));

t('index.html подключает скрипты и стили с версией', () => { assert(refs.length >= 10); refs.forEach(u => assert(/\?v=\d+$/.test(u), u)); });
t('версия в index.html одна и совпадает с sw.js', () => { assert.deepStrictEqual([...new Set(refs.map(u => u.match(/\?v=\d+$/)[0]))], [V]); });
t('каждый файл из index.html есть в кэше оболочки', () => refs.forEach(u => assert(shell.includes(u), 'нет в SHELL: ' + u)));
t('кэш оболочки не содержит несуществующих файлов', () => shell.filter(u => u !== '/').forEach(u => assert(fs.existsSync(path.join(pub, u.split('?')[0])), 'нет файла: ' + u)));
t('в кэше есть страница, манифест и иконки', () => ['/', '/images/favico/site.webmanifest', '/images/favico/favicon.svg', '/images/favico/favicon.ico', '/images/favico/apple-touch-icon.png', '/images/favico/web-app-manifest-192x192.png', '/images/favico/web-app-manifest-512x512.png'].forEach(u => assert(shell.includes(u), u)));
t('service worker не трогает /api/ и не кэширует POST', () => { assert(/pathname\.startsWith\('\/api\/'\)/.test(sw)); assert(/req\.method !== 'GET'/.test(sw)); });
t('иконки из site.webmanifest существуют, область PWA — весь сайт', () => { const m = JSON.parse(fs.readFileSync(path.join(pub, 'images/favico/site.webmanifest'), 'utf8')); assert.strictEqual(m.start_url, '/'); assert.strictEqual(m.scope, '/'); m.icons.forEach(i => assert(fs.existsSync(path.join(pub, i.src)), i.src)); });
t('в index.html подключены все теги иконок и манифест', () => {
  ['favicon-96x96.png', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest'].forEach(f => assert(index.includes('/images/favico/' + f), f));
  assert(index.includes('apple-mobile-web-app-title" content="DOOR"'));
});
t('порядок скриптов: offline.js до views.js и app.js', () => { const o = refs.findIndex(u => u.includes('offline.js')), v = refs.findIndex(u => u.includes('views.js')), a = refs.findIndex(u => u.includes('app.js')); assert(o > -1 && o < v && v < a); });
console.log('\nПройдено проверок: ' + n);
