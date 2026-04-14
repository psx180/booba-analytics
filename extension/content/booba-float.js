// booba-float.js — floating avatar injected into Pacifica pages
(function () {
  'use strict';

  const EXTENSION_URL = chrome.runtime.getURL('');

  const MOODS = {
    calm:      'assets/booba-calm.svg',
    alert:     'assets/booba-alert.svg',
    nervous:   'assets/booba-nervous.svg',
    panicking: 'assets/booba-panicking.svg',
    money:     'assets/booba-money.svg',
    pout:      'assets/booba-pout.svg',
    excited:   'assets/booba-alert.svg',
  };

  // ── Persistent state ─────────────────────────────────────────────────────────
  let currentMood    = 'calm';
  let infoPanelOpen  = false;
  let isDragging     = false;
  let dragOffsetX    = 0, dragOffsetY = 0;
  let dragMoved      = false;
  let root           = null;

  // SSE
  let sseSource         = null;
  let sseReconnectTimer = null;

  // Timers
  let moodResetTimer      = null;
  let popupDismissTimer   = null;
  let popupCountdownTimer = null;
  let sessionTimerInt     = null;

  // Session tracking
  let sessionStart      = Date.now();
  let sessionTrades     = 0;
  let sessionWarned     = false;
  let lastTrade         = null; // { symbol, side, pnl }

  // Analytics cache
  let analyticsCache    = null; // { data, ts }
  const CACHE_TTL       = 5 * 60 * 1000;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function moodUrl(mood) {
    return EXTENSION_URL + (MOODS[mood] || MOODS.calm);
  }

  // ── Mood management ──────────────────────────────────────────────────────────

  function setMood(mood, durationMs) {
    currentMood = mood;
    const url = moodUrl(mood);
    if (root) {
      const img = root.querySelector('.booba-avatar img');
      if (img) img.src = url;
      const panelImg = root.querySelector('.booba-info-panel__mood img');
      if (panelImg) panelImg.src = url;
    }
    if (moodResetTimer) { clearTimeout(moodResetTimer); moodResetTimer = null; }
    if (durationMs && mood !== 'calm') {
      moodResetTimer = setTimeout(() => setMood('calm'), durationMs);
    }
  }

  // ── Connection dot ───────────────────────────────────────────────────────────

  function setConnectionDot(state) {
    if (!root) return;
    let dot = root.querySelector('.booba-status-dot');
    if (state === 'none') { if (dot) dot.remove(); return; }
    if (!dot) {
      dot = document.createElement('div');
      root.appendChild(dot);
    }
    dot.className = 'booba-status-dot booba-status-dot--' + state;
  }

  // ── Session badge ────────────────────────────────────────────────────────────

  function createSessionBadge() {
    const badge = document.createElement('div');
    badge.id = 'booba-session-badge';
    root.appendChild(badge);
    refreshSessionBadge(badge);
    return badge;
  }

  function refreshSessionBadge(badge) {
    const el = badge || (root && root.querySelector('#booba-session-badge'));
    if (!el) return;
    const mins = Math.floor((Date.now() - sessionStart) / 60000);
    el.textContent = 'Session: ' + (mins > 0 ? mins + 'm' : '<1m') + ' | ' + sessionTrades + ' trades';
    el.className = 'booba-session-badge' + (sessionWarned ? ' booba-session-badge--warning' : '');
  }

  // ── Position helper ──────────────────────────────────────────────────────────

  function getPositionStyles(settings) {
    const m = 16;
    if (settings.position === 'bottom-left') {
      return { bottom: m + 'px', left: m + 'px', right: 'auto', top: 'auto' };
    }
    return { bottom: m + 'px', right: m + 'px', left: 'auto', top: 'auto' };
  }

  // ── Avatar builder ───────────────────────────────────────────────────────────

  function buildAvatar(settings) {
    const size = settings.boobaSize || 50;
    const img  = document.createElement('img');
    img.src        = moodUrl(currentMood);
    img.alt        = 'Booba';
    img.draggable  = false;

    const avatar   = document.createElement('div');
    avatar.className = 'booba-avatar';
    avatar.style.setProperty('--booba-size', size + 'px');
    avatar.style.width  = size + 'px';
    avatar.style.height = size + 'px';
    avatar.appendChild(img);
    return avatar;
  }

  // ── Info panel ───────────────────────────────────────────────────────────────

  function openInfoPanel(settings) {
    if (infoPanelOpen) return;
    infoPanelOpen = true;

    const size   = settings.boobaSize || 50;
    const isLeft = settings.position === 'bottom-left';

    const avatar = root.querySelector('.booba-avatar');
    if (avatar) avatar.classList.add('booba-avatar--paused');

    const panel  = document.createElement('div');
    panel.id     = 'booba-info-panel';
    panel.className = 'booba-info-panel' + (isLeft ? ' booba-info-panel--left' : '');
    // Position above the session badge (badge is ~26px, gap 6px, total ~32px above avatar top)
    panel.style.bottom = (size + 38) + 'px';
    if (isLeft) panel.style.left = '0';
    else        panel.style.right = '0';

    // ── Header ──
    const header   = document.createElement('div');
    header.className = 'booba-info-panel__header';

    const moodWrap = document.createElement('div');
    moodWrap.className = 'booba-info-panel__mood';
    const moodImg  = document.createElement('img');
    moodImg.src    = moodUrl(currentMood);
    moodImg.alt    = 'Booba';
    moodWrap.appendChild(moodImg);

    const titleEl  = document.createElement('div');
    titleEl.className = 'booba-info-panel__title';
    titleEl.textContent = 'Booba';

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'booba-info-panel__close';
    closeBtn.textContent = '×';
    closeBtn.title       = 'Close';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeInfoPanel(); });

    header.appendChild(moodWrap);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    // ── Stats ──
    const statsEl = document.createElement('div');
    statsEl.className = 'booba-info-panel__stats';
    statsEl.id        = 'booba-info-stats';
    renderStats(statsEl, null);

    // ── Actions ──
    const actions  = document.createElement('div');
    actions.className = 'booba-info-panel__actions';
    const base     = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');

    const journalBtn = mkBtn_('📒  Open Journal', 'booba-btn booba-btn--primary');
    journalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: base + '/' });
    });
    const settingsBtn = mkBtn_('⚙️  Settings', 'booba-btn');
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    });
    const hideBtn = mkBtn_('👋  Hide Booba', 'booba-btn booba-btn--danger');
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopSSE();
      chrome.storage.local.set({ showBooba: false });
      root.style.display = 'none';
    });

    actions.appendChild(journalBtn);
    actions.appendChild(settingsBtn);
    actions.appendChild(hideBtn);

    panel.appendChild(header);
    panel.appendChild(statsEl);
    panel.appendChild(actions);
    root.appendChild(panel);

    // Fetch analytics async (cached)
    fetchAnalytics(settings).then((data) => {
      const el = document.getElementById('booba-info-stats');
      if (el) renderStats(el, data);
    });

    setTimeout(() => {
      document.addEventListener('click', onInfoClickOutside, { once: true, capture: true });
    }, 0);
  }

  function renderStats(container, analytics) {
    const mins     = Math.floor((Date.now() - sessionStart) / 60000);
    const timeStr  = mins > 0 ? mins + 'm' : '<1m';
    const count    = sessionTrades;

    let html = '';

    // Session
    html += row('Session', timeStr + ' · ' + count + ' trade' + (count !== 1 ? 's' : ''));

    // Last trade
    if (lastTrade) {
      const p = lastTrade.pnl;
      const pStr  = (p >= 0 ? '+$' : '-$') + Math.abs(p).toFixed(2);
      const pColor = p >= 0 ? '#22c55e' : '#ef4444';
      html += row(
        'Last trade',
        '<span style="color:#c9d1d9">' + lastTrade.symbol + ' ' + lastTrade.side.toUpperCase() + '</span> '
          + '<span style="color:' + pColor + '">' + pStr + '</span>'
      );
    }

    if (analytics === null) {
      html += '<div class="booba-stat-loading">Loading stats…</div>';
    } else if (analytics) {
      if (analytics.wartResult) {
        const w = analytics.wartResult;
        const sign   = w.composite >= 0 ? '+' : '';
        const wColor = w.composite > 1 ? '#22c55e' : w.composite < -1 ? '#ef4444' : '#f97316';
        html += row('WART',
          '<span style="color:' + wColor + '">' + sign + w.composite.toFixed(1) + '</span>'
            + ' <span style="color:#475569">·</span> ' + w.tier
        );
      }
      if (analytics.eloResult) {
        const e = analytics.eloResult;
        const arrow  = e.recentTrend === 'improving' ? '↑' : e.recentTrend === 'declining' ? '↓' : '→';
        const eColor = e.currentElo >= 1800 ? '#22c55e' : e.currentElo >= 1400 ? '#3b82f6' : '#f97316';
        html += row('Elo',
          '<span style="color:' + eColor + '">' + Math.round(e.currentElo) + '</span>'
            + ' <span style="color:#475569">·</span> ' + e.tier
            + ' <span style="color:#475569">' + arrow + '</span>'
        );
      }
    }

    container.innerHTML = html;
  }

  function row(label, valueHtml) {
    return '<div class="booba-stat-row">'
      + '<span class="booba-stat-label">' + label + '</span>'
      + '<span class="booba-stat-value">' + valueHtml + '</span>'
      + '</div>';
  }

  async function fetchAnalytics(settings) {
    const now = Date.now();
    if (analyticsCache && now - analyticsCache.ts < CACHE_TTL) return analyticsCache.data;

    const appUrl  = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    const apiKey  = settings.apiKey || '';
    const wallet  = settings.walletAddress || '';
    if (!apiKey || !wallet) return null;

    const qs = new URLSearchParams({ apiKey, wallet }).toString();
    try {
      const res = await fetch(`${appUrl}/api/analytics/summary?${qs}`);
      if (!res.ok) return null;
      const data = await res.json();
      analyticsCache = { data, ts: now };
      return data;
    } catch {
      return null;
    }
  }

  function closeInfoPanel() {
    infoPanelOpen = false;
    const panel   = document.getElementById('booba-info-panel');
    if (panel) panel.remove();
    const avatar  = root && root.querySelector('.booba-avatar');
    if (avatar) avatar.classList.remove('booba-avatar--paused');
    document.removeEventListener('click', onInfoClickOutside, { capture: true });
  }

  function onInfoClickOutside(e) {
    if (root && root.contains(e.target)) {
      setTimeout(() => {
        document.addEventListener('click', onInfoClickOutside, { once: true, capture: true });
      }, 0);
      return;
    }
    closeInfoPanel();
  }

  // ── Draggable ────────────────────────────────────────────────────────────────

  function makeDraggable(rootEl) {
    rootEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging  = true;
      dragMoved   = false;
      dragOffsetX = e.clientX - rootEl.getBoundingClientRect().left;
      dragOffsetY = e.clientY - rootEl.getBoundingClientRect().top;
      const avatar = rootEl.querySelector('.booba-avatar');
      if (avatar) avatar.classList.add('booba-avatar--paused');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      dragMoved = true;
      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w  = rootEl.offsetWidth,  h  = rootEl.offsetHeight;
      rootEl.style.left   = Math.max(0, Math.min(vw - w, x)) + 'px';
      rootEl.style.top    = Math.max(0, Math.min(vh - h, y)) + 'px';
      rootEl.style.right  = 'auto';
      rootEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      const avatar = root && root.querySelector('.booba-avatar');
      if (avatar && !infoPanelOpen) avatar.classList.remove('booba-avatar--paused');
    });
  }

  // ── Closed position toast ────────────────────────────────────────────────────

  function showClosedToast(data) {
    const old = document.getElementById('booba-toast');
    if (old) old.remove();

    const symbol   = data.symbol || 'Position';
    const side     = data.side === 'long' ? 'LONG' : 'SHORT';
    const pnl      = typeof data.pnl === 'number' ? data.pnl : null;
    const isProfit = pnl === null ? null : pnl >= 0;
    const pnlStr   = pnl === null ? '' : (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    const bdrColor = isProfit === true ? '#22c55e44' : isProfit === false ? '#ef444444' : '#30363d';

    const toast    = document.createElement('div');
    toast.id       = 'booba-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:80px', 'right:16px', 'z-index:999998',
      'background:#161b22', 'border:1px solid ' + bdrColor,
      'border-radius:10px', 'padding:10px 14px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:13px', 'color:#c9d1d9',
      'box-shadow:0 4px 20px rgba(0,0,0,.5)',
      'display:flex', 'align-items:center', 'gap:8px', 'max-width:280px',
      'opacity:0', 'transform:translateY(8px)', 'transition:opacity .25s ease,transform .25s ease',
    ].join(';');

    const icon   = document.createElement('span');
    icon.style.fontSize = '15px';
    icon.textContent = isProfit === true ? '🐙' : '😬';

    const text   = document.createElement('span');
    text.innerHTML = '<strong>' + symbol + ' ' + side + '</strong> closed'
      + (pnlStr
        ? ': <span style="color:' + (isProfit ? '#22c55e' : '#ef4444') + ';font-weight:600">' + pnlStr + '</span>'
        : '');

    toast.appendChild(icon);
    toast.appendChild(text);
    document.body.appendChild(toast);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      toast.style.opacity   = '1';
      toast.style.transform = 'translateY(0)';
    }));
    setTimeout(() => {
      toast.style.opacity   = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 280);
    }, 5000);
  }

  // ── Trade popup ──────────────────────────────────────────────────────────────

  function removeTradePopup() {
    if (popupDismissTimer)   { clearTimeout(popupDismissTimer);   popupDismissTimer   = null; }
    if (popupCountdownTimer) { clearInterval(popupCountdownTimer); popupCountdownTimer = null; }
    const el = document.getElementById('booba-trade-popup');
    if (el) el.remove();
  }

  function showTradePopup(data, settings) {
    removeTradePopup();

    const appUrl = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    const apiKey = settings.apiKey || '';
    const wallet = settings.walletAddress || '';
    const aqp    = new URLSearchParams();
    if (apiKey) aqp.set('apiKey', apiKey);
    if (wallet) aqp.set('wallet', wallet);
    const authQs = aqp.toString();

    const symbol   = data.symbol || '???';
    const isLong   = data.side === 'long';
    const side     = isLong ? 'LONG' : 'SHORT';
    const sideColor = isLong ? '#22c55e' : '#ef4444';
    const sideBg   = isLong ? '#16653440' : '#7f1d1d40';
    const priceStr = data.price
      ? '$' + parseFloat(data.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
      : '';

    const EMOTIONS = ['Focused', 'Confident', 'Anxious', 'FOMO', 'Revenge', 'Bored'];
    const form     = { strategyId: '', thesis: '', emotion: null, conviction: null };

    // Outer wrapper (positions popup above Booba, bottom-right)
    const overlay   = document.createElement('div');
    overlay.id      = 'booba-trade-popup';
    overlay.style.cssText = 'position:fixed;bottom:80px;right:16px;z-index:1000000;pointer-events:none';

    // Card
    const card = document.createElement('div');
    card.style.cssText = [
      'width:350px', 'background:#161b22', 'border:1px solid #30363d',
      'border-radius:12px', 'box-shadow:0 8px 40px rgba(0,0,0,.8)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'color:#c9d1d9', 'font-size:13px', 'pointer-events:all', 'overflow:hidden',
      'opacity:0', 'transform:translateY(16px)',
      'transition:opacity .25s ease,transform .3s cubic-bezier(.34,1.56,.64,1)',
    ].join(';');

    // ── Header ──
    const hdr  = mkEl('div', 'padding:12px 14px 10px;border-bottom:1px solid #21262d;display:flex;align-items:center;justify-content:space-between');
    const hdrl = mkEl('div', 'display:flex;align-items:center;gap:8px');
    hdrl.appendChild(mkTxt('span', '🐙', 'font-size:15px'));
    hdrl.appendChild(mkTxt('span', 'New Trade Detected!', 'font-weight:600;color:#e6edf3;font-size:13px'));
    const closeX = mkEl('button', 'background:none;border:none;color:#6e7681;font-size:18px;cursor:pointer;padding:0 2px;line-height:1');
    closeX.textContent = '×';
    closeX.addEventListener('click', removeTradePopup);
    hdr.appendChild(hdrl); hdr.appendChild(closeX);

    // ── Summary ──
    const smry = mkEl('div', 'padding:10px 14px;border-bottom:1px solid #21262d');
    const trow = mkEl('div', 'display:flex;align-items:center;gap:6px;margin-bottom:4px');
    trow.appendChild(mkTxt('span', symbol, 'font-weight:700;font-size:14px;color:#e6edf3'));
    const stag = mkEl('span', 'font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;background:' + sideBg + ';color:' + sideColor);
    stag.textContent = side;
    trow.appendChild(stag);
    if (priceStr) trow.appendChild(mkTxt('span', '@ ' + priceStr, 'color:#8b949e;font-size:12px'));
    smry.appendChild(trow);

    if (data.regimeContext) {
      const r    = data.regimeContext;
      const diff = r.assetRegimeWinRate - r.baselineWinRate;
      const dc   = diff >= 0 ? '#22c55e' : '#ef4444';
      const rEl  = mkEl('div', 'font-size:11px;color:#8b949e;margin-bottom:2px');
      rEl.innerHTML = 'Regime: <span style="color:#c9d1d9">' + r.currentRegime.replace(/_/g, ' ') + '</span>'
        + ' · ' + symbol + ' WR: <span style="color:' + dc + '">' + r.assetRegimeWinRate.toFixed(1) + '%</span>';
      smry.appendChild(rEl);
    }
    if (data.sessionWarning) {
      const sw  = data.sessionWarning;
      const wEl = mkEl('div', 'font-size:11px;color:#f97316');
      wEl.textContent = '⚠ Trade #' + sw.tradeNumber + ' this session (optimal: ' + sw.optimalStop + ')';
      smry.appendChild(wEl);
    }

    // ── Form body ──
    const body = mkEl('div', 'padding:12px 14px;display:flex;flex-direction:column;gap:10px');

    // Strategy
    const stratWrap = mkEl('div', '');
    stratWrap.appendChild(mkLbl('Strategy'));
    const stratSel   = document.createElement('select');
    stratSel.style.cssText = fldCss() + ';width:100%;cursor:pointer';
    const emptyOpt   = new Option('— No strategy —', '');
    const newStratOp = new Option('+ New Strategy', '__new__');
    stratSel.appendChild(emptyOpt);
    stratSel.appendChild(newStratOp);

    const nsRow  = mkEl('div', 'display:none;gap:6px;margin-top:4px');
    const nsIn   = mkInput('text', 'Strategy name', 'flex:1;' + fldCss());
    const nsAdd  = mkPopupBtn('Add', '#1d4ed8');
    const nsCanc = mkEl('button', 'background:none;border:none;color:#6e7681;font-size:12px;cursor:pointer;font-family:inherit');
    nsCanc.textContent = 'Cancel';
    nsRow.appendChild(nsIn); nsRow.appendChild(nsAdd); nsRow.appendChild(nsCanc);

    stratSel.addEventListener('change', () => {
      if (stratSel.value === '__new__') {
        stratSel.style.display = 'none'; nsRow.style.display = 'flex'; nsIn.focus();
      } else { form.strategyId = stratSel.value; }
    });
    nsCanc.addEventListener('click', () => {
      stratSel.value = form.strategyId; stratSel.style.display = ''; nsRow.style.display = 'none';
    });
    nsAdd.addEventListener('click', async () => {
      const name = nsIn.value.trim();
      if (!name) return;
      nsAdd.textContent = '…'; nsAdd.disabled = true;
      try {
        const r = await fetch(`${appUrl}/api/strategies${authQs ? '?' + authQs : ''}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        if (r.ok) {
          const d = await r.json();
          if (d.strategy) {
            stratSel.insertBefore(new Option(d.strategy.name, d.strategy.id), newStratOp);
            form.strategyId = d.strategy.id; stratSel.value = d.strategy.id;
          }
        }
      } catch {}
      nsAdd.textContent = 'Add'; nsAdd.disabled = false;
      stratSel.style.display = ''; nsRow.style.display = 'none';
    });

    stratWrap.appendChild(stratSel); stratWrap.appendChild(nsRow);

    // Load strategies async
    fetch(`${appUrl}/api/strategies${authQs ? '?' + authQs : ''}`)
      .then(r => r.json())
      .then(d => { (d.strategies || []).forEach(s => stratSel.insertBefore(new Option(s.name, s.id), newStratOp)); })
      .catch(() => {});

    // Thesis
    const thesisWrap = mkEl('div', '');
    thesisWrap.appendChild(mkLbl('Thesis'));
    const thesisIn = mkInput('text', 'Why did you take this trade?', fldCss() + ';width:100%;box-sizing:border-box');
    thesisIn.addEventListener('input', () => { form.thesis = thesisIn.value; });
    thesisWrap.appendChild(thesisIn);

    // Emotion
    const emotWrap = mkEl('div', '');
    emotWrap.appendChild(mkLbl('Emotion'));
    const emotRow = mkEl('div', 'display:flex;flex-wrap:wrap;gap:5px');
    EMOTIONS.forEach(e => {
      const b = mkPill(e, e);
      b.addEventListener('click', () => {
        form.emotion = (form.emotion === e) ? null : e;
        emotRow.querySelectorAll('[data-pill]').forEach(x => {
          const on = x.dataset.pill === form.emotion;
          x.style.background  = on ? '#4a1d96' : '#0d1117';
          x.style.borderColor = on ? '#7c3aed' : '#30363d';
          x.style.color       = on ? '#e6edf3' : '#8b949e';
        });
      });
      emotRow.appendChild(b);
    });
    emotWrap.appendChild(emotRow);

    // Conviction 1-5
    const convWrap = mkEl('div', '');
    convWrap.appendChild(mkLbl('Conviction'));
    const convRow = mkEl('div', 'display:flex;gap:5px');
    [1, 2, 3, 4, 5].forEach(v => {
      const b = mkPill(v, v);
      b.style.cssText += ';flex:1;border-radius:6px';
      b.addEventListener('click', () => {
        form.conviction = (form.conviction === v) ? null : v;
        convRow.querySelectorAll('[data-pill]').forEach(x => {
          const on = parseInt(x.dataset.pill) === form.conviction;
          x.style.background  = on ? '#1d4ed8' : '#0d1117';
          x.style.borderColor = on ? '#3b82f6' : '#30363d';
          x.style.color       = on ? '#fff' : '#8b949e';
        });
      });
      convRow.appendChild(b);
    });
    convWrap.appendChild(convRow);

    body.appendChild(stratWrap); body.appendChild(thesisWrap);
    body.appendChild(emotWrap);  body.appendChild(convWrap);

    // ── Footer ──
    const ftr  = mkEl('div', 'padding:10px 14px;border-top:1px solid #21262d;display:flex;align-items:center;justify-content:space-between');
    const timerEl = mkEl('span', 'font-size:11px;color:#6e7681');
    const ftrR    = mkEl('div', 'display:flex;gap:8px;align-items:center');

    const skipB = mkEl('button', 'background:none;border:none;color:#8b949e;font-size:13px;cursor:pointer;font-family:inherit');
    skipB.textContent = 'Skip';
    skipB.addEventListener('click', removeTradePopup);

    const saveB = mkPopupBtn('Save & Close', '#1f6feb');
    saveB.style.padding    = '7px 14px';
    saveB.style.fontSize   = '13px';
    saveB.style.fontWeight = '500';
    saveB.addEventListener('click', async () => {
      saveB.textContent = 'Saving…'; saveB.disabled = true;
      try {
        const patch = { thesis: form.thesis, conviction: form.conviction, emotion: form.emotion, strategyId: form.strategyId || null };
        const r = await fetch(
          `${appUrl}/api/positions/${data.positionId}${authQs ? '?' + authQs : ''}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }
        );
        if (r.ok) {
          saveB.textContent       = 'Saved!';
          saveB.style.background  = '#166534';
          setTimeout(removeTradePopup, 600);
          return;
        }
      } catch {}
      saveB.textContent = 'Save & Close'; saveB.disabled = false;
    });

    ftrR.appendChild(skipB); ftrR.appendChild(saveB);
    ftr.appendChild(timerEl); ftr.appendChild(ftrR);

    card.appendChild(hdr); card.appendChild(smry); card.appendChild(body); card.appendChild(ftr);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.style.opacity   = '1';
      card.style.transform = 'translateY(0)';
    }));
    requestAnimationFrame(() => thesisIn.focus());

    // Countdown 60 s
    let secs = 60;
    const tick = () => { timerEl.textContent = 'Auto-saving in ' + secs + 's'; secs--; };
    tick();
    popupCountdownTimer = setInterval(tick, 1000);
    popupDismissTimer   = setTimeout(() => {
      if (popupCountdownTimer) { clearInterval(popupCountdownTimer); popupCountdownTimer = null; }
      const msg = mkEl('span', 'font-size:11px;color:#8b949e;font-style:italic');
      msg.textContent = "I saved your trade — you can add context later.";
      ftr.insertBefore(msg, ftrR);
      timerEl.textContent = '';
      setTimeout(() => {
        card.style.opacity   = '0';
        card.style.transform = 'translateY(8px)';
        setTimeout(removeTradePopup, 300);
      }, 2000);
    }, 60000);
  }

  // ── DOM micro-helpers ────────────────────────────────────────────────────────

  function mkEl(tag, css) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    return e;
  }
  function mkTxt(tag, text, css) {
    const e = mkEl(tag, css || '');
    e.textContent = text;
    return e;
  }
  function mkLbl(text) {
    const e = document.createElement('label');
    e.style.cssText = 'display:block;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6e7681;margin-bottom:4px';
    e.textContent = text;
    return e;
  }
  function fldCss() {
    return 'background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 10px;font-size:13px;outline:none;font-family:inherit';
  }
  function mkInput(type, placeholder, css) {
    const e = document.createElement('input');
    e.type = type; e.placeholder = placeholder; e.style.cssText = css;
    return e;
  }
  function mkPopupBtn(text, bg) {
    const b = document.createElement('button');
    b.textContent  = text;
    b.style.cssText = 'background:' + bg + ';border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit';
    return b;
  }
  function mkPill(text, dataVal) {
    const b = document.createElement('button');
    b.textContent   = text;
    b.dataset.pill  = dataVal;
    b.style.cssText = 'padding:4px 10px;font-size:12px;border-radius:20px;border:1px solid #30363d;background:#0d1117;color:#8b949e;cursor:pointer;font-family:inherit';
    return b;
  }
  function mkBtn_(text, cls) {
    const b = document.createElement('button');
    b.className   = cls;
    b.textContent = text;
    return b;
  }

  // ── Screenshot upload ────────────────────────────────────────────────────────

  async function uploadScreenshot(positionId, dataUrl, settings) {
    const appUrl = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    try {
      await fetch(`${appUrl}/api/positions/${positionId}/screenshot?apiKey=${settings.apiKey}&wallet=${settings.walletAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenshot: dataUrl }),
      });
      console.log('[booba-ext] Screenshot uploaded for position', positionId);
    } catch (err) {
      console.error('[booba-ext] Screenshot upload failed:', err);
    }
  }

  // ── SSE ──────────────────────────────────────────────────────────────────────

  function stopSSE() {
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer);  sseReconnectTimer = null; }
    if (sseSource)         { sseSource.close();                sseSource         = null; }
    if (sessionTimerInt)   { clearInterval(sessionTimerInt);   sessionTimerInt   = null; }
  }

  function startSSE(settings) {
    stopSSE();
    if (!settings || settings.enableTradeDetection === false) {
      setConnectionDot('none');
      return;
    }

    const appUrl = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    const apiKey = settings.apiKey || '';
    const wallet = settings.walletAddress || '';
    const qp     = new URLSearchParams();
    if (apiKey) qp.set('apiKey', apiKey);
    if (wallet) qp.set('wallet', wallet);
    const qs = qp.toString();

    setConnectionDot('disconnected');

    const es = new EventSource(`${appUrl}/api/ws${qs ? '?' + qs : ''}`);
    sseSource = es;

    es.addEventListener('open', () => setConnectionDot('connected'));

    es.addEventListener('new_trade', (event) => {
      try {
        const d = JSON.parse(event.data);
        sessionTrades++;
        if (d.sessionWarning) sessionWarned = true;
        refreshSessionBadge(null);

        if (d.isNewPosition) {
          setMood('excited', 10000);
          if (settings.enableThesisPopup !== false) showTradePopup(d, settings);

          // Screenshot capture — 1-second delay to let the chart update
          if (d.positionId) {
            const posId = d.positionId;
            setTimeout(async () => {
              try {
                const s = await chrome.storage.local.get(['enableScreenshots']);
                if (!s.enableScreenshots) return;

                let screenshotData = null;

                try {
                  const chartEl = document.querySelector('canvas')
                    || document.querySelector('[class*="chart"]')
                    || document.querySelector('[class*="trading"]');

                  if (chartEl && typeof html2canvas !== 'undefined') {
                    const canvas = await html2canvas(chartEl, {
                      backgroundColor: '#0d1117',
                      scale: 1,
                      logging: false,
                    });
                    screenshotData = canvas.toDataURL('image/png', 0.8);
                    console.log('[booba-ext] Chart element captured via html2canvas');
                  }
                } catch (err) {
                  console.warn('[booba-ext] html2canvas failed:', err);
                }

                if (!screenshotData) {
                  chrome.runtime.sendMessage({ type: 'capture_screenshot', positionId: posId });
                  return;
                }

                uploadScreenshot(posId, screenshotData, settings);
              } catch (err) {
                console.error('[booba-ext] Screenshot flow error:', err);
              }
            }, 1000);
          }
        }
      } catch {}
    });

    es.addEventListener('position_closed', (event) => {
      try {
        const d = JSON.parse(event.data);
        lastTrade = { symbol: d.symbol, side: d.side, pnl: d.pnl };
        showClosedToast(d);
        setMood(d.pnl > 0 ? 'money' : 'nervous', 10000);
      } catch {}
    });

    es.onerror = () => {
      setConnectionDot('disconnected');
      if (es.readyState === EventSource.CLOSED) {
        sseSource = null;
        sseReconnectTimer = setTimeout(() => startSSE(settings), 5000);
      }
    };

    // Update session badge every minute
    sessionTimerInt = setInterval(() => refreshSessionBadge(null), 60000);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init(settings) {
    stopSSE();

    const existing = document.getElementById('booba-root');
    if (existing) {
      root = existing;
    } else {
      root = document.createElement('div');
      root.id = 'booba-root';

      Object.assign(root.style, getPositionStyles(settings));

      const avatar = buildAvatar(settings);
      root.appendChild(avatar);

      root.addEventListener('click', (e) => {
        if (dragMoved) { dragMoved = false; return; }
        if (infoPanelOpen) { closeInfoPanel(); } else { openInfoPanel(settings); }
      });

      makeDraggable(root);
      document.body.appendChild(root);
    }

    if (!root.querySelector('#booba-session-badge')) createSessionBadge();

    startSSE(settings);
  }

  // ── Expose ───────────────────────────────────────────────────────────────────

  window.__initBooba = init;

  if (window.__boobaSettings) {
    init(window.__boobaSettings);
  } else {
    const DEFAULTS = {
      showBooba:            true,
      boobaSize:            50,
      position:             'bottom-right',
      webAppUrl:            'http://localhost:3000',
      apiKey:               '',
      walletAddress:        '',
      enableTradeDetection: true,
      enableThesisPopup:    true,
    };
    chrome.storage.local.get(DEFAULTS, (s) => {
      if (s.showBooba) init(s);
    });
  }
})();
