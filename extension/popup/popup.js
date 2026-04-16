// popup.js
(function () {
  'use strict';

  const DEFAULTS = {
    showBooba: true,
    muteAlerts: false,
    webAppUrl: 'http://localhost:3000',
  };

  const statusBadge      = document.getElementById('status-badge');
  const statusText       = document.getElementById('status-text');
  const showBoobaToggle  = document.getElementById('show-booba-toggle');
  const muteAlertsToggle = document.getElementById('mute-alerts-toggle');
  const openDashboard    = document.getElementById('open-dashboard');
  const openOptions      = document.getElementById('open-options');

  // ── Connection status ──────────────────────────────────────────────────────

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const url = tab && tab.url ? tab.url : '';
    const onPacifica = url.includes('pacifica.fi');

    if (onPacifica) {
      statusBadge.classList.remove('popup__conn--disconnected');
      statusBadge.classList.add('popup__conn--connected');
      statusText.textContent = 'Connected';
    } else {
      statusText.textContent = 'Not connected';
    }
  });

  // ── Load settings ──────────────────────────────────────────────────────────

  chrome.storage.local.get(DEFAULTS, (settings) => {
    showBoobaToggle.checked  = settings.showBooba;
    muteAlertsToggle.checked = settings.muteAlerts;
  });

  // ── Show Booba toggle ──────────────────────────────────────────────────────

  showBoobaToggle.addEventListener('change', () => {
    const show = showBoobaToggle.checked;
    chrome.storage.local.set({ showBooba: show });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'BOOBA_TOGGLE', show }).catch(() => {});
      }
    });
  });

  // ── Mute alerts toggle ─────────────────────────────────────────────────────

  muteAlertsToggle.addEventListener('change', () => {
    const mute = muteAlertsToggle.checked;
    chrome.storage.local.set({ muteAlerts: mute });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'BOOBA_MUTE', mute }).catch(() => {});
      }
    });
  });

  // ── Open Dashboard ─────────────────────────────────────────────────────────

  openDashboard.addEventListener('click', () => {
    chrome.storage.local.get({ webAppUrl: DEFAULTS.webAppUrl }, (s) => {
      const url = (s.webAppUrl || DEFAULTS.webAppUrl).replace(/\/$/, '');
      chrome.tabs.create({ url });
    });
  });

  // ── Advanced Settings ──────────────────────────────────────────────────────

  openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
})();
