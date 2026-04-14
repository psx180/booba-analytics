// options.js
(function () {
  'use strict';

  const DEFAULTS = {
    webAppUrl:            'http://localhost:3000',
    apiKey:               '',
    walletAddress:        '',
    showBooba:            true,
    enableTradeDetection: true,
    enableThesisPopup:    true,
    enableScreenshots:    false,
    boobaSize:            50,
    position:             'bottom-right',
  };

  const form                  = document.getElementById('options-form');
  const urlInput              = document.getElementById('web-app-url');
  const apiKeyInput           = document.getElementById('api-key');
  const walletInput           = document.getElementById('wallet-address');
  const showToggle            = document.getElementById('show-booba');
  const tradeDetectToggle     = document.getElementById('enable-trade-detection');
  const thesisPopupToggle     = document.getElementById('enable-thesis-popup');
  const screenshotsToggle     = document.getElementById('enable-screenshots');
  const saveStatus            = document.getElementById('save-status');

  // ── Load saved settings ──────────────────────────────────────────────────

  chrome.storage.local.get(DEFAULTS, (s) => {
    urlInput.value              = s.webAppUrl;
    apiKeyInput.value           = s.apiKey;
    walletInput.value           = s.walletAddress;
    showToggle.checked          = s.showBooba;
    tradeDetectToggle.checked   = s.enableTradeDetection;
    thesisPopupToggle.checked   = s.enableThesisPopup;
    screenshotsToggle.checked   = s.enableScreenshots;

    const sizeRadio = form.querySelector(`input[name="booba-size"][value="${s.boobaSize}"]`);
    if (sizeRadio) sizeRadio.checked = true;

    const posRadio = form.querySelector(`input[name="position"][value="${s.position}"]`);
    if (posRadio) posRadio.checked = true;
  });

  // ── Save ─────────────────────────────────────────────────────────────────

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const sizeInput = form.querySelector('input[name="booba-size"]:checked');
    const posInput  = form.querySelector('input[name="position"]:checked');

    const settings = {
      webAppUrl:            urlInput.value.trim()   || DEFAULTS.webAppUrl,
      apiKey:               apiKeyInput.value.trim(),
      walletAddress:        walletInput.value.trim(),
      showBooba:            showToggle.checked,
      enableTradeDetection: tradeDetectToggle.checked,
      enableThesisPopup:    thesisPopupToggle.checked,
      enableScreenshots:    screenshotsToggle.checked,
      boobaSize:            sizeInput ? parseInt(sizeInput.value, 10) : DEFAULTS.boobaSize,
      position:             posInput  ? posInput.value : DEFAULTS.position,
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
