/* =============================================================================
 *  modules/account.js — страница аккаунта
 *  - load(): получает /account/ и обновляет шапку + страницу аккаунта
 *  - render(): рендерит страницу account (name, email, verified, credits)
 * ========================================================================== */

(function (global) {
  'use strict';

  let accountData = null;

  async function load() {
    const r = await API.api(API.PATHS.account);
    if (!r.success) {
      if (r.error === 'Unauthorized') Auth.doLogout();
      return null;
    }
    accountData = r.data;
    updateTopbar();
    renderAccountPage();
    return accountData;
  }

  function updateTopbar() {
    if (!accountData) return;
    const a = accountData;
    const avatarEl = document.getElementById('t-avatar');
    const nameEl = document.getElementById('t-name');
    const creditsEl = document.getElementById('t-credits');
    if (avatarEl) avatarEl.textContent = UI.initials(a.name);
    if (nameEl) nameEl.textContent = a.name;
    if (creditsEl) {
      const credits = Number(a.credits) || 0;
      creditsEl.textContent = `${credits.toFixed(2)} cr`;
    }
  }

  function renderAccountPage() {
    const el = document.getElementById('account-content');
    if (!el || !accountData) return;
    const a = accountData;
    el.innerHTML = `
      <div class="section-card">
        <div class="section-card-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          Профиль
        </div>
        <div class="account-grid">
          <div class="account-row">
            <span class="account-row-label">Имя</span>
            <span class="account-row-val">${UI.escapeHtml(a.name || '—')}</span>
          </div>
          <div class="account-row">
            <span class="account-row-label">Email</span>
            <span class="account-row-val">${UI.escapeHtml(a.email || '—')}</span>
          </div>
          <div class="account-row">
            <span class="account-row-label">Верификация</span>
            ${a.verified
              ? '<span class="verified-badge">✓ Подтверждён</span>'
              : '<span class="unverified-badge">Не подтверждён</span>'}
          </div>
          <div class="account-row">
            <span class="account-row-label">Кредиты</span>
            <span class="account-row-val">${(Number(a.credits) || 0).toFixed(2)} cr</span>
          </div>
        </div>
      </div>
      <div class="section-card">
        <div class="section-card-title">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          О API-подключении
        </div>
        <div class="account-grid">
          <div class="account-row">
            <span class="account-row-label">Worker URL</span>
            <span class="account-row-val">${UI.escapeHtml(API.WORKER)}</span>
          </div>
          <div class="account-row">
            <span class="account-row-label">WebSocket</span>
            <span class="account-row-val">${API.WORKER.startsWith('https') ? 'wss' : 'ws'}://…/ws/servers/{id}</span>
          </div>
          <div class="account-row">
            <span class="account-row-label">Сессия</span>
            <span class="account-row-val">${API.getSessionToken() ? 'активна' : 'нет'}</span>
          </div>
          <div class="account-row">
            <span class="account-row-label">Источник</span>
            <span class="account-row-val">exaroton API v1</span>
          </div>
        </div>
      </div>`;
    // Также отрендерим лог аудита (если мы на странице аккаунта)
    if (global.Audit) Audit.renderInAccount();
  }

  function getData() { return accountData; }

  // ── Export ──────────────────────────────────────────────────────
  global.Account = { load, getData, updateTopbar };
})(window);
