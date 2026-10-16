/**
 * YouTube Music Jam - Background Service Worker (Manifest V3)
 * Manages persistent WebSocket connection to ws://localhost:8080
 * Coordinates state across YouTube Music tabs, content scripts, and popup.
 */

const DEFAULT_SERVER_URL = 'wss://ytm-jam-extension-0u7d.onrender.com';
let currentServerUrl = DEFAULT_SERVER_URL;
let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 10000;

// Active ports from content scripts and popup (keeps SW alive)
const activePorts = new Set();

// In-memory state cache
let currentRoom = null;
let currentUser = {
  userId: null,
  userName: 'Aman',
  roomId: null
};

// 1. Keep service worker awake and alive via chrome.alarms
chrome.alarms.create('ytm_jam_keepalive', { periodInMinutes: 0.3 }); // ~18 seconds
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ytm_jam_keepalive') {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    } else if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ action: 'PING' }));
      } catch (_) {}
    }
  }
});

// Watch for serverUrl changes from storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.serverUrl) {
    const val = changes.serverUrl.newValue;
    if (val && val !== currentServerUrl) {
      currentServerUrl = val;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      if (socket) {
        try { socket.close(); } catch (_) {}
        socket = null;
      }
      connectWebSocket();
    }
  }
});

// 2. Initialize user identity and last room from storage
async function initUserFromStorage() {
  const data = await chrome.storage.local.get(['userId', 'userName', 'roomId', 'lastRoomState', 'serverUrl']);
  if (!data.userId) {
    currentUser.userId = 'u_' + Math.random().toString(36).substring(2, 10);
    await chrome.storage.local.set({ userId: currentUser.userId });
  } else {
    currentUser.userId = data.userId;
  }

  if (data.serverUrl) {
    currentServerUrl = data.serverUrl;
  }
  if (data.userName) {
    currentUser.userName = data.userName;
  }
  if (data.roomId) {
    currentUser.roomId = data.roomId;
  }
  if (data.lastRoomState) {
    currentRoom = data.lastRoomState;
  }

  // Connect immediately upon startup
  connectWebSocket();
}

initUserFromStorage();

/**
 * Establish WebSocket connection with auto-reconnection
 */
function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(currentServerUrl);
  } catch (err) {
    console.warn('[YTM-Jam Background] Error creating WebSocket with URL', currentServerUrl, err);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log('[YTM-Jam Background] Connected to sync server:', currentServerUrl);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    broadcastToAll({ type: 'SOCKET_STATUS', connected: true });

    // Auto-rejoin room if we have a room saved
    if (currentUser.roomId && currentUser.userId) {
      sendWsMessage({
        action: 'JOIN',
        roomId: currentUser.roomId,
        userId: currentUser.userId,
        userName: currentUser.userName
      });
    }
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.warn('[YTM-Jam Background] Failed to parse message JSON:', e);
      return;
    }

    handleServerMessage(data);
  };

  socket.onclose = () => {
    console.log('[YTM-Jam Background] WebSocket closed.');
    socket = null;
    broadcastToAll({ type: 'SOCKET_STATUS', connected: false });
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.warn('[YTM-Jam Background] WebSocket error:', err.message || err);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[YTM-Jam Background] Scheduling reconnect in ${delay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function sendWsMessage(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  } else {
    // If not connected, connect first
    connectWebSocket();
    // Wait briefly and try sending
    setTimeout(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    }, 600);
  }
}

/**
 * Handle incoming messages from Server
 */
function handleServerMessage(data) {
  const { action } = data;

  if (action === 'PONG') {
    return;
  }

  if (action === 'ROOM_STATE') {
    currentRoom = data.room;
    chrome.storage.local.set({ lastRoomState: currentRoom, roomId: currentRoom.roomId });
    broadcastToAll({ type: 'ROOM_STATE', room: currentRoom });
  } else if (action === 'PLAYBACK_UPDATE') {
    if (currentRoom) {
      currentRoom.currentState = data.state;
      chrome.storage.local.set({ lastRoomState: currentRoom });
    }
    broadcastToAll({
      type: 'PLAYBACK_UPDATE',
      playbackAction: data.playbackAction,
      state: data.state,
      triggeredBy: data.triggeredBy
    });
  } else if (action === 'PARTICIPANTS_UPDATE') {
    if (currentRoom) {
      currentRoom.participants = data.participants;
      currentRoom.hostId = data.hostId;
      chrome.storage.local.set({ lastRoomState: currentRoom });
    }
    broadcastToAll({
      type: 'PARTICIPANTS_UPDATE',
      participants: data.participants,
      hostId: data.hostId
    });
  } else if (action === 'QUEUE_UPDATE') {
    if (currentRoom) {
      currentRoom.queue = data.queue;
      chrome.storage.local.set({ lastRoomState: currentRoom });
    }
    broadcastToAll({
      type: 'QUEUE_UPDATE',
      queue: data.queue
    });
  } else if (action === 'GUEST_CONTROL_UPDATED') {
    if (currentRoom) {
      currentRoom.allowGuestControl = data.allowGuestControl;
      chrome.storage.local.set({ lastRoomState: currentRoom });
    }
    broadcastToAll({
      type: 'GUEST_CONTROL_UPDATED',
      allowGuestControl: data.allowGuestControl
    });
  } else if (action === 'PERMISSION_DENIED') {
    broadcastToAll({
      type: 'PERMISSION_DENIED',
      message: data.message
    });
  } else if (action === 'ERROR') {
    broadcastToAll({
      type: 'SERVER_ERROR',
      message: data.message
    });
  }
}

/**
 * Broadcast payload to all open ports and YouTube Music tabs
 */
function broadcastToAll(message) {
  // 1. Post to active ports (Popup / Content Scripts)
  activePorts.forEach((port) => {
    try {
      port.postMessage(message);
    } catch (_) {
      activePorts.delete(port);
    }
  });

  // 2. Send message to tabs matching music.youtube.com
  chrome.tabs.query({ url: '*://music.youtube.com/*' }, (tabs) => {
    if (tabs && tabs.length > 0) {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    }
  });
}

/**
 * Keep service worker awake via long-lived port connections
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ytm-jam-port') {
    activePorts.add(port);

    // If socket isn't open, initiate connection now
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }

    // Send current status immediately upon connection
    port.postMessage({
      type: 'INIT_STATUS',
      connected: socket && socket.readyState === WebSocket.OPEN,
      serverUrl: currentServerUrl,
      currentUser,
      currentRoom
    });

    port.onDisconnect.addListener(() => {
      activePorts.delete(port);
    });

    port.onMessage.addListener(async (msg) => {
      try {
        const response = await handleClientRequest(msg);
        port.postMessage({ type: 'RESPONSE', requestId: msg.requestId, response });
      } catch (_) {}
    });
  }
});

/**
 * Handle direct messages via chrome.runtime.sendMessage
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleClientRequest(request)
    .then(res => sendResponse(res))
    .catch(err => sendResponse({ success: false, error: err?.message || String(err) }));
  return true; // Keep sendResponse open for async replies
});

async function handleClientRequest(request) {
  const { type } = request;

  if (type === 'BG_GET_STATUS') {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    return {
      connected: socket && socket.readyState === WebSocket.OPEN,
      serverUrl: currentServerUrl,
      currentUser,
      currentRoom
    };
  }

  if (type === 'BG_SET_SERVER_URL') {
    let newUrl = (request.serverUrl || '').trim();
    if (!newUrl) newUrl = DEFAULT_SERVER_URL;
    if (newUrl.startsWith('http://')) newUrl = newUrl.replace('http://', 'ws://');
    if (newUrl.startsWith('https://')) newUrl = newUrl.replace('https://', 'wss://');
    if (!newUrl.startsWith('ws://') && !newUrl.startsWith('wss://')) {
      newUrl = 'wss://' + newUrl;
    }
    newUrl = newUrl.replace(/\/+$/, '');

    currentServerUrl = newUrl;
    await chrome.storage.local.set({ serverUrl: currentServerUrl });

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    if (socket) {
      try { socket.close(); } catch (_) {}
      socket = null;
    }
    connectWebSocket();
    return { success: true, serverUrl: currentServerUrl };
  }

  if (type === 'BG_JOIN_ROOM') {
    const { roomId, userName, currentTrack } = request;
    if (!roomId) {
      return { success: false, message: 'Missing room ID' };
    }

    currentUser.roomId = roomId.trim().toUpperCase();
    if (userName) currentUser.userName = userName.trim();

    await chrome.storage.local.set({
      roomId: currentUser.roomId,
      userName: currentUser.userName
    });

    connectWebSocket();

    sendWsMessage({
      action: 'JOIN',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      userName: currentUser.userName,
      currentTrack: currentTrack || null
    });

    return { success: true, roomId: currentUser.roomId, userId: currentUser.userId };
  }

  if (type === 'BG_LEAVE_ROOM') {
    if (currentUser.roomId) {
      sendWsMessage({
        action: 'LEAVE',
        roomId: currentUser.roomId,
        userId: currentUser.userId
      });
    }

    currentUser.roomId = null;
    currentRoom = null;
    await chrome.storage.local.remove(['roomId', 'lastRoomState']);

    broadcastToAll({ type: 'LEFT_ROOM' });
    return { success: true };
  }

  if (type === 'BG_SEND_SYNC') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'SYNC_PLAYBACK',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      ...request.payload
    });
    return { success: true };
  }

  if (type === 'BG_ADD_QUEUE') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'ADD_TO_QUEUE',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      track: request.track
    });
    return { success: true };
  }

  if (type === 'BG_BULK_ADD_QUEUE') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'BULK_ADD_TO_QUEUE',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      tracks: request.tracks
    });
    return { success: true };
  }

  if (type === 'BG_REMOVE_QUEUE') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'REMOVE_FROM_QUEUE',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      queueItemId: request.queueItemId
    });
    return { success: true };
  }

  if (type === 'BG_REORDER_QUEUE') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'REORDER_QUEUE',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      fromIndex: request.fromIndex,
      toIndex: request.toIndex
    });
    return { success: true };
  }

  if (type === 'BG_PLAY_QUEUE') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'PLAY_FROM_QUEUE',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      queueItemId: request.queueItemId
    });
    return { success: true };
  }

  if (type === 'BG_TRACK_ENDED') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'TRACK_ENDED',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      videoId: request.videoId
    });
    return { success: true };
  }

  if (type === 'BG_TOGGLE_GUEST_CONTROL') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'TOGGLE_GUEST_CONTROL',
      roomId: currentUser.roomId,
      userId: currentUser.userId,
      allowGuestControl: request.allowGuestControl
    });
    return { success: true };
  }

  if (type === 'BG_REQUEST_SYNC') {
    if (!currentUser.roomId) {
      return { success: false, message: 'Not in a room' };
    }
    sendWsMessage({
      action: 'REQUEST_SYNC',
      roomId: currentUser.roomId,
      userId: currentUser.userId
    });
    return { success: true };
  }

  if (type === 'BG_SEARCH_TRACK') {
    const { title, artist } = request;
    if (!title || title === 'Unknown Title') {
      return { videoId: null };
    }

    const query = `${title} ${artist && artist !== 'Unknown Artist' ? artist : ''}`.trim();
    console.log(`[YTM-Jam Background] Searching YouTube for track: "${query}"`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const html = await res.text();
      // Match 1: Primary videoRenderer in initialData
      let match = html.match(/\"videoRenderer\":\{\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
      // Match 2: General videoId in search results
      if (!match) match = html.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
      // Match 3: URL watch link
      if (!match) match = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);

      const videoId = match ? match[1] : null;
      console.log(`[YTM-Jam Background] Search resolved videoId: ${videoId} for "${query}"`);
      return { videoId };
    } catch (err) {
      console.warn('[YTM-Jam Background] Search fallback failed:', err);
      return { videoId: null };
    }
  }

  return { success: false, message: 'Unknown request type' };
}
