'use strict';
/* Запуск: node tests/js/roles.test.js  (без зависимостей).
   Права ролей читаются из app/Core/Permissions.php — единственного источника истины, чтобы тест не расходился с сервером. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Roles = require('../../public/js/roles.js');

const php = fs.readFileSync(path.join(__dirname, '../../app/Core/Permissions.php'), 'utf8');
const strings = s => [...s.matchAll(/'([a-z_.]+)'/g)].map(m => m[1]);
const ALL = strings(/public const ALL = \[([\s\S]*?)\];/.exec(php)[1]);
const EXCL = strings(/public const OWNER_EXCLUDED = \[([\s\S]*?)\];/.exec(php)[1]);
const matrix = /private const MATRIX = \[([\s\S]*?)\n    \];/.exec(php)[1];
const PERMS = {
  owner: ALL.filter(p => !EXCL.includes(p)),
  master: strings(/'master' => \[([\s\S]*?)\]/.exec(matrix)[1]),
  director: strings(/'director' => \[([\s\S]*?)\]/.exec(matrix)[1]),
};
assert(ALL.length > 15 && PERMS.master.length && PERMS.director.length, 'Не удалось разобрать Permissions.php');

const menu = role => Roles.menuFor(role, PERMS[role]).flatMap(g => g.items.map(i => i.title));
const paths = role => Roles.menuFor(role, PERMS[role]).flatMap(g => g.items.map(i => i.path));
const open = (role, p, param) => Roles.canOpen(role, PERMS[role], p, param);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// --- меню, согласованное с заказчиком ---
t('мастер: Главная, Регистрация работы, Выполненные работы, Начисления и выплаты',
  () => assert.deepStrictEqual(menu('master'), ['Главная', 'Регистрация работы', 'Выполненные работы', 'Начисления и выплаты']));
t('директор: Главная, Выполненные работы, Начисления и выплаты, Отчёты, Расценки, Виды работ',
  () => assert.deepStrictEqual(menu('director'), ['Главная', 'Выполненные работы', 'Начисления и выплаты', 'Отчёты', 'Расценки', 'Виды работ']));
t('администратор: список заказчика + Начисления и выплаты + Отчёты',
  () => assert.deepStrictEqual(menu('owner'), ['Главная', 'Выполненные работы', 'Начисления и выплаты', 'Отчёты', 'Виды работ', 'Расценки', 'Журнал действий', 'Пользователи']));

// --- скачивание отчётов ---
t('директор и администратор могут скачивать отчёты (право и раздел), мастер — нет', () => {
  for (const r of ['director', 'owner']) { assert(PERMS[r].includes('reports.export'), r); assert(open(r, 'reports'), r); }
  assert.strictEqual(open('master', 'reports'), false);
  assert(!PERMS.master.includes('reports.export'));
});

// --- расценки и виды работ: устанавливает только директор ---
t('директор устанавливает расценки и виды работ', () => {
  assert(open('director', 'rates') && open('director', 'work-types'));
  for (const p of ['rates.view', 'rates.manage', 'work_types.view_all', 'work_types.manage']) assert(PERMS.director.includes(p), p);
});
t('администратор видит расценки и виды работ, но изменять не может', () => {
  assert(open('owner', 'rates') && open('owner', 'work-types'));
  for (const p of ['rates.view', 'work_types.view_all']) assert(PERMS.owner.includes(p), p);
  for (const p of ['rates.manage', 'work_types.manage']) assert(!PERMS.owner.includes(p), p);
  assert.deepStrictEqual([...EXCL].sort(), ['finance.manage', 'rates.manage', 'work_types.manage']);
});
t('мастер не видит расценки и виды работ', () => { assert.strictEqual(open('master', 'rates'), false); assert.strictEqual(open('master', 'work-types'), false); });

// --- финансы: создаёт и изменяет только директор ---
t('директор управляет финансами, администратор только просматривает', () => {
  assert(open('director', 'finance') && open('owner', 'finance'));
  assert(PERMS.director.includes('finance.manage') && PERMS.director.includes('finance.view_all'));
  assert(PERMS.owner.includes('finance.view_all') && !PERMS.owner.includes('finance.manage'));
  assert(!PERMS.master.includes('finance.manage') && PERMS.master.includes('finance.view_own'));
});

// --- запреты ---
t('мастер: чужие разделы закрыты', () => { for (const p of ['executors', 'reports', 'rates', 'work-types', 'users', 'audit']) assert.strictEqual(open('master', p), false, p); });
t('директор: регистрация, журнал, пользователи закрыты', () => { for (const p of ['register', 'audit', 'users']) assert.strictEqual(open('director', p), false, p); });
t('справочные экраны доступны по ссылкам, но не в меню', () => {
  for (const r of ['director', 'owner']) { assert(open(r, 'doors') && open(r, 'executors'), r); assert(!paths(r).includes('doors') && !paths(r).includes('executors'), r); }
  assert(open('master', 'doors') && !paths('master').includes('doors'));
  assert.strictEqual(open('master', 'executors'), false);
});
t('каждый показанный пункт подтверждён правом роли', () => {
  for (const role of Object.keys(PERMS)) for (const p of paths(role)) {
    const need = Roles.ROUTES[p].need;
    assert(!need.length || need.some(x => PERMS[role].includes(x)), role + ':' + p);
  }
});
t('без права пункт скрывается даже у администратора (двойной фильтр)', () => {
  const perms = PERMS.owner.filter(x => x !== 'rates.view' && x !== 'audit.view');
  const v = Roles.menuFor('owner', perms).flatMap(g => g.items.map(i => i.path));
  assert(!v.includes('rates') && !v.includes('audit') && v.includes('users'));
});
t('пункт вне профиля роли не открывается, даже если право есть', () => assert.strictEqual(Roles.canOpen('master', [...PERMS.master, 'users.manage'], 'users'), false));
t('чужие финансы: мастеру нельзя, директору и администратору можно', () => {
  assert.strictEqual(open('master', 'finance', 'user/5'), false);
  for (const s of ['', 'runs', 'payments', 'adjustments']) assert.strictEqual(open('master', 'finance', s), true, s);
  assert.strictEqual(open('director', 'finance', 'user/5'), true);
  assert.strictEqual(open('owner', 'finance', 'user/5'), true);
});
t('перенаправление при запрещённом адресе', () => {
  assert.strictEqual(Roles.fallback('master', PERMS.master, 'finance'), 'finance');
  assert.strictEqual(Roles.fallback('master', PERMS.master, 'audit'), 'home');
  assert.strictEqual(Roles.fallback('director', PERMS.director, 'register'), 'home');
  assert.strictEqual(Roles.fallback('owner', PERMS.owner, 'nonexistent'), 'home');
});
t('неизвестная роль видит только главную', () => assert.deepStrictEqual(Roles.menuFor('stranger', ['work.register', 'users.manage']).flatMap(g => g.items.map(i => i.path)), ['home']));
t('нижняя панель — только у мастера, 4 раздела', () => {
  assert.deepStrictEqual(Roles.bottomNav('master', PERMS.master).map(i => i.path), ['home', 'register', 'works', 'finance']);
  assert.deepStrictEqual(Roles.bottomNav('director', PERMS.director), []);
  assert.deepStrictEqual(Roles.bottomNav('owner', PERMS.owner), []);
});
t('все разделы профилей описаны, а экраны существуют в коде', () => {
  const dir = path.join(__dirname, '../../public/js');
  const code = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const prof of Object.values(Roles.PROFILES)) for (const p of [...prof.groups.flatMap(g => g.items), ...prof.reachable]) assert(Roles.ROUTES[p], 'нет маршрута ' + p);
  for (const [p, r] of Object.entries(Roles.ROUTES)) assert(new RegExp('Views\\.' + r.view + '\\s*=|\\b' + r.view + '\\b[,\\s}]').test(code), 'нет экрана ' + r.view + ' для ' + p);
});
console.log('\nПройдено проверок: ' + n);
