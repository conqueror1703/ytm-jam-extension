/**
 * YouTube Music Jam - Extension Popup Controller
 * Connects with background.js and updates UI reactively
 */

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app-root');
  const socketDot = document.getElementById('socket-dot');
  const socketText = document.getElementById('socket-status-text');

  // Settings elements
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const serverUrlInput = document.getElementById('server-url-input');
  const serverSaveBtn = document.getElementById('server-save-btn');
  const serverPresetLocal = document.getElementById('server-preset-local');
  const activeServerUrlText = document.getElementById('active-server-url-text');
  const serverSaveMsg = document.getElementById('server-save-msg');

  let currentRoom = null;
  let currentUser = {
    userId: null,
    userName: 'Aman',
    roomId: null
  };
  let currentServerUrl = 'ws://localhost:8080';
  let isConnected = false;
  let lastRenderedView = null; // 'NOT_IN_ROOM' | 'IN_ROOM'
  let pendingRoomCode = '';

  function updateServerDisplay(url) {
    if (url) {
      currentServerUrl = url;
      if (activeServerUrlText) activeServerUrlText.innerText = url;
      if (serverUrlInput && !serverUrlInput.matches(':focus')) {
        serverUrlInput.value = url;
      }
    }
  }

  function saveServerUrl(url) {
    chrome.runtime.sendMessage({ type: 'BG_SET_SERVER_URL', serverUrl: url }, (res) => {
      if (res && res.serverUrl) {
        updateServerDisplay(res.serverUrl);
        if (serverSaveMsg) {
          serverSaveMsg.innerText = 'Saved!';
          setTimeout(() => { if (serverSaveMsg) serverSaveMsg.innerText = ''; }, 2500);
        }
      }
    });
  }

  if (settingsToggleBtn && settingsPanel) {
    settingsToggleBtn.addEventListener('click', () => {
      settingsPanel.classList.toggle('hidden');
    });
  }

  if (serverPresetLocal && serverUrlInput) {
    serverPresetLocal.addEventListener('click', () => {
      serverUrlInput.value = 'ws://localhost:8080';
      saveServerUrl('ws://localhost:8080');
    });
  }

  if (serverSaveBtn && serverUrlInput) {
    serverSaveBtn.addEventListener('click', () => {
      const targetUrl = serverUrlInput.value.trim();
      saveServerUrl(targetUrl);
    });
  }

  // 1. Initial render
  render();

  // 2. Fetch persisted data directly from storage
  chrome.storage.local.get(['userId', 'userName', 'roomId', 'lastRoomState', 'serverUrl'], (data) => {
    if (data.userId) currentUser.userId = data.userId;
    if (data.userName) currentUser.userName = data.userName;
    if (data.roomId) currentUser.roomId = data.roomId;
    if (data.lastRoomState) currentRoom = data.lastRoomState;
    if (data.serverUrl) updateServerDisplay(data.serverUrl);

    // Only render if room state transitioned
    if (currentRoom) {
      render();
    } else {
      // Just update name input value without rewriting DOM
      const nameInput = document.getElementById('user-name-input');
      if (nameInput && !nameInput.matches(':focus')) {
        nameInput.value = currentUser.userName;
      }
    }
  });

  // 3. Connect to background via Port
  let port = null;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'ytm-jam-port' });

      port.onMessage.addListener((msg) => {
        handleBackgroundMessage(msg);
      });

      port.onDisconnect.addListener(() => {
        port = null;
        updateConnectionStatus(false);
        setTimeout(connectPort, 1500);
      });
    } catch (e) {
      setTimeout(connectPort, 1500);
    }
  }
  connectPort();

  // 4. Query background status
  function fetchStatus() {
    chrome.runtime.sendMessage({ type: 'BG_GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError) {
        updateConnectionStatus(false);
        return;
      }
      if (res) {
        isConnected = !!res.connected;
        if (res.currentUser) currentUser = res.currentUser;
        if (res.serverUrl) updateServerDisplay(res.serverUrl);

        // Check if room changed
        const roomChanged = JSON.stringify(currentRoom) !== JSON.stringify(res.currentRoom);
        if (res.currentRoom) currentRoom = res.currentRoom;
        else if (currentRoom && !res.currentRoom) currentRoom = null;

        updateConnectionStatus(isConnected);

        // ONLY trigger re-render if room state actually changed!
        if (roomChanged || (currentRoom && lastRenderedView !== 'IN_ROOM')) {
          render();
        }
      }
    });
  }
  fetchStatus();
  const pollInterval = setInterval(fetchStatus, 3000);
  window.addEventListener('unload', () => clearInterval(pollInterval));

  // 5. Handle messages from Background
  function handleBackgroundMessage(msg) {
    const { type } = msg;

    if (type === 'INIT_STATUS') {
      isConnected = !!msg.connected;
      if (msg.currentUser) currentUser = msg.currentUser;
      if (msg.serverUrl) updateServerDisplay(msg.serverUrl);
      const roomChanged = JSON.stringify(currentRoom) !== JSON.stringify(msg.currentRoom);
      currentRoom = msg.currentRoom;
      updateConnectionStatus(isConnected);
      if (roomChanged || (currentRoom && lastRenderedView !== 'IN_ROOM')) {
        render();
      }
      return;
    }

    if (type === 'SOCKET_STATUS') {
      isConnected = !!msg.connected;
      updateConnectionStatus(isConnected);
      return;
    }

    if (type === 'ROOM_STATE') {
      currentRoom = msg.room;
      render();
      return;
    }

    if (type === 'PLAYBACK_UPDATE') {
      if (currentRoom) {
        currentRoom.currentState = msg.state;
      }
      if (lastRenderedView === 'IN_ROOM') {
        updateNowPlayingCard();
      }
      return;
    }

    if (type === 'PARTICIPANTS_UPDATE') {
      if (currentRoom) {
        currentRoom.participants = msg.participants;
        currentRoom.hostId = msg.hostId;
      }
      if (lastRenderedView === 'IN_ROOM') {
        updateParticipantsCard();
      }
      return;
    }

    if (type === 'QUEUE_UPDATE') {
      if (currentRoom) {
        currentRoom.queue = msg.queue;
      }
      if (lastRenderedView === 'IN_ROOM') {
        updateQueueCard();
      }
      return;
    }

    if (type === 'GUEST_CONTROL_UPDATED') {
      if (currentRoom) {
        currentRoom.allowGuestControl = msg.allowGuestControl;
      }
      render();
      return;
    }

    if (type === 'LEFT_ROOM') {
      currentRoom = null;
      render();
      return;
    }
  }

  function updateConnectionStatus(connected) {
    if (connected) {
      socketDot.classList.add('online');
      socketText.innerText = 'Connected';
      socketText.style.color = '#22c55e';
    } else {
      socketDot.classList.remove('online');
      socketText.innerText = 'Disconnected';
      socketText.style.color = '#a1a1aa';
    }
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // 6. Targeted DOM Updates (preserves user interaction and scroll position)
  function updateNowPlayingCard() {
    const currentState = currentRoom?.currentState || {};
    const titleEl = root.querySelector('.now-playing-title');
    const artistEl = root.querySelector('.now-playing-artist');
    const artEl = root.querySelector('.now-playing-art');

    if (titleEl) titleEl.innerText = currentState.title || 'No track playing';
    if (artistEl) artistEl.innerText = currentState.artist || 'Waiting for track';
    if (artEl && currentState.thumbnail) artEl.src = currentState.thumbnail;
  }

  function updateParticipantsCard() {
    const participants = currentRoom?.participants || [];
    const countEl = root.querySelector('#participants-count');
    const listEl = root.querySelector('.participants-list');

    if (countEl) countEl.innerText = participants.length;
    if (listEl) {
      listEl.innerHTML = participants.map(p => {
        const isSelf = p.userId === currentUser.userId;
        const initial = (p.userName || 'P')[0].toUpperCase();
        return `
          <div class="participant-item">
            <div class="avatar">${escapeHtml(initial)}</div>
            <span class="participant-name">${escapeHtml(p.userName)}</span>
            ${p.isHost ? '<span class="badge-host">👑 Host</span>' : ''}
            ${isSelf ? '<span style="font-size:9px; background:rgba(255,255,255,0.15); padding:2px 4px; border-radius:3px;">You</span>' : ''}
          </div>
        `;
      }).join('');
    }
  }

  function updateQueueCard() {
    const queue = currentRoom?.queue || [];
    const countEl = root.querySelector('#queue-count');
    const listEl = root.querySelector('.queue-list');

    if (countEl) countEl.innerText = queue.length;
    if (listEl) {
      if (queue.length === 0) {
        listEl.innerHTML = `<div style="text-align: center; color: #71717a; font-size: 11px; padding: 12px 0;">Jam queue is empty. Click "+ Jam" on songs or import Up Next!</div>`;
      } else {
        listEl.innerHTML = queue.map((item, idx) => `
          <div class="queue-item" data-id="${item.id}" data-index="${idx}">
            <img class="queue-thumb" src="${item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/default.jpg'}" />
            <div class="queue-meta">
              <div class="queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
              <div class="queue-artist">${escapeHtml(item.artist)} • Added by ${escapeHtml(item.addedBy)}</div>
            </div>
            <div style="display: flex; gap: 2px;">
              <button class="icon-btn play-btn" data-action="play" data-id="${item.id}" title="Play Now">▶</button>
              ${idx > 0 ? `<button class="icon-btn" data-action="up" data-index="${idx}" title="Move Up">▲</button>` : ''}
              ${idx < queue.length - 1 ? `<button class="icon-btn" data-action="down" data-index="${idx}" title="Move Down">▼</button>` : ''}
              <button class="icon-btn remove-btn" data-action="remove" data-id="${item.id}" title="Remove">✕</button>
            </div>
          </div>
        `).join('');
        bindQueueEvents();
      }
    }
  }

  // 7. Full Render Function
  function render() {
    if (!root) return;

    // View A: NOT IN ROOM
    if (!currentRoom) {
      // If already showing the NOT_IN_ROOM form, DO NOT rewrite innerHTML (preserves active typing!)
      if (lastRenderedView === 'NOT_IN_ROOM' && document.getElementById('room-code-input')) {
        return;
      }
      lastRenderedView = 'NOT_IN_ROOM';

      root.innerHTML = `
        <div class="card">
          <div class="card-title">Profile</div>
          <input type="text" id="user-name-input" class="input" placeholder="Your Display Name" value="${escapeHtml(currentUser.userName || 'Aman')}" />
        </div>

        <div class="card">
          <div class="card-title">Create a Jam</div>
          <p style="font-size: 11px; color: #a1a1aa; margin-bottom: 8px;">Start a synchronized listening room for your friends.</p>
          <button id="create-jam-btn" class="btn-primary">
            <span>✨ Create New Jam Room</span>
          </button>
        </div>

        <div class="divider"><span>OR</span></div>

        <div class="card">
          <div class="card-title">Join Existing Jam</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <input type="text" id="room-code-input" class="input" placeholder="Enter 6-char Room Code (e.g. JAM123)" value="${escapeHtml(pendingRoomCode)}" />
            <button id="join-jam-btn" class="btn-secondary">
              <span>🚀 Join Room</span>
            </button>
          </div>
        </div>

        <p style="font-size: 11px; color: #71717a; text-align: center; margin-top: auto;">
          Open <a href="https://music.youtube.com" target="_blank" style="color: #ff0033; text-decoration: none; font-weight: bold;">music.youtube.com</a> to use in-page controls.
        </p>
      `;

      // Event listeners for NOT IN ROOM
      const nameInput = document.getElementById('user-name-input');
      if (nameInput) {
        nameInput.addEventListener('input', () => {
          currentUser.userName = nameInput.value.trim() || 'Aman';
          chrome.storage.local.set({ userName: currentUser.userName });
        });
      }

      const codeInput = document.getElementById('room-code-input');
      if (codeInput) {
        codeInput.addEventListener('input', () => {
          pendingRoomCode = codeInput.value;
        });
        codeInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const joinBtn = document.getElementById('join-jam-btn');
            if (joinBtn) joinBtn.click();
          }
        });
      }

      const createBtn = document.getElementById('create-jam-btn');
      if (createBtn) {
        createBtn.addEventListener('click', () => {
          const name = nameInput ? nameInput.value.trim() : (currentUser.userName || 'Host');
          currentUser.userName = name || 'Host';
          const code = generateRoomCode();
          joinRoom(code, currentUser.userName);
        });
      }

      const joinBtn = document.getElementById('join-jam-btn');
      if (joinBtn) {
        joinBtn.addEventListener('click', () => {
          const name = nameInput ? nameInput.value.trim() : (currentUser.userName || 'Guest');
          currentUser.userName = name || 'Guest';
          const code = codeInput ? codeInput.value.trim().toUpperCase() : '';
          if (!code) {
            if (codeInput) {
              codeInput.focus();
              codeInput.placeholder = 'Please enter room code first!';
            }
            return;
          }
          joinRoom(code, currentUser.userName);
        });
      }

      return;
    }

    // View B: IN ROOM
    lastRenderedView = 'IN_ROOM';
    const isHost = currentRoom.hostId === currentUser.userId;
    const participants = currentRoom.participants || [];
    const queue = currentRoom.queue || [];
    const currentState = currentRoom.currentState || {};

    let participantsHtml = participants.map(p => {
      const isSelf = p.userId === currentUser.userId;
      const initial = (p.userName || 'P')[0].toUpperCase();
      return `
        <div class="participant-item">
          <div class="avatar">${escapeHtml(initial)}</div>
          <span class="participant-name">${escapeHtml(p.userName)}</span>
          ${p.isHost ? '<span class="badge-host">👑 Host</span>' : ''}
          ${isSelf ? '<span style="font-size:9px; background:rgba(255,255,255,0.15); padding:2px 4px; border-radius:3px;">You</span>' : ''}
        </div>
      `;
    }).join('');

    let queueHtml = '';
    if (queue.length === 0) {
      queueHtml = `<div style="text-align: center; color: #71717a; font-size: 11px; padding: 12px 0;">Jam queue is empty. Click "+ Jam" on songs or import Up Next!</div>`;
    } else {
      queueHtml = queue.map((item, idx) => `
        <div class="queue-item" data-id="${item.id}" data-index="${idx}">
          <img class="queue-thumb" src="${item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/default.jpg'}" />
          <div class="queue-meta">
            <div class="queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="queue-artist">${escapeHtml(item.artist)} • Added by ${escapeHtml(item.addedBy)}</div>
          </div>
          <div style="display: flex; gap: 2px;">
            <button class="icon-btn play-btn" data-action="play" data-id="${item.id}" title="Play Now">▶</button>
            ${idx > 0 ? `<button class="icon-btn" data-action="up" data-index="${idx}" title="Move Up">▲</button>` : ''}
            ${idx < queue.length - 1 ? `<button class="icon-btn" data-action="down" data-index="${idx}" title="Move Down">▼</button>` : ''}
            <button class="icon-btn remove-btn" data-action="remove" data-id="${item.id}" title="Remove">✕</button>
          </div>
        </div>
      `).join('');
    }

    root.innerHTML = `
      <!-- Room Code & Link Card -->
      <div class="card">
        <div class="card-title">
          <span>Active Jam Room</span>
          <span style="color: #22c55e;">● Live</span>
        </div>
        <div class="room-info">
          <span class="room-code">${escapeHtml(currentRoom.roomId)}</span>
          <button class="copy-btn" id="copy-link-btn">
            <span>📋 Copy Link</span>
          </button>
        </div>

        <!-- Host Controls Toggle -->
        ${isHost ? `
          <div class="toggle-row">
            <span>Allow guests to control playback</span>
            <label class="switch">
              <input type="checkbox" id="guest-control-toggle" ${currentRoom.allowGuestControl ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        ` : `
          <div class="toggle-row" style="color:#71717a;">
            <span>Playback controls:</span>
            <span>${currentRoom.allowGuestControl ? '🔓 Everyone' : '🔒 Host Only'}</span>
          </div>
        `}
      </div>

      <!-- Now Playing Card -->
      <div class="card">
        <div class="card-title">Now Playing</div>
        <div class="now-playing">
          <img class="now-playing-art" src="${currentState.thumbnail || 'https://i.ytimg.com/vi/' + (currentState.videoId || 'default') + '/hqdefault.jpg'}" />
          <div class="now-playing-info">
            <div class="now-playing-title">${escapeHtml(currentState.title || 'No track playing')}</div>
            <div class="now-playing-artist">${escapeHtml(currentState.artist || 'Waiting for track')}</div>
          </div>
        </div>
      </div>

      <!-- Participants List -->
      <div class="card">
        <div class="card-title">
          <span>Participants</span>
          <span id="participants-count">${participants.length}</span>
        </div>
        <div class="participants-list">
          ${participantsHtml}
        </div>
      </div>

      <!-- Shared Queue -->
      <div class="card">
        <div class="queue-header">
          <div class="card-title" style="margin-bottom: 0;">
            <span>Shared Queue (<span id="queue-count">${queue.length}</span>)</span>
          </div>
          <button class="copy-btn" id="import-upnext-btn" style="padding: 3px 6px;">
            <span>📥 Import Up Next</span>
          </button>
        </div>
        <div class="queue-list">
          ${queueHtml}
        </div>
      </div>

      <button id="leave-jam-btn" class="btn-leave">Leave Jam Room</button>
    `;

    // Bind In-Room Listeners
    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const inviteUrl = `https://music.youtube.com/?jam=${currentRoom.roomId}`;
        navigator.clipboard.writeText(inviteUrl).then(() => {
          copyBtn.classList.add('copied');
          copyBtn.innerHTML = '<span>✓ Copied!</span>';
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.innerHTML = '<span>📋 Copy Link</span>';
          }, 2000);
        });
      });
    }

    if (isHost) {
      const toggle = document.getElementById('guest-control-toggle');
      if (toggle) {
        toggle.addEventListener('change', () => {
          chrome.runtime.sendMessage({
            type: 'BG_TOGGLE_GUEST_CONTROL',
            allowGuestControl: toggle.checked
          });
        });
      }
    }

    const importBtn = document.getElementById('import-upnext-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        chrome.tabs.query({ url: '*://music.youtube.com/*' }, (tabs) => {
          if (!tabs || tabs.length === 0) {
            alert('Please open music.youtube.com to import your Up Next queue!');
            return;
          }
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
              const btn = document.getElementById('ytm-jam-import-up-next-btn');
              if (btn) btn.click();
            }
          });
        });
      });
    }

    const leaveBtn = document.getElementById('leave-jam-btn');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'BG_LEAVE_ROOM' }, () => {
          currentRoom = null;
          pendingRoomCode = '';
          render();
        });
      });
    }

    bindQueueEvents();
  }

  function bindQueueEvents() {
    root.querySelectorAll('.queue-item button').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.getAttribute('data-action');
        const id = button.getAttribute('data-id');
        const index = parseInt(button.getAttribute('data-index'), 10);

        if (action === 'play') {
          chrome.runtime.sendMessage({ type: 'BG_PLAY_QUEUE', queueItemId: id });
        } else if (action === 'remove') {
          chrome.runtime.sendMessage({ type: 'BG_REMOVE_QUEUE', queueItemId: id });
        } else if (action === 'up' && index > 0) {
          chrome.runtime.sendMessage({ type: 'BG_REORDER_QUEUE', fromIndex: index, toIndex: index - 1 });
        } else if (action === 'down' && index < (currentRoom?.queue?.length || 0) - 1) {
          chrome.runtime.sendMessage({ type: 'BG_REORDER_QUEUE', fromIndex: index, toIndex: index + 1 });
        }
      });
    });
  }

  function cleanRoomCode(input) {
    if (!input) return '';
    const str = input.trim();
    const match = str.match(/[?&]jam=([a-zA-Z0-9]+)/i);
    if (match) return match[1].toUpperCase();
    return str.replace(/^https?:\/\/[^\/]+\/?/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  function joinRoom(roomId, userName) {
    if (!roomId) return;
    const cleanRoomId = cleanRoomCode(roomId);
    if (!cleanRoomId) return;
    chrome.runtime.sendMessage({
      type: 'BG_JOIN_ROOM',
      roomId: cleanRoomId,
      userName: userName || currentUser.userName
    }, (res) => {
      if (res && res.success) {
        currentUser.roomId = res.roomId;
        currentUser.userId = res.userId;
        fetchStatus();
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});