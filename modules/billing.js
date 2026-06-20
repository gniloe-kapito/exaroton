/* =============================================================================
 *  modules/billing.js — страница Credit Pools
 *
 *  Эндпоинты:
 *    GET /billing/pools/                 → список всех пулов
 *    GET /billing/pools/{poolId}/        → детали пула
 *    GET /billing/pools/{poolId}/servers/ → серверы пула
 *    GET /billing/pools/{poolId}/members/ → участники пула
 * ========================================================================== */

(function (global) {
  'use strict';

  let pools = [];
  let currentPool = null;
  let currentPoolServers = [];
  let currentPoolMembers = [];

  async function load() {
    UI.activity('Загрузка кредитных пулов...');
    const r = await API.api(API.PATHS.pools);
    if (!r.success) {
      UI.toast(r.error || 'Не удалось загрузить пулы', 'err');
      renderPoolsList([]);
      return;
    }
    pools = Array.isArray(r.data) ? r.data : [];
    renderPoolsList(pools);
    UI.activity('Готово');
  }

  function renderPoolsList(list) {
    const grid = document.getElementById('pools-grid');
    const sub = document.getElementById('pools-sub');
    if (sub) sub.textContent = `${list.length} ${pluralize(list.length, 'пул', 'пула', 'пулов')}`;
    if (!grid) return;
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V6H12v10zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
        <p>Кредитных пулов нет</p>
      </div>`;
      return;
    }
    grid.innerHTML = list.map(p => `
      <div class="pool-card${currentPool?.id === p.id ? ' selected' : ''}" onclick="Billing.open('${p.id}')">
        <div class="pool-head">
          <div>
            <div class="pool-name">${UI.escapeHtml(p.name)}</div>
            <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:2px;">${UI.escapeHtml(p.id)}</div>
          </div>
          ${p.isOwner ? '<span class="pool-owner-tag">Владелец</span>' : ''}
        </div>
        <div class="pool-stats">
          <div>
            <div class="pool-stat-label">Кредиты</div>
            <div class="pool-stat-val">${(Number(p.credits) || 0).toFixed(2)}</div>
          </div>
          <div>
            <div class="pool-stat-label">Моя доля</div>
            <div class="pool-stat-val">${(Number(p.ownCredits) || 0).toFixed(2)}</div>
          </div>
          <div>
            <div class="pool-stat-label">Серверов</div>
            <div class="pool-stat-val">${p.servers || 0}</div>
          </div>
          <div>
            <div class="pool-stat-label">Участников</div>
            <div class="pool-stat-val">${p.members || 0}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  function pluralize(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  async function open(poolId) {
    UI.activity('Загрузка деталей пула...');
    const [poolR, serversR, membersR] = await Promise.all([
      API.api(API.PATHS.pool(poolId)),
      API.api(API.PATHS.poolServers(poolId)),
      API.api(API.PATHS.poolMembers(poolId)),
    ]);
    if (!poolR.success) {
      UI.toast(poolR.error || 'Не удалось открыть пул', 'err');
      return;
    }
    currentPool = poolR.data;
    currentPoolServers = serversR.success && Array.isArray(serversR.data) ? serversR.data : [];
    currentPoolMembers = membersR.success && Array.isArray(membersR.data) ? membersR.data : [];
    renderPoolsList(pools); // подсветить selected
    renderDetail();
    UI.activity('Готово');
  }

  function renderDetail() {
    const el = document.getElementById('pool-detail');
    if (!el || !currentPool) { if (el) el.innerHTML = ''; return; }
    const p = currentPool;
    el.innerHTML = `
      <div class="section-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin-bottom:14px;">
          <div>
            <div style="font-size:18px;font-weight:600;color:var(--text);letter-spacing:-0.01em;">${UI.escapeHtml(p.name)}</div>
            <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-top:2px;">ID: ${UI.escapeHtml(p.id)}</div>
          </div>
          ${p.isOwner ? '<span class="pool-owner-tag">Ты владелец</span>' : ''}
        </div>
        <div class="bento" style="margin-bottom:0;">
          <div class="bento-card">
            <div class="bento-card-title">Всего кредитов</div>
            <div class="big-num">${(Number(p.credits) || 0).toFixed(2)}</div>
            <div class="big-sub">в пуле</div>
          </div>
          <div class="bento-card">
            <div class="bento-card-title">Моя доля</div>
            <div class="big-num">${(Number(p.ownCredits) || 0).toFixed(2)}</div>
            <div class="big-sub">${((Number(p.ownShare) || 0) * 100).toFixed(1)}% от пула</div>
          </div>
          <div class="bento-card">
            <div class="bento-card-title">Серверов</div>
            <div class="big-num">${p.servers || 0}</div>
            <div class="big-sub">используют пул</div>
          </div>
          <div class="bento-card">
            <div class="bento-card-title">Участников</div>
            <div class="big-num">${p.members || 0}</div>
            <div class="big-sub">в пуле</div>
          </div>
        </div>
      </div>
      <div class="pool-detail-grid">
        <div class="section-card">
          <div class="section-card-title">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            Участники (${currentPoolMembers.length})
          </div>
          ${currentPoolMembers.length ? currentPoolMembers.map(m => `
            <div class="member-row">
              <div class="member-avatar">${UI.escapeHtml(UI.initials(m.name))}</div>
              <div class="member-name">${UI.escapeHtml(m.name)}</div>
              ${m.isOwner ? '<span class="member-owner-badge">Owner</span>' : ''}
              <div class="member-share">${(Number(m.share) * 100).toFixed(1)}% • ${(Number(m.credits) || 0).toFixed(2)} cr</div>
            </div>
          `).join('') : '<div class="empty-state"><p>Участников нет</p></div>'}
        </div>
        <div class="section-card">
          <div class="section-card-title">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-2.18c.07-.44.18-.88.18-1a3 3 0 0 0-6 0c0 .12.11.56.18 1H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z"/></svg>
            Серверы пула (${currentPoolServers.length})
          </div>
          ${currentPoolServers.length ? currentPoolServers.map(s => {
            const st = API.statusInfo(s.status);
            return `<div class="pool-server-row" style="cursor:pointer;" onclick="Servers.open('${s.id}'); App.navTo('server');">
              <span class="srv-dot ${st.dot.replace('srv-dot ', '')}" style="width:6px;height:6px;border-radius:50%;flex-shrink:0;"></span>
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${UI.escapeHtml(s.name)}</div>
                <div style="font-size:11px;color:var(--text3);font-family:var(--mono);">${UI.escapeHtml(s.address)}</div>
              </div>
              <span class="status-pill ${st.cls}" style="font-size:9px;padding:2px 6px;">${st.l}</span>
            </div>`;
          }).join('') : '<div class="empty-state"><p>Серверов нет</p></div>'}
        </div>
      </div>`;
  }

  function onOpenPage() {
    if (!pools.length) load();
  }

  // ── Export ──────────────────────────────────────────────────────
  global.Billing = { load, open, onOpenPage };
})(window);
