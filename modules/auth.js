/* =============================================================================
 *  modules/auth.js — аутентификация (login/logout/verify)
 * ========================================================================== */

(function (global) {
  'use strict';

  async function doLogin() {
    const pwEl = document.getElementById('pw');
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-err');
    const pw = pwEl.value;
    if (!pw) { pwEl.focus(); return; }

    btn.disabled = true; btn.textContent = 'Вход...';
    errEl.textContent = '';
    pwEl.classList.remove('err-input');

    const r = await fetch(API.WORKER + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(r => r.json()).catch(() => ({ success: false, error: 'Ошибка сети' }));

    if (r.success) {
      API.setSessionToken(r.token);
      btn.textContent = 'OK';
      await showApp();
    } else {
      errEl.textContent = r.error || 'Неверный пароль';
      pwEl.classList.add('err-input');
      btn.disabled = false; btn.textContent = 'Войти';
    }
  }

  function doLogout() {
    API.setSessionToken('');
    // Останавливаем всё
    if (global.App) App.onLogout();
    document.getElementById('app')?.classList.remove('visible');
    document.getElementById('login-screen')?.classList.remove('out');
    const pw = document.getElementById('pw');
    if (pw) { pw.value = ''; pw.focus(); }
  }

  async function checkSession() {
    const token = API.getSessionToken();
    if (!token) return false;
    try {
      const r = await fetch(API.WORKER + '/verify', {
        headers: { 'X-Session-Token': token },
      }).then(r => r.json());
      return !!r.success;
    } catch {
      return false;
    }
  }

  async function showApp() {
    document.getElementById('login-screen')?.classList.add('out');
    document.getElementById('app')?.classList.add('visible');
    UI.activity('Загрузка данных...');
    await Account.load();
    await Servers.load();
    UI.activity('Готово');
    if (global.App) App.startAutoRefresh();
  }

  // ── Export ──────────────────────────────────────────────────────
  global.Auth = { doLogin, doLogout, checkSession, showApp };
})(window);
