// background.js — Booba service worker

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open options page on first install so the user can configure the web app URL
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: msg.url });
    return;
  }

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.type === 'capture_screenshot') {
    chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 80 }, async (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        console.error('[booba-ext] Tab capture failed:', chrome.runtime.lastError);
        sendResponse({ success: false });
        return;
      }

      const settings = await chrome.storage.local.get(['appUrl', 'apiKey', 'walletAddress']);
      const appUrl = settings.appUrl || 'http://localhost:3000';

      try {
        await fetch(`${appUrl}/api/positions/${msg.positionId}/screenshot?apiKey=${settings.apiKey}&wallet=${settings.walletAddress}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screenshot: dataUrl }),
        });
        console.log('[booba-ext] Screenshot uploaded (tab capture) for position', msg.positionId);
        sendResponse({ success: true });
      } catch (err) {
        console.error('[booba-ext] Screenshot upload failed:', err);
        sendResponse({ success: false });
      }
    });
    return true; // async response
  }
});
