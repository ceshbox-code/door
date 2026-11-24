'use strict';
/* Клиент REST API (/api/v1). Единый формат ответов: {success, data} | {success:false, error:{code,message,details}}. */
(function (w) {
  const BASE = '/api/v1';
  const state = { csrf: '', onUnauth: null };

  class ApiError extends Error {
    constructor(code, message, status, details) {
      super(message);
      this.code = code; this.status = status; this.details = details || null;
    }
    /** Человекочитаемый текст, включая ошибки по полям. */
    full() {
      if (!this.details || typeof this.details !== 'object') return this.message;
      const parts = Object.values(this.details).filter(v => typeof v === 'string');
      return parts.length ? this.message + ': ' + parts.join('; ') : this.message;
    }
  }

  function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') p.append(k, String(v));
    }
    const s = p.toString();
    return s ? '?' + s : '';
  }

  async function parse(res) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* не JSON */ }
    if (!body || body.success !== true) {
      const err = body && body.error ? body.error : {};
      if (res.status === 401 && state.onUnauth) state.onUnauth();
      throw new ApiError(err.code || 'HTTP_' + res.status, err.message || 'Ошибка запроса (' + res.status + ')', res.status, err.details);
    }
    return body.data;
  }

  async function request(method, path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    let body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    let res;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);       // слабый сигнал не должен подвешивать экран
    try {
      res = await fetch(BASE + path + qs(opts.query), { method, headers, body, credentials: 'same-origin', signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (w.Net) w.Net.markOffline();
      throw new ApiError('NETWORK', 'Нет связи с сервером. Проверьте подключение и повторите.', 0);
    }
    clearTimeout(timer);
    if (w.Net) w.Net.markOnline();
    return parse(res);
  }

  /** Отправка multipart с прогрессом загрузки (fetch не умеет).
      Загрузка не должна «висеть» при потере связи: она обрывается сразу по событию «нет сети» и после 45 секунд без
      движения байтов; ожидание ответа сервера после полной отправки — до 2 минут. Обрыв — ошибка NETWORK: вызывающий код
      сохраняет работу черновиком, а повтор с тем же Idempotency-Key не создаёт дубль. */
  const activeUploads = new Set();
  let netHooked = false;
  function hookNet() {
    if (netHooked || !w.Net) return;
    netHooked = true;
    w.Net.on(online => { if (!online) activeUploads.forEach(x => x.abort()); });
  }
  function upload(path, formData, headers, onProgress) {
    hookNet();
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      let watchdog = null;
      const arm = ms => { clearTimeout(watchdog); watchdog = setTimeout(() => x.abort(), ms); };
      const done = () => { clearTimeout(watchdog); activeUploads.delete(x); };
      const netFail = () => { done(); if (w.Net) w.Net.markOffline(); reject(new ApiError('NETWORK', 'Нет связи с сервером. Работа будет сохранена и отправлена позже — дубля не будет.', 0)); };
      x.open('POST', BASE + path);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/json');
      if (state.csrf) x.setRequestHeader('X-CSRF-Token', state.csrf);
      for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
      if (x.upload) x.upload.onprogress = e => {
        arm(e.lengthComputable && e.loaded >= e.total ? 120000 : 45000);       // всё отправлено — ждём ответ дольше
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      x.onerror = x.ontimeout = x.onabort = netFail;
      x.onload = () => {
        done();
        if (w.Net) w.Net.markOnline();
        let body = null;
        try { body = JSON.parse(x.responseText); } catch (e) { /* */ }
        if (body && body.success === true) return resolve(body.data);
        const err = body && body.error ? body.error : {};
        if (x.status === 401 && state.onUnauth) state.onUnauth();
        reject(new ApiError(err.code || 'HTTP_' + x.status, err.message || 'Ошибка запроса (' + x.status + ')', x.status, err.details));
      };
      x.timeout = 10 * 60 * 1000;
      activeUploads.add(x);
      arm(45000);
      x.send(formData);
    });
  }

  /** Скачивание файла отчёта (нужна сессия, поэтому через fetch, а не ссылкой). */
  async function download(path, query) {
    let res;
    try { res = await fetch(BASE + path + qs(query), { credentials: 'same-origin' }); }
    catch (e) { throw new ApiError('NETWORK', 'Нет связи с сервером.', 0); }
    if (!res.ok) return parse(res);              // ошибка в JSON
    const m = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = m ? m[1] : 'report';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  w.Api = {
    ApiError, state, upload, download,
    get: (p, q) => request('GET', p, { query: q }),
    post: (p, json, headers) => request('POST', p, { json: json === undefined ? {} : json, headers }),
    patch: (p, json) => request('PATCH', p, { json }),
    put: (p, json) => request('PUT', p, { json }),
    del: p => request('DELETE', p),
    qs,
  };
})(window);
