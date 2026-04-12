// options.js
(function () {
  'use strict';

  const DEFAULTS = {
    webAppUrl:  'http://localhost:3000',
    showBooba:  true,
    boobaSize:  50,
    position:   'bottom-right',
  };

  const form        = document.getElementById('options-form');
  const urlInput    = document.getElementById('web-app-url');
  const showToggle  = document.getElementById('show-booba');
  const saveStatus  = document.getElementById('save-status');

  // ── Load saved settings ────────────────────────────────────────────────────

  chrome.storage.local.get(DEFAULTS, (s) => {
    urlInput.value   = s.webAppUrl;
    showToggle.checked = s.showBooba;

    const sizeRadio = form.querySelector(`input[name="booba-size"][value="${s.boobaSize}"]`);
    if (sizeRadio) sizeRadio.checked = true;

    const posRadio = form.querySelector(`input[name="position"][value="${s.position}"]`);
    if (posRadio) posRadio.checked = true;
  });

  // ── Save ───────────────────────────────────────────────────────────────────

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const sizeInput = form.querySelector('input[name="booba-size"]:checked');
    const posInput  = form.querySelector('input[name="position"]:checked');

    const settings = {
      webAppUrl:  urlInput.value.trim() || DEFAULTS.webAppUrl,
      showBooba:  showToggle.checked,
      boobaSize:  sizeInput ? parseInt(sizeInput.value, 10) : DEFAULTS.boobaSize,
      position:   posInput  ? posInput.value : DEFAULTS.position,
    };

    chrome.storage.local.set(settings, () => {
      // Notify all Pacifica tabs to reload Booba with new settings
      chrome.tabs.query({ url: ['https://app.pacifica.fi/*', 'https://*.pacifica.fi/*'] }, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, { type: 'BOOBA_SETTINGS_UPDATED' }).catch(() => {});
        });
      });

      saveStatus.hidden = false;
      setTimeout(() => { saveStatus.hidden = true; }, 2000);
    });
  });
})();
