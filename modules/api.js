/* =============================================================================
 *  modules/api.js — HTTP API клиент + константы
 *  - api() / apiRaw() — обёртки над fetch с session-token
 *  - STATUS — маппинг кодов статусов серверов
 *  - PATHS — переиспользуемые пути к эндпоинтам
 * ========================================================================== */

(function (global) {
  'use strict';

  // ⚠️ Замени на URL своего Cloudflare Worker (с /ws поддержкой):
  const WORKER = 'https://exatronys.danvox123hyu.workers.dev';

  // ── Server status codes (см. openapi.yaml ServerStatus) ──────────
  const STATUS = {
    0:  { l: 'Офлайн',           cls: 'sp-off',   dot: 'srv-dot' },
    1:  { l: 'Онлайн',           cls: 'sp-on',    dot: 'srv-dot on' },
    2:  { l: 'Запуск',           cls: 'sp-start', dot: 'srv-dot starting' },
    3:  { l: 'Остановка',        cls: 'sp-stop',  dot: 'srv-dot stopping' },
    4:  { l: 'Перезапуск',       cls: 'sp-start', dot: 'srv-dot starting' },
    5:  { l: 'Сохранение',       cls: 'sp-stop',  dot: 'srv-dot stopping' },
    6:  { l: 'Загрузка',         cls: 'sp-start', dot: 'srv-dot starting' },
    7:  { l: 'Краш',             cls: 'sp-crash', dot: 'srv-dot stopping' },
    8:  { l: 'Ожидание',         cls: 'sp-start', dot: 'srv-dot starting' },
    9:  { l: 'Перенос',          cls: 'sp-start', dot: 'srv-dot starting' },
    10: { l: 'Подготовка',       cls: 'sp-start', dot: 'srv-dot starting' },
  };

  function statusInfo(code) {
    return STATUS[code] || STATUS[0];
  }

  // ── Session storage ──────────────────────────────────────────────
  function getSessionToken() {
    return localStorage.getItem('exaroton_session') || '';
  }
  function setSessionToken(token) {
    if (token) localStorage.setItem('exaroton_session', token);
    else localStorage.removeItem('exaroton_session');
  }

  // ── Direct exaroton token (для прямого скачивания в обход Worker) ──
  // Если установлен — фронт качает файлы напрямую с api.exaroton.com,
  // минуя Cloudflare Worker (обход лимита 100 MB на ответ).
  // НЕБЕЗОПАСНО: токен виден в DevTools. Только для личного использования!
  const EXAROTON_API_BASE = 'https://api.exaroton.com/v1';

  function getDirectToken() {
    return localStorage.getItem('exaroton_direct_token') || '';
  }
  function setDirectToken(token) {
    if (token) localStorage.setItem('exaroton_direct_token', token);
    else localStorage.removeItem('exaroton_direct_token');
  }

  // Прямой запрос к exaroton API (минуя Worker). Только если есть directToken.
  async function directApi(path, options = {}) {
    const token = getDirectToken();
    if (!token) {
      return { success: false, error: 'Direct token не установлен. Открой Account → Direct exaroton token.' };
    }
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    try {
      const r = await fetch(EXAROTON_API_BASE + path, { ...options, headers });
      return await r.json();
    } catch (e) {
      return { success: false, error: `Сеть: ${e.message || e}` };
    }
  }

  // Прямой binary-запрос (для скачивания файлов минуя Worker).
  // Возвращает Response (можно .blob() / .arrayBuffer()).
  async function directApiRaw(path, options = {}) {
    const token = getDirectToken();
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'Direct token не установлен' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Accept')) headers.set('Accept', '*/*');
    try {
      return await fetch(EXAROTON_API_BASE + path, { ...options, headers });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: String(e) }), {
        status: 0, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Прямые пути к exaroton API (для directApi/directApiRaw)
  const DIRECT_PATHS = {
    fileInfo: (id, path) => `/servers/${id}/files/info/${normalizePath(path)}/`,
    fileData: (id, path) => `/servers/${id}/files/data/${normalizePath(path)}/`,
  };

  function isDirectMode() {
    return !!getDirectToken();
  }

  // ── api() — JSON-запрос ──────────────────────────────────────────
  async function api(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': getSessionToken() },
    };
    if (body != null) opts.body = JSON.stringify(body);
    try {
      const r = await fetch(WORKER + path, opts);
      return await r.json();
    } catch (e) {
      return { success: false, error: friendlyNetworkError(e) };
    }
  }

  // ── apiRaw() — произвольный запрос (для binary) ──────────────────
  async function apiRaw(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('X-Session-Token')) headers.set('X-Session-Token', getSessionToken());
    try {
      return await fetch(WORKER + path, { ...options, headers });
    } catch (e) {
      const msg = friendlyNetworkError(e);
      return new Response(JSON.stringify({ success: false, error: msg }), {
        status: 0, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Человеко-читаемое объяснение сетевых ошибок fetch.
  function friendlyNetworkError(e) {
    const msg = (e && (e.message || String(e))) || '';
    if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
      return 'Нет соединения с сервером (Worker недоступен или нет интернета)';
    }
    if (/CORS|cross-origin/i.test(msg)) {
      return 'CORS-ошибка: Worker не разрешает запрос с этого домена';
    }
    return `Сеть: ${msg || 'неизвестная ошибка'}`;
  }

  // ── Path helpers ─────────────────────────────────────────────────
  const PATHS = {
    account: '/proxy/account/',
    servers: '/proxy/servers/',
    server: (id) => `/proxy/servers/${id}/`,
    serverLogs: (id) => `/proxy/servers/${id}/logs/`,
    serverLogsShare: (id) => `/proxy/servers/${id}/logs/share/`,
    serverRam: (id) => `/proxy/servers/${id}/options/ram/`,
    serverMotd: (id) => `/proxy/servers/${id}/options/motd/`,
    serverStart: (id) => `/proxy/servers/${id}/start/`,
    serverStop: (id) => `/proxy/servers/${id}/stop/`,
    serverRestart: (id) => `/proxy/servers/${id}/restart/`,
    serverCommand: (id) => `/proxy/servers/${id}/command/`,
    serverExtendTime: (id) => `/proxy/servers/${id}/extend-time/`,
    playerLists: (id) => `/proxy/servers/${id}/playerlists/`,
    playerList: (id, list) => `/proxy/servers/${id}/playerlists/${list}/`,
    fileInfo: (id, path) => `/proxy/servers/${id}/files/info/${normalizePath(path)}/`,
    fileData: (id, path) => `/proxy/servers/${id}/files/data/${normalizePath(path)}/`,
    fileConfig: (id, path) => `/proxy/servers/${id}/files/config/${normalizePath(path)}/`,
    pools: '/proxy/billing/pools/',
    pool: (id) => `/proxy/billing/pools/${id}/`,
    poolServers: (id) => `/proxy/billing/pools/${id}/servers/`,
    poolMembers: (id) => `/proxy/billing/pools/${id}/members/`,
    // Браузеры не дают установить кастомные заголовки на WS-handshake,
    // поэтому X-Session-Token передаётся через query-параметр ?token=...
    // Worker.js понимает оба варианта (заголовок И query).
    wsServer: (id) => `${WORKER}/ws/servers/${id}?token=${encodeURIComponent(getSessionToken())}`,
  };

  function normalizePath(path = '/') {
    if (!path || path === '/') return '/';
    const clean = String(path).replace(/\\/g, '/').replace(/\/+/g, '/');
    return clean.startsWith('/') ? clean : '/' + clean;
  }

  function parentPath(path = '/') {
    const normalized = normalizePath(path);
    if (normalized === '/') return '/';
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? '/' + parts.join('/') : '/';
  }

  function joinPath(base, name) {
    const normBase = normalizePath(base);
    if (normBase === '/') return '/' + name;
    return normBase + '/' + name;
  }

  // ── Common player list names ─────────────────────────────────────
  const PLAYER_LIST_LABELS = {
    'whitelist': 'Whitelist',
    'ops': 'Operators',
    'banned-players': 'Banned Players',
    'banned-ips': 'Banned IPs',
  };

  function playerListLabel(key) {
    return PLAYER_LIST_LABELS[key] || key;
  }

  // ── File extension → preview kind ────────────────────────────────
  const PREVIEWABLE_EXT = /\.(txt|log|json|yml|yaml|properties|cfg|conf|ini|toml|xml|md|csv|mcmeta|java|js|ts|html|css|sh|bat|gradle|json5|toml)$/i;
  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg)$/i;
  const CONFIG_EXT = /\.(properties|yml|yaml|toml|ini|conf|cfg)$/i;

  function isPreviewableFile(entry) {
    if (!entry || entry.isDirectory) return false;
    const name = (entry.name || '').toLowerCase();
    if (entry.isTextFile || entry.isConfigFile || entry.isLog) return true;
    return PREVIEWABLE_EXT.test(name);
  }

  function isImageFile(entry) {
    const name = (entry?.name || '').toLowerCase();
    return IMAGE_EXT.test(name);
  }

  function isConfigFile(entry) {
    if (!entry || entry.isDirectory) return false;
    if (entry.isConfigFile) return true;
    const name = (entry.name || '').toLowerCase();
    return CONFIG_EXT.test(name);
  }

  // ── Export ───────────────────────────────────────────────────────
  global.API = {
    WORKER,
    STATUS, statusInfo,
    getSessionToken, setSessionToken,
    api, apiRaw,
    PATHS,
    normalizePath, parentPath, joinPath,
    PLAYER_LIST_LABELS, playerListLabel,
    isPreviewableFile, isImageFile, isConfigFile,
    // Прямой режим (минуя Cloudflare Worker)
    getDirectToken, setDirectToken, isDirectMode,
    directApi, directApiRaw, DIRECT_PATHS,
  };
})(window);
