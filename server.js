/**
 * YouTube Music Jam - Real-Time Synchronization Server
 * Node.js WebSocket Server on port 8080
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Create HTTP server for cloud health checks (Render, Railway, Glitch)
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    status: 'online',
    service: 'YouTube Music Jam Server',
    activeRooms: rooms.size,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now()
  }));
});

// Attach WebSocket server to HTTP server
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`[YTM-Jam Server] Running on http/ws port ${PORT}`);
});

/**
 * In-memory room store:
 * Map<roomId, RoomObject>
 */
const rooms = new Map();

/**
 * Generate a clean, human-readable room summary to send to clients
 */
function serializeRoom(room) {
  const participants = Array.from(room.participants.values()).map(p => ({
    userId: p.userId,
    userName: p.userName,
    isHost: p.userId === room.hostId,
    joinedAt: p.joinedAt
  }));

  // Calculate live timestamp for playback if currently playing
  const calculatedState = { ...room.currentState };
  if (calculatedState.isPlaying && calculatedState.updatedAt > 0) {
    const elapsed = (Date.now() - calculatedState.updatedAt) / 1000;
    calculatedState.currentTime = (calculatedState.currentTime || 0) + elapsed;
    if (calculatedState.duration > 0 && calculatedState.currentTime > calculatedState.duration) {
      calculatedState.currentTime = calculatedState.duration;
    }
  }

  return {
    roomId: room.roomId,
    hostId: room.hostId,
    allowGuestControl: room.allowGuestControl,
    participants,
    currentState: calculatedState,
    queue: room.queue
  };
}

/**
 * Broadcast a JSON message to all clients in a room
 */
function broadcast(room, payload, excludeWs = null) {
  const message = JSON.stringify(payload);
  room.participants.forEach(participant => {
    if (participant.ws && participant.ws !== excludeWs && participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(message);
    }
  });
}

/**
 * Advance to next track in queue
 */
function advanceQueue(room, reason = 'auto_queue') {
  if (room.queue.length === 0) {
    room.currentState.isPlaying = false;
    room.currentState.updatedAt = Date.now();
    broadcast(room, {
      action: 'PLAYBACK_UPDATE',
      playbackAction: 'PAUSE',
      state: room.currentState,
      triggeredBy: reason
    });
    return null;
  }

  const nextTrack = room.queue.shift();
  room.currentState = {
    videoId: nextTrack.videoId,
    title: nextTrack.title,
    artist: nextTrack.artist,
    thumbnail: nextTrack.thumbnail,
    duration: nextTrack.duration || 0,
    currentTime: 0,
    isPlaying: true,
    updatedAt: Date.now()
  };

  broadcast(room, {
    action: 'PLAYBACK_UPDATE',
    playbackAction: 'TRACK_CHANGE',
    state: room.currentState,
    triggeredBy: reason
  });

  broadcast(room, {
    action: 'QUEUE_UPDATE',
    queue: room.queue
  });

  return nextTrack;
}

function cleanRoomCode(input) {
  if (!input) return '';
  const str = input.trim();
  const match = str.match(/[?&]jam=([a-zA-Z0-9]+)/i);
  if (match) return match[1].toUpperCase();
  return str.replace(/^https?:\/\/[^\/]+\/?/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/**
 * Automatically fetch missing song title and artist via YouTube's official OEMBED endpoint
 */
function resolveOEmbedMetadata(videoId, room) {
  if (!videoId || !room) return;
  fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`)
    .then(res => res.json())
    .then(data => {
      if (data && data.title && room.currentState.videoId === videoId) {
        const cleanTitle = data.title;
        const cleanArtist = (data.author_name || '').replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube Music';
        room.currentState.title = cleanTitle;
        if (!room.currentState.artist || room.currentState.artist === 'Unknown Artist') {
          room.currentState.artist = cleanArtist;
        }
        if (!room.currentState.thumbnail) {
          room.currentState.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        }
        console.log(`[YTM-Jam Server] [${room.roomId}] Resolved OEmbed title: "${cleanTitle}" by "${cleanArtist}"`);
        broadcast(room, {
          action: 'PLAYBACK_UPDATE',
          playbackAction: 'METADATA_UPDATE',
          state: room.currentState,
          triggeredBy: 'server_oembed'
        });
      }
    })
    .catch(err => {
      console.warn(`[YTM-Jam Server] OEmbed lookup failed for ${videoId}:`, err.message);
    });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.userId = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch (err) {
      console.error('[YTM-Jam Server] Failed to parse message JSON:', err.message);
      return;
    }

    const { action, roomId, userId, userName } = data;

    // Handle Ping Heartbeat
    if (action === 'PING') {
      ws.isAlive = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'PONG', timestamp: Date.now() }));
      }
      return;
    }

    // 1. JOIN ROOM
    if (action === 'JOIN') {
      if (!roomId || !userId) {
        ws.send(JSON.stringify({ action: 'ERROR', message: 'Missing roomId or userId' }));
        return;
      }

      const cleanRoomId = cleanRoomCode(roomId);
      if (!cleanRoomId) {
        ws.send(JSON.stringify({ action: 'ERROR', message: 'Invalid room ID' }));
        return;
      }

      const cleanUserName = (userName && userName.trim()) || 'Participant';

      let room = rooms.get(cleanRoomId);
      if (!room) {
        room = {
          roomId: cleanRoomId,
          hostId: userId,
          allowGuestControl: true,
          participants: new Map(),
          currentState: {
            videoId: null,
            title: '',
            artist: '',
            thumbnail: '',
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            updatedAt: Date.now()
          },
          queue: [],
          cleanupTimer: null,
          lastTrackEndedAt: 0
        };
        rooms.set(cleanRoomId, room);
        console.log(`[YTM-Jam Server] Created new room: ${cleanRoomId} (Host: ${cleanUserName} [${userId}])`);
      } else {
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = null;
          console.log(`[YTM-Jam Server] Cancelled cleanup timer for room: ${cleanRoomId}`);
        }
        // If current host is gone, assign this user as host
        if (!room.hostId || !room.participants.has(room.hostId)) {
          room.hostId = userId;
        }
      }

      // If room has no active song and joiner provided their current track, adopt it!
      if (!room.currentState.videoId && data.currentTrack && data.currentTrack.videoId) {
        room.currentState = {
          videoId: data.currentTrack.videoId,
          title: data.currentTrack.title || '',
          artist: data.currentTrack.artist || '',
          thumbnail: data.currentTrack.thumbnail || (data.currentTrack.videoId ? `https://i.ytimg.com/vi/${data.currentTrack.videoId}/hqdefault.jpg` : ''),
          isPlaying: data.currentTrack.isPlaying !== false,
          currentTime: data.currentTrack.currentTime || 0,
          duration: data.currentTrack.duration || 0,
          updatedAt: Date.now()
        };
        console.log(`[YTM-Jam Server] [${cleanRoomId}] Adopted initial track from ${cleanUserName}: "${room.currentState.title}" [${room.currentState.videoId}]`);
        if (!room.currentState.title || room.currentState.title === 'Unknown Title') {
          resolveOEmbedMetadata(room.currentState.videoId, room);
        }
      }

      ws.roomId = cleanRoomId;
      ws.userId = userId;

      room.participants.set(userId, {
        userId,
        userName: cleanUserName,
        ws,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      });

      console.log(`[YTM-Jam Server] User ${cleanUserName} (${userId}) joined room ${cleanRoomId}. Total: ${room.participants.size}`);

      // Send initial full room state to the joiner
      ws.send(JSON.stringify({
        action: 'ROOM_STATE',
        room: serializeRoom(room)
      }));

      // Broadcast participants update to everyone else in the room
      broadcast(room, {
        action: 'PARTICIPANTS_UPDATE',
        participants: Array.from(room.participants.values()).map(p => ({
          userId: p.userId,
          userName: p.userName,
          isHost: p.userId === room.hostId,
          joinedAt: p.joinedAt
        })),
        hostId: room.hostId
      }, ws);

      return;
    }

    // All following actions require an active room
    if (!ws.roomId || !rooms.has(ws.roomId)) {
      return;
    }

    const room = rooms.get(ws.roomId);
    const participant = room.participants.get(ws.userId);
    if (participant) {
      participant.lastSeen = Date.now();
    }

    // 2. LEAVE ROOM
    if (action === 'LEAVE') {
      handleUserLeave(ws);
      return;
    }

    // 3. REQUEST_SYNC
    if (action === 'REQUEST_SYNC') {
      ws.send(JSON.stringify({
        action: 'ROOM_STATE',
        room: serializeRoom(room)
      }));
      return;
    }

    // 4. TOGGLE GUEST CONTROL (Host only)
    if (action === 'TOGGLE_GUEST_CONTROL') {
      if (ws.userId !== room.hostId) {
        ws.send(JSON.stringify({ action: 'ERROR', message: 'Only the host can toggle guest controls.' }));
        return;
      }
      room.allowGuestControl = !!data.allowGuestControl;
      broadcast(room, {
        action: 'GUEST_CONTROL_UPDATED',
        allowGuestControl: room.allowGuestControl
      });
      return;
    }

    // 5. SYNC PLAYBACK (PLAY, PAUSE, SEEK, TRACK_CHANGE, HEARTBEAT)
    if (action === 'SYNC_PLAYBACK') {
      const { playbackAction, videoId, title, artist, thumbnail, currentTime, duration } = data;

      // Handle Host or active leader periodic heartbeat
      if (playbackAction === 'HEARTBEAT') {
        const canHeartbeat = (ws.userId === room.hostId) || (room.allowGuestControl && videoId === room.currentState.videoId);
        if (canHeartbeat && videoId === room.currentState.videoId) {
          room.currentState.currentTime = typeof currentTime === 'number' ? currentTime : room.currentState.currentTime;
          room.currentState.duration = typeof duration === 'number' ? duration : room.currentState.duration;
          room.currentState.isPlaying = true;
          room.currentState.updatedAt = Date.now();
          broadcast(room, {
            action: 'PLAYBACK_UPDATE',
            playbackAction: 'HEARTBEAT',
            state: room.currentState,
            triggeredBy: ws.userId
          }, ws);
        }
        return;
      }

      // Check permission: If guest control is disabled and sender is not host
      if (!room.allowGuestControl && ws.userId !== room.hostId) {
        ws.send(JSON.stringify({
          action: 'PERMISSION_DENIED',
          message: 'Host has restricted playback controls to host-only.'
        }));
        // Send back current state to force revert guest
        ws.send(JSON.stringify({
          action: 'PLAYBACK_UPDATE',
          playbackAction: room.currentState.isPlaying ? 'PLAY' : 'PAUSE',
          state: serializeRoom(room).currentState,
          triggeredBy: 'server_revert'
        }));
        return;
      }

      // Suppress duplicate or ping-pong TRACK_CHANGE
      if (playbackAction === 'TRACK_CHANGE') {
        const now = Date.now();
        if (room.currentState.videoId === videoId) {
          console.log(`[YTM-Jam Server] [${room.roomId}] Suppressing duplicate TRACK_CHANGE for active video: ${videoId}`);
          return;
        }
        if (ws.userId !== room.hostId && room.lastTrackChangeAt && (now - room.lastTrackChangeAt < 3500)) {
          console.log(`[YTM-Jam Server] [${room.roomId}] Suppressing rapid guest TRACK_CHANGE within cooldown`);
          return;
        }
        room.lastTrackChangeAt = now;
      }

      // Resolve title / artist if missing or Unknown
      let finalTitle = title;
      let finalArtist = artist;
      let finalThumb = thumbnail;

      if ((!finalTitle || finalTitle === 'Unknown Title') && videoId) {
        const qItem = room.queue.find(item => item.videoId === videoId);
        if (qItem) {
          finalTitle = qItem.title;
          finalArtist = qItem.artist;
          finalThumb = qItem.thumbnail;
        } else if (room.currentState.videoId === videoId && room.currentState.title && room.currentState.title !== 'Unknown Title') {
          finalTitle = room.currentState.title;
          finalArtist = room.currentState.artist;
          finalThumb = room.currentState.thumbnail;
        }
      }

      const isPlay = playbackAction === 'PLAY';
      const isPause = playbackAction === 'PAUSE';

      // Update room playback state
      room.currentState = {
        videoId: videoId || room.currentState.videoId,
        title: (finalTitle && finalTitle !== 'Unknown Title') ? finalTitle : (room.currentState.title || finalTitle || ''),
        artist: (finalArtist && finalArtist !== 'Unknown Artist') ? finalArtist : (room.currentState.artist || finalArtist || ''),
        thumbnail: finalThumb || room.currentState.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''),
        isPlaying: isPlay ? true : (isPause ? false : room.currentState.isPlaying),
        currentTime: typeof currentTime === 'number' ? currentTime : (room.currentState.currentTime || 0),
        duration: typeof duration === 'number' ? duration : (room.currentState.duration || 0),
        updatedAt: Date.now()
      };

      console.log(`[YTM-Jam Server] [${room.roomId}] SYNC_PLAYBACK (${playbackAction}): "${room.currentState.title}" [${room.currentState.videoId}] @ ${room.currentState.currentTime.toFixed(1)}s (isPlaying: ${room.currentState.isPlaying})`);

      // If title is still missing or Unknown Title, query OEMBED asynchronously
      if (room.currentState.videoId && (!room.currentState.title || room.currentState.title === 'Unknown Title')) {
        resolveOEmbedMetadata(room.currentState.videoId, room);
      }

      // Broadcast update: TRACK_CHANGE goes to everyone; PLAY/PAUSE/SEEK excludes sender
      const excludeWs = (playbackAction === 'TRACK_CHANGE') ? null : ws;
      broadcast(room, {
        action: 'PLAYBACK_UPDATE',
        playbackAction,
        state: room.currentState,
        triggeredBy: ws.userId
      }, excludeWs);

      return;
    }

    // 6. ADD TO QUEUE
    if (action === 'ADD_TO_QUEUE') {
      const { track } = data;
      if (!track || !track.videoId) return;

      const queueItem = {
        id: 'q_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
        videoId: track.videoId,
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
        thumbnail: track.thumbnail || '',
        duration: track.duration || 0,
        addedBy: (participant && participant.userName) || 'Guest',
        addedById: ws.userId,
        addedAt: Date.now()
      };

      room.queue.push(queueItem);

      // If nothing is playing, play this track right away
      if (!room.currentState.videoId) {
        advanceQueue(room, 'first_track_added');
      } else {
        broadcast(room, {
          action: 'QUEUE_UPDATE',
          queue: room.queue,
          addedItem: queueItem
        });
      }
      return;
    }

    // 7. BULK ADD TO QUEUE (For Up Next import)
    if (action === 'BULK_ADD_TO_QUEUE') {
      const { tracks } = data;
      if (!Array.isArray(tracks) || tracks.length === 0) return;

      const addedItems = [];
      tracks.forEach(track => {
        if (!track.videoId) return;
        const item = {
          id: 'q_' + Math.random().toString(36).substring(2, 9) + '_' + Math.random().toString(36).substring(2, 5),
          videoId: track.videoId,
          title: track.title || 'Unknown Title',
          artist: track.artist || 'Unknown Artist',
          thumbnail: track.thumbnail || '',
          duration: track.duration || 0,
          addedBy: (participant && participant.userName) || 'Import',
          addedById: ws.userId,
          addedAt: Date.now()
        };
        room.queue.push(item);
        addedItems.push(item);
      });

      if (!room.currentState.videoId && room.queue.length > 0) {
        advanceQueue(room, 'bulk_import');
      } else {
        broadcast(room, {
          action: 'QUEUE_UPDATE',
          queue: room.queue,
          bulkCount: addedItems.length
        });
      }
      return;
    }

    // 8. REMOVE FROM QUEUE
    if (action === 'REMOVE_FROM_QUEUE') {
      const { queueItemId } = data;
      room.queue = room.queue.filter(item => item.id !== queueItemId);
      broadcast(room, {
        action: 'QUEUE_UPDATE',
        queue: room.queue
      });
      return;
    }

    // 9. REORDER QUEUE
    if (action === 'REORDER_QUEUE') {
      const { fromIndex, toIndex } = data;
      if (typeof fromIndex === 'number' && typeof toIndex === 'number') {
        if (fromIndex >= 0 && fromIndex < room.queue.length && toIndex >= 0 && toIndex < room.queue.length) {
          const [movedItem] = room.queue.splice(fromIndex, 1);
          room.queue.splice(toIndex, 0, movedItem);
          broadcast(room, {
            action: 'QUEUE_UPDATE',
            queue: room.queue
          });
        }
      }
      return;
    }

    // 10. PLAY FROM QUEUE
    if (action === 'PLAY_FROM_QUEUE') {
      const { queueItemId } = data;
      if (!room.allowGuestControl && ws.userId !== room.hostId) {
        ws.send(JSON.stringify({ action: 'PERMISSION_DENIED', message: 'Only the host can start tracks.' }));
        return;
      }

      const itemIdx = room.queue.findIndex(item => item.id === queueItemId);
      if (itemIdx !== -1) {
        const [targetTrack] = room.queue.splice(itemIdx, 1);
        room.currentState = {
          videoId: targetTrack.videoId,
          title: targetTrack.title,
          artist: targetTrack.artist,
          thumbnail: targetTrack.thumbnail,
          duration: targetTrack.duration || 0,
          currentTime: 0,
          isPlaying: true,
          updatedAt: Date.now()
        };

        broadcast(room, {
          action: 'PLAYBACK_UPDATE',
          playbackAction: 'TRACK_CHANGE',
          state: room.currentState,
          triggeredBy: ws.userId
        });

        broadcast(room, {
          action: 'QUEUE_UPDATE',
          queue: room.queue
        });
      }
      return;
    }

    // 11. TRACK ENDED (Auto-Advance Queue)
    if (action === 'TRACK_ENDED') {
      const { videoId } = data;
      const now = Date.now();

      // Debounce track ended (within 3 seconds) to prevent simultaneous multiple client triggers
      if (now - room.lastTrackEndedAt < 3000) {
        return;
      }

      // Check if video matches current playing video
      if (!videoId || videoId === room.currentState.videoId) {
        room.lastTrackEndedAt = now;
        console.log(`[YTM-Jam Server] Track ended in room ${room.roomId}. Advancing queue...`);
        advanceQueue(room, 'track_ended');
      }
      return;
    }
  });

  ws.on('close', () => {
    handleUserLeave(ws);
  });

  ws.on('error', (err) => {
    console.error(`[YTM-Jam Server] WebSocket error for user ${ws.userId}:`, err.message);
  });
});

/**
 * Handle user disconnection or deliberate LEAVE
 */
function handleUserLeave(ws) {
  if (!ws.roomId || !rooms.has(ws.roomId)) return;

  const room = rooms.get(ws.roomId);
  const userId = ws.userId;
  const participant = room.participants.get(userId);
  const userName = participant ? participant.userName : 'User';

  room.participants.delete(userId);
  console.log(`[YTM-Jam Server] ${userName} (${userId}) left room ${room.roomId}. Remaining: ${room.participants.size}`);

  // If room is now empty, set cleanup timer (5 minutes grace period for page reloads)
  if (room.participants.size === 0) {
    room.cleanupTimer = setTimeout(() => {
      if (room.participants.size === 0) {
        rooms.delete(room.roomId);
        console.log(`[YTM-Jam Server] Room ${room.roomId} cleaned up after inactivity.`);
      }
    }, 5 * 60 * 1000);
    return;
  }

  // If the leaving user was the host, promote the oldest active participant
  if (room.hostId === userId) {
    const nextParticipant = room.participants.values().next().value;
    if (nextParticipant) {
      room.hostId = nextParticipant.userId;
      console.log(`[YTM-Jam Server] Host promoted to ${nextParticipant.userName} (${nextParticipant.userId}) in room ${room.roomId}`);
    }
  }

  // Broadcast updated participant list and host
  broadcast(room, {
    action: 'PARTICIPANTS_UPDATE',
    participants: Array.from(room.participants.values()).map(p => ({
      userId: p.userId,
      userName: p.userName,
      isHost: p.userId === room.hostId,
      joinedAt: p.joinedAt
    })),
    hostId: room.hostId
  });

  ws.roomId = null;
  ws.userId = null;
}

/**
 * Ping-Pong Heartbeat Interval (clean dead connections every 25 seconds)
 */
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`[YTM-Jam Server] Terminating stale socket (User: ${ws.userId})`);
      handleUserLeave(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});