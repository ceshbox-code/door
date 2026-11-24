'use strict';
/* Вход по биометрии (WebAuthn / passkey): отпечаток или лицо подтверждаются самим телефоном, на сервер уходит только подпись.
   Работает по HTTPS. Сервер включает функцию настройками WEBAUTHN_RP_ID и WEBAUTHN_ORIGIN (.env). */
(function (w) {
  const { h, clear, dt, errBox, alert, modal } = UI;

  const b64uToBuf = s => {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  const bufToB64u = buf => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const supported = () => !!(w.PublicKeyCredential && navigator.credentials && w.isSecureContext);

  /** Есть ли на этом устройстве отпечаток / Face ID / Windows Hello. */
  async function platformAvailable() {
    if (!supported() || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; }
  }

  function deviceLabel() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android-телефон';
    if (/Windows/.test(ua)) return 'Компьютер с Windows';
    if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
    return 'Устройство';
  }

  /** Понятное сообщение вместо технической ошибки браузера или сервера. */
  function friendlyError(e) {
    if (e && e.full) return e.full();                         // ошибка API
    switch (e && e.name) {
      case 'NotAllowedError': return 'Подтверждение отменено или время вышло. Попробуйте ещё раз или войдите по паролю.';
      case 'InvalidStateError': return 'Это устройство уже зарегистрировано.';
      case 'NotSupportedError': return 'Это устройство не поддерживает вход по биометрии.';
      case 'SecurityError': return 'Адрес сайта не подходит для биометрии: нужен HTTPS и верные настройки сервера.';
      case 'AbortError': return 'Подтверждение прервано.';
      default: return 'Не удалось выполнить вход по биометрии.';
    }
  }

  const decodeCreation = pk => ({
    ...pk, challenge: b64uToBuf(pk.challenge), user: { ...pk.user, id: b64uToBuf(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })),
  });
  const decodeRequest = pk => ({
    ...pk, challenge: b64uToBuf(pk.challenge),
    allowCredentials: (pk.allowCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })),
  });

  /** Включить биометрию на этом устройстве (пользователь уже вошёл). */
  async function register(label) {
    const opts = await Api.post('/auth/webauthn/register/options');
    const cred = await navigator.credentials.create({ publicKey: decodeCreation(opts.publicKey) });
    if (!cred) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    return Api.post('/auth/webauthn/register/verify', {
      challenge_id: opts.challenge_id, id: cred.id, label: label || deviceLabel(),
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) },
    });
  }

  /** Войти без пароля: телефон показывает запрос отпечатка/лица. Возвращает сессию, как /auth/login. */
  async function login() {
    const opts = await Api.post('/auth/webauthn/login/options');
    const a = await navigator.credentials.get({ publicKey: decodeRequest(opts.publicKey) });
    if (!a) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    return Api.post('/auth/webauthn/login/verify', {
      challenge_id: opts.challenge_id, id: a.id,
      response: {
        clientDataJSON: bufToB64u(a.response.clientDataJSON), authenticatorData: bufToB64u(a.response.authenticatorData),
        signature: bufToB64u(a.response.signature), userHandle: a.response.userHandle ? bufToB64u(a.response.userHandle) : '',
      },
    });
  }

  /** Карточка «Вход по биометрии» на главной: устройства пользователя, включение и отключение. */
  async function card(ctx) {
    let cfg = null;
    try { cfg = await Api.get('/auth/config'); } catch (e) { return null; }
    if (!cfg.webauthn.enabled) {
      return ctx.permissions.includes('users.manage')
        ? h('div', { class: 'card muted' }, h('strong', {}, 'Вход по биометрии выключен. '), 'Чтобы включить, задайте WEBAUTHN_RP_ID и WEBAUTHN_ORIGIN в файле .env и перезапустите приложение.')
        : null;
    }
    const box = h('div', { class: 'card', id: 'bio-card' });
    const available = await platformAvailable();

    async function render() {
      clear(box);
      box.appendChild(h('h2', { style: 'margin-top:0' }, 'Вход по отпечатку или лицу'));
      let items = [];
      try { items = (await Api.get('/auth/webauthn/credentials')).items; } catch (e) { box.appendChild(errBox(e)); return; }
      box.appendChild(h('p', { class: 'muted' }, 'Биометрию проверяет сам телефон, на сервер она не передаётся. На странице входа появится кнопка «Войти по биометрии».'));
      if (items.length) {
        box.appendChild(h('table', { class: 'resp' },
          h('thead', {}, h('tr', {}, ['Устройство', 'Включено', 'Последний вход', ''].map(t => h('th', {}, t)))),
          h('tbody', {}, items.map(c => h('tr', {},
            h('td', { 'data-l': 'Устройство' }, c.label), h('td', { 'data-l': 'Включено' }, dt(c.created_at)),
            h('td', { 'data-l': 'Последний вход' }, c.last_used_at ? dt(c.last_used_at) : '—'),
            h('td', {}, h('button', { class: 'btn secondary', onclick: () => confirmRemove(c) }, 'Отключить')))))));
      } else {
        box.appendChild(h('p', {}, 'Биометрия пока не включена ни на одном устройстве.'));
      }
      const msg = h('div');
      if (available) {
        const b = h('button', { class: 'btn', type: 'button', id: 'bio-enable' }, items.length ? 'Включить на этом устройстве ещё раз' : 'Включить на этом устройстве');
        b.addEventListener('click', async () => {
          clear(msg); b.disabled = true;
          try { await register(deviceLabel()); await render(); }
          catch (e) { msg.appendChild(alert('err', friendlyError(e))); b.disabled = false; }
        });
        box.append(h('div', { style: 'margin-top:.8rem' }, b), msg);
      } else {
        box.appendChild(h('p', { class: 'muted' }, 'На этом устройстве биометрия недоступна (нет отпечатка или Face ID, не настроена блокировка экрана или страница открыта не по HTTPS).'));
      }
    }

    function confirmRemove(c) {
      modal(close => {
        const msg = h('div');
        const ok = h('button', { class: 'btn danger', type: 'button' }, 'Отключить');
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          try { await Api.del('/auth/webauthn/credentials/' + c.id); close(); await render(); }
          catch (e) { clear(msg).appendChild(errBox(e)); ok.disabled = false; }
        });
        return [h('h1', {}, 'Отключить вход по биометрии?'), h('p', {}, 'Устройство «' + c.label + '» больше не сможет входить без пароля. Позже его можно включить снова.'),
          msg, h('div', { class: 'row' }, ok, h('button', { class: 'btn secondary', type: 'button', onclick: close }, 'Отмена'))];
      });
    }

    await render();
    return box;
  }

  w.Bio = { supported, platformAvailable, register, login, card, friendlyError, deviceLabel, b64uToBuf, bufToB64u };
})(window);
