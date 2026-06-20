/* =============================================================================
 *  modules/ui.js — общие UI-хелперы
 *  Toast, activity bar, escape, formatBytes, Minecraft text rendering,
 *  log rendering, modal helpers.
 * ========================================================================== */

(function (global) {
  'use strict';

  // ── Toast ────────────────────────────────────────────────────────
  // Ошибки показываем дольше (5 сек) — пользователь успеет прочитать.
  function toast(msg, type = 'ok', duration = null) {
    if (duration == null) duration = type === 'err' ? 5000 : 3000;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = String(msg);
    const container = document.getElementById('toast-container');
    if (!container) { console.log('[toast]', type, msg); return; }
    container.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // ── Activity bar ─────────────────────────────────────────────────
  function activity(msg) {
    const bar = document.getElementById('activity-bar');
    const msgEl = document.getElementById('activity-msg');
    if (!bar || !msgEl) return;
    msgEl.textContent = msg;
    bar.classList.add('visible');
    clearTimeout(activity._t);
    activity._t = setTimeout(() => bar.classList.remove('visible'), 3000);
  }

  // ── Escape HTML ──────────────────────────────────────────────────
  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // ── Encode a string for safe embedding inside a JS string literal
  //    within an HTML attribute (onclick="...('${X}')").
  //    encodeURIComponent covers most chars but NOT ' — replace it too.
  function encodeForJsAttr(value = '') {
    return encodeURIComponent(String(value)).replace(/'/g, '%27');
  }

  // ── Format bytes ─────────────────────────────────────────────────
  function formatBytes(size) {
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // ── Format duration (seconds → "1h 5m 12s") ──────────────────────
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}ч ${m}м`;
    if (m > 0) return `${m}м ${s}с`;
    return `${s}с`;
  }

  function formatRelativeTime(timestampMs) {
    if (!Number.isFinite(timestampMs)) return '—';
    const now = Date.now();
    const diff = Math.max(0, now - timestampMs);
    return formatDuration(diff / 1000);
  }

  // ── Minecraft text rendering (§-codes + &-codes) ─────────────────
  function renderMinecraftText(value = '') {
    const colorMap = {
      '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
      '4': '#ff5555', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
      '8': '#555555', '9': '#5555ff', 'a': '#55ff55', 'b': '#55ffff',
      'c': '#ff5555', 'd': '#ff55ff', 'e': '#ffff55', 'f': '#ffffff',
    };
    const normalized = String(value || '').replace(/&([0-9a-frlomnk])/gi, '\u00A7$1');
    let html = '';
    let buffer = '';
    let state = { color: '#ffffff', bold: false, italic: false, underline: false, strike: false };

    const flush = () => {
      if (!buffer) return;
      const decoration = [state.underline ? 'underline' : '', state.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
      html += `<span style="color:${state.color};font-weight:${state.bold ? 700 : 400};font-style:${state.italic ? 'italic' : 'normal'};text-decoration:${decoration};">${escapeHtml(buffer)}</span>`;
      buffer = '';
    };

    for (let i = 0; i < normalized.length; i += 1) {
      const char = normalized[i];
      const code = normalized[i + 1]?.toLowerCase();
      if (char === '\u00A7' && code) {
        flush();
        if (colorMap[code]) state = { color: colorMap[code], bold: false, italic: false, underline: false, strike: false };
        else if (code === 'l') state.bold = true;
        else if (code === 'o') state.italic = true;
        else if (code === 'n') state.underline = true;
        else if (code === 'm') state.strike = true;
        else if (code === 'r') state = { color: '#ffffff', bold: false, italic: false, underline: false, strike: false };
        i += 1;
        continue;
      }
      if (char === '\n') { flush(); html += '<br />'; continue; }
      buffer += char;
    }
    flush();
    return html || 'A Minecraft Server';
  }

  // ── Strip ANSI codes (from console output) ───────────────────────
  function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
  }

  // ── Render log content (ANSI stripped, §-codes rendered) ─────────
  function renderLogContent(content = '') {
    return stripAnsi(content)
      .split('\n')
      .map(line => renderMinecraftText(line))
      .join('<br />');
  }

  // ── Modal dialog (promise-based) ─────────────────────────────────
  // Закрывается по: клику на overlay, клику на action-кнопку, нажатию Escape.
  function showModal({ title, sub = '', bodyHtml = '', actions = [{ label: 'OK', value: true, primary: true }] }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${escapeHtml(title)}</div>
          ${sub ? `<div class="modal-sub">${escapeHtml(sub)}</div>` : ''}
          ${bodyHtml ? `<div class="modal-body">${bodyHtml}</div>` : ''}
          <div class="modal-actions">
            ${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-green' : ''}" data-i="${i}">${escapeHtml(a.label)}</button>`).join('')}
          </div>
        </div>`;
      document.body.appendChild(overlay);

      let resolved = false;
      const cleanup = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(null);
        }
      };
      document.addEventListener('keydown', onKey);

      overlay.querySelectorAll('button[data-i]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (resolved) return;
          resolved = true;
          const i = Number(btn.dataset.i);
          cleanup();
          resolve(actions[i].value);
        });
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(null);
        }
      });
    });
  }

  // ── Prompt dialog (promise-based, returns string or null) ────────
  function promptModal({ title, label, placeholder = '', initial = '', okLabel = 'OK', cancelLabel = 'Отмена' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${escapeHtml(title)}</div>
          ${label ? `<div class="modal-sub">${escapeHtml(label)}</div>` : ''}
          <input type="text" id="modal-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(initial)}" style="width:100%;padding:8px 11px;border:1px solid var(--border2);border-radius:var(--radius-xs);background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;outline:none;" />
          <div class="modal-actions">
            <button class="btn" data-act="cancel">${escapeHtml(cancelLabel)}</button>
            <button class="btn btn-green" data-act="ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#modal-input');
      input.focus();
      input.select();

      let resolved = false;
      const close = (value) => {
        if (resolved) return;
        resolved = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
      };
      document.addEventListener('keydown', onKey);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
      overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(input.value));
      overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  // ── Confirm dialog (promise-based, returns boolean) ──────────────
  function confirmModal({ title, message, okLabel = 'OK', cancelLabel = 'Отмена', danger = false }) {
    return showModal({
      title,
      sub: message,
      actions: [
        { label: cancelLabel, value: false, primary: false },
        { label: okLabel, value: true, primary: !danger },
      ],
    }).then(v => v === true);
  }

  // ── Initials from name ───────────────────────────────────────────
  function initials(name = '?') {
    return String(name).split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }

  // ── Debounce ─────────────────────────────────────────────────────
  function debounce(fn, ms = 200) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ── Export ───────────────────────────────────────────────────────
  global.UI = {
    toast, activity, escapeHtml, encodeForJsAttr, formatBytes, formatDuration, formatRelativeTime,
    renderMinecraftText, stripAnsi, renderLogContent,
    showModal, promptModal, confirmModal,
    initials, debounce,
  };
})(window);
