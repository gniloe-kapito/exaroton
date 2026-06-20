/* =============================================================================
 *  modules/servers.js — список серверов + детальная страница + actions
 *
 *  Функции:
 *    - load(): получить список серверов и отрендерить главную
 *    - silentRefresh(): тихое обновление (для авто-поллинга)
 *    - openServer(id): перейти на детальную страницу
 *    - loadServer(id): получить один сервер + опции (RAM, MOTD)
 *    - updateDetailUI(): обновить карточки детальной страницы
 *    - srvAct(action, opts): start/stop/restart (start поддерживает useOwnCredits)
 *    - extendStop(): правильно использует /extend-time с {time: seconds}
 *    - setRam(), setMotd(): сохранение настроек
 * ========================================================================== */

(function (global) {
  'use strict';

  let servers = [];
  let currentSrv = null;
  let autoRefreshTimer = null;
  let runtimeSettingsLoadedFor = null;

  function getServers() { return servers; }
  function getCurrent() { return currentSrv; }

  // ── Загрузка списка серверов ────────────────────────────────────
  async function load() {
    const r = await API.api(API.PATHS.servers);
    if (!r.success) {
      UI.toast(r.error || 'Не удалось получить список серверов', 'err');
      return;
    }
    servers = mergeRuntime(r.data || []);
    renderSidebar();
    renderGrid();
  }

  function mergeRuntime(nextServers = []) {
    const runtimeById = new Map(
      [...servers, currentSrv].filter(Boolean).map(s => [s.id, s])
    );
    return nextServers.map(server => {
      const runtime = runtimeById.get(server.id);
      return runtime
        ? { ...runtime, ...server, ram: server.ram ?? runtime.ram, motd: server.motd ?? runtime.motd }
        : server;
    });
  }

  function renderSidebar() {
    const sb = document.getElementById('sidebar-servers');
    if (!sb) return;
    if (!servers.length) { sb.innerHTML = ''; return; }
    sb.innerHTML = '<div class="sidebar-label">Серверы</div>' + servers.map(s => {
      const st = API.statusInfo(s.status);
      return `<button class="sidebar-srv${currentSrv?.id === s.id ? ' active' : ''}" onclick="Servers.open('${s.id}')">
        <span class="${st.dot}" style="width:6px;height:6px;border-radius:50%;flex-shrink:0;display:inline-block;"></span>
        <span class="sidebar-srv-name">${UI.escapeHtml(s.name)}</span>
      </button>`;
    }).join('');
  }

  function renderGrid() {
    const grid = document.getElementById('servers-grid');
    const sub = document.getElementById('home-sub');
    if (sub) sub.textContent = `${servers.length} ${pluralize(servers.length, 'сервер', 'сервера', 'серверов')}`;

    if (!grid) return;
    if (!servers.length) {
      grid.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-2.18c.07-.44.18-.88.18-1a3 3 0 0 0-6 0c0 .12.11.56.18 1H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z"/></svg>
        <p>Серверов нет</p>
      </div>`;
      return;
    }

    // Компактные карточки — кнопки только start/stop (restart внутри детали)
    grid.innerHTML = servers.map(s => {
      const st = API.statusInfo(s.status);
      const isOffline = s.status === 0;
      const isOnline = s.status === 1;
      const playersStr = s.players ? `${s.players.count}/${s.players.max}` : '—';
      const ramStr = s.ram ? `${s.ram}GB` : '—';
      const verStr = s.software?.version || s.software?.name || '—';
      return `<div class="server-card" onclick="Servers.open('${s.id}')">
        <div class="sc-head">
          <div>
            <div class="sc-name">${UI.escapeHtml(s.name)}</div>
            <div class="sc-addr">${UI.escapeHtml(s.address)}</div>
          </div>
          <span class="status-pill ${st.cls}">
            <span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;"></span>
            ${st.l}
          </span>
        </div>
        <div class="sc-metrics">
          <div class="sc-metric">
            <div class="sc-metric-label">Игроки</div>
            <div class="sc-metric-val">${playersStr}</div>
          </div>
          <div class="sc-metric">
            <div class="sc-metric-label">RAM</div>
            <div class="sc-metric-val">${ramStr}</div>
          </div>
          <div class="sc-metric">
            <div class="sc-metric-label">Версия</div>
            <div class="sc-metric-val small">${UI.escapeHtml(verStr)}</div>
          </div>
        </div>
        <div class="sc-actions">
          <button class="btn btn-green btn-sm" ${!isOffline ? 'disabled' : ''} title="Запустить" aria-label="Запустить" onclick="event.stopPropagation(); Servers.act('start','${s.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="btn btn-red btn-sm" ${!isOnline ? 'disabled' : ''} title="Остановить" aria-label="Остановить" onclick="event.stopPropagation(); Servers.act('stop','${s.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
          </button>
          <button class="btn btn-sm" ${!isOnline ? 'disabled' : ''} title="Перезапустить" aria-label="Перезапустить" onclick="event.stopPropagation(); Servers.act('restart','${s.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  function pluralize(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ── Тихое обновление (auto-refresh) ─────────────────────────────
  async function silentRefresh() {
    const r = await API.api(API.PATHS.servers);
    if (!r.success) return;
    servers = mergeRuntime(r.data || []);
    renderSidebar();
    // Если на главной — обновить только статусы в карточках (без поломки кликов)
    if (document.getElementById('page-home')?.classList.contains('active')) {
      // Обновим только пеллы и метрики (минимально инвазивно)
      const cards = document.querySelectorAll('#servers-grid .server-card');
      cards.forEach((card, i) => {
        const s = servers[i];
        if (!s) return;
        const pill = card.querySelector('.status-pill');
        const st = API.statusInfo(s.status);
        if (pill) {
          pill.className = 'status-pill ' + st.cls;
          pill.innerHTML = `<span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;"></span>${st.l}`;
        }
        const metrics = card.querySelectorAll('.sc-metric-val');
        if (metrics.length >= 3) {
          metrics[0].textContent = s.players ? `${s.players.count}/${s.players.max}` : '—';
          metrics[1].textContent = s.ram ? `${s.ram}GB` : '—';
          metrics[2].textContent = s.software?.version || s.software?.name || '—';
        }
        // Обновим disabled-состояния кнопок
        const btns = card.querySelectorAll('.sc-actions .btn');
        if (btns.length >= 3) {
          btns[0].disabled = s.status !== 0; // start
          btns[1].disabled = s.status !== 1; // stop
          btns[2].disabled = s.status !== 1; // restart
        }
      });
    }
    if (currentSrv) {
      const fresh = servers.find(s => s.id === currentSrv.id);
      if (fresh) {
        const prevStatus = currentSrv.status;
        currentSrv = { ...currentSrv, ...fresh, ram: currentSrv.ram ?? fresh.ram, motd: currentSrv.motd ?? fresh.motd };
        updateDetailUI();
        // Если статус изменился — Console.live может захотеть переподключиться
        if (prevStatus !== currentSrv.status && global.Console && typeof Console.onServerStatusChange === 'function') {
          Console.onServerStatusChange(currentSrv.status);
        }
      }
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(silentRefresh, 30000);
  }
  function stopAutoRefresh() {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  // ── Открытие детальной страницы ─────────────────────────────────
  async function open(id) {
    const s = servers.find(x => x.id === id);
    if (!s) { UI.toast('Сервер не найден', 'err'); return; }
    currentSrv = s;
    if (global.App) App.navTo('server');
    renderSidebar();

    // Сбросить табы в консоль
    document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('on', i === 0));
    document.querySelectorAll('.dtab').forEach((el, i) => el.style.display = i === 0 ? 'block' : 'none');

    await loadServer(id);
    if (global.Console) Console.onOpenServer();
    if (global.Players) Players.onOpenServer();
    if (global.Files) Files.onOpenServer();
  }

  async function loadServer(id) {
    const r = await API.api(API.PATHS.server(id));
    if (!r.success) { UI.toast(r.error || 'Не удалось загрузить сервер', 'err'); return; }
    currentSrv = { ...currentSrv, ...r.data, ram: currentSrv?.ram, motd: currentSrv?.motd };
    servers = servers.map(s => s.id === id ? currentSrv : s);
    await loadRuntimeSettings();
    updateDetailUI();
  }

  async function loadRuntimeSettings() {
    if (!currentSrv) return;
    const [ramResp, motdResp] = await Promise.all([
      API.api(API.PATHS.serverRam(currentSrv.id)),
      API.api(API.PATHS.serverMotd(currentSrv.id)),
    ]);
    if (ramResp?.success && Number.isFinite(Number(ramResp.data?.ram))) {
      currentSrv.ram = Number(ramResp.data.ram);
    }
    if (motdResp?.success && typeof motdResp.data?.motd === 'string') {
      currentSrv.motd = motdResp.data.motd;
    }
    runtimeSettingsLoadedFor = currentSrv.id;
  }

  function updateDetailUI() {
    if (!currentSrv) return;
    const s = currentSrv;
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    setText('d-name', s.name);
    setText('d-addr', s.address);

    const st = API.statusInfo(s.status);
    const pill = document.getElementById('d-status-pill');
    if (pill) {
      pill.className = 'status-pill ' + st.cls;
      pill.innerHTML = `<span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;margin-right:4px;"></span>${st.l}`;
    }

    setText('d-players', s.players ? String(s.players.count) : '—');
    setText('d-max-players', s.players ? `из ${s.players.max} слотов` : '');
    setText('d-ram', s.ram ? String(s.ram) : '—');
    setText('d-ver', s.software?.version || '—');
    setText('d-sw', s.software?.name || '—');

    const on = s.status === 1, off = s.status === 0;
    const dStart = document.getElementById('d-start');
    const dStop = document.getElementById('d-stop');
    const dRestart = document.getElementById('d-restart');
    if (dStart) dStart.disabled = !off;
    if (dStop) dStop.disabled = !on;
    if (dRestart) dRestart.disabled = !on;

    // RAM slider
    if (s.ram) {
      const sl = document.getElementById('ram-sl');
      if (sl) {
        sl.max = Math.max(16, Number(s.ram) || 16);
        sl.value = s.ram;
        updateRamSlider(sl);
      }
    }
    // MOTD
    if (typeof s.motd === 'string') {
      const motdIn = document.getElementById('motd-in');
      if (motdIn) {
        motdIn.value = s.motd;
        renderMotdPreview(s.motd);
      }
    }
    const ramSub = document.getElementById('ram-sub');
    if (ramSub) {
      ramSub.textContent = s.status === 0
        ? 'Сервер остановлен — RAM можно менять'
        : 'Останови сервер для изменения RAM';
    }

    // Host/port (если онлайн)
    const hostEl = document.getElementById('d-host');
    if (hostEl) {
      hostEl.textContent = s.host && s.port ? `${s.host}:${s.port}` : '—';
    }

    // Shared indicator
    const sharedEl = document.getElementById('d-shared');
    if (sharedEl) {
      sharedEl.style.display = s.shared ? '' : 'none';
    }
  }

  // ── Действия: start / stop / restart ────────────────────────────
  // action: 'start' | 'stop' | 'restart'
  // opts:   { useOwnCredits?: boolean } — только для start
  async function act(action, serverId = null, opts = {}) {
    const srv = serverId ? servers.find(s => s.id === serverId) : currentSrv;
    if (!srv) { UI.toast('Сервер не выбран', 'err'); return; }

    const labels = {
      start: 'Запуск сервера...',
      stop: 'Остановка сервера...',
      restart: 'Перезапуск сервера...',
    };
    UI.activity(labels[action] || action);

    // Дизейблим детальные кнопки на время запроса
    const isDetail = !serverId || (currentSrv && currentSrv.id === serverId);
    const detailBtnIds = ['d-start', 'd-stop', 'd-restart', 'd-start-own'];
    const detailBtns = isDetail
      ? detailBtnIds.map(id => document.getElementById(id)).filter(Boolean)
      : [];
    detailBtns.forEach(b => { b.disabled = true; });

    let r;
    try {
      if (action === 'start') {
        // POST /start/ с {useOwnCredits} если useOwnCredits=true
        // GET /start/ в обычном случае (общие кредиты)
        if (opts.useOwnCredits) {
          r = await API.api(API.PATHS.serverStart(srv.id), 'POST', { useOwnCredits: true });
        } else {
          r = await API.api(API.PATHS.serverStart(srv.id));
        }
      } else if (action === 'stop') {
        r = await API.api(API.PATHS.serverStop(srv.id));
      } else if (action === 'restart') {
        r = await API.api(API.PATHS.serverRestart(srv.id));
      } else {
        UI.toast('Неизвестное действие', 'err');
        return;
      }
    } finally {
      // При ошибке — возвращаем кнопки в исходное состояние.
      // При успехе — НЕ трогаем: silentRefresh через 2 сек сам обновит UI
      // через loadServer() → updateDetailUI(), и кнопки получат
      // корректный disabled-state под новый статус.
      if (!r || !r.success) {
        detailBtns.forEach(b => { b.disabled = false; });
        updateDetailUI();
      }
    }

    if (r && r.success) {
      UI.toast(`Команда «${action}» отправлена`, 'ok');
      if (global.Audit) Audit.log('server.' + action, { useOwnCredits: opts.useOwnCredits });
      // Обновим через 2 сек
      setTimeout(async () => {
        if (currentSrv?.id === srv.id) {
          await loadServer(srv.id);
          if (global.Console) Console.refreshLog();
        }
        await silentRefresh();
      }, 2000);
    } else if (r) {
      UI.toast(r.error || `Ошибка команды ${action}`, 'err');
    }
  }

  // ── Старт с собственными кредитами (отдельный handler для UI) ───
  async function startWithOwnCredits() {
    const confirmed = await UI.confirmModal({
      title: 'Запустить с личных кредитов?',
      message: 'Сервер будет запущен за счёт твоих личных кредитов, а не общего пула. Продолжить?',
      okLabel: 'Запустить',
      danger: true,
    });
    if (!confirmed) return;
    await act('start', null, { useOwnCredits: true });
  }

  // ── Продлить время авто-остановки ───────────────────────────────
  // ПРАВИЛЬНО: POST /extend-time/ с {time: <секунды>}
  // (старый код использовал несуществующий /stop/extended и /command)
  async function extendStop() {
    if (!currentSrv) return;
    const minEl = document.getElementById('extend-min');
    const minutes = parseInt(minEl?.value || '60', 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      UI.toast('Укажи количество минут', 'err');
      return;
    }
    const seconds = Math.max(1, Math.min(480, minutes)) * 60;
    UI.activity('Продлеваю время работы...');
    const r = await API.api(API.PATHS.serverExtendTime(currentSrv.id), 'POST', { time: seconds });
    if (r.success) {
      UI.toast(`Время продлено на ${minutes} мин (${seconds} сек)`, 'ok');
      if (global.Audit) Audit.log('server.extend', { minutes });
    } else {
      UI.toast(r.error || 'Не удалось продлить время', 'err');
    }
  }

  // ── RAM / MOTD setters ──────────────────────────────────────────
  async function setRam() {
    if (!currentSrv) return;
    if (currentSrv.status !== 0) {
      UI.toast('Сначала останови сервер', 'err');
      return;
    }
    const sl = document.getElementById('ram-sl');
    const ram = parseInt(sl.value);
    if (!Number.isFinite(ram)) return;
    if (ram < 2 || ram > 16) {
      UI.toast('RAM должен быть от 2 до 16 GB', 'err');
      return;
    }
    UI.activity('Сохранение RAM...');
    const r = await API.api(API.PATHS.serverRam(currentSrv.id), 'POST', { ram });
    if (r.success) {
      currentSrv.ram = ram;
      updateDetailUI();
      UI.toast(`RAM: ${ram} GB`, 'ok');
      if (global.Audit) Audit.log('server.setRam', { ram });
      await loadServer(currentSrv.id);
    } else {
      UI.toast(r.error || 'Не удалось изменить RAM', 'err');
    }
  }

  async function setMotd() {
    if (!currentSrv) return;
    const motdIn = document.getElementById('motd-in');
    const motd = motdIn.value;
    const r = await API.api(API.PATHS.serverMotd(currentSrv.id), 'POST', { motd });
    if (r.success) {
      currentSrv.motd = motd;
      renderMotdPreview(motd);
      updateDetailUI();
      UI.toast('MOTD обновлён', 'ok');
      if (global.Audit) Audit.log('server.setMotd', {});
    } else {
      UI.toast(r.error || 'Не удалось изменить MOTD', 'err');
    }
  }

  function renderMotdPreview(value = '') {
    const preview = document.getElementById('motd-preview');
    if (!preview) return;
    preview.innerHTML = UI.renderMinecraftText(value?.trim() ? value : 'A Minecraft Server');
  }

  function updateRamSlider(el) {
    const val = Number(el.value), min = Number(el.min), max = Number(el.max);
    const pct = ((val - min) / (max - min) * 100).toFixed(1) + '%';
    el.style.setProperty('--pct', pct);
    const out = document.getElementById('ram-out');
    if (out) out.textContent = `${val} GB`;
  }

  // ── Export ──────────────────────────────────────────────────────
  global.Servers = {
    getServers, getCurrent,
    load, silentRefresh, startAutoRefresh, stopAutoRefresh,
    open, loadServer, updateDetailUI,
    act, startWithOwnCredits, extendStop,
    setRam, setMotd, renderMotdPreview, updateRamSlider,
  };
})(window);
