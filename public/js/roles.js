'use strict';
/* Профили интерфейса по ролям (ТЗ раздел 9, 13.1). Модуль без DOM — проверяется автотестом tests/js/roles.test.js.
   ВАЖНО: это только отображение. Права проверяет сервер (Guard) при каждом запросе; здесь два фильтра:
   1) пункт должен входить в профиль роли; 2) у пользователя должно быть соответствующее право из сессии. */
(function (root) {
  // path -> экран и необходимые права (достаточно любого из списка; пусто = доступно всем вошедшим)
  const ROUTES = {
    home:        { view: 'home',      need: [], title: 'Главная' },
    register:    { view: 'register',  need: ['work.register'], title: 'Регистрация работы' },
    doors:       { view: 'doors',     need: ['doors.view', 'doors.lookup'], title: 'Двери' },
    executors:   { view: 'executors', need: ['stats.view'], title: 'Исполнители' },
    review:      { view: 'review',    need: ['work.review'], title: 'Приёмка работ' },
    works:       { view: 'works',     need: ['work.view_all', 'work.view_own'], title: 'Выполненные работы' },
    finance:     { view: 'finance',   need: ['finance.view_all', 'finance.view_own'], title: 'Начисления и выплаты',
                   // чужие финансы (#/finance/user/ID) — только при финансовом просмотре всех
                   guard: (perms, param) => perms.includes('finance.view_all') || !param || ['runs', 'payments', 'adjustments'].includes(param) },
    reports:     { view: 'reports',   need: ['reports.export'], title: 'Отчёты' },
    'work-types': { view: 'workTypes', need: ['work_types.manage', 'work_types.view_all'], title: 'Виды работ' },
    rates:       { view: 'rates',     need: ['rates.view', 'rates.manage'], title: 'Расценки' },
    audit:       { view: 'audit',     need: ['audit.view'], title: 'Журнал действий' },
    users:       { view: 'users',     need: ['users.manage'], title: 'Пользователи' },
  };

  /* groups — то, что показано в меню (в заданном порядке); reachable — экраны, доступные по ссылкам из других экранов
     (например, номер двери в карточке работы), но не вынесенные в меню. Права при этом проверяются так же. */
  const PROFILES = {
    master: {
      label: 'Мастер', theme: 'master',
      groups: [{ title: '', items: ['home', 'register', 'works', 'finance'] }],
      reachable: ['doors'],
      titles: {},
      bottomNav: { home: 'Главная', register: 'Работа', works: 'Работы', finance: 'Начисления' },
    },
    director: {
      label: 'Директор', theme: 'director',
      groups: [{ title: '', items: ['home', 'review', 'works', 'finance', 'reports', 'rates', 'work-types'] }],
      reachable: ['doors', 'executors'],
      titles: {}, bottomNav: null,
    },
    owner: {
      label: 'Администратор', theme: 'owner',
      groups: [{ title: '', items: ['home', 'works', 'finance', 'reports', 'work-types', 'rates', 'audit', 'users'] }],
      reachable: ['doors', 'executors'],
      titles: {}, bottomNav: null,
    },
  };

  const profile = role => PROFILES[role] || { label: String(role || ''), theme: 'none', groups: [{ title: '', items: ['home'] }], reachable: [], titles: {}, bottomNav: null };
  const listed = (role, path) => path === 'home' || profile(role).groups.some(g => g.items.includes(path)) || (profile(role).reachable || []).includes(path);

  /** Можно ли показать экран: он есть в профиле роли, право у пользователя есть, подмаршрут разрешён. */
  function canOpen(role, perms, path, param) {
    const r = ROUTES[path];
    if (!r || !listed(role, path)) return false;
    if (r.need.length && !r.need.some(p => perms.includes(p))) return false;
    return !r.guard || !!r.guard(perms, param || '');
  }
  const titleFor = (role, path) => (profile(role).titles[path]) || (ROUTES[path] && ROUTES[path].title) || '';

  /** Группы меню роли: только доступные пункты, пустые группы убираются. */
  function menuFor(role, perms) {
    return profile(role).groups
      .map(g => ({ title: g.title, items: g.items.filter(p => canOpen(role, perms, p)).map(p => ({ path: p, title: titleFor(role, p) })) }))
      .filter(g => g.items.length);
  }
  /** Нижняя панель (смартфон) — только если профиль её предусматривает. */
  function bottomNav(role, perms) {
    const bn = profile(role).bottomNav;
    if (!bn) return [];
    return Object.keys(bn).filter(p => canOpen(role, perms, p)).map(p => ({ path: p, title: bn[p] }));
  }
  /** Куда перенаправить при запрещённом адресе: тот же раздел без подпути, если он разрешён, иначе главная. */
  function fallback(role, perms, path) { return canOpen(role, perms, path, '') ? path : 'home'; }

  const api = { ROUTES, PROFILES, profile, canOpen, titleFor, menuFor, bottomNav, fallback };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Roles = api;
})(typeof window !== 'undefined' ? window : globalThis);
