/* =============================================================================
 *  modules/audit.js — лог аудита действий пользователя
 *
 *  Логирует в localStorage действия:
 *    - start/stop/restart сервера
 *    - useOwnCredits
 *    - extend-time
 *    - команды в консоли (только отправленные, не содержимое)
 *    - изменение RAM / MOTD
 *    - saveServerProperty
 *    - создание/удаление/загрузка файлов
 *    - добавление/удаление из player lists
 *
 *  Лог можно посмотреть в Account → "Лог действий" (последние 200)
 * ========================================================================== */

(function (global) {
  'use strict';

  const AUDIT_KEY = 'exaroton_audit_log';
  const MAX_ENTRIES = 500;

  let cache = null;

  function loadLog() {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(AUDIT_KEY);
      cache = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(cache)) cache = [];
    } catch { cache = []; }
    return cache;
  }

  function saveLog() {
    try {
      localStorage.setItem(AUDIT_KEY, JSON.stringify(loadLog().slice(-MAX_ENTRIES)));
    } catch {}
  }

  function log(action, details = {}) {
    const entries = loadLog();
    const entry = {
      ts: Date.now(),
      action,
      server: Servers.getCurrent()?.name || null,
      serverId: Servers.getCurrent()?.id || null,
      details,
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    saveLog();
  }

  function getLog(limit = 200) {
    return loadLog().slice(-limit).reverse();
  }

  function clearLog() {
    cache = [];
    saveLog();
    UI.toast('Лог аудита очищен', 'ok');
  }

  // ── Рендер лога в Account страницу ──────────────────────────────
  function renderInAccount() {
    const el = document.getElementById('audit-log');
    if (!el) return;
    const entries = getLog(200);
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Действий пока не было</p></div>';
      return;
    }
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:11px;color:var(--text3);">Последние ${entries.length} действий</span>
        <button class="btn btn-ghost btn-xs" onclick="Audit.clearLog()">Очистить лог</button>
      </div>
      <div style="max-height:400px;overflow-y:auto;font-family:var(--mono);font-size:11px;">
        ${entries.map(e => {
          const time = new Date(e.ts).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
          const actionLabel = actionToLabel(e.action, e.details);
          const serverTag = e.server ? `<span style="color:var(--blue-text);">[${UI.escapeHtml(e.server)}]</span> ` : '';
          return `<div style="padding:5px 8px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:flex-start;">
            <span style="color:var(--text3);flex-shrink:0;">${time}</span>
            <span style="color:var(--text2);">${serverTag}${UI.escapeHtml(actionLabel)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  function actionToLabel(action, d) {
    switch (action) {
      case 'server.start': return `▶ Запуск сервера${d.useOwnCredits ? ' (свои кредиты)' : ''}`;
      case 'server.stop': return '■ Остановка сервера';
      case 'server.restart': return '↻ Перезапуск сервера';
      case 'server.extend': return `⏱ Продление на ${d.minutes || '?'} мин`;
      case 'server.setRam': return `RAM → ${d.ram || '?'} GB`;
      case 'server.setMotd': return `MOTD обновлён`;
      case 'console.command': return `> ${d.command || ''}`;
      case 'config.save': return `server.properties: ${d.key} = ${d.value}`;
      case 'file.createDir': return `+ папка: ${d.path}`;
      case 'file.createFile': return `+ файл: ${d.path}`;
      case 'file.upload': return `↑ загрузка: ${d.name} (${d.size || '?'})`;
      case 'file.uploadMulti': return `↑ загрузка ${d.count} файлов`;
      case 'file.delete': return `× удаление: ${d.path}`;
      case 'file.deleteMulti': return `× удаление ${d.count} файлов`;
      case 'file.save': return `✓ сохранение: ${d.path}`;
      case 'playerlist.add': return `+ ${d.list}: ${d.name}`;
      case 'playerlist.remove': return `− ${d.list}: ${d.name}`;
      default: return action;
    }
  }

  // ── Export ──────────────────────────────────────────────────────
  global.Audit = { log, getLog, clearLog, renderInAccount };
})(window);
