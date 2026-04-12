// content.js — entry point, reads settings and initialises Booba
(function () {
  'use strict';

  const DEFAULTS = {
    showBooba: true,
    boobaSize: 50,
    position: 'bottom-right',
    webAppUrl: 'http://localhost:3000',
  };

  chrome.storage.local.get(DEFAULTS, (settings) => {
    if (settings.showBooba) {
      window.__boobaSettings = settings;
      // booba-float.js initialises itself via DOMContentLoaded / immediate call
      if (typeof window.__initBooba === 'function') {
        window.__initBooba(settings);
      }
    }
  });

  // Listen for show/hide messages from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BOOBA_TOGGLE') {
      const avatar = document.getElementById('booba-root');
      if (avatar) {
        avatar.style.display = msg.show ? 'flex' : 'none';
      } else if (msg.show && typeof window.__initBooba === 'function') {
        chrome.storage.local.get(DEFAULTS, (s) => window.__initBooba(s));
      }
    }
    if (msg.type === 'BOOBA_SETTINGS_UPDATED') {
      const avatar = document.getElementById('booba-root');
      if (avatar) avatar.remove();
      chrome.storage.local.get(DEFAULTS, (s) => {
        if (s.showBooba && typeof window.__initBooba === 'function') {
          window.__initBooba(s);
        }
      });
    }
  });
})();
