import browser from 'webextension-polyfill';
import { Peer } from 'peerjs';

// State maps indexed by windowId
const rooms = new Map();          // windowId -> Room
const videoTabs = new Map();      // windowId -> tabId
const hostStates = new Map();     // windowId -> { url, currentTime, paused, recordedAt }

// ---------- Helpers ----------

const PSEUDO_MAX = 32;

// Normalise un pseudo reçu via DataChannel ou popup :
// trim, supprime caractères de contrôle, cap longueur. Évite XSS/spam.
function sanitizePseudo(raw) {
  if (typeof raw !== 'string') return '';
  // \p{C} = control chars (incl. zero-width, line separators, etc.)
  const cleaned = raw.replace(/[\p{C}]/gu, '').trim();
  return cleaned.slice(0, PSEUDO_MAX);
}

// Mappe les codes d'erreur PeerJS vers des messages utilisateur lisibles.
function describePeerError(err) {
  const type = err && (err.type || err.name) || '';
  const map = {
    'browser-incompatible': 'Ton navigateur ne supporte pas WebRTC.',
    'disconnected':         'Déconnecté du serveur Cinemate.',
    'invalid-id':           'ID de salle invalide.',
    'invalid-key':          'Clé invalide.',
    'network':              'Problème de connexion réseau.',
    'peer-unavailable':     'Salle introuvable ou hôte hors ligne.',
    'ssl-unavailable':      'Connexion SSL indisponible.',
    'server-error':         'Erreur du serveur Cinemate. Réessaie dans un instant.',
    'socket-error':         'Erreur réseau (socket).',
    'socket-closed':        'Connexion au serveur fermée.',
    'unavailable-id':       'Cet identifiant est déjà utilisé.',
    'webrtc':               'Erreur WebRTC.'
  };
  return map[type] || (err && err.message) || 'Erreur de connexion inconnue.';
}

/**
 * Room shape:
 * {
 *   windowId, roomId, pseudo, isHost,
 *   peer: PeerJS instance,
 *   connections: Map<peerId, DataConnection>,
 *   members: Map<peerId, { pseudo, isHost }>,
 *   selfPeerId
 * }
 */

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const conn of room.connections.values()) {
    if (conn.open) {
      try { conn.send(data); } catch (_) {}
    }
  }
}

function getMembersList(room) {
  const list = [];
  for (const [, info] of room.members) list.push(info);
  list.sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    return a.pseudo.localeCompare(b.pseudo);
  });
  return list;
}

async function sendToContent(windowId, message) {
  const tabId = videoTabs.get(windowId);
  if (tabId == null) return;
  for (let i = 0; i < 3; i++) {
    try {
      await browser.tabs.sendMessage(tabId, message);
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

function diffMembers(prev, current, selfPeerId) {
  const prevList = prev || [];
  const prevMap = new Map(prevList.map(m => [m.peerId, m]));
  const currentMap = new Map(current.map(m => [m.peerId, m]));

  const joined = [];
  const left = [];
  for (const m of current) {
    if (!prevMap.has(m.peerId) && m.peerId !== selfPeerId) joined.push(m.pseudo);
  }
  for (const m of prevList) {
    if (!currentMap.has(m.peerId) && m.peerId !== selfPeerId) left.push(m.pseudo);
  }

  const prevHost = prevList.find(m => m.isHost);
  const currentHost = current.find(m => m.isHost);
  let newHost = null;
  if (currentHost && (!prevHost || prevHost.peerId !== currentHost.peerId)) {
    newHost = currentHost;
  }
  return { joined, left, newHost };
}

function emitMemberToasts(windowId, diff, selfPeerId) {
  for (const pseudo of diff.joined) {
    sendToContent(windowId, { type: 'SHOW_TOAST', message: `${pseudo} a rejoint la salle` });
  }
  for (const pseudo of diff.left) {
    sendToContent(windowId, { type: 'SHOW_TOAST', message: `${pseudo} a quitté la salle` });
  }
  if (diff.newHost) {
    if (diff.newHost.peerId === selfPeerId) {
      sendToContent(windowId, { type: 'SHOW_TOAST', message: 'Tu es maintenant l\'hôte de la salle' });
    } else {
      sendToContent(windowId, { type: 'SHOW_TOAST', message: `${diff.newHost.pseudo} est maintenant l'hôte` });
    }
  }
}

function sendPopupUpdate() {
  // Le popup, s'il est ouvert, écoute ce message pour rafraîchir son état.
  // Si aucun popup ouvert, runtime.sendMessage rejette — on ignore.
  browser.runtime.sendMessage({ type: 'POPUP_UPDATE' }).catch(() => {});
}

async function notifyMembersUpdate(room, currentMembers) {
  const current = currentMembers || getMembersList(room);
  const isInitial = !room.lastMembers;
  const diff = diffMembers(room.lastMembers, current, room.selfPeerId);
  room.lastMembers = current;

  await sendToContent(room.windowId, {
    type: 'ROOM_MEMBERS',
    members: current,
    selfPeerId: room.selfPeerId
  });
  if (!isInitial) emitMemberToasts(room.windowId, diff, room.selfPeerId);
  sendPopupUpdate();

  if (room.isHost) {
    broadcast(room, { type: 'MEMBERS_UPDATE', members: current });
  }
}

function compensatedState(state) {
  if (!state) return null;
  if (state.paused) return state;
  const drift = (Date.now() - state.recordedAt) / 1000;
  return { ...state, currentTime: state.currentTime + drift, recordedAt: Date.now() };
}

const HEARTBEAT_MS = 3000;

function startHostHeartbeat(room) {
  if (room.heartbeatInterval) clearInterval(room.heartbeatInterval);
  room.heartbeatInterval = setInterval(() => {
    if (!room.isHost) return;
    const state = hostStates.get(room.windowId);
    if (!state) return;
    broadcast(room, {
      type: 'HEARTBEAT',
      url: state.url,
      currentTime: state.currentTime,
      paused: state.paused,
      recordedAt: state.recordedAt
    });
  }, HEARTBEAT_MS);
}

function stopHostHeartbeat(room) {
  if (room.heartbeatInterval) {
    clearInterval(room.heartbeatInterval);
    room.heartbeatInterval = null;
  }
}

async function followHostUrl(room, msg) {
  // Tient à jour l'URL attendue côté invité pour qu'elle puisse être
  // distinguée d'une navigation manuelle dans tabs.onUpdated.
  room.expectedHostUrl = msg.url;

  const tabId = videoTabs.get(room.windowId);
  if (tabId == null) {
    try {
      const [tab] = await browser.tabs.query({ active: true, windowId: room.windowId });
      if (tab) videoTabs.set(room.windowId, tab.id);
    } catch (_) {}
  }
  const target = videoTabs.get(room.windowId);
  if (target == null) return false;

  let tab;
  try { tab = await browser.tabs.get(target); } catch (_) { return false; }

  if (tab.url !== msg.url) {
    try {
      // Redirection en cours → on n'est plus prêt tant que la nouvelle page
      // n'a pas chargé sa vidéo (canplay ré-émettra SET_READY=true).
      if (!room.isHost) {
        const selfMember = room.members.get(room.selfPeerId);
        if (selfMember && selfMember.ready) selfMember.ready = false;
        for (const c of room.connections.values()) {
          if (c.open) c.send(JSON.stringify({ type: 'GUEST_READY', ready: false }));
        }
      }
      await browser.tabs.update(target, { url: msg.url });
      // Wait for the new page's content script before applying sync
      setTimeout(() => {
        const projected = msg.currentTime + (msg.paused ? 0 : (Date.now() - msg.recordedAt) / 1000);
        sendToContent(room.windowId, {
          type: 'APPLY_SYNC',
          action: 'seek',
          currentTime: projected,
          paused: msg.paused
        });
      }, 2500);
      return true;
    } catch (e) {
      console.warn('[cinemate] could not redirect tab', e);
    }
  }
  return false;
}

async function leaveRoomAndNotify(windowId, message) {
  leaveRoom(windowId);
  // Le tab est probablement en train de charger une nouvelle page,
  // sendToContent retente jusqu'à 3 fois — on attrape le nouveau content script.
  sendToContent(windowId, { type: 'SHOW_TOAST', message });
}

// Pubs : chaque membre signale son ad state. L'hôte agrège dans room.adStates
// et rebroadcast la liste à tous. Tant qu'au moins un membre est en pub, les
// autres se mettent en pause locale (gérée côté content script).
function notifyAdStates(room) {
  const peers = [];
  for (const peerId of room.adStates.keys()) {
    if (peerId === room.selfPeerId) continue;
    const member = room.members.get(peerId);
    if (member) peers.push({ peerId, pseudo: member.pseudo });
  }
  sendToContent(room.windowId, { type: 'OTHERS_IN_AD', peers });
}

function broadcastAdStates(room) {
  const peerIds = Array.from(room.adStates.keys());
  broadcast(room, { type: 'AD_STATES_UPDATE', peerIds });
}

function setupHostConnection(room, conn) {
  conn.on('open', async () => {
    room.connections.set(conn.peer, conn);
    // Send INITIAL_STATE to the new guest
    const state = compensatedState(hostStates.get(room.windowId));
    if (state) {
      conn.send(JSON.stringify({
        type: 'INITIAL_STATE',
        url: state.url,
        currentTime: state.currentTime,
        paused: state.paused,
        recordedAt: state.recordedAt
      }));
    }
    // État pubs courant : nécessaire pour que l'arrivant voie qui est déjà
    // en pub. Sinon il rate les AD_STATES_UPDATE émis avant son join.
    if (room.adStates && room.adStates.size > 0) {
      conn.send(JSON.stringify({
        type: 'AD_STATES_UPDATE',
        peerIds: Array.from(room.adStates.keys())
      }));
    }
  });

  conn.on('data', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'HELLO') {
      const safePseudo = sanitizePseudo(msg.pseudo) || 'Anonyme';
      // Nouvel invité = pas prêt par défaut. Doit cliquer "Je suis prêt" pour
      // débloquer la lecture côté hôte.
      room.members.set(conn.peer, { pseudo: safePseudo, isHost: false, peerId: conn.peer, ready: false });
      notifyMembersUpdate(room);
    } else if (msg.type === 'REQUEST_SYNC') {
      const state = compensatedState(hostStates.get(room.windowId));
      if (state) {
        conn.send(JSON.stringify({
          type: 'INITIAL_STATE',
          url: state.url,
          currentTime: state.currentTime,
          paused: state.paused,
          recordedAt: state.recordedAt
        }));
      }
    } else if (msg.type === 'AD_STATE') {
      // Un invité signale son entrée/sortie de pub.
      if (msg.inAd) room.adStates.set(conn.peer, true);
      else room.adStates.delete(conn.peer);
      broadcastAdStates(room);
      notifyAdStates(room);
    } else if (msg.type === 'GUEST_READY') {
      const member = room.members.get(conn.peer);
      if (member) {
        member.ready = !!msg.ready;
        notifyMembersUpdate(room);
      }
    } else if (msg.type === 'VIDEO_EVENT') {
      // Action venant d'un invité : appliquer côté hôte + relayer aux autres
      // invités. Pour play/pause/rate, on ne touche pas à hostStates.currentTime
      // (le currentTime émis par l'invité peut être en retard) ; le heartbeat
      // utilisera la position réelle de l'hôte (mise à jour par le setInterval
      // 2s côté content).
      const isSeek = msg.action === 'seek';
      const prevState = hostStates.get(room.windowId);
      hostStates.set(room.windowId, {
        url: msg.url,
        currentTime: isSeek ? msg.currentTime : (prevState ? prevState.currentTime : msg.currentTime),
        paused: msg.paused,
        recordedAt: Date.now()
      });
      sendToContent(room.windowId, {
        type: 'APPLY_SYNC',
        action: msg.action,
        currentTime: msg.currentTime,
        paused: msg.paused
      });
      const sender = conn.peer;
      for (const [peerId, c] of room.connections) {
        if (peerId === sender) continue;
        if (c.open) c.send(JSON.stringify({
          type: 'VIDEO_EVENT',
          action: msg.action,
          currentTime: msg.currentTime,
          paused: msg.paused,
          recordedAt: Date.now()
        }));
      }
    }
  });

  conn.on('close', () => {
    room.connections.delete(conn.peer);
    room.members.delete(conn.peer);
    if (room.adStates && room.adStates.delete(conn.peer)) {
      broadcastAdStates(room);
      notifyAdStates(room);
    }
    notifyMembersUpdate(room);
  });

  conn.on('error', (err) => {
    console.warn('[cinemate] connection error', err);
  });
}

function setupGuestConnection(room, conn) {
  conn.on('open', () => {
    room.connections.set(conn.peer, conn);
    conn.send(JSON.stringify({ type: 'HELLO', pseudo: room.pseudo }));
  });

  conn.on('data', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'INITIAL_STATE') {
      const redirected = await followHostUrl(room, msg);
      if (!redirected) {
        sendToContent(room.windowId, {
          type: 'APPLY_SYNC',
          action: 'seek',
          currentTime: msg.currentTime + (msg.paused ? 0 : (Date.now() - msg.recordedAt) / 1000),
          paused: msg.paused
        });
      }
    } else if (msg.type === 'VIDEO_EVENT') {
      sendToContent(room.windowId, {
        type: 'APPLY_SYNC',
        action: msg.action,
        currentTime: msg.currentTime + (msg.paused ? 0 : (Date.now() - msg.recordedAt) / 1000),
        paused: msg.paused
      });
    } else if (msg.type === 'HEARTBEAT') {
      // Suivi d'URL : si l'hôte a changé de vidéo, on redirige l'onglet invité.
      const redirected = await followHostUrl(room, msg);
      if (!redirected) {
        // Sinon on demande au content script de vérifier le drift (>1s déclenche reposition).
        const projected = msg.currentTime + (msg.paused ? 0 : (Date.now() - msg.recordedAt) / 1000);
        sendToContent(room.windowId, {
          type: 'CHECK_DRIFT',
          currentTime: projected,
          paused: msg.paused
        });
      }
    } else if (msg.type === 'AD_STATES_UPDATE') {
      // L'hôte rebroadcast la liste agrégée des peers en pub.
      room.adStates.clear();
      for (const peerId of msg.peerIds || []) room.adStates.set(peerId, true);
      notifyAdStates(room);
    } else if (msg.type === 'MEMBERS_UPDATE') {
      // L'hôte est source de vérité — on synchronise notre state local.
      // On re-sanitize les pseudos par défense en profondeur (un hôte
      // compromis ne peut pas injecter du contenu malveillant chez les invités).
      const sanitized = (msg.members || [])
        .filter(m => m && typeof m.peerId === 'string')
        .map(m => ({
          peerId: m.peerId,
          pseudo: sanitizePseudo(m.pseudo) || 'Anonyme',
          isHost: !!m.isHost,
          ready: !!m.ready
        }));
      room.members.clear();
      for (const m of sanitized) {
        room.members.set(m.peerId, m);
        if (m.isHost) room.hostPeerId = m.peerId;
      }
      notifyMembersUpdate(room, sanitized);
    }
  });

  conn.on('close', () => {
    room.connections.delete(conn.peer);
    // Si on est en train de quitter volontairement, on ne déclenche pas
    // le toast "hôte parti" — c'est nous qui fermons la connexion.
    if (room.leaving) return;
    if (conn.peer === room.hostPeerId) {
      // L'hôte a quitté → la salle est dissoute pour tous les invités.
      leaveRoomAndNotify(room.windowId, "L'hôte a quitté — la salle est dissoute");
    }
  });

  conn.on('error', (err) => {
    console.warn('[cinemate] guest conn error', err);
  });
}

function createRoom(windowId, pseudo) {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    const room = {
      windowId, pseudo, isHost: true,
      peer, connections: new Map(), members: new Map(), adStates: new Map(),
      selfPeerId: null, hostPeerId: null, roomId: null
    };
    let settled = false;

    peer.on('open', (id) => {
      room.selfPeerId = id;
      room.hostPeerId = id;
      room.roomId = id;
      // L'hôte est toujours considéré prêt — il contrôle le déclenchement.
      room.members.set(id, { pseudo, isHost: true, peerId: id, ready: true });
      rooms.set(windowId, room);
      sendToContent(windowId, { type: 'SET_ROLE', isHost: true });
      notifyMembersUpdate(room);
      startHostHeartbeat(room);
      settled = true;
      resolve({ roomId: id, windowId });
    });

    peer.on('connection', (conn) => {
      setupHostConnection(room, conn);
    });

    peer.on('error', (err) => {
      console.error('[cinemate] peer error', err);
      if (!settled) {
        settled = true;
        try { peer.destroy(); } catch (_) {}
        reject(new Error(describePeerError(err)));
      }
    });

    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (_) {}
    });
  });
}

function joinRoom(windowId, pseudo, roomId) {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    const room = {
      windowId, pseudo, isHost: false,
      peer, connections: new Map(), members: new Map(), adStates: new Map(),
      selfPeerId: null, hostPeerId: roomId, roomId
    };
    let settled = false;
    let connectTimer = 0;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = 0; }
      // Si on a déjà inscrit la room dans la map, on la nettoie sans
      // émettre le toast "hôte parti" (room.leaving = true via leaveRoom).
      if (rooms.get(windowId) === room) leaveRoom(windowId);
      try { peer.destroy(); } catch (_) {}
      reject(new Error(describePeerError(err)));
    };

    peer.on('open', (id) => {
      room.selfPeerId = id;
      rooms.set(windowId, room);
      const conn = peer.connect(roomId, { reliable: true });
      setupGuestConnection(room, conn);

      // On ne résout que quand le DataChannel est réellement ouvert.
      // Évite que le popup transitionne en "en salle" avant qu'on ait la
      // confirmation que l'hôte est joignable (cf. T022/T026).
      conn.on('open', () => {
        if (settled) return;
        settled = true;
        sendToContent(windowId, { type: 'SET_ROLE', isHost: false });
        resolve({ windowId });
      });

      // Garde-fou : si rien n'ouvre dans 10s, on échoue avec une erreur claire.
      connectTimer = setTimeout(() => {
        fail({ type: 'peer-unavailable' });
      }, 10000);
    });

    peer.on('error', (err) => {
      console.error('[cinemate] peer error', err);
      if (!settled) {
        // Échec avant que la connexion soit prête (réseau, serveur down,
        // ID inexistant détecté tôt par PeerJS, etc.)
        fail(err);
      } else if (err && err.type === 'peer-unavailable') {
        // Cas tardif : l'hôte disparaît après l'établissement de la salle.
        leaveRoomAndNotify(windowId, describePeerError(err));
      }
    });

    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (_) {}
    });
  });
}

function leaveRoom(windowId) {
  const room = rooms.get(windowId);
  if (!room) return;
  // Marqueur consulté par les handlers conn.on('close') pour ne pas
  // émettre le toast "hôte parti" alors que c'est nous qui partons.
  room.leaving = true;
  stopHostHeartbeat(room);
  for (const conn of room.connections.values()) {
    try { conn.close(); } catch (_) {}
  }
  try { room.peer.destroy(); } catch (_) {}
  rooms.delete(windowId);
  hostStates.delete(windowId);
  sendToContent(windowId, { type: 'ROOM_MEMBERS', members: [] });
  sendToContent(windowId, { type: 'SET_ROLE', isHost: false, leftRoom: true });
  sendPopupUpdate();
}

// Message routing
browser.runtime.onMessage.addListener(async (message, sender) => {
  // POPUP_UPDATE est destiné uniquement au popup ; on l'ignore côté bg.
  if (message.type === 'POPUP_UPDATE') return;
  switch (message.type) {
    case 'REGISTER_VIDEO_TAB': {
      const tabId = sender.tab && sender.tab.id;
      const windowId = sender.tab && sender.tab.windowId;
      if (tabId == null || windowId == null) return { inRoom: false };

      const room = rooms.get(windowId);
      const lockedTab = videoTabs.get(windowId);

      // Lock anti-race : si une salle existe déjà pour cette window et qu'elle
      // est attachée à un autre onglet, on refuse l'enregistrement. Évite
      // qu'un second onglet vidéo dans la même fenêtre n'orpheline la salle.
      if (room && lockedTab != null && lockedTab !== tabId) {
        return { inRoom: false, locked: true };
      }

      videoTabs.set(windowId, tabId);

      if (room && room.isHost) {
        const prev = hostStates.get(windowId);
        const urlChanged = !!(prev && prev.url && prev.url !== message.url);
        hostStates.set(windowId, {
          url: message.url,
          currentTime: message.currentTime,
          paused: message.paused,
          recordedAt: Date.now()
        });
        // Nouvelle vidéo côté hôte → tous les invités redeviennent "pas prêt"
        // tant qu'ils n'ont pas chargé la nouvelle vidéo.
        if (urlChanged) {
          let any = false;
          for (const member of room.members.values()) {
            if (!member.isHost && member.ready) { member.ready = false; any = true; }
          }
          if (any) notifyMembersUpdate(room);
        }
      }
      if (room) {
        return {
          inRoom: true,
          isHost: room.isHost,
          members: getMembersList(room)
        };
      }
      return { inRoom: false };
    }

    case 'VIDEO_EVENT': {
      const windowId = sender.tab && sender.tab.windowId;
      const room = rooms.get(windowId);
      if (!room) return;
      if (room.isHost) {
        hostStates.set(windowId, {
          url: message.url,
          currentTime: message.currentTime,
          paused: message.paused,
          recordedAt: Date.now()
        });
        broadcast(room, {
          type: 'VIDEO_EVENT',
          action: message.action,
          currentTime: message.currentTime,
          paused: message.paused,
          recordedAt: Date.now()
        });
      } else {
        // Invité : forward à l'hôte qui appliquera localement et relaiera
        // aux autres invités.
        for (const conn of room.connections.values()) {
          if (conn.open) conn.send(JSON.stringify({
            type: 'VIDEO_EVENT',
            action: message.action,
            url: message.url,
            currentTime: message.currentTime,
            paused: message.paused
          }));
        }
      }
      return;
    }

    case 'REQUEST_SYNC': {
      const windowId = sender.tab && sender.tab.windowId;
      const room = rooms.get(windowId);
      if (!room || room.isHost) return;
      // Ask the host
      for (const conn of room.connections.values()) {
        if (conn.open) conn.send(JSON.stringify({ type: 'REQUEST_SYNC' }));
      }
      return;
    }

    case 'SET_READY': {
      // Bouton "Je suis prêt" côté invité.
      const windowId = sender.tab && sender.tab.windowId;
      const room = rooms.get(windowId);
      if (!room || room.isHost) return;
      const ready = !!message.ready;
      const selfMember = room.members.get(room.selfPeerId);
      if (selfMember) selfMember.ready = ready;
      // L'hôte est source de vérité : on le notifie, il rebroadcast à tous.
      for (const conn of room.connections.values()) {
        if (conn.open) conn.send(JSON.stringify({ type: 'GUEST_READY', ready }));
      }
      // Feedback local immédiat (n'attend pas le rebroadcast).
      notifyMembersUpdate(room);
      return;
    }

    case 'AD_STATE': {
      // Le content script signale son entrée/sortie de pub.
      const windowId = sender.tab && sender.tab.windowId;
      const room = rooms.get(windowId);
      if (!room) return;
      const selfId = room.selfPeerId;
      if (room.isHost) {
        // Hôte : met à jour son propre état + rebroadcast à tous.
        if (message.inAd) room.adStates.set(selfId, true);
        else room.adStates.delete(selfId);
        broadcastAdStates(room);
        notifyAdStates(room);
      } else {
        // Invité : envoie à l'hôte qui agrégera et rebroadcast.
        for (const conn of room.connections.values()) {
          if (conn.open) conn.send(JSON.stringify({ type: 'AD_STATE', inAd: !!message.inAd }));
        }
      }
      return;
    }

    case 'CREATE_ROOM': {
      try {
        const { windowId } = message;
        const pseudo = sanitizePseudo(message.pseudo);
        if (!pseudo) return { ok: false, error: 'Pseudo requis.' };
        try {
          const [tab] = await browser.tabs.query({ active: true, windowId });
          if (tab) videoTabs.set(windowId, tab.id);
        } catch (_) {}
        const result = await createRoom(windowId, pseudo);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }

    case 'JOIN_ROOM': {
      try {
        const { windowId } = message;
        const pseudo = sanitizePseudo(message.pseudo);
        const roomId = typeof message.roomId === 'string' ? message.roomId.trim() : '';
        if (!pseudo) return { ok: false, error: 'Pseudo requis.' };
        if (!roomId) return { ok: false, error: 'ID de salle requis.' };
        // Ouvre un nouvel onglet dédié à la salle (on ne squatte pas l'onglet
        // courant). followHostUrl naviguera ce tab vers l'URL de l'hôte dès
        // que l'INITIAL_STATE arrivera.
        try {
          const newTab = await browser.tabs.create({ windowId, url: 'about:blank', active: true });
          videoTabs.set(windowId, newTab.id);
        } catch (_) {}
        const result = await joinRoom(windowId, pseudo, roomId);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }

    case 'LEAVE_ROOM': {
      leaveRoom(message.windowId);
      return { ok: true };
    }

    case 'GET_ROOM_INFO': {
      const room = rooms.get(message.windowId);
      if (!room) return { inRoom: false };
      return {
        inRoom: true,
        isHost: room.isHost,
        roomId: room.roomId,
        pseudo: room.pseudo,
        members: getMembersList(room)
      };
    }
  }
});

// Cleanup on tab close — couvre aussi la fermeture de la fenêtre entière
// (chaque tab fermé déclenche un onRemoved). Si une salle était attachée à
// ce tab, on la quitte : pour l'hôte ça dissout la salle pour les invités via
// la fermeture des DataChannels ; pour l'invité ça libère la connexion côté
// hôte qui propage un MEMBERS_UPDATE aux autres.
browser.tabs.onRemoved.addListener((tabId) => {
  for (const [windowId, id] of videoTabs) {
    if (id === tabId) {
      videoTabs.delete(windowId);
      if (rooms.has(windowId)) leaveRoom(windowId);
    }
  }
});

// Détection de navigation manuelle d'un invité :
// si l'URL du tab change et ne correspond pas à celle de l'hôte connue,
// on considère que l'invité a quitté la salle.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const windowId = tab.windowId;
  const tracked = videoTabs.get(windowId);
  if (tracked !== tabId) return;
  const room = rooms.get(windowId);
  if (!room || room.isHost) return;
  if (room.expectedHostUrl && changeInfo.url === room.expectedHostUrl) return;
  leaveRoomAndNotify(windowId, 'Tu as quitté la salle Cinemate');
});
