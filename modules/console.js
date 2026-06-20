/* =============================================================================
 *  modules/console.js — live-консоль + live-статистика
 *
 *  Использует WebSocket (ExarotonWS) для:
 *    - status:   real-time смена статуса сервера
 *    - console:  real-time вывод строк консоли
 *    - heap:     использование heap (для прогресс-бара)
 *    - stats:    статистика CPU/world/save
 *    - tick:     TPS и среднее время тика
 *
 *  Если WebSocket недоступен (worker не обновлён), автоматически
 *  откатывается на поллинг HTTP /logs/ каждые 8 секунд.
 * ========================================================================== */

(function (global) {
  'use strict';

  let ws = null;
  let pollTimer = null;
  let currentDetailTab = 'console';
  let lastConsoleHtml = '';
  let consoleBuffer = [];         // накопленный лог через WS
  const MAX_BUFFER_LINES = 800;

  // История команд (как в bash: ↑/↓ переключают)
  let cmdHistory = [];
  let cmdHistoryIndex = -1;       // -1 = "новая пустая строка"
  const MAX_HISTORY = 100;

  // Шаблоны быстрых команд (пользовательские кнопки, сохраняются в localStorage)
  let cmdTemplates = [];
  const TEMPLATES_KEY = 'exaroton_cmd_templates';

  // Состояние live-статистики (последние значения)
  let lastStats = { heap: null, stats: null, tick: null };

  // ── Шаблоны команд: загрузка/сохранение ─────────────────────────
  function loadCmdTemplates() {
    try {
      const raw = localStorage.getItem(TEMPLATES_KEY);
      cmdTemplates = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(cmdTemplates)) cmdTemplates = [];
    } catch { cmdTemplates = []; }
  }

  function saveCmdTemplates() {
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(cmdTemplates));
    } catch {}
  }

  function addCmdTemplate() {
    UI.promptModal({
      title: 'Новый шаблон команды',
      label: 'Команда (без /)',
      placeholder: 'say Welcome to the server!',
      okLabel: 'Добавить',
    }).then(cmd => {
      if (!cmd || !cmd.trim()) return;
      cmdTemplates.push(cmd.trim());
      saveCmdTemplates();
      renderQuickCmds();
      UI.toast(`Шаблон добавлен (${cmdTemplates.length} всего)`, 'ok');
    });
  }

  function removeCmdTemplate(index) {
    if (index < 0 || index >= cmdTemplates.length) return;
    const removed = cmdTemplates[index];
    cmdTemplates.splice(index, 1);
    saveCmdTemplates();
    renderQuickCmds();
    UI.toast(`Удалено: ${removed}`, 'ok');
  }

  function renderQuickCmds() {
    const container = document.getElementById('user-cmd-templates');
    if (!container) return;
    const defaultCmds = ['list', 'save-all', 'save-on', 'save-off', 'tps', 'mem', 'time set day', 'time set night', 'weather clear', 'stop'];
    const defaultsHtml = defaultCmds.map(c =>
      `<button class="btn btn-sm" onclick="Console.quickCmd('${UI.escapeHtml(c)}')">${UI.escapeHtml(c)}</button>`
    ).join('');
    const userHtml = cmdTemplates.length ? cmdTemplates.map((c, i) =>
      `<button class="btn btn-sm" style="position:relative;padding-right:20px;" onclick="Console.quickCmd('${UI.escapeHtml(c)}')" title="${UI.escapeHtml(c)}">
        ${UI.escapeHtml(c.length > 20 ? c.slice(0, 18) + '…' : c)}
        <span style="position:absolute;top:-4px;right:-2px;width:14px;height:14px;border-radius:50%;background:var(--red);color:white;font-size:9px;line-height:14px;text-align:center;cursor:pointer;" onclick="event.stopPropagation();Console.removeCmdTemplate(${i})">×</span>
      </button>`
    ).join('') : '<span style="font-size:11px;color:var(--text3);">Своих шаблонов ещё нет — нажми «+ команда»</span>';
    container.innerHTML = defaultsHtml + userHtml;
  }

  // ── Открытие сервера ────────────────────────────────────────────
  function onOpenServer() {
    disconnectWS();
    stopPolling();
    consoleBuffer = [];
    lastConsoleHtml = '';
    lastStats = { heap: null, stats: null, tick: null };
    clearConsoleLog();
    clearLiveStats();
    renderQuickCmds();
    // Подключаем WS
    connectWS();
    // Первичная загрузка лога через HTTP (на случай если WS ещё не готов)
    refreshLog();
    updateWSIndicator();
  }

  // ── Подключение WS ──────────────────────────────────────────────
  function connectWS() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    try {
      ws = new ExarotonWS(srv.id);
      ws
        .on('open', () => { updateWSIndicator('connecting'); })
        .on('ready', () => {
          updateWSIndicator('connecting');
          // Подпишемся на все live-стримы
          ws.subscribe('status');
          ws.subscribe('console', { tail: 0 });
          ws.subscribe('heap');
          ws.subscribe('stats');
          ws.subscribe('tick');
        })
        .on('connected', () => { updateWSIndicator('on'); })
        .on('disconnected', () => { updateWSIndicator('off'); })
        .on('close', () => { updateWSIndicator('off'); })
        .on('status', (data) => {
          // Real-time обновление статуса сервера
          if (data && Servers.getCurrent()) {
            Servers.getCurrent().status = data.status;
            Servers.updateDetailUI();
          }
        })
        .on('consoleLine', (rawLine) => {
          // rawLine — строка из консоли (с ANSI-кодами)
          const clean = WS.parseConsoleLine(rawLine);
          appendConsoleLine(clean);
        })
        .on('heap', (data) => {
          lastStats.heap = data;
          renderLiveStats();
        })
        .on('stats', (data) => {
          lastStats.stats = data;
          renderLiveStats();
        })
        .on('tick', (data) => {
          lastStats.tick = data;
          renderLiveStats();
        })
        .on('management', ({ type, data }) => {
          // notifications — пока просто пишем в лог
          if (type === 'notification' && data?.name) {
            consoleBuffer.push(`[notification] ${data.name}`);
            trimBuffer();
            renderConsoleFromBuffer();
          }
        });
      ws.connect();
    } catch (e) {
      console.warn('[console] WS init failed, fallback to polling', e);
      startPolling();
    }
  }

  function disconnectWS() {
    if (ws) {
      try { ws.disconnect(); } catch {}
      ws = null;
    }
  }

  // ── Fallback: поллинг каждые 8 секунд ───────────────────────────
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (currentDetailTab !== 'console') return;
      refreshLog();
    }, 8000);
    updateWSIndicator('off');
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ── Смена активной вкладки ──────────────────────────────────────
  function setTab(name) {
    currentDetailTab = name;
    if (name === 'console') {
      refreshLog();
      // WS остаётся активным — он обновляет консоль в реальном времени
    }
  }

  function onServerStatusChange(newStatus) {
    // Стримы console/heap/stats/tick активны только когда сервер онлайн (status=1)
    // WS-клиент сам попробует перезапустить стримы, но можно дать подсказку
    if (ws && ws.isReady()) {
      // статус уже обновлён через WS-event, ничего не делаем
    }
  }

  // ── Рендер лога ─────────────────────────────────────────────────
  function clearConsoleLog() {
    const logEl = document.getElementById('act-log');
    if (logEl) logEl.innerHTML = '';
  }

  function appendConsoleLine(line) {
    if (!line) return;
    consoleBuffer.push(line);
    trimBuffer();
    const logEl = document.getElementById('act-log');
    if (!logEl) return;
    const wasNearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 50;
    const lineDiv = document.createElement('div');
    lineDiv.innerHTML = UI.renderMinecraftText(line);
    logEl.appendChild(lineDiv);
    if (wasNearBottom) logEl.scrollTop = logEl.scrollHeight;
    // Ограничим высоту DOM
    while (logEl.children.length > MAX_BUFFER_LINES) {
      logEl.removeChild(logEl.firstChild);
    }
  }

  function trimBuffer() {
    while (consoleBuffer.length > MAX_BUFFER_LINES) consoleBuffer.shift();
  }

  function renderConsoleFromBuffer() {
    const logEl = document.getElementById('act-log');
    if (!logEl) return;
    logEl.innerHTML = consoleBuffer.map(l => `<div>${UI.renderMinecraftText(l)}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── Refresh через HTTP (fallback + первичная загрузка) ──────────
  async function refreshLog(showToast = false) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const metaEl = document.getElementById('console-log-meta');
    if (metaEl) metaEl.textContent = ws?.isConnected() ? 'Live (WebSocket)' : 'Обновление...';

    const r = await API.api(API.PATHS.serverLogs(srv.id));
    if (!r.success) {
      if (metaEl) metaEl.textContent = 'Не удалось загрузить журнал';
      if (showToast) UI.toast(r.error || 'Ошибка журнала', 'err');
      return;
    }
    const content = r.data?.content || '';
    if (content) {
      // Если WS не подключён — рендерим весь лог. Если подключён — пропускаем,
      // т.к. WS уже добавил все строки по одной.
      if (!ws?.isConnected()) {
        consoleBuffer = content.split('\n').filter(Boolean);
        trimBuffer();
        const logEl = document.getElementById('act-log');
        if (logEl) {
          logEl.innerHTML = content ? UI.renderLogContent(content) : 'Лог пуст.';
          // Авто-скролл в самый низ при первичной загрузке
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
    } else {
      const logEl = document.getElementById('act-log');
      if (logEl && !logEl.children.length) {
        logEl.innerHTML = '<span style="color:var(--text3)">Лог пуст.</span>';
      }
    }
    if (metaEl) {
      metaEl.textContent = ws?.isConnected()
        ? `Live (WebSocket) • ${new Date().toLocaleTimeString('ru-RU')}`
        : `Последнее обновление: ${new Date().toLocaleTimeString('ru-RU')}`;
    }
    if (showToast) UI.toast('Журнал обновлён');
  }

  // ── История команд (стрелки ↑/↓) ───────────────────────────────
  function loadCmdHistory() {
    try {
      const raw = localStorage.getItem('exaroton_cmd_history');
      cmdHistory = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(cmdHistory)) cmdHistory = [];
    } catch { cmdHistory = []; }
  }

  function saveCmdHistory() {
    try {
      localStorage.setItem('exaroton_cmd_history', JSON.stringify(cmdHistory.slice(-MAX_HISTORY)));
    } catch {}
  }

  function pushCmdHistory(cmd) {
    if (!cmd) return;
    // Не дублируем последнюю
    if (cmdHistory[cmdHistory.length - 1] === cmd) return;
    cmdHistory.push(cmd);
    if (cmdHistory.length > MAX_HISTORY) cmdHistory.shift();
    saveCmdHistory();
  }

  function handleCmdKeydown(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!cmdHistory.length) return;
    const inp = e.target;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistoryIndex === -1) cmdHistoryIndex = cmdHistory.length - 1;
      else if (cmdHistoryIndex > 0) cmdHistoryIndex -= 1;
      inp.value = cmdHistory[cmdHistoryIndex] || '';
      // Поставим курсор в конец
      requestAnimationFrame(() => { inp.setSelectionRange(inp.value.length, inp.value.length); });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdHistoryIndex === -1) return;
      cmdHistoryIndex += 1;
      if (cmdHistoryIndex >= cmdHistory.length) {
        cmdHistoryIndex = -1;
        inp.value = '';
      } else {
        inp.value = cmdHistory[cmdHistoryIndex] || '';
      }
      requestAnimationFrame(() => { inp.setSelectionRange(inp.value.length, inp.value.length); });
    }
  }

  // ── Команды ─────────────────────────────────────────────────────
  async function sendCmd() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const inp = document.getElementById('cmd-in');
    const cmd = (inp.value || '').trim();
    if (!cmd) return;
    inp.value = '';
    // Сбросим индекс истории + запомним команду
    cmdHistoryIndex = -1;
    pushCmdHistory(cmd);

    // Отрисуем команду локально (echo)
    appendConsoleLine(`> ${cmd}`);
    if (global.Audit) Audit.log('console.command', { command: cmd });

    // Если активен console-stream — шлём через WS
    if (ws && ws.isConnected() && ws.startedStreams?.has('console')) {
      const ok = ws.sendConsoleCommand(cmd);
      if (ok) return;
      UI.toast('Команда не отправлена (WS занят) — пробую HTTP', 'warn');
    }
    // Fallback: HTTP POST /command/
    const r = await API.api(API.PATHS.serverCommand(srv.id), 'POST', { command: cmd });
    if (!r.success) {
      UI.toast(r.error || 'Ошибка команды', 'err');
      appendConsoleLine(`[error] ${r.error || 'command failed'}`);
      return;
    }
    setTimeout(() => refreshLog(), 800);
  }

  function quickCmd(cmd) {
    const inp = document.getElementById('cmd-in');
    if (inp) inp.value = cmd;
    sendCmd();
  }

  // ── Скачать логи / поделиться ───────────────────────────────────
  async function downloadLogs() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    UI.activity('Загрузка логов...');
    const r = await API.api(API.PATHS.serverLogs(srv.id));
    if (r.success) {
      const blob = new Blob([r.data?.content || ''], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${srv.name}-latest.log`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      UI.toast('Логи скачаны');
    } else {
      UI.toast(r.error || 'Ошибка', 'err');
    }
  }

  async function shareLogs() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    UI.activity('Публикация логов...');
    const r = await API.api(API.PATHS.serverLogsShare(srv.id));
    if (r.success && r.data?.url) {
      try { await navigator.clipboard?.writeText(r.data.url); } catch {}
      UI.toast('Ссылка скопирована: ' + r.data.url, 'ok', 5000);
    } else {
      UI.toast(r.error || 'Ошибка публикации', 'err');
    }
  }

  // ── WS-индикатор ────────────────────────────────────────────────
  function updateWSIndicator(state) {
    const el = document.getElementById('ws-indicator');
    if (!el) return;
    if (!state) {
      state = !ws ? 'off' : (ws.isServerConnected() ? 'on' : (ws.isReady() ? 'connecting' : 'off'));
    }
    const map = {
      on:         { cls: 'ws-on',         text: 'Live' },
      off:        { cls: 'ws-off',         text: 'Поллинг' },
      connecting: { cls: 'ws-connecting',  text: 'Подключение...' },
    };
    const info = map[state] || map.off;
    el.className = 'ws-indicator ' + info.cls;
    el.innerHTML = `<span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;"></span>${info.text}`;
  }

  // ── Live stats (heap/tick/stats) ────────────────────────────────
  function clearLiveStats() {
    const row = document.getElementById('live-stats-row');
    if (row) row.innerHTML = '';
  }

  function renderLiveStats() {
    const row = document.getElementById('live-stats-row');
    if (!row) return;
    const heap = lastStats.heap;
    const tick = lastStats.tick;
    const stats = lastStats.stats;

    const heapPct = heap && Number.isFinite(heap.used) && Number.isFinite(heap.total)
      ? Math.min(100, (heap.used / heap.total) * 100)
      : null;
    const heapUsedStr = heap && Number.isFinite(heap.used) ? UI.formatBytes(heap.used) : '—';
    const heapTotalStr = heap && Number.isFinite(heap.total) ? UI.formatBytes(heap.total) : '—';

    const tps = tick?.tps;
    const tickMs = tick?.averageTickTime;
    const tpsColor = tps == null ? 'var(--text3)' : (tps >= 19 ? 'var(--green-text)' : (tps >= 15 ? 'var(--amber-text)' : 'var(--red-text)'));

    row.innerHTML = `
      <div class="live-stat-card">
        <div class="live-stat-head">
          <span class="live-stat-label">Heap</span>
          <span class="live-stat-dot ${heap ? 'on' : ''}"></span>
        </div>
        <div class="live-stat-val">${heapUsedStr} <span style="font-size:13px;color:var(--text3)">/ ${heapTotalStr}</span></div>
        <div class="live-stat-bar">${heapPct != null ? `<div style="width:${heapPct.toFixed(1)}%;background:${heapPct > 85 ? 'var(--red)' : (heapPct > 65 ? 'var(--amber)' : 'var(--green)')}"></div>` : ''}</div>
        <div class="live-stat-sub">${heapPct != null ? heapPct.toFixed(1) + '%' : 'ожидание данных...'}</div>
      </div>
      <div class="live-stat-card">
        <div class="live-stat-head">
          <span class="live-stat-label">TPS</span>
          <span class="live-stat-dot ${tick ? 'on' : ''}"></span>
        </div>
        <div class="live-stat-val" style="color:${tpsColor}">${tps != null ? tps.toFixed(1) : '—'} <span style="font-size:13px;color:var(--text3)">/ 20</span></div>
        <div class="live-stat-bar">${tps != null ? `<div style="width:${(tps/20*100).toFixed(1)}%;background:${tpsColor}"></div>` : ''}</div>
        <div class="live-stat-sub">${tickMs != null ? tickMs.toFixed(2) + ' мс/тик' : 'ожидание данных...'}</div>
      </div>
      <div class="live-stat-card">
        <div class="live-stat-head">
          <span class="live-stat-label">CPU / Stats</span>
          <span class="live-stat-dot ${stats ? 'on' : ''}"></span>
        </div>
        <div class="live-stat-val" style="font-size:16px">${stats?.cpu?.toFixed?.(1) ?? '—'}<span style="font-size:13px;color:var(--text3)">%</span></div>
        <div class="live-stat-sub">CPU ${stats?.cpu != null ? stats.cpu.toFixed(1) + '%' : '—'} • World ${stats?.world ?? '—'} • Players ${stats?.players ?? '—'}</div>
      </div>`;
  }

  // ── Закрытие ────────────────────────────────────────────────────
  function onClose() {
    disconnectWS();
    stopPolling();
  }

  // ── Init: загрузка истории команд + шаблонов ────────────────────
  loadCmdHistory();
  loadCmdTemplates();

  // ── Export ──────────────────────────────────────────────────────
  global.Console = {
    onOpenServer, onClose,
    setTab, onServerStatusChange,
    refreshLog, sendCmd, quickCmd, downloadLogs, shareLogs,
    updateWSIndicator,
    handleCmdKeydown,
    clearCmdHistory: () => { cmdHistory = []; saveCmdHistory(); UI.toast('История команд очищена'); },
    addCmdTemplate, removeCmdTemplate, renderQuickCmds,
  };
})(window);
