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
  };

  let currentMood = 'calm';
  let panelOpen = false;
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let dragMoved = false;
  let root = null;

  function moodUrl(mood) {
    return EXTENSION_URL + MOODS[mood];
  }

  function getPositionStyles(settings, size) {
    const margin = 16;
    if (settings.position === 'bottom-left') {
      return { bottom: margin + 'px', left: margin + 'px', right: 'auto', top: 'auto' };
    }
    return { bottom: margin + 'px', right: margin + 'px', left: 'auto', top: 'auto' };
  }

  function buildAvatar(settings) {
    const size = settings.boobaSize || 50;
    const img = document.createElement('img');
    img.src = moodUrl(currentMood);
    img.alt = 'Booba';
    img.draggable = false;

    const avatar = document.createElement('div');
    avatar.className = 'booba-avatar';
    avatar.style.setProperty('--booba-size', size + 'px');
    avatar.style.width = size + 'px';
    avatar.style.height = size + 'px';
    avatar.appendChild(img);
    return avatar;
  }

  function buildPanel(settings) {
    const isLeft = settings.position === 'bottom-left';
    const panel = document.createElement('div');
    panel.className = 'booba-panel' + (isLeft ? ' booba-panel--bottom-left' : '');

    // Position panel above avatar
    const size = settings.boobaSize || 50;
    panel.style.bottom = (size + 12) + 'px';
    if (isLeft) {
      panel.style.left = '0';
    } else {
      panel.style.right = '0';
    }

    const header = document.createElement('div');
    header.className = 'booba-panel__header';

    const moodImg = document.createElement('div');
    moodImg.className = 'booba-panel__mood-img';
    const img = document.createElement('img');
    img.src = moodUrl(currentMood);
    img.alt = 'Booba';
    moodImg.appendChild(img);

    const title = document.createElement('div');
    title.className = 'booba-panel__title';
    title.textContent = 'Booba';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'booba-panel__close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePanel();
    });

    header.appendChild(moodImg);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const speech = document.createElement('div');
    speech.className = 'booba-speech';
    speech.textContent = 'Watching your trades...';

    const actions = document.createElement('div');
    actions.className = 'booba-actions';

    const baseUrl = (settings.webAppUrl || 'http://localhost:3000').replace(/\/$/, '');

    const openJournalBtn = document.createElement('button');
    openJournalBtn.className = 'booba-btn booba-btn--primary';
    openJournalBtn.textContent = '📒  Open Journal';
    openJournalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: baseUrl + '/' });
    });

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'booba-btn';
    settingsBtn.textContent = '⚙️  Settings';
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    });

    const hideBtn = document.createElement('button');
    hideBtn.className = 'booba-btn booba-btn--danger';
    hideBtn.textContent = '👋  Hide Booba';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ showBooba: false });
      root.style.display = 'none';
    });

    actions.appendChild(openJournalBtn);
    actions.appendChild(settingsBtn);
    actions.appendChild(hideBtn);

    panel.appendChild(header);
    panel.appendChild(speech);
    panel.appendChild(actions);

    return panel;
  }

  function openPanel(settings) {
    if (panelOpen) return;
    panelOpen = true;
    const avatar = root.querySelector('.booba-avatar');
    if (avatar) {
      avatar.classList.add('booba-avatar--paused');
    }
    const panel = buildPanel(settings);
    panel.id = 'booba-panel';
    root.appendChild(panel);

    // Click outside to close
    setTimeout(() => {
      document.addEventListener('click', onClickOutside, { once: true, capture: true });
    }, 0);
  }

  function closePanel() {
    panelOpen = false;
    const panel = document.getElementById('booba-panel');
    if (panel) panel.remove();
    const avatar = root && root.querySelector('.booba-avatar');
    if (avatar) avatar.classList.remove('booba-avatar--paused');
    document.removeEventListener('click', onClickOutside, { capture: true });
  }

  function onClickOutside(e) {
    if (root && root.contains(e.target)) {
      // Re-attach listener since once: true removed it
      setTimeout(() => {
        document.addEventListener('click', onClickOutside, { once: true, capture: true });
      }, 0);
      return;
    }
    closePanel();
  }

  function makeDraggable(root) {
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      dragMoved = false;
      dragOffsetX = e.clientX - root.getBoundingClientRect().left;
      dragOffsetY = e.clientY - root.getBoundingClientRect().top;

      // Pause bob animation while dragging
      const avatar = root.querySelector('.booba-avatar');
      if (avatar) avatar.classList.add('booba-avatar--paused');

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      dragMoved = true;

      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = root.offsetWidth, h = root.offsetHeight;

      root.style.left = Math.max(0, Math.min(vw - w, x)) + 'px';
      root.style.top  = Math.max(0, Math.min(vh - h, y)) + 'px';
      root.style.right  = 'auto';
      root.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      const avatar = root && root.querySelector('.booba-avatar');
      if (avatar && !panelOpen) avatar.classList.remove('booba-avatar--paused');
    });
  }

  function init(settings) {
    if (document.getElementById('booba-root')) return;

    root = document.createElement('div');
    root.id = 'booba-root';

    const posStyles = getPositionStyles(settings, settings.boobaSize || 50);
    Object.assign(root.style, posStyles);

    const avatar = buildAvatar(settings);
    root.appendChild(avatar);

    // Click handler: open/close panel (only if not a drag)
    root.addEventListener('click', (e) => {
      if (dragMoved) { dragMoved = false; return; }
      if (panelOpen) {
        closePanel();
      } else {
        openPanel(settings);
      }
    });

    makeDraggable(root);
    document.body.appendChild(root);
  }

  // Expose for content.js
  window.__initBooba = init;

  // Auto-init if settings already loaded
  if (window.__boobaSettings) {
    init(window.__boobaSettings);
  } else {
    const DEFAULTS = {
      showBooba: true,
      boobaSize: 50,
      position: 'bottom-right',
      webAppUrl: 'http://localhost:3000',
    };
    chrome.storage.local.get(DEFAULTS, (s) => {
      if (s.showBooba) init(s);
    });
  }
})();
