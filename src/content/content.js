import browser from 'webextension-polyfill';

let video = null;
let isHost = false;
let inRoom = false;
let isSyncing = false;
let banner = null;
let currentMembers = []; // [{ peerId, pseudo, isHost, ready }]
let selfPeerId = null;
let hasSentReady = false;

function allMembersReady() {
  return currentMembers.length > 0 && currentMembers.every(m => m.ready);
}

let lastNotReadyToastAt = 0;
const NOT_READY_TOAST_COOLDOWN_MS = 5000;
function notifyNotReady() {
  const now = Date.now();
  if (now - lastNotReadyToastAt < NOT_READY_TOAST_COOLDOWN_MS) return;
  lastNotReadyToastAt = now;
  showToast('Tous les spectateurs ne sont pas prêts');
}

function maybeAutoSendReady() {
  if (!inRoom || isHost || hasSentReady) return;
  if (!video) return;
  // readyState >= 3 (HAVE_FUTURE_DATA) : la vidéo peut commencer la lecture.
  if (video.readyState < 3) return;
  hasSentReady = true;
  browser.runtime.sendMessage({ type: 'SET_READY', ready: true }).catch(() => {});
}

const NATIVE_PLAY = HTMLMediaElement.prototype.play;
const NATIVE_PAUSE = HTMLMediaElement.prototype.pause;
const CT_DESCRIPTOR = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');

function nativeSetCurrentTime(v, t) {
  try {
    if (CT_DESCRIPTOR && CT_DESCRIPTOR.set) {
      CT_DESCRIPTOR.set.call(v, t);
    } else {
      v.currentTime = t;
    }
  } catch (_) {}
}

function nativePlay(v) {
  try { return NATIVE_PLAY.call(v); } catch (_) {}
}
function nativePause(v) {
  try { return NATIVE_PAUSE.call(v); } catch (_) {}
}

function findVideo() {
  const vids = document.querySelectorAll('video');
  let best = null;
  let bestArea = 0;
  for (const v of vids) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea && v.readyState > 0) {
      best = v;
      bestArea = area;
    }
  }
  return best || (vids.length ? vids[0] : null);
}

function registerVideo() {
  if (!video) return;
  browser.runtime.sendMessage({
    type: 'REGISTER_VIDEO_TAB',
    url: location.href,
    currentTime: video.currentTime,
    paused: video.paused
  }).then((resp) => {
    if (resp && resp.inRoom) {
      inRoom = true;
      isHost = !!resp.isHost;
      renderBanner(resp.members || []);
    } else {
      inRoom = false;
    }
  }).catch(() => {});
}

function sendVideoEvent(action) {
  if (!video || !inRoom || isSyncing) return;
  browser.runtime.sendMessage({
    type: 'VIDEO_EVENT',
    action,
    url: location.href,
    currentTime: video.currentTime,
    paused: video.paused
  }).catch(() => {});
}

function attachVideoListeners(v) {
  v.addEventListener('play', () => {
    if (isSyncing) return;
    // Gates uniquement quand on est en salle — sinon lecture libre.
    if (inRoom) {
      if (othersInAd.length > 0 && !localInAd) {
        isSyncing = true;
        nativePause(video);
        setTimeout(() => { isSyncing = false; }, 100);
        return;
      }
      if (!localInAd && !allMembersReady()) {
        isSyncing = true;
        nativePause(video);
        setTimeout(() => { isSyncing = false; }, 100);
        notifyNotReady();
        return;
      }
    }
    sendVideoEvent('play');
  });
  v.addEventListener('pause', () => {
    if (isSyncing) return;
    sendVideoEvent('pause');
  });
  v.addEventListener('seeked', () => {
    if (isSyncing) return;
    sendVideoEvent('seek');
  });
  v.addEventListener('ratechange', () => {
    if (isSyncing) return;
    sendVideoEvent('rate');
  });
  v.addEventListener('loadedmetadata', () => registerVideo());
  // Auto-ready : dès que la vidéo peut jouer en continu, on signale prêt à l'hôte.
  v.addEventListener('canplay', maybeAutoSendReady);
  v.addEventListener('canplaythrough', maybeAutoSendReady);
}

function applySync(msg) {
  if (!video) return;
  isSyncing = true;
  nativeSetCurrentTime(video, msg.currentTime);
  if (msg.paused) {
    nativePause(video);
  } else {
    const p = nativePlay(video);
    if (p && typeof p.then === 'function') p.catch(() => {});
  }
  setTimeout(() => { isSyncing = false; }, 100);
}

// ----- Banner UI -----

function ensureBanner() {
  if (banner && document.body.contains(banner)) return banner;
  banner = document.createElement('div');
  banner.id = 'cinemate-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-label', 'Salle Cinemate');
  // Thème cinéma classique : velours rouge profond + or, cohérent avec le popup.
  banner.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'right:16px',
    'z-index:2147483647',
    'background:linear-gradient(135deg,#4a0608 0%,#2d0405 100%)',
    'color:#fff5d6',
    'font-family:Georgia,"Times New Roman",serif',
    'font-size:12px',
    'padding:10px 12px 12px',
    'border-radius:8px',
    'border:1px solid rgba(245,197,66,0.45)',
    'box-shadow:0 6px 20px rgba(0,0,0,.55),inset 0 0 14px rgba(0,0,0,0.4)',
    'min-width:200px',
    'max-width:280px',
    'pointer-events:auto',
    'line-height:1.4'
  ].join(';');
  document.body.appendChild(banner);
  return banner;
}

let toastContainer = null;
const TOAST_DURATION_MS = 3000;

function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.id = 'cinemate-toast-container';
  toastContainer.setAttribute('role', 'status');
  toastContainer.setAttribute('aria-live', 'polite');
  toastContainer.setAttribute('aria-atomic', 'false');
  toastContainer.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'pointer-events:none',
    'max-width:340px'
  ].join(';');
  document.body.appendChild(toastContainer);
  return toastContainer;
}

function showToast(text) {
  const append = () => {
    if (!document.body) { setTimeout(append, 50); return; }
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = 'cinemate-toast';
    toast.textContent = text;
    toast.style.cssText = [
      'background:linear-gradient(180deg,#f5c542 0%,#c9941a 100%)',
      'color:#3a0608',
      'font-family:Georgia,serif',
      'font-size:13px',
      'font-weight:700',
      'letter-spacing:0.4px',
      'padding:10px 16px',
      'border-radius:6px',
      'border:1px solid #b8860b',
      'box-shadow:0 4px 12px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.4)',
      'opacity:0',
      'transform:translateX(20px)',
      'transition:opacity 0.25s ease, transform 0.25s ease',
      'word-wrap:break-word'
    ].join(';');
    // appendChild => le plus récent en bas de la pile (flex column)
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
        if (container.children.length === 0 && container.parentNode) {
          container.remove();
          if (toastContainer === container) toastContainer = null;
        }
      }, 300);
    }, TOAST_DURATION_MS);
  };
  append();
}

function memberInAd(peerId) {
  if (peerId === selfPeerId) return localInAd;
  return othersInAd.some(p => p.peerId === peerId);
}

function statusIcon(member) {
  if (memberInAd(member.peerId)) return { icon: '😴', label: 'En pub', color: '#ff9b3a' };
  if (member.isHost) return { icon: '⭐', label: 'Hôte', color: '#f5c542' };
  if (member.ready) return { icon: '🍿', label: 'Prêt', color: '#7ed957' };
  return { icon: '⏳', label: 'Pas prêt', color: '#d4a857' };
}

function renderBanner(members) {
  if (!members || members.length === 0) {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
    return;
  }
  const el = ensureBanner();
  el.textContent = '';

  // En-tête type marquee
  const header = document.createElement('div');
  header.style.cssText = [
    'font-weight:900',
    'letter-spacing:3px',
    'text-transform:uppercase',
    'color:#f5c542',
    'text-align:center',
    'font-size:11px',
    'border-bottom:1px dashed rgba(245,197,66,0.35)',
    'padding-bottom:6px',
    'margin-bottom:8px',
    'text-shadow:0 0 4px rgba(245,197,66,0.4)'
  ].join(';');
  header.textContent = '★ CINEMATE ★';
  el.appendChild(header);

  const sorted = [...members].sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    return a.pseudo.localeCompare(b.pseudo);
  });

  for (const m of sorted) {
    const isSelf = m.peerId === selfPeerId;
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:4px 2px',
      'border-bottom:1px dashed rgba(245,197,66,0.12)'
    ].join(';');

    const { icon, label, color } = statusIcon(m);
    const statusEl = document.createElement('span');
    statusEl.style.cssText = `min-width:18px;text-align:center;font-size:14px;color:${color};`;
    statusEl.textContent = icon;
    statusEl.title = label;

    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;color:#fff5d6;' + (m.isHost ? 'font-weight:700;color:#f5c542;' : '');
    nameEl.textContent = m.pseudo + (isSelf ? ' (toi)' : '');

    row.appendChild(statusEl);
    row.appendChild(nameEl);
    el.appendChild(row);
  }

  // Hint quand le gate "pas prêt" est actif (s'applique à tout le monde).
  if (!allMembersReady()) {
    const hint = document.createElement('div');
    hint.style.cssText = [
      'margin-top:8px',
      'padding-top:6px',
      'border-top:1px dashed rgba(245,197,66,0.25)',
      'color:#d4a857',
      'font-size:10px',
      'font-style:italic',
      'text-align:center'
    ].join(';');
    hint.textContent = 'Lecture bloquée — pas tous prêts';
    el.appendChild(hint);
  }
}

// ----- Détection pub + gate (option B : tous en pause si quelqu'un a une pub) -----

let localInAd = false;
let othersInAd = []; // [{ peerId, pseudo }]
let pausedByAdGate = false;
let adBanner = null;
let adObserver = null;

function detectInAd() {
  // YouTube : la classe `.ad-showing` est posée sur #movie_player pendant
  // la diffusion d'une publicité. Autres plateformes : pas de détection.
  const player = document.querySelector('#movie_player');
  return !!(player && player.classList.contains('ad-showing'));
}

function publishAdState() {
  const inAd = detectInAd();
  if (inAd === localInAd) return;
  const wasInAd = localInAd;
  localInAd = inAd;
  if (inRoom) {
    browser.runtime.sendMessage({ type: 'AD_STATE', inAd }).catch(() => {});
  }
  // Pub locale terminée → resync immédiat sans attendre le heartbeat.
  if (wasInAd && !inAd && inRoom && !isHost) {
    browser.runtime.sendMessage({ type: 'REQUEST_SYNC' }).catch(() => {});
  }
  applyAdGate();
}

function startAdObserver() {
  if (adObserver) return;
  const player = document.querySelector('#movie_player');
  if (!player) {
    setTimeout(startAdObserver, 1000);
    return;
  }
  adObserver = new MutationObserver(publishAdState);
  adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  publishAdState();
}

function stopAdObserver() {
  if (adObserver) { adObserver.disconnect(); adObserver = null; }
}

function applyAdGate() {
  const shouldGate = othersInAd.length > 0 && !localInAd;
  if (shouldGate) {
    if (video && !video.paused) {
      isSyncing = true;
      nativePause(video);
      pausedByAdGate = true;
      setTimeout(() => { isSyncing = false; }, 100);
    }
  } else if (pausedByAdGate && !localInAd) {
    // Gate libéré → reprise auto. L'hôte se réaligne via son heartbeat ;
    // les invités attendront le prochain APPLY_SYNC/CHECK_DRIFT.
    if (video && video.paused) {
      isSyncing = true;
      const p = nativePlay(video);
      if (p && typeof p.then === 'function') p.catch(() => {});
      setTimeout(() => { isSyncing = false; }, 100);
    }
    pausedByAdGate = false;
  }
  renderAdBanner();
  // Statuts "en pub" dans la liste membres → re-render à chaque changement.
  if (currentMembers.length) renderBanner(currentMembers);
}

function renderAdBanner() {
  if (othersInAd.length === 0) {
    if (adBanner && adBanner.parentNode) adBanner.parentNode.removeChild(adBanner);
    adBanner = null;
    return;
  }
  const player = document.querySelector('#movie_player') || document.body;
  if (!adBanner || !document.body.contains(adBanner)) {
    adBanner = document.createElement('div');
    adBanner.id = 'cinemate-ad-banner';
    adBanner.setAttribute('role', 'status');
    adBanner.style.cssText = [
      'position:absolute',
      'top:12px',
      'right:12px',
      'z-index:2147483647',
      'background:linear-gradient(180deg,#f5c542 0%,#c9941a 100%)',
      'color:#3a0608',
      'font-family:Georgia,serif',
      'font-size:13px',
      'font-weight:700',
      'letter-spacing:0.3px',
      'padding:8px 14px',
      'border-radius:6px',
      'border:1px solid #b8860b',
      'box-shadow:0 4px 12px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.4)',
      'pointer-events:none',
      'max-width:280px',
      'word-wrap:break-word'
    ].join(';');
  }
  if (adBanner.parentNode !== player) player.appendChild(adBanner);
  if (player !== document.body && getComputedStyle(player).position === 'static') {
    player.style.position = 'relative';
  }
  const names = othersInAd.map(p => p.pseudo).join(', ');
  adBanner.textContent = `⏸ Pub en cours chez ${names}`;
}

// ----- Boot -----

function init() {
  const v = findVideo();
  if (v && v !== video) {
    video = v;
    attachVideoListeners(video);
    registerVideo();
    // On a trouvé une vidéo stable → on stoppe l'observer pour éviter
    // de réagir à chaque mutation DOM (très coûteux sur YouTube/SPA).
    // Il sera réarmé sur changement d'URL.
    stopObserver();
    startAdObserver();
  }
}

let observer = null;
let observerRaf = 0;

function debouncedInit() {
  if (observerRaf) return;
  observerRaf = requestAnimationFrame(() => {
    observerRaf = 0;
    init();
  });
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(debouncedInit);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObserver() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
  if (observerRaf) {
    cancelAnimationFrame(observerRaf);
    observerRaf = 0;
  }
}

startObserver();
window.addEventListener('load', init);
init();

// Refresh périodique du state hôte vers le bg (alimente le heartbeat).
setInterval(() => {
  if (inRoom && isHost && video) {
    browser.runtime.sendMessage({
      type: 'REGISTER_VIDEO_TAB',
      url: location.href,
      currentTime: video.currentTime,
      paused: video.paused
    }).catch(() => {});
  }
}, 2000);

// Détection rapide d'un changement d'URL côté hôte (SPA YouTube, etc.) :
// dès que l'URL change, on re-trigge l'init pour retrouver la nouvelle vidéo
// et on pousse le nouvel état au bg pour que les invités soient redirigés
// au prochain heartbeat.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    video = null;
    // Nouvelle page → on réarme l'observer pour retrouver la nouvelle <video>
    stopAdObserver();
    localInAd = false;
    pausedByAdGate = false;
    // Nouvelle vidéo en cours de chargement → on n'est plus prêt.
    if (inRoom && !isHost && hasSentReady) {
      browser.runtime.sendMessage({ type: 'SET_READY', ready: false }).catch(() => {});
    }
    hasSentReady = false;
    startObserver();
    init();
    if (inRoom && isHost) {
      // Petit délai pour laisser la nouvelle vidéo se charger
      setTimeout(() => {
        if (video) {
          browser.runtime.sendMessage({
            type: 'REGISTER_VIDEO_TAB',
            url: location.href,
            currentTime: video.currentTime,
            paused: video.paused
          }).catch(() => {});
        }
      }, 500);
    }
  }
}, 500);

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'APPLY_SYNC') {
    // Tant qu'une pub tourne (ici ou ailleurs), on ne touche pas au player :
    // soit l'ad joue localement, soit on est figé en attendant que les autres
    // sortent de pub. Le resync vient ensuite via REQUEST_SYNC / heartbeat.
    if (localInAd || othersInAd.length > 0) return;
    applySync(message);
  } else if (message.type === 'CHECK_DRIFT') {
    // Heartbeat invité : reposition uniquement si drift > 1s ou état play/pause incohérent
    if (!video || isHost) return;
    if (localInAd || othersInAd.length > 0) return;
    const drift = Math.abs(video.currentTime - message.currentTime);
    const playMismatch = video.paused !== message.paused;
    if (drift > 1.0 || playMismatch) {
      applySync(message);
    }
  } else if (message.type === 'SET_ROLE') {
    isHost = !!message.isHost;
    if (message.leftRoom) {
      inRoom = false;
      othersInAd = [];
      pausedByAdGate = false;
      currentMembers = [];
      selfPeerId = null;
      hasSentReady = false;
      renderBanner([]);
      renderAdBanner();
    } else {
      inRoom = true;
      // Création/rejointure : on fige la lecture au timecode courant.
      // L'hôte ne pourra play qu'après que tout le monde soit prêt.
      if (video && !video.paused) {
        isSyncing = true;
        nativePause(video);
        setTimeout(() => { isSyncing = false; }, 100);
      }
    }
  } else if (message.type === 'ROOM_MEMBERS') {
    currentMembers = message.members || [];
    if (message.selfPeerId) selfPeerId = message.selfPeerId;
    renderBanner(currentMembers);
    // Si quelqu'un n'est pas prêt et qu'on est en lecture, on coupe.
    if (video && !video.paused && !localInAd && !allMembersReady()) {
      isSyncing = true;
      nativePause(video);
      setTimeout(() => { isSyncing = false; }, 100);
      notifyNotReady();
    }
  } else if (message.type === 'OTHERS_IN_AD') {
    othersInAd = message.peers || [];
    applyAdGate();
  } else if (message.type === 'SHOW_TOAST') {
    showToast(message.message || '');
  } else if (message.type === 'PING') {
    return Promise.resolve({ ok: true, hasVideo: !!video });
  }
});
