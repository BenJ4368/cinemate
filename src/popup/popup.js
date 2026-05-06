import browser from 'webextension-polyfill';

const $ = (id) => document.getElementById(id);

const pseudoInput = $('pseudo');
const createBtn = $('create-btn');
const noVideoHint = $('no-video-hint');
const pseudoRequiredHint = $('pseudo-required-hint');
const joinIdInput = $('join-id');
const joinBtn = $('join-btn');
const statusSection = $('status-section');
const statusText = $('status-text');
const roomIdRow = $('room-id-row');
const roomIdDisplay = $('room-id-display');
const copyBtn = $('copy-btn');
const leaveBtn = $('leave-btn');
const actionsSection = $('actions-section');
const errorEl = $('error');
const membersList = $('members-list');

let currentWindowId = null;
let activeTabId = null;
let hasVideo = false;

let errorTimer = 0;
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorEl.classList.add('hidden');
    errorTimer = 0;
  }, 5000);
}
function clearError() {
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = 0; }
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
}

function setLoading(btn, isLoading) {
  btn.classList.toggle('loading', isLoading);
  btn.disabled = isLoading;
}

async function init() {
  // Load saved pseudo
  try {
    const stored = await browser.storage.local.get('pseudo');
    if (stored.pseudo) pseudoInput.value = stored.pseudo;
  } catch (_) {}

  pseudoInput.addEventListener('input', async () => {
    try { await browser.storage.local.set({ pseudo: pseudoInput.value }); } catch (_) {}
    refreshButtons();
    clearError();
  });
  joinIdInput.addEventListener('input', () => { refreshButtons(); clearError(); });

  // Mettre à jour l'état des boutons/champ avant de poser le focus :
  // sinon joinIdInput est encore disabled (attribut HTML par défaut) et
  // le focus ne s'applique pas (cf. T115).
  refreshButtons();

  // Autofocus : si pas de pseudo, on focus dessus ; sinon sur le champ rejoindre.
  setTimeout(() => {
    if (!pseudoInput.value.trim()) pseudoInput.focus();
    else joinIdInput.focus();
  }, 0);

  // Touche Entrée dans le champ ID = rejoindre directement
  joinIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
  });

  // Boucle de focus : Tab depuis le dernier élément actif → premier ; Shift+Tab
  // depuis le premier → dernier. Sans ça, le focus s'évade vers la barre d'URL
  // et on ne peut plus revenir au champ pseudo (cf. T110).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = Array.from(document.querySelectorAll(
      'input:not([disabled]):not(.hidden), button:not([disabled]):not(.hidden), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => {
      // Exclut les éléments dans une section masquée
      let node = el;
      while (node) {
        if (node.classList && node.classList.contains('hidden')) return false;
        node = node.parentElement;
      }
      return true;
    });
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Resolve current window/tab
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentWindowId = tab.windowId;
      activeTabId = tab.id;
      // Probe content script
      try {
        const resp = await browser.tabs.sendMessage(tab.id, { type: 'PING' });
        hasVideo = !!(resp && resp.hasVideo);
      } catch (_) {
        hasVideo = false;
      }
    }
  } catch (_) {}

  // Check existing room state
  if (currentWindowId != null) {
    try {
      const info = await browser.runtime.sendMessage({ type: 'GET_ROOM_INFO', windowId: currentWindowId });
      if (info && info.inRoom) {
        renderInRoom(info);
        return;
      }
    } catch (_) {}
  }

  renderOutOfRoom();
}

function refreshButtons() {
  const hasPseudo = pseudoInput.value.trim().length > 0;
  createBtn.disabled = !(hasPseudo && hasVideo);
  joinBtn.disabled = !(hasPseudo && joinIdInput.value.trim().length > 0);
  joinIdInput.disabled = !hasPseudo;

  // Verrouille visuellement la step 2 tant que pas de pseudo
  actionsSection.classList.toggle('locked', !hasPseudo);

  // Hints
  pseudoRequiredHint.classList.toggle('hidden', hasPseudo);
  noVideoHint.classList.toggle('hidden', !hasPseudo || hasVideo);
}

function renderOutOfRoom() {
  statusSection.classList.add('hidden');
  actionsSection.classList.remove('hidden');
  refreshButtons();
}

function renderInRoom(info) {
  actionsSection.classList.add('hidden');
  statusSection.classList.remove('hidden');
  const roleLabel = info.isHost ? 'Hôte' : 'Invité';
  const memberCount = (info.members || []).length;
  statusText.textContent = `${roleLabel} — ${memberCount} membre${memberCount > 1 ? 's' : ''}`;
  if (info.isHost && info.roomId) {
    roomIdRow.classList.remove('hidden');
    roomIdDisplay.value = info.roomId;
  } else {
    roomIdRow.classList.add('hidden');
  }

  // Liste des membres (hôte d'abord, puis invités triés alphabétiquement)
  membersList.innerHTML = '';
  const sorted = [...(info.members || [])].sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    return a.pseudo.localeCompare(b.pseudo);
  });
  for (const m of sorted) {
    const li = document.createElement('li');
    if (m.isHost) li.classList.add('host');
    li.textContent = m.pseudo;
    membersList.appendChild(li);
  }
}

async function refreshRoomState() {
  if (currentWindowId == null) return;
  try {
    const info = await browser.runtime.sendMessage({ type: 'GET_ROOM_INFO', windowId: currentWindowId });
    if (info && info.inRoom) renderInRoom(info);
    else renderOutOfRoom();
  } catch (_) {}
}

// Le bg envoie POPUP_UPDATE quand un membre rejoint/quitte ou que l'hôte change.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'POPUP_UPDATE') refreshRoomState();
});

createBtn.addEventListener('click', async () => {
  const pseudo = pseudoInput.value.trim();
  if (!pseudo || currentWindowId == null) return;
  clearError();
  setLoading(createBtn, true);
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CREATE_ROOM', windowId: currentWindowId, pseudo });
    if (resp && resp.ok) {
      const info = await browser.runtime.sendMessage({ type: 'GET_ROOM_INFO', windowId: currentWindowId });
      renderInRoom(info);
    } else {
      showError(resp && resp.error || 'Erreur de création de la salle');
    }
  } catch (e) {
    showError(String(e.message || e));
  }
  setLoading(createBtn, false);
});

joinBtn.addEventListener('click', async () => {
  const pseudo = pseudoInput.value.trim();
  const roomId = joinIdInput.value.trim();
  if (!pseudo || !roomId || currentWindowId == null) return;
  clearError();
  setLoading(joinBtn, true);
  try {
    const resp = await browser.runtime.sendMessage({ type: 'JOIN_ROOM', windowId: currentWindowId, pseudo, roomId });
    if (resp && resp.ok) {
      const info = await browser.runtime.sendMessage({ type: 'GET_ROOM_INFO', windowId: currentWindowId });
      renderInRoom(info);
    } else {
      showError(resp && resp.error || 'Impossible de rejoindre la salle');
    }
  } catch (e) {
    showError(String(e.message || e));
  }
  setLoading(joinBtn, false);
});

leaveBtn.addEventListener('click', async () => {
  if (currentWindowId == null) return;
  try {
    await browser.runtime.sendMessage({ type: 'LEAVE_ROOM', windowId: currentWindowId });
    renderOutOfRoom();
  } catch (e) {
    showError(String(e.message || e));
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomIdDisplay.value);
    copyBtn.textContent = 'Copié';
    setTimeout(() => { copyBtn.textContent = 'Copier'; }, 1500);
  } catch (_) {
    roomIdDisplay.select();
  }
});

init();
