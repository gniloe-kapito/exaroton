/* =============================================================================
 *  modules/ws.js — Exaroton WebSocket клиент
 *
 *  Подключается к WORKER + /ws/servers/{id}, который проксирует соединение
 *  к wss://api.exaroton.com/v1/servers/{id}/websocket с Bearer-токеном.
 *
 *  Поддерживаемые стримы:
 *    - status:     real-time смена статуса сервера
 *    - console:    real-time вывод консоли (с возможностью отправлять команды)
 *    - heap:       использование heap памяти (раз в секунду)
 *    - stats:      статистика CPU/world/save
 *    - tick:       TPS и среднее время тика
 *    - management: notifications (используем только для уведомлений)
 *
 *  Протокол exaroton WS:
 *    Входящие: { type: "ready" | "connected" | "disconnected" | "keep-alive" | "status", data? }
 *              { stream: "<name>", type: "started" | "stopped" | <data-type>, data? }
 *    Исходящие: { stream: "<name>", type: "start" | "stop" | "command", data? }
 * ========================================================================== */

(function (global) {
  'use strict';

  const RECONNECT_INTERVAL = 3000;     // 3 секунды между попытками
  const STREAM_RETRY_INTERVAL = 15000; // 15 секунд на retry старта стримов

  // Статусы сервера exaroton (см. openapi.yaml ServerStatus)
  const STATUS_OFFLINE = 0;
  const STATUS_ONLINE = 1;
  const STATUS_STARTING = 2;
  const STATUS_STOPPING = 3;
  const STATUS_RESTARTING = 4;

  // Какие статусы нужны каждому стриму (как в официальной библиотеке):
  // console — ONLINE/STARTING/STOPPING/RESTARTING (можно смотреть консоль при запуске/остановке)
  // heap/stats/tick — только ONLINE
  // status/management — всегда (не требуют проверки статуса)
  const STREAM_START_STATUSES = {
    console: [STATUS_ONLINE, STATUS_STARTING, STATUS_STOPPING, STATUS_RESTARTING],
    heap: [STATUS_ONLINE],
    stats: [STATUS_ONLINE],
    tick: [STATUS_ONLINE],
  };

  class ExarotonWS {
    constructor(serverId, initialStatus = null) {
      this.serverId = serverId;
      this.url = API.PATHS.wsServer(serverId);

      this.ws = null;
      this.shouldConnect = false;
      this.ready = false;
      this.serverConnected = false;
      this.reconnectTimer = null;
      this.streamRetryTimer = null;
      this.streamRestartTimer = null;

      // Подписанные стримы (name → true|{startData})
      this.subscribedStreams = new Map();

      // Активные стримы (name → true)
      this.startedStreams = new Set();

      // Callbacks: { open, close, ready, status, consoleLine, heap, stats, tick, management }
      this.handlers = {};

      // Последний статус сервера. Берём из Servers.getCurrent() при создании,
      // обновляется при каждом status-event от WS.
      this.lastStatus = (initialStatus != null) ? initialStatus : (global.Servers?.getCurrent()?.status ?? null);
    }

    // ── Управление подписками ─────────────────────────────────────
    on(event, fn) { this.handlers[event] = fn; return this; }
    off(event) { delete this.handlers[event]; return this; }
    _emit(event, ...args) { if (this.handlers[event]) this.handlers[event](...args); }

    // ── Подключение ───────────────────────────────────────────────
    connect() {
      if (this.shouldConnect) return;
      this.shouldConnect = true;
      this._open();
    }

    _open() {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        console.error('[ws] cannot construct WebSocket', e);
        this._scheduleReconnect();
        return;
      }

      this.ws.addEventListener('open', () => {
        console.log('[ws] open');
        this._emit('open');
        // Запускаем retry старта стримов
        if (!this.streamRetryTimer) {
          this.streamRetryTimer = setInterval(() => this._tryStartAllStreams(), STREAM_RETRY_INTERVAL);
        }
      });

      this.ws.addEventListener('message', (event) => {
        this._onMessage(event.data);
      });

      this.ws.addEventListener('close', () => {
        console.log('[ws] close');
        this.ready = false;
        this.serverConnected = false;
        this.startedStreams.clear();
        this._emit('close');
        if (this.shouldConnect) this._scheduleReconnect();
      });

      this.ws.addEventListener('error', (e) => {
        console.error('[ws] error', e);
      });
    }

    _scheduleReconnect() {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (this.shouldConnect) this._open();
      }, RECONNECT_INTERVAL);
    }

    disconnect() {
      this.shouldConnect = false;
      clearTimeout(this.reconnectTimer);
      clearInterval(this.streamRetryTimer);
      clearTimeout(this.streamRestartTimer);
      this.reconnectTimer = null;
      this.streamRetryTimer = null;
      this.streamRestartTimer = null;
      this.subscribedStreams.clear();
      this.startedStreams.clear();
      if (this.ws) {
        try { this.ws.close(); } catch {}
      }
      this.ws = null;
    }

    isConnected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
    isReady() { return this.ready; }
    isServerConnected() { return this.serverConnected; }

    // ── Обработка сообщений ───────────────────────────────────────
    _onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'keep-alive':
          return;
        case 'ready':
          this.ready = true;
          this._emit('ready');
          this._tryStartAllStreams();
          return;
        case 'connected':
          this.serverConnected = true;
          this._emit('connected');
          return;
        case 'disconnected':
          this.serverConnected = false;
          this._emit('disconnected');
          // Попробуем перезапустить стримы через RECONNECT_INTERVAL
          clearTimeout(this.streamRestartTimer);
          this.streamRestartTimer = setTimeout(() => {
            this.streamRestartTimer = null;
            this._tryStartAllStreams();
          }, RECONNECT_INTERVAL);
          return;
        case 'status':
          if (msg.stream === 'status') {
            this.lastStatus = msg.data;
            this._emit('status', msg.data);
            // Статус сервера изменился — перепроверим стримы
            // (например, при переходе OFFLINE → ONLINE надо стартовать heap/stats/tick)
            this._tryStartAllStreams();
            return;
          }
          // fall through для status-стримов
      }

      // Маршрутизация стрим-сообщений
      if (msg.stream) {
        this._onStreamMessage(msg);
      }
    }

    _onStreamMessage(msg) {
      const { stream, type, data } = msg;
      if (type === 'started') {
        this.startedStreams.add(stream);
        this._emit(`${stream}:started`);
        return;
      }
      if (type === 'stopped') {
        this.startedStreams.delete(stream);
        this._emit(`${stream}:stopped`);
        return;
      }
      // Данные стрима
      if (stream === 'console' && type === 'line') {
        this._emit('consoleLine', data);
      } else if (stream === 'heap') {
        this._emit('heap', data);
      } else if (stream === 'stats') {
        this._emit('stats', data);
      } else if (stream === 'tick' && type === 'tick') {
        // tps вычисляем на стороне клиента (как в офиц. библиотеке)
        if (data && typeof data.averageTickTime === 'number') {
          data.tps = Math.round(Math.min(1000 / data.averageTickTime, 20) * 10) / 10;
        }
        this._emit('tick', data);
      } else if (stream === 'management') {
        this._emit('management', { type, data });
      } else {
        this._emit(`${stream}:${type}`, data);
      }
    }

    // ── Отправка ──────────────────────────────────────────────────
    _send(payload) {
      if (!this.isConnected() || !this.ready) return false;
      try {
        this.ws.send(JSON.stringify(payload));
        return true;
      } catch (e) {
        console.error('[ws] send failed', e);
        return false;
      }
    }

    // ── Управление стримами ───────────────────────────────────────
    subscribe(streamName, startData = null) {
      this.subscribedStreams.set(streamName, startData || {});
      this._tryStartStream(streamName);
    }

    unsubscribe(streamName) {
      this.subscribedStreams.delete(streamName);
      this._send({ stream: streamName, type: 'stop' });
    }

    _tryStartAllStreams() {
      for (const [name] of this.subscribedStreams) {
        this._tryStartStream(name);
      }
      // Заодно остановим те, что больше не должны работать
      this._tryStopAllStreams();
    }

    _tryStartStream(name) {
      if (this.startedStreams.has(name)) return;
      if (!this.ready) return;
      const startData = this.subscribedStreams.get(name);
      if (startData === undefined) return;
      // Проверим, разрешён ли текущий статус сервера для этого стрима
      const allowedStatuses = STREAM_START_STATUSES[name];
      if (allowedStatuses && this.lastStatus != null && !allowedStatuses.includes(this.lastStatus)) {
        // Статус не подходит (например, heap требует ONLINE, а сервер OFFLINE) — пропускаем
        return;
      }
      this._send({ stream: name, type: 'start', data: startData });
    }

    // Остановить стримы, которые больше не должны работать при текущем статусе
    _tryStopAllStreams() {
      for (const name of this.startedStreams) {
        const allowedStatuses = STREAM_START_STATUSES[name];
        if (allowedStatuses && this.lastStatus != null && !allowedStatuses.includes(this.lastStatus)) {
          this._send({ stream: name, type: 'stop' });
          // server сам пришлёт 'stopped', тогда уберём из startedStreams
        }
      }
    }

    // ── Отправка команды в консоль (через console stream) ─────────
    sendConsoleCommand(command) {
      return this._send({ stream: 'console', type: 'command', data: command });
    }
  }

  // ── ANSI-stripping для консоли (как в офиц. библиотеке) ─────────
  const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

  function parseConsoleLine(line) {
    let str = String(line).replace(/^\r|\r$/, '');
    const rIndex = str.lastIndexOf('\r');
    if (rIndex !== -1) str = str.substr(rIndex + 1);
    return str.replace(ANSI_REGEX, '');
  }

  // ── Export ──────────────────────────────────────────────────────
  global.ExarotonWS = ExarotonWS;
  global.WS = {
    ExarotonWS,
    parseConsoleLine,
  };
})(window);
