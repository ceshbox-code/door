'use strict';
/* Оболочка: вход, меню по ролям, маршрутизация по hash. */
(function (w) {
  const { h, clear, errBox } = UI;
  const root = document.getElementById('app');
  const ctx = { user: null, permissions: [], role: null };

  // Разделы, меню и права по ролям описаны в roles.js (проверяется tests/js/roles.test.js).
  const ICONS = { home: '🏠', register: '➕', works: '📋', finance: '💰', doors: '🚪' };

  Api.state.onUnauth = () => { if (ctx.user) { ctx.user = null; showLogin('Сессия завершена. Войдите снова.'); } };

  function showLogin(notice) {
    document.body.classList.remove('authed', 'role-owner', 'role-master', 'role-director', 'has-bottomnav');
    clear(root); netbar = null;
    const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', autocapitalize: 'none', required: true });
    const pass = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true });
    const msg = h('div', {}, notice ? UI.alert('err', notice) : null);

    // Капча: картинка с сервера, ответ вводится вручную. Каждая картинка одноразовая — после любой попытки запрашивается новая.
    let captchaId = null;
    const capImg = h('img', { class: 'captcha-img', alt: 'Проверочные символы', width: 220, height: 80 });
    const capAns = h('input', { type: 'text', id: 'cap', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', maxlength: 10, placeholder: 'Символы с картинки' });
    const capRefresh = h('button', { type: 'button', class: 'btn secondary', 'aria-label': 'Показать другую картинку', title: 'Другая картинка' }, '↻');
    const capBox = h('div', { class: 'captcha hidden', id: 'captcha-box' },
      h('label', { for: 'cap' }, 'Проверка: введите символы с картинки'), h('div', { class: 'captcha-row' }, capImg, capRefresh), capAns);
    async function loadCaptcha() {
      try {
        const d = await Api.get('/auth/captcha');
        captchaId = d.captcha_id; capImg.src = d.image; capAns.value = ''; capBox.classList.remove('hidden');
      } catch (e) { captchaId = null; msg.appendChild(errBox(e)); }
    }
    capRefresh.addEventListener('click', loadCaptcha);

    const btn = h('button', { class: 'btn big', type: 'submit' }, 'Войти');
    const bioBtn = h('button', { class: 'btn secondary big hidden', type: 'button', id: 'bio-login' }, '🔒 Войти по биометрии');
    const form = h('form', { class: 'card' }, h('h1', {}, 'Учёт дверей'), h('label', { for: 'u' }, 'Логин'), user, h('label', { for: 'p' }, 'Пароль'), pass, capBox, msg, btn, bioBtn);

    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(msg);
      if (captchaId && !capAns.value.trim()) { msg.appendChild(UI.alert('err', 'Введите символы с картинки')); return; }
      btn.disabled = true;
      const body = { username: user.value, password: pass.value };
      if (captchaId) { body.captcha_id = captchaId; body.captcha_answer = capAns.value; }
      try { start(await Api.post('/auth/login', body)); }
      catch (e) {
        msg.appendChild(errBox(e)); btn.disabled = false; pass.value = '';
        if (captchaId || e.code === 'CAPTCHA_REQUIRED' || e.code === 'CAPTCHA_INVALID') { await loadCaptcha(); capAns.focus(); } else pass.focus();
      }
    });

    bioBtn.addEventListener('click', async () => {
      clear(msg); bioBtn.disabled = true;
      try { start(await Bio.login()); }
      catch (e) { msg.appendChild(UI.alert('err', Bio.friendlyError(e))); bioBtn.disabled = false; }
    });

    root.appendChild(h('div', { class: 'login' }, form));
    user.focus();

    // Что показывать, решает сервер: нужна ли капча и включена ли биометрия. Если настройки не получены,
    // капча подгрузится сама, когда сервер потребует её при входе.
    Api.get('/auth/config').then(cfg => {
      if (cfg.captcha && cfg.captcha.required) loadCaptcha();
      if (cfg.webauthn && cfg.webauthn.enabled && w.Bio) Bio.platformAvailable().then(ok => { if (ok) bioBtn.classList.remove('hidden'); });
    }).catch(() => { /* см. комментарий выше */ });
  }

  function start(session, opts) {
    Api.state.csrf = session.csrf_token;
    ctx.user = session.user; ctx.permissions = session.permissions; ctx.role = session.user.role;
    ctx.offline = !!(opts && opts.offline);                  // запуск без связи по сохранённому профилю
    Offline.setUser(ctx.user.id);
    if (!ctx.offline) Offline.saveIdentity(session);        // профиль и права (без CSRF-токена) — для запуска без интернета
    document.body.classList.add('authed');
    document.body.classList.remove('role-owner', 'role-master', 'role-director', 'has-bottomnav');
    document.body.classList.add('role-' + ctx.role);
    if (!location.hash || location.hash === '#/') location.hash = '#/home';
    shell(); route(); updateNetbar();
    if (!ctx.offline) trySync();
  }

  // ---------------------------------------------------------------- работа без связи
  let netbar, flashTimer = null, reconnecting = false;

  async function updateNetbar() {
    if (!netbar) return;
    const n = ctx.user ? await Offline.countDrafts(ctx.user.id) : 0;
    if (ctx.offline) {
      netbar.className = 'netbar offline';
      netbar.textContent = '⚠ Нет связи. ' + (n ? 'Не отправлено работ: ' + n + '. ' : '') + 'Регистрация работ сохраняется на телефоне и отправится позже.';
    } else if (n > 0) {
      netbar.className = 'netbar pending';
      netbar.textContent = 'Не отправлено на сервер работ: ' + n;
    } else if (!flashTimer) {
      netbar.className = 'netbar hidden'; netbar.textContent = '';
    }
  }
  function flash(text) {
    if (!netbar) return;
    netbar.className = 'netbar ok'; netbar.textContent = text;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashTimer = null; updateNetbar(); }, 6000);
  }
  async function trySync() {
    if (!ctx.user || ctx.offline) return;
    const r = await Offline.sync(ctx).catch(() => ({ sent: 0 }));
    if (r.sent) { flash('Отправлено на сервер работ: ' + r.sent); route(); }
    updateNetbar();
  }
  /** Связь появилась: проверяем, что сессия жива (получаем новый CSRF-токен), затем отправляем черновики. */
  async function reconnect() {
    if (!ctx.user || reconnecting) return;
    reconnecting = true;
    try {
      const s = await Api.get('/auth/me');                  // 401 → onUnauth → страница входа; черновики остаются на телефоне
      Api.state.csrf = s.csrf_token;
      const changed = s.user.role !== ctx.role || JSON.stringify(s.permissions) !== JSON.stringify(ctx.permissions);
      ctx.user = s.user; ctx.permissions = s.permissions; ctx.role = s.user.role; ctx.offline = false;
      Offline.saveIdentity(s);
      if (changed) { document.body.classList.remove('role-owner', 'role-master', 'role-director', 'has-bottomnav'); document.body.classList.add('role-' + ctx.role); shell(); }
      updateNetbar();
      const r = await Offline.sync(ctx).catch(() => ({ sent: 0 }));
      if (r.sent) flash('Связь восстановлена. Отправлено на сервер работ: ' + r.sent);
      route();
    } catch (e) {
      if (e && e.code === 'NETWORK') { ctx.offline = true; updateNetbar(); }
    } finally { reconnecting = false; }
  }
  Offline.Net.on(online => {
    if (!ctx.user) return;
    if (online) { if (ctx.offline) reconnect(); else trySync(); }
    else { ctx.offline = true; updateNetbar(); }
  });
  Offline.onChange(() => updateNetbar());
  window.addEventListener('door-drafts-retry', () => trySync());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !ctx.user) return;
    if (ctx.offline) Offline.Net.probe(); else trySync();
  });

  const OFFLINE_NOTICE_PAGES = ['home', 'register'];        // что работает без интернета; остальное показывает заглушку

  let menu, scrim, main, title, bottom;
  const profile = () => Roles.profile(ctx.role);

  async function logout(ev) {
    if (ev) ev.preventDefault();
    const n = ctx.user ? await Offline.countDrafts(ctx.user.id) : 0;
    if (n > 0) {
      const go = await new Promise(resolve => UI.modal(close => [
        h('h1', {}, 'Есть неотправленные работы: ' + n),
        h('p', {}, 'Они сохранены только на этом телефоне и ещё не учтены в начислениях. После выхода они останутся на телефоне и отправятся при следующем входе под вашей учётной записью.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); resolve(true); } }, 'Всё равно выйти'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => { close(); resolve(false); } }, 'Остаться'))]));
      if (!go) return;
    }
    let notice = null;
    try { await Api.post('/auth/logout'); }
    catch (e) { if (e && e.code === 'NETWORK') notice = 'Без связи сессия на сервере не завершена. Выйдите ещё раз, когда появится интернет.'; }
    Offline.clearIdentity();
    ctx.user = null; ctx.offline = false; location.hash = ''; showLogin(notice);
  }

  function shell() {
    clear(root);
    const close = () => { menu.classList.remove('open'); scrim.classList.add('hidden'); };
    scrim = h('div', { class: 'scrim hidden', onclick: close });
    const groups = Roles.menuFor(ctx.role, ctx.permissions);
    menu = h('nav', { class: 'menu', 'aria-label': 'Главное меню' },
      h('div', { class: 'who' }, h('strong', {}, ctx.user.full_name), h('br'), h('span', { class: 'badge' }, profile().label)),
      groups.map(g => [g.title ? h('div', { class: 'grp' }, g.title) : null,
        g.items.map(i => h('a', { href: '#/' + i.path, 'data-p': i.path, onclick: close }, i.title))]),
      h('a', { href: '#', onclick: logout }, 'Выйти'));

    const bn = Roles.bottomNav(ctx.role, ctx.permissions);
    bottom = bn.length ? h('nav', { class: 'bottomnav', 'aria-label': 'Основные разделы' },
      bn.map(i => h('a', { href: '#/' + i.path, 'data-p': i.path }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ICONS[i.path] || '•'), i.title))) : null;
    document.body.classList.toggle('has-bottomnav', !!bottom);

    title = h('div', { class: 'title' }, 'Учёт дверей');
    main = h('main', { id: 'main' });
    netbar = h('div', { class: 'netbar hidden', id: 'netbar', role: 'status' });
    root.append(
      h('header', { class: 'topbar' },
        h('button', { class: 'burger', 'aria-label': 'Меню', onclick: () => { menu.classList.add('open'); scrim.classList.remove('hidden'); } }, '☰'),
        title, h('span', { class: 'badge' }, profile().label),
        bottom ? h('button', { class: 'logout', onclick: logout }, 'Выйти') : null),
      netbar, scrim, menu, main, bottom);
  }

  let token = 0;
  async function route() {
    if (!ctx.user) return;
    let [, path, param] = /^#\/([\w-]+)(?:\/(.+))?$/.exec(location.hash) || [];
    if (!Roles.canOpen(ctx.role, ctx.permissions, path, param)) {
      // запрещённый или неизвестный адрес: исправляем его в адресной строке, не оставляя чужой путь
      const to = Roles.fallback(ctx.role, ctx.permissions, path);
      history.replaceState(null, '', '#/' + to);
      path = to; param = undefined;
    }
    const view = Roles.ROUTES[path].view;
    document.querySelectorAll('a[data-p]').forEach(a => a.classList.toggle('active', a.dataset.p === path));
    title.textContent = Roles.titleFor(ctx.role, path);
    const mine = ++token;
    // Каждый маршрут рисует в СВОЙ контейнер. Устаревший (его заменил новый переход) отключён от страницы, поэтому
    // запоздавший ответ старого экрана не может ни затереть, ни дополнить содержимое нового.
    const holder = h('div', { class: 'view' });
    clear(main).appendChild(holder);
    try {
      const offlineOk = OFFLINE_NOTICE_PAGES.includes(path) && (path === 'register' || ctx.permissions.includes('work.register'));
      if (ctx.offline && !offlineOk) {
        holder.appendChild(h('div', { class: 'card' }, h('h1', {}, Roles.titleFor(ctx.role, path)),
          h('p', {}, 'Нет связи с сервером. Этот раздел работает только с интернетом: данные на телефоне не сохраняются.'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { await Offline.Net.probe(); route(); } }, 'Проверить связь')));
        return;
      }
      if (typeof Views[view] !== 'function') throw new Error('Приложение обновилось, но браузер показывает старую версию. Обновите страницу: Ctrl+F5 (на телефоне — закройте и откройте приложение заново).');
      await Views[view](ctx, holder, param);
    } catch (e) {
      if (mine === token) holder.appendChild(errBox(e));
    }
  }
  w.route = route;
  window.addEventListener('hashchange', route);

  // Восстановление сессии при загрузке
  Api.get('/auth/me').then(s => start(s)).catch(async e => {
    if (e && e.code === 'NETWORK') {                               // нет интернета при запуске: работаем по сохранённому профилю
      const id = await Offline.loadIdentity();
      if (id) return start({ user: id.user, permissions: id.permissions, csrf_token: '' }, { offline: true });
    }
    showLogin();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => { /* PWA необязательна для работы */ });
})(window);
