import browser from 'webextension-polyfill';

let video = null;
let isHost = false;
let inRoom = false;
let isSyncing = false;
let lastSync = null; // { currentTime, paused, ts }
let banner = null;

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

function registerVideo(action) {
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
  if (!video || !inRoom || !isHost || isSyncing) return;
  browser.runtime.sendMessage({
    type: 'VIDEO_EVENT',
    action,
    url: location.href,
    currentTime: video.currentTime,
    paused: video.paused
  }).catch(() => {});
}

function enforceGuestState() {
  if (!video || !lastSync || isHost) return;
  const expected = lastSync.paused
    ? lastSync.currentTime
    : lastSync.currentTime + (Date.now() - lastSync.ts) / 1000;

  if (Math.abs(video.currentTime - expected) > 0.5) {
    isSyncing = true;
    nativeSetCurrentTime(video, expected);
    setTimeout(() => { isSyncing = false; }, 50);
  }
  if (lastSync.paused && !video.paused) {
    isSyncing = true;
    nativePause(video);
    setTimeout(() => { isSyncing = false; }, 50);
  } else if (!lastSync.paused && video.paused) {
    isSyncing = true;
    nativePlay(video);
    setTimeout(() => { isSyncing = false; }, 50);
  }
}

function attachVideoListeners(v) {
  v.addEventListener('play', () => {
    if (isSyncing) return;
    if (isHost) sendVideoEvent('play');
    else enforceGuestState();
  });
  v.addEventListener('pause', () => {
    if (isSyncing) return;
    if (isHost) sendVideoEvent('pause');
    else enforceGuestState();
  });
  v.addEventListener('seeked', () => {
    if (isSyncing) return;
    if (isHost) sendVideoEvent('seek');
    else enforceGuestState();
  });
  v.addEventListener('ratechange', () => {
    if (isSyncing) return;
    if (isHost) sendVideoEvent('rate');
  });
  v.addEventListener('loadedmetadata', () => registerVideo('loaded'));
}

function applySync(msg) {
  if (!video) return;
  isSyncing = true;
  lastSync = { currentTime: msg.currentTime, paused: msg.paused, ts: Date.now() };
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
  banner.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'right:16px',
    'z-index:2147483647',
    'background:linear-gradient(135deg,#6e3bff,#ff3ba0)',
    'color:#fff',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'font-size:13px',
    'padding:10px 14px',
    'border-radius:10px',
    'box-shadow:0 6px 20px rgba(0,0,0,.35)',
    'pointer-events:none',
    'max-width:360px',
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

function renderBanner(members) {
  if (!members || members.length === 0) {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
    return;
  }
  const el = ensureBanner();
  const sorted = [...members].sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    return a.pseudo.localeCompare(b.pseudo);
  });
  const visible = sorted.slice(0, 3).map(m => m.isHost ? `★ ${m.pseudo}` : m.pseudo);
  const extra = sorted.length - visible.length;
  const tail = extra > 0 ? ` +${extra} autre${extra > 1 ? 's' : ''}` : '';
  el.textContent = `Cinemate — ${visible.join(', ')}${tail}`;
}

// ----- Boot -----

function init() {
  const v = findVideo();
  if (v && v !== video) {
    video = v;
    attachVideoListeners(video);
    registerVideo('detected');
    // On a trouvé une vidéo stable → on stoppe l'observer pour éviter
    // de réagir à chaque mutation DOM (très coûteux sur YouTube/SPA).
    // Il sera réarmé sur changement d'URL.
    stopObserver();
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

// ----- Blocker clavier pour l'invité -----
// L'hôte garde le contrôle exclusif. Quand l'invité appuie sur les raccourcis
// vidéo classiques (espace, k, flèches…), on les bloque AVANT le player pour
// éviter le flicker visible (sinon enforceGuestState revert ~1s plus tard).

const BLOCKED_KEYS = new Set([
  ' ', 'Spacebar', 'k', 'K',           // play/pause
  'ArrowLeft', 'ArrowRight',           // seek 5s
  'j', 'J', 'l', 'L',                  // seek 10s
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', // seek %
  ',', '.'                             // frame step
]);

function isUserTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

let lastBlockedToastAt = 0;
document.addEventListener('keydown', (e) => {
  if (!inRoom || isHost) return;
  if (isUserTyping(e.target)) return;
  if (!BLOCKED_KEYS.has(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  // Toast informatif rate-limité (1 toutes les 5s) pour ne pas spammer
  const now = Date.now();
  if (now - lastBlockedToastAt > 5000) {
    lastBlockedToastAt = now;
    showToast('Tu es invité — seul l\'hôte contrôle la lecture');
  }
}, true /* capture phase, passe avant le player */);

// Pas d'enforcement périodique côté invité : c'était ce qui causait des
// saccades visibles toutes les secondes en cas de petit décalage naturel
// (buffering, frames perdues). La correction passe désormais uniquement par
// les events du player et le CHECK_DRIFT du heartbeat (toutes les 3s, seuil 1s).

// Periodically refresh hostState for the background (host only)
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
    lastSync = null;
    // Nouvelle page → on réarme l'observer pour retrouver la nouvelle <video>
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
    applySync(message);
  } else if (message.type === 'CHECK_DRIFT') {
    // Heartbeat invité : reposition uniquement si drift > 1s ou état play/pause incohérent
    if (!video || isHost) return;
    lastSync = { currentTime: message.currentTime, paused: message.paused, ts: Date.now() };
    const drift = Math.abs(video.currentTime - message.currentTime);
    const playMismatch = video.paused !== message.paused;
    if (drift > 1.0 || playMismatch) {
      applySync(message);
    }
  } else if (message.type === 'SET_ROLE') {
    isHost = !!message.isHost;
    if (message.leftRoom) {
      inRoom = false;
      lastSync = null;
      renderBanner([]);
    } else {
      inRoom = true;
    }
  } else if (message.type === 'ROOM_MEMBERS') {
    renderBanner(message.members || []);
  } else if (message.type === 'SHOW_TOAST') {
    showToast(message.message || '');
  } else if (message.type === 'PING') {
    return Promise.resolve({ ok: true, hasVideo: !!video });
  }
});
