/* =============================================================================
 *  modules/players.js — игроки онлайн + player lists
 *
 *  ИСПРАВЛЕНО относительно старой версии:
 *   1. Сначала вызываем GET /playerlists/ чтобы узнать ДОСТУПНЫЕ списки
 *      (а не хардкодим whitelist/ops/banned-players).
 *   2. GET /playerlists/{list}/ возвращает data КАК МАССИВ строк (а не data.entries).
 *   3. PUT /playerlists/{list}/ с телом {entries: [...]} — добавление.
 *   4. DELETE /playerlists/{list}/ с телом {entries: [...]} — удаление.
 *      (старый код шёл на /playerlists/{list}/{name} — неверный URL)
 *   5. Поддержка banned-ips и любых других кастомных списков.
 * ========================================================================== */

(function (global) {
  'use strict';

  let availableLists = [];      // Список названий с бэкенда
  let listContents = {};        // {listName: string[]}
  let currentServerId = null;

  function onOpenServer() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    currentServerId = srv.id;
    availableLists = [];
    listContents = {};
    renderOnlinePlayers();
    loadAll();
  }

  // ── Онлайн-игроки (из данных сервера) ───────────────────────────
  function renderOnlinePlayers() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const el = document.getElementById('players-online-list');
    if (!el) return;
    const players = srv.players;
    if (!players || players.count === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:1.25rem;"><p>Нет игроков онлайн</p></div>';
      return;
    }
    const list = players.list || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty-state" style="padding:1.25rem;"><p>${players.count} игрок(ов) онлайн — список ников недоступен</p></div>`;
      return;
    }
    el.innerHTML = '<div class="player-list">' + list.map(name => `
      <div class="player-row">
        <div class="player-name">
          <div class="player-avatar">${UI.escapeHtml(UI.initials(name))}</div>
          ${UI.escapeHtml(name)}
        </div>
        <div class="player-actions">
          <button class="btn player-btn" title="Выдать OP" onclick="Players.quickCmd('op ${UI.escapeHtml(name)}')">OP</button>
          <button class="btn player-btn" title="Деоп" onclick="Players.quickCmd('deop ${UI.escapeHtml(name)}')">Deop</button>
          <button class="btn player-btn" title="Кикнуть" onclick="Players.quickCmd('kick ${UI.escapeHtml(name)}')">Kick</button>
          <button class="btn player-btn btn-red" title="Забанить" onclick="Players.quickCmd('ban ${UI.escapeHtml(name)}')">Ban</button>
        </div>
      </div>`).join('') + '</div>';
  }

  function quickCmd(cmd) {
    if (global.Console) Console.quickCmd(cmd);
  }

  // ── Загрузка доступных списков ──────────────────────────────────
  async function loadAll() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const r = await API.api(API.PATHS.playerLists(srv.id));
    if (!r.success) {
      renderListsError(r.error || 'Не удалось получить списки игроков');
      return;
    }
    // data — массив строк (названия списков)
    availableLists = Array.isArray(r.data) ? r.data : [];
    // Загружаем содержимое каждого списка
    await Promise.all(availableLists.map(name => loadList(name)));
    renderLists();
  }

  async function loadList(listName) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const r = await API.api(API.PATHS.playerList(srv.id, listName));
    if (!r.success) {
      listContents[listName] = [];
      return;
    }
    // data — массив строк (а НЕ data.entries, как было в старом коде)
    listContents[listName] = Array.isArray(r.data) ? r.data : [];
  }

  function renderListsError(msg) {
    const el = document.getElementById('player-lists-grid');
    if (!el) return;
    el.innerHTML = `<div class="empty-state" style="padding:1.5rem;"><p>${UI.escapeHtml(msg)}</p></div>`;
  }

  function renderLists() {
    const el = document.getElementById('player-lists-grid');
    if (!el) return;
    if (!availableLists.length) {
      el.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Списки игроков не доступны (сервер должен быть запущен)</p></div>';
      return;
    }
    el.innerHTML = '<div class="player-list-grid">' + availableLists.map(name => {
      const entries = listContents[name] || [];
      return `<div class="player-list-card">
        <div class="player-list-card-head">
          <span class="player-list-card-name">${UI.escapeHtml(API.playerListLabel(name))}</span>
          <span class="player-list-card-count">${entries.length}</span>
        </div>
        <div class="player-list-entries" id="pl-entries-${UI.escapeHtml(name)}">
          ${entries.length ? entries.map(n => `
            <span class="player-chip">
              ${UI.escapeHtml(n)}
              <button title="Удалить" onclick="Players.removeEntry('${UI.escapeHtml(name)}','${UI.escapeHtml(n)}')">×</button>
            </span>`).join('') : '<span style="font-size:11px;color:var(--text3)">Список пуст</span>'}
        </div>
        <div class="cmd-row">
          <input type="text" placeholder="${name === 'banned-ips' ? 'IP или ник' : 'Ник игрока'}" id="pl-input-${UI.escapeHtml(name)}" style="font-size:12px;" onkeydown="if(event.key==='Enter')Players.addEntry('${UI.escapeHtml(name)}')" />
          <button class="btn btn-green btn-sm" onclick="Players.addEntry('${UI.escapeHtml(name)}')">+</button>
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  // ── Добавление записи ───────────────────────────────────────────
  // ПРАВИЛЬНО: PUT /playerlists/{list}/ с {entries: [name]}
  async function addEntry(listName) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const input = document.getElementById('pl-input-' + listName);
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    UI.activity(`Добавление в ${listName}...`);
    const r = await API.api(API.PATHS.playerList(srv.id, listName), 'PUT', { entries: [name] });
    if (r.success) {
      UI.toast(`${name} → ${API.playerListLabel(listName)}`, 'ok');
      if (global.Audit) Audit.log('playerlist.add', { list: listName, name });
      await loadList(listName);
      renderLists();
    } else {
      UI.toast(r.error || 'Не удалось добавить', 'err');
    }
  }

  // ── Удаление записи ─────────────────────────────────────────────
  // ПРАВИЛЬНО: DELETE /playerlists/{list}/ с {entries: [name]} в body
  async function removeEntry(listName, name) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const confirmed = await UI.confirmModal({
      title: 'Удалить запись?',
      message: `Удалить «${name}» из списка «${API.playerListLabel(listName)}»?`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    UI.activity(`Удаление из ${listName}...`);
    const r = await API.api(API.PATHS.playerList(srv.id, listName), 'DELETE', { entries: [name] });
    if (r.success) {
      UI.toast(`${name} удалён из ${API.playerListLabel(listName)}`, 'ok');
      if (global.Audit) Audit.log('playerlist.remove', { list: listName, name });
      await loadList(listName);
      renderLists();
    } else {
      UI.toast(r.error || 'Не удалось удалить', 'err');
    }
  }

  // ── Экспорт ─────────────────────────────────────────────────────
  global.Players = {
    onOpenServer,
    renderOnlinePlayers,
    loadAll, loadList, renderLists,
    addEntry, removeEntry,
    quickCmd,
  };
})(window);
