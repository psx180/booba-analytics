// popup.js
(function () {
  'use strict';

  const DEFAULTS = {
    showBooba: true,
    webAppUrl: 'http://localhost:3000',
  };

  const statusBadge = document.getElementById('status-badge');
  const statusText  = document.getElementById('status-text');
  const toggle      = document.getElementById('show-booba-toggle');
  const openOptions = document.getElementById('open-options');

  // ── Detect if we're on a Pacifica tab ──────────────────────────────────────

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const url = tab && tab.url ? tab.url : '';
    const onPacifica = url.includes('pacifica.fi');

    if (onPacifica) {
      statusBadge.classList.remove('popup__status--inactive');
      statusBadge.classList.add('popup__status--active');
      statusText.textContent = 'Connected to Pacifica';
    } else {
      statusText.textContent = 'Not on Pacifica — open app.pacifica.fi';
    }
  });

  // ── Load settings ──────────────────────────────────────────────────────────

  chrome.storage.local.get(DEFAULTS, (settings) => {
    toggle.checked = settings.showBooba;
  });

  // ── Toggle ─────────────────────────────────────────────────────────────────

  toggle.addEventListener('change', () => {
    const show = toggle.checked;
    chrome.storage.local.set({ showBooba: show });

    // Notify content script on active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'BOOBA_TOGGLE', show }).catch(() => {});
      }
    });
  });

  // ── Quick links ────────────────────────────────────────────────────────────

  document.querySelectorAll('.popup__link-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.storage.local.get({ webAppUrl: 'http://localhost:3000' }, (s) => {
        const base = (s.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');
        const path = btn.dataset.path || '/';
        chrome.tabs.create({ url: base + path });
      });
    });
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
})();
