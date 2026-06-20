/* =============================================================================
 *  app.js — главный entry point
 *  - Навигация между страницами
 *  - Переключение табов на странице сервера
 *  - Init при загрузке
 * ========================================================================== */

(function (global) {
  'use strict';

  function navTo(page, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    // Подсветка sidebar
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    const navBtn = btn || document.getElementById('nav-' + page);
    if (navBtn) navBtn.classList.add('active');

    // Логаут вкладок при уходе с server-страницы
    if (page !== 'server') {
      if (global.Console) Console.onClose();
    }

    // Фокус layout на server-странице
    setLayoutFocus(page === 'server');

    // Ленивая загрузка страниц
    if (page === 'billing' && global.Billing) Billing.onOpenPage();
    if (page === 'account' && global.Account) {
      Account.updateTopbar();
      if (global.Audit) Audit.renderInAccount();
    }
  }

  function setLayoutFocus(isServerPage) {
    const layout = document.getElementById('app-layout');
    if (!layout) return;
    layout.classList.toggle('server-focus', !!isServerPage && window.innerWidth > 768);
  }

  function detailTab(name, btn) {
    document.querySelectorAll('.dtab').forEach(el => el.style.display = 'none');
    const target = document.getElementById('dtab-' + name);
    if (target) target.style.display = 'block';
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('on'));
    if (btn) btn.classList.add('on');
    if (global.Console) Console.setTab(name);
    // Подгрузка server.properties при первом открытии настроек
    if (name === 'settings' && global.Files) {
      const cfgEl = document.getElementById('server-config-list');
      if (cfgEl && !cfgEl.dataset.loaded) {
        cfgEl.dataset.loaded = '1';
        Files.loadServerProperties();
      }
    }
  }

  function startAutoRefresh() {
    if (global.Servers) Servers.startAutoRefresh();
  }

  function onLogout() {
    if (global.Servers) Servers.stopAutoRefresh();
    if (global.Console) Console.onClose();
  }

  // ── Init ────────────────────────────────────────────────────────
  async function init() {
    // Resize listener
    window.addEventListener('resize', () => {
      const serverVisible = document.getElementById('page-server')?.classList.contains('active');
      setLayoutFocus(serverVisible);
    });

    // Enter на поле пароля
    const pw = document.getElementById('pw');
    if (pw) {
      pw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') Auth.doLogin();
      });
    }

    // Drag-and-drop в файловом браузере (один раз при загрузке)
    if (global.Files && typeof Files.initDragAndDrop === 'function') {
      Files.initDragAndDrop();
    }

    // Восстановление сессии
    if (API.getSessionToken()) {
      const valid = await Auth.checkSession();
      if (valid) {
        await Auth.showApp();
        return;
      }
      API.setSessionToken('');
    }
  }

  // Экспорт для inline-обработчиков
  global.App = { navTo, detailTab, setLayoutFocus, startAutoRefresh, onLogout, init };

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
