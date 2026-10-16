/**
 * YouTube Music Jam - Content Script
 * Handles player synchronization, ad detection, UI injection, and queue management.
 */

(function () {
  console.log('[YTM-Jam Content] Initializing content script...');

  // State
  let currentRoom = null;
  let currentUserId = null;
  let currentUserName = 'Music Lover';
  let isSyncingFromRemote = false;
  let isAdPlaying = false;
  let videoElement = null;
  let port = null;
  let lastReportedVideoId = null;
  let lastBroadcastedVideoId = null;
  let pendingPlaybackState = null;
  let lastTrackEndedSentAt = 0;
  let isDrawerOpen = false;
  let ignoreLocalSeeksUntil = 0;
  let lastDriftCorrectionAt = 0;
  let lastLocalSeekSentAt = 0;
  let lastHostHeartbeatAt = 0;
  let userInitiatedControlAction = false;
  let userInitiatedResetTimer = null;
  let lastTrackChangeSentAt = 0;

  function markUserAction() {
    userInitiatedControlAction = true;
    if (userInitiatedResetTimer) clearTimeout(userInitiatedResetTimer);
    userInitiatedResetTimer = setTimeout(() => {
      userInitiatedControlAction = false;
    }, 2000);
  }

  // Calculate live dynamic playback time based on elapsed seconds since updatedAt
  function getEstimatedRoomTime(currentState) {
    if (!currentState || typeof currentState.currentTime !== 'number') return 0;
    if (!currentState.isPlaying || !currentState.updatedAt) return currentState.currentTime;
    const elapsed = (Date.now() - currentState.updatedAt) / 1000;
    const est = currentState.currentTime + elapsed;
    if (currentState.duration && currentState.duration > 0 && est > currentState.duration) {
      return currentState.duration;
    }
    return est;
  }

  // Track direct user clicks and keypresses on player controls
  window.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    if (
      target.closest?.('ytmusic-player-bar') ||
      target.closest?.('#player') ||
      target.closest?.('#movie_player') ||
      target.closest?.('video') ||
      target.closest?.('ytmusic-play-button-renderer') ||
      target.closest?.('.ytm-jam-add-btn') ||
      target.closest?.('#ytm-jam-inpage-queue') ||
      target.closest?.('#ytm-jam-drawer')
    ) {
      markUserAction();
    }
    // Auto-unblock audio on first click anywhere
    const pill = document.getElementById('ytm-jam-autoplay-pill');
    if (pill) pill.remove();
    if (videoElement && currentRoom?.currentState?.isPlaying && videoElement.paused) {
      videoElement.play().catch(() => {});
    }
  }, { capture: true });

  window.addEventListener('keydown', (e) => {
    const key = e.key;
    if ([' ', 'k', 'K', 'j', 'J', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'].includes(key)) {
      if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        markUserAction();
      }
    }
  }, { capture: true });

  function showAutoplaySyncPrompt() {
    if (document.getElementById('ytm-jam-autoplay-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'ytm-jam-autoplay-pill';
    pill.style.cssText = `
      position: fixed;
      bottom: 85px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99999999;
      background: linear-gradient(135deg, #ff0033 0%, #c40028 100%);
      color: #fff;
      padding: 10px 22px;
      border-radius: 999px;
      box-shadow: 0 8px 25px rgba(255, 0, 51, 0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: Roboto, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
      transition: transform 0.2s ease;
    `;
    pill.innerHTML = `
      <span style="font-size: 16px;">🎧</span>
      <span>Music is playing in Jam • Click here to sync audio</span>
    `;
    pill.addEventListener('click', () => {
      if (videoElement) {
        videoElement.play().catch(() => {});
        sendToBridge({ action: 'CMD_PLAY' });
      }
      pill.remove();
    });
    document.body.appendChild(pill);
    setTimeout(() => { if (pill.parentNode) pill.remove(); }, 15000);
  }

  // page-bridge.js is injected into MAIN world by manifest.json at document_start

  // Helper to talk to page-bridge.js in MAIN world
  function sendToBridge(payload) {
    window.postMessage({
      source: 'YTM_JAM_CONTENT',
      ...payload
    }, '*');
  }

  // 1b. Immediately read local storage on startup
  chrome.storage.local.get(['userId', 'userName', 'roomId', 'lastRoomState'], (data) => {
    if (data.userId) currentUserId = data.userId;
    if (data.userName) currentUserName = data.userName;
    if (data.lastRoomState) {
      currentRoom = data.lastRoomState;
      updateUI();
    } else if (data.roomId) {
      chrome.runtime.sendMessage({ type: 'BG_GET_STATUS' }, (res) => {
        if (res && res.currentRoom) {
          currentRoom = res.currentRoom;
          updateUI();
        }
      });
    }
  });

  // 2. Connect to Background Service Worker via Port
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'ytm-jam-port' });

      port.onMessage.addListener((msg) => {
        handleBackgroundMessage(msg);
      });

      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connectPort, 2000);
      });
    } catch (err) {
      console.warn('[YTM-Jam Content] Port connect error:', err);
      setTimeout(connectPort, 2000);
    }
  }
  connectPort();

  // Also listen for one-off messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    handleBackgroundMessage(msg);
  });

  // 3. Handle messages from Background Service Worker
  function handleBackgroundMessage(msg) {
    const { type } = msg;

    if (type === 'INIT_STATUS') {
      if (msg.currentUser) {
        currentUserId = msg.currentUser.userId;
        currentUserName = msg.currentUser.userName || currentUserName;
      }
      if (msg.currentRoom) {
        currentRoom = msg.currentRoom;
        applyPlaybackState(currentRoom.currentState, 'INIT');
      }
      updateUI();
      checkForUrlInvite();
      return;
    }

    if (type === 'ROOM_STATE') {
      currentRoom = msg.room;
      updateUI();
      if (currentRoom.currentState) {
        applyPlaybackState(currentRoom.currentState, 'ROOM_STATE');
      }
      return;
    }

    if (type === 'PLAYBACK_UPDATE') {
      if (currentRoom) {
        currentRoom.currentState = msg.state;
      }
      applyPlaybackState(msg.state, msg.playbackAction);
      updateUI();
      return;
    }

    if (type === 'PARTICIPANTS_UPDATE') {
      if (currentRoom) {
        currentRoom.participants = msg.participants;
        currentRoom.hostId = msg.hostId;
      }
      updateUI();
      return;
    }

    if (type === 'QUEUE_UPDATE') {
      if (currentRoom) {
        currentRoom.queue = msg.queue;
      }
      updateUI();
      if (msg.bulkCount) {
        showToast(`Imported ${msg.bulkCount} tracks to Jam Queue!`);
      } else if (msg.addedItem) {
        showToast(`Added "${msg.addedItem.title}" to Jam Queue`);
      }
      return;
    }

    if (type === 'GUEST_CONTROL_UPDATED') {
      if (currentRoom) {
        currentRoom.allowGuestControl = msg.allowGuestControl;
      }
      showToast(msg.allowGuestControl ? 'Host allowed guest playback controls' : 'Host restricted playback controls to host only');
      updateUI();
      return;
    }

    if (type === 'LEFT_ROOM') {
      currentRoom = null;
      updateUI();
      showToast('You left the Jam room');
      return;
    }

    if (type === 'PERMISSION_DENIED') {
      showToast(msg.message || 'Permission denied: host only', true);
      return;
    }

    if (type === 'SERVER_ERROR') {
      showToast(msg.message || 'Server error', true);
      return;
    }
  }

  // 4. Listen to messages from page-bridge.js
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'YTM_JAM_PAGE') return;

    if (event.data.action === 'ON_TRACK_CHANGED') {
      const { videoId, title, artist, currentTime, duration, isPlaying } = event.data;
      if (!currentRoom) return;
      if (isSyncingFromRemote || isAdPlaying) return;

      const isHost = currentRoom.hostId === currentUserId;
      // Only the Host can broadcast track changes from passive player events!
      if (!isHost) return;
      if (currentRoom.currentState?.videoId === videoId) return;
      if (videoId === lastBroadcastedVideoId) return;

      const now = Date.now();
      if (now - lastTrackChangeSentAt < 4000) return;
      lastTrackChangeSentAt = now;

      lastBroadcastedVideoId = videoId;
      console.log(`[YTM-Jam Content] Host bridge reported new track: ${videoId}. Broadcasting...`);
      chrome.runtime.sendMessage({
        type: 'BG_SEND_SYNC',
        payload: {
          playbackAction: 'TRACK_CHANGE',
          videoId,
          title: title || 'Unknown Title',
          artist: artist || 'Unknown Artist',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          currentTime: currentTime || 0,
          duration: duration || 0
        }
      });
    }

    if (event.data.action === 'ON_PLAYER_STATE_CHANGE') {
      const { state, videoData, currentTime } = event.data;
      // State 0 = ENDED
      if (state === 0) {
        handleTrackEnded(videoData?.video_id || getCurrentVideoId());
      }
    }
  });

  function cleanRoomCode(input) {
    if (!input) return '';
    const str = input.trim();
    const match = str.match(/[?&]jam=([a-zA-Z0-9]+)/i);
    if (match) return match[1].toUpperCase();
    return str.replace(/^https?:\/\/[^\/]+\/?/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  // 5. Check URL for "?jam=ROOMCODE"
  function checkForUrlInvite() {
    const params = new URLSearchParams(window.location.search);
    const inviteRoom = params.get('jam');
    if (inviteRoom) {
      const cleanRoom = cleanRoomCode(inviteRoom);
      if (cleanRoom && (!currentRoom || currentRoom.roomId !== cleanRoom)) {
        console.log(`[YTM-Jam Content] Auto-joining room from URL: ${cleanRoom}`);
        const currentVid = getCurrentVideoId();
        const meta = getCurrentTrackMetadata();
        chrome.runtime.sendMessage({
          type: 'BG_JOIN_ROOM',
          roomId: cleanRoom,
          userName: currentUserName,
          currentTrack: currentVid ? { videoId: currentVid, ...meta } : null
        }, (res) => {
          if (res && res.success) {
            showToast(`Joined Jam Room: ${cleanRoom}!`);
          }
        });
      }
    }
  }

  // 6. Find & Monitor YouTube Music HTML5 Player
  function attachPlayerListeners() {
    videoElement = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!videoElement) {
      setTimeout(attachPlayerListeners, 800);
      return;
    }

    console.log('[YTM-Jam Content] Hooked into HTML5 video player element.');

    // If there is a pending playback state from room join, apply it now!
    if (pendingPlaybackState) {
      const stateToApply = pendingPlaybackState;
      pendingPlaybackState = null;
      applyPlaybackState(stateToApply, 'INITIAL_ATTACH');
    } else if (currentRoom && currentRoom.currentState && currentRoom.currentState.videoId) {
      applyPlaybackState(currentRoom.currentState, 'INITIAL_ATTACH');
    } else if (currentRoom && currentRoom.hostId === currentUserId && !currentRoom.currentState?.videoId) {
      // Host has song playing, seed room!
      const currentVid = getCurrentVideoId();
      if (currentVid) {
        const meta = getCurrentTrackMetadata();
        lastBroadcastedVideoId = currentVid;
        chrome.runtime.sendMessage({
          type: 'BG_SEND_SYNC',
          payload: {
            playbackAction: 'TRACK_CHANGE',
            videoId: currentVid,
            title: meta.title,
            artist: meta.artist,
            thumbnail: meta.thumbnail,
            currentTime: videoElement.currentTime || 0,
            duration: videoElement.duration || 0
          }
        });
      }
    }

    videoElement.addEventListener('play', () => onLocalPlaybackChange('PLAY'));
    videoElement.addEventListener('pause', () => onLocalPlaybackChange('PAUSE'));
    videoElement.addEventListener('seeked', () => onLocalPlaybackChange('SEEK'));
    videoElement.addEventListener('canplay', () => {
      if (currentRoom && currentRoom.currentState && currentRoom.currentState.videoId === getCurrentVideoId()) {
        const targetTime = getEstimatedRoomTime(currentRoom.currentState);
        if (targetTime > 0.5 && Math.abs(videoElement.currentTime - targetTime) > 0.5) {
          console.log(`[YTM-Jam Content] canplay event: snapping directly to same line: ${targetTime.toFixed(1)}s`);
          videoElement.currentTime = targetTime;
          sendToBridge({ action: 'CMD_SEEK', time: targetTime });
        }
        if (currentRoom.currentState.isPlaying && videoElement.paused) {
          videoElement.play().catch(showAutoplaySyncPrompt);
        }
      }
    });
    videoElement.addEventListener('ended', () => {
      handleTrackEnded(getCurrentVideoId());
    });
    videoElement.addEventListener('timeupdate', () => {
      if (videoElement.duration > 0 && videoElement.currentTime >= videoElement.duration - 0.5) {
        handleTrackEnded(getCurrentVideoId());
      }
    });

    // Ad detection observer
    monitorAds();
  }

  // Ad Detection Guard
  function monitorAds() {
    const moviePlayer = document.getElementById('movie_player');
    if (!moviePlayer) {
      setTimeout(monitorAds, 1500);
      return;
    }

    const checkAd = () => {
      const hasAd = moviePlayer.classList.contains('ad-showing') ||
                    document.querySelector('.video-ads:not(:empty)') !== null ||
                    document.querySelector('.ytp-ad-player-overlay') !== null;

      if (hasAd && !isAdPlaying) {
        isAdPlaying = true;
        console.log('[YTM-Jam Content] Ad detected. Pausing outgoing sync broadcasts.');
      } else if (!hasAd && isAdPlaying) {
        isAdPlaying = false;
        console.log('[YTM-Jam Content] Ad ended. Re-syncing with room...');
        // Request fresh sync to catch up to live room position
        chrome.runtime.sendMessage({ type: 'BG_REQUEST_SYNC' });
      }
    };

    const observer = new MutationObserver(checkAd);
    observer.observe(moviePlayer, { attributes: true, attributeFilter: ['class'] });
    setInterval(checkAd, 1500);
  }

  // 7. Track Ended Handling (Auto-Advance Queue)
  function handleTrackEnded(videoId) {
    if (!currentRoom) return;
    if (isSyncingFromRemote || isAdPlaying) return;

    // Only the Host advances the room queue when a track ends!
    const isHost = currentRoom.hostId === currentUserId;
    if (!isHost) {
      return;
    }

    const now = Date.now();
    if (now - lastTrackEndedSentAt < 3000) return;
    lastTrackEndedSentAt = now;

    console.log('[YTM-Jam Content] Track ended on Host. Notifying room to advance queue...');
    chrome.runtime.sendMessage({
      type: 'BG_TRACK_ENDED',
      videoId: videoId || getCurrentVideoId()
    });
  }

  // 8. Handle Local User Playback Changes (PLAY, PAUSE, SEEK)
  function onLocalPlaybackChange(action) {
    if (!currentRoom) return;
    if (isSyncingFromRemote) return;
    if (isAdPlaying) return;

    const now = Date.now();
    const isHost = currentRoom.hostId === currentUserId;

    // Suppress internal browser seeking/buffering pause events
    if (videoElement && videoElement.seeking) {
      return;
    }
    if (now < ignoreLocalSeeksUntil) {
      return;
    }

    // PLAY, PAUSE, and SEEK must be directly initiated by the user (clicks on controls or keypress)
    // Passive HTML5 media buffering / pause events must NEVER be broadcast to the room!
    if (!userInitiatedControlAction) {
      return;
    }
    userInitiatedControlAction = false;

    // Check Host Controls permission
    if (!currentRoom.allowGuestControl && !isHost) {
      // Revert local action
      showToast('Host has restricted playback control to host only.', true);
      chrome.runtime.sendMessage({ type: 'BG_REQUEST_SYNC' });
      return;
    }

    // Suppress fake/buffering seeks that happen right after track change or remote seek
    if (action === 'SEEK') {
      if (videoElement && videoElement.currentTime < 1.0) {
        return;
      }
      if (now - lastLocalSeekSentAt < 1500) return;
      lastLocalSeekSentAt = now;
    }

    const currentVid = getCurrentVideoId();
    const meta = getCurrentTrackMetadata();

    let playbackAction = action;
    if (currentVid && currentVid !== lastBroadcastedVideoId) {
      if (isHost && currentVid !== currentRoom.currentState?.videoId) {
        playbackAction = 'TRACK_CHANGE';
        lastBroadcastedVideoId = currentVid;
      } else {
        playbackAction = action;
      }
    }

    chrome.runtime.sendMessage({
      type: 'BG_SEND_SYNC',
      payload: {
        playbackAction,
        videoId: currentVid,
        currentTime: videoElement ? videoElement.currentTime : 0,
        duration: videoElement ? videoElement.duration : 0,
        title: meta.title,
        artist: meta.artist,
        thumbnail: meta.thumbnail
      }
    });
  }

  /**
   * Switch the YouTube Music player to a new track without full page reload
   * 1. If tab is on non-watch page (Home/Library), direct navigate immediately
   * 2. Try clicking matching item in DOM (instant zero-reload SPA switch)
   * 3. Tell page-bridge to load video via #movie_player, Polymer, and update player bar UI
   * 4. Fallback: if after 900ms video hasn't switched, direct navigate to watch URL
   */
  function switchTrack(videoId, startTime = 0, autoplay = true, title = '', artist = '', thumbnail = '') {
    if (!videoId) return;
    console.log(`[YTM-Jam Content] Switching player to track: ${videoId} ("${title || ''} - ${artist || ''}") (start: ${startTime}s)`);

    isSyncingFromRemote = true;
    ignoreLocalSeeksUntil = Date.now() + 6000;
    lastBroadcastedVideoId = videoId;

    // If tab is NOT on /watch page (e.g. Home, Explore, Library), direct navigation is required!
    if (!window.location.pathname.startsWith('/watch')) {
      console.log('[YTM-Jam Content] Not on /watch page. Direct navigating to track watch URL...');
      const targetUrl = `https://music.youtube.com/watch?v=${videoId}${startTime > 1.5 ? '&t=' + Math.floor(startTime) : ''}`;
      window.location.href = targetUrl;
      return;
    }

    // Strategy 1: Check if song exists in DOM (Up Next list, playlist, or page)
    const matchingEl = document.querySelector(
      `ytmusic-player-queue-item[data-ytm-video-id="${videoId}"], ` +
      `[data-ytm-video-id="${videoId}"], ` +
      `a[href*="watch?v=${videoId}"], ` +
      `img[src*="${videoId}"]`
    );

    if (matchingEl) {
      const row = matchingEl.closest('ytmusic-player-queue-item, ytmusic-responsive-list-item-renderer') || matchingEl;
      console.log(`[YTM-Jam Content] Found track ${videoId} in DOM. Triggering native click...`);
      const playBtn = row.querySelector('ytmusic-play-button-renderer') || row;
      playBtn.click();

      if (startTime > 1.5) {
        setTimeout(() => {
          sendToBridge({ action: 'CMD_SEEK', time: startTime });
        }, 600);
      }

      setTimeout(() => { isSyncingFromRemote = false; }, 3500);
      return;
    }

    // Strategy 2: Tell page-bridge to load video via #movie_player & Polymer and update player bar UI
    sendToBridge({
      action: 'CMD_LOAD_VIDEO',
      videoId,
      startTime: startTime || 0,
      autoplay: autoplay !== false,
      title: title || '',
      artist: artist || '',
      thumbnail: thumbnail || ''
    });

    // Verification Fallback: If after 900ms the video hasn't switched, direct navigate
    setTimeout(() => {
      const activeVid = getCurrentVideoId();
      if (activeVid !== videoId) {
        console.log(`[YTM-Jam Content] SPA track switch unverified (Current: ${activeVid}, Target: ${videoId}). Falling back to watch URL navigation...`);
        const targetUrl = `https://music.youtube.com/watch?v=${videoId}${startTime > 1.5 ? '&t=' + Math.floor(startTime) : ''}`;
        window.location.href = targetUrl;
      } else {
        isSyncingFromRemote = false;
      }
    }, 900);
  }

  // 9. Apply Remote State from Room (Drift compensation, SPA navigation)
  function applyPlaybackState(state, actionType) {
    if (!state) return;

    const currentVid = getCurrentVideoId();

    // A. Track Switch (SPA Navigation or direct fallback)
    if (state.videoId && state.videoId !== currentVid) {
      console.log(`[YTM-Jam Content] Remote track change to: ${state.videoId} (Current: ${currentVid})`);
      const targetStartTime = getEstimatedRoomTime(state);
      switchTrack(state.videoId, targetStartTime, state.isPlaying, state.title, state.artist, state.thumbnail);
      return;
    }

    if (!videoElement) {
      pendingPlaybackState = state;
      return;
    }

    // If an ad is currently playing on this tab, don't interrupt the ad
    if (isAdPlaying) {
      console.log('[YTM-Jam Content] Ad is currently active. Queueing sync update until ad ends.');
      pendingPlaybackState = state;
      return;
    }

    isSyncingFromRemote = true;

    // B. Drift Compensation: Check against live estimated room time!
    const targetTime = getEstimatedRoomTime(state);
    if (typeof targetTime === 'number') {
      const now = Date.now();
      const drift = Math.abs(videoElement.currentTime - targetTime);
      const isInitialSync = ['INITIAL_ATTACH', 'INIT', 'TRACK_CHANGE', 'SEEK'].includes(actionType);

      if (isInitialSync) {
        if (targetTime > 0.5 && Math.abs(videoElement.currentTime - targetTime) > 0.5) {
          console.log(`[YTM-Jam Content] Initial sync: snapping directly to same line: ${targetTime.toFixed(1)}s`);
          videoElement.currentTime = targetTime;
          sendToBridge({ action: 'CMD_SEEK', time: targetTime });
          lastDriftCorrectionAt = now;
          ignoreLocalSeeksUntil = now + 1500;
        }
      } else if (drift > 1.2 && now - lastDriftCorrectionAt > 2500 && now > ignoreLocalSeeksUntil) {
        lastDriftCorrectionAt = now;
        ignoreLocalSeeksUntil = now + 2000;
        console.log(`[YTM-Jam Content] Synchronizing lines (drift ${drift.toFixed(2)}s). Snapping to: ${targetTime.toFixed(1)}s`);
        videoElement.currentTime = targetTime;
        sendToBridge({ action: 'CMD_SEEK', time: targetTime });
      }
    }

    // C. Play / Pause Synchronization
    if (state.isPlaying && videoElement.paused) {
      videoElement.play().catch((err) => {
        console.warn('[YTM-Jam Content] Autoplay blocked:', err);
        showAutoplaySyncPrompt();
      });
      sendToBridge({ action: 'CMD_PLAY' });
    } else if (!state.isPlaying && !videoElement.paused) {
      videoElement.pause();
      sendToBridge({ action: 'CMD_PAUSE' });
    }

    setTimeout(() => {
      isSyncingFromRemote = false;
    }, 1200);
  }

  // 10. Extract Currently Playing Video ID and Metadata
  function getCurrentVideoId() {
    // 1. Dataset stamped by page-bridge.js (most accurate & synchronous!)
    const bridgeVid = document.documentElement.dataset.ytmCurrentVideoId;
    if (bridgeVid && /^[a-zA-Z0-9_-]{11}$/.test(bridgeVid)) {
      return bridgeVid;
    }

    // 2. URL search params
    const params = new URLSearchParams(window.location.search);
    const vParam = params.get('v');
    if (vParam) return vParam;

    // 3. Player bar watch link
    const titleLink = document.querySelector('ytmusic-player-bar .title a, ytmusic-player-bar a.yt-simple-endpoint[href*="watch?v="]');
    if (titleLink && titleLink.href) {
      const match = titleLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match) return match[1];
    }

    // 4. Player bar thumbnail image
    const thumbImg = document.querySelector('ytmusic-player-bar img.image, ytmusic-player-bar .thumbnail img');
    if (thumbImg && thumbImg.src) {
      const match = thumbImg.src.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
      if (match) return match[1];
    }

    return null;
  }

  function getCurrentTrackMetadata() {
    const titleEl = document.querySelector('ytmusic-player-bar .title');
    const artistEl = document.querySelector('ytmusic-player-bar .byline');
    const thumbEl = document.querySelector('ytmusic-player-bar img.image, ytmusic-player-bar .thumbnail img');

    const bridgeTitle = document.documentElement.dataset.ytmTitle;
    const bridgeArtist = document.documentElement.dataset.ytmArtist;
    const vid = getCurrentVideoId();

    let title = (titleEl && titleEl.textContent.trim()) || bridgeTitle || '';
    let artist = (artistEl && artistEl.textContent.trim()) || bridgeArtist || '';

    // Check Jam Queue fallback if DOM title is missing or generic
    if ((!title || title === 'Unknown Title') && vid && currentRoom?.queue) {
      const qItem = currentRoom.queue.find(q => q.videoId === vid);
      if (qItem) {
        title = qItem.title;
        artist = qItem.artist;
      }
    }

    // Check current room state fallback
    if ((!title || title === 'Unknown Title') && currentRoom?.currentState?.videoId === vid) {
      if (currentRoom.currentState.title && currentRoom.currentState.title !== 'Unknown Title') {
        title = currentRoom.currentState.title;
        artist = currentRoom.currentState.artist;
      }
    }

    return {
      title: title || 'Unknown Title',
      artist: artist || 'Unknown Artist',
      thumbnail: (thumbEl && thumbEl.src) || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : (currentRoom?.currentState?.thumbnail || ''))
    };
  }

  // 11. Scrape Track Info from a Song Row (Queue Item or Responsive List Item)
  function extractTrackDataFromRow(rowEl) {
    if (!rowEl) return null;

    // A. Extract Title
    let title = rowEl.getAttribute('data-ytm-title') || '';
    if (!title || title === 'Unknown Title') {
      const titleSelectors = [
        '.song-title',
        'yt-formatted-string.song-title',
        '.title',
        'yt-formatted-string.title',
        '.song-info .title',
        'ytmusic-responsive-list-item-flex-column-renderer:first-child yt-formatted-string',
        'a[href*="watch?v="]'
      ];
      for (const sel of titleSelectors) {
        const el = rowEl.querySelector(sel);
        if (el && el.textContent.trim()) {
          title = el.textContent.trim();
          break;
        }
      }
    }

    // B. Extract Artist
    let artist = rowEl.getAttribute('data-ytm-artist') || '';
    if (!artist || artist === 'Unknown Artist') {
      const artistSelectors = [
        '.byline',
        'yt-formatted-string.byline',
        '.song-info .byline',
        'ytmusic-responsive-list-item-flex-column-renderer:nth-child(2) yt-formatted-string',
        '.author',
        '.artist-name'
      ];
      for (const sel of artistSelectors) {
        const el = rowEl.querySelector(sel);
        if (el && el.textContent.trim()) {
          artist = el.textContent.trim().split('•')[0].trim();
          break;
        }
      }
    }

    // Fallback: Parse innerText lines for Title and Artist
    if (!title || title === 'Unknown Title' || !artist || artist === 'Unknown Artist') {
      if (rowEl.innerText) {
        const lines = rowEl.innerText.split('\n')
          .map(s => s.trim())
          .filter(s => s && !s.includes('Jam') && !s.includes('LIVE') && !/^\d+:\d+$/.test(s) && s.length < 100);
        if (lines.length >= 1 && (!title || title === 'Unknown Title')) {
          title = lines[0];
        }
        if (lines.length >= 2 && (!artist || artist === 'Unknown Artist')) {
          artist = lines[1].split('•')[0].trim();
        }
      }
    }

    if (!title) title = 'Unknown Title';
    if (!artist) artist = 'Unknown Artist';

    // C. Extract Thumbnail
    let thumbnail = rowEl.getAttribute('data-ytm-thumbnail') || '';
    if (!thumbnail) {
      const img = rowEl.querySelector('img');
      if (img && img.src && !img.src.startsWith('data:')) {
        thumbnail = img.src;
      }
    }

    // D. Extract Video ID (from stamped attribute, links, img, play button, regex)
    let videoId = rowEl.getAttribute('data-ytm-video-id');

    // Check watch link
    if (!videoId) {
      const link = rowEl.querySelector('a[href*="watch?v="]');
      if (link && link.href) {
        const match = link.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (match) videoId = match[1];
      }
    }

    // Check thumbnail img src (including WebP: /vi_webp/)
    if (!videoId) {
      const img = rowEl.querySelector('img[src*="/vi"]');
      if (img && img.src) {
        const match = img.src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})[\/?]/);
        if (match) videoId = match[1];
      }
    }

    // Check play button
    if (!videoId) {
      const playBtn = rowEl.querySelector('ytmusic-play-button-renderer');
      if (playBtn && playBtn.getAttribute('data-video-id')) {
        videoId = playBtn.getAttribute('data-video-id');
      }
    }

    // Check regex on row outerHTML
    if (!videoId && rowEl.outerHTML) {
      const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})[\/?]/,
        /video-id=["']([a-zA-Z0-9_-]{11})["']/i,
        /data-video-id=["']([a-zA-Z0-9_-]{11})["']/i,
        /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
        /videoId%22%3A%22([a-zA-Z0-9_-]{11})%22/
      ];
      for (const p of patterns) {
        const m = rowEl.outerHTML.match(p);
        if (m && m[1]) {
          videoId = m[1];
          break;
        }
      }
    }

    if (videoId) {
      rowEl.setAttribute('data-ytm-video-id', videoId);
      if (title && title !== 'Unknown Title') rowEl.setAttribute('data-ytm-title', title);
      if (artist && artist !== 'Unknown Artist') rowEl.setAttribute('data-ytm-artist', artist);
      if (!thumbnail) thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      rowEl.setAttribute('data-ytm-thumbnail', thumbnail);
    }

    return { videoId: videoId || null, title, artist, thumbnail };
  }

  // Cache resolved track search queries so duplicate clicks or imports resolve in 0ms
  const trackSearchCache = new Map();

  /**
   * Asynchronously resolve track data with multi-layer fallback:
   * 1. Element DOM & outerHTML
   * 2. MAIN world page-bridge
   * 3. In-memory Search Cache
   * 4. Real-time YouTube search by Title + Artist (10s timeout)
   */
  async function resolveTrackData(rowEl) {
    let data = extractTrackDataFromRow(rowEl);
    if (data && data.videoId) return data;

    // Layer 2: Query page-bridge.js on demand
    const rowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    rowEl.setAttribute('data-jam-row-id', rowId);

    const bridgeData = await new Promise((resolve) => {
      const reqId = 'req_' + Math.random().toString(36).substring(2, 9);
      const listener = (event) => {
        if (!event.data || event.data.source !== 'YTM_JAM_PAGE' || event.data.action !== 'RESP_ROW_DATA') return;
        if (event.data.requestId === reqId) {
          window.removeEventListener('message', listener);
          resolve(event.data.data);
        }
      };
      window.addEventListener('message', listener);
      sendToBridge({ action: 'CMD_EXTRACT_ROW_DATA', rowId, requestId: reqId });
      setTimeout(() => {
        window.removeEventListener('message', listener);
        resolve(null);
      }, 800);
    });

    if (bridgeData && bridgeData.videoId) {
      rowEl.setAttribute('data-ytm-video-id', bridgeData.videoId);
      return bridgeData;
    }

    // Layer 3: YouTube Search Fallback by Song Title + Artist
    const title = (data && data.title && data.title !== 'Unknown Title') ? data.title : (bridgeData?.title || '');
    const artist = (data && data.artist && data.artist !== 'Unknown Artist') ? data.artist : (bridgeData?.artist || '');

    if (title && title !== 'Unknown Title') {
      const cacheKey = (title + ' ' + (artist || '')).trim().toLowerCase();
      if (trackSearchCache.has(cacheKey)) {
        const cachedId = trackSearchCache.get(cacheKey);
        if (cachedId) {
          rowEl.setAttribute('data-ytm-video-id', cachedId);
          rowEl.setAttribute('data-ytm-title', title);
          if (artist) rowEl.setAttribute('data-ytm-artist', artist);
          return {
            videoId: cachedId,
            title,
            artist,
            thumbnail: data?.thumbnail || `https://i.ytimg.com/vi/${cachedId}/hqdefault.jpg`
          };
        }
      }

      console.log(`[YTM-Jam Content] Using YouTube search fallback for: "${title} - ${artist}"`);
      const searchRes = await new Promise((resolve) => {
        let done = false;
        chrome.runtime.sendMessage({
          type: 'BG_SEARCH_TRACK',
          title,
          artist
        }, (res) => {
          if (!done) {
            done = true;
            resolve(res);
          }
        });
        setTimeout(() => {
          if (!done) {
            done = true;
            resolve(null);
          }
        }, 10000);
      });

      if (searchRes && searchRes.videoId) {
        trackSearchCache.set(cacheKey, searchRes.videoId);
        rowEl.setAttribute('data-ytm-video-id', searchRes.videoId);
        rowEl.setAttribute('data-ytm-title', title);
        if (artist) rowEl.setAttribute('data-ytm-artist', artist);
        return {
          videoId: searchRes.videoId,
          title,
          artist,
          thumbnail: data?.thumbnail || `https://i.ytimg.com/vi/${searchRes.videoId}/hqdefault.jpg`
        };
      }
    }

    return data;
  }

  // 12. UI: In-Page Jam Drawer Injection & DOM Construction
  function ensureDrawerInDOM() {
    if (document.getElementById('ytm-jam-drawer')) return;

    const drawer = document.createElement('div');
    drawer.id = 'ytm-jam-drawer';
    drawer.innerHTML = `
      <div class="ytm-jam-header">
        <div class="ytm-jam-header-title">
          <span>🎧 YouTube Music Jam</span>
          <span class="jam-badge">LIVE</span>
        </div>
        <button class="ytm-jam-close-btn" id="ytm-jam-close-btn" title="Close Drawer">✕</button>
      </div>
      <div class="ytm-jam-body" id="ytm-jam-drawer-content">
        <!-- Rendered dynamically -->
      </div>
    `;

    document.body.appendChild(drawer);

    document.getElementById('ytm-jam-close-btn').addEventListener('click', () => {
      toggleDrawer(false);
    });
  }

  function toggleDrawer(forceState) {
    ensureDrawerInDOM();
    const drawer = document.getElementById('ytm-jam-drawer');
    const barBtn = document.getElementById('ytm-jam-bar-btn');

    isDrawerOpen = typeof forceState === 'boolean' ? forceState : !isDrawerOpen;

    if (isDrawerOpen) {
      drawer.classList.add('open');
      if (barBtn) barBtn.classList.add('active');
      renderDrawerContent();
    } else {
      drawer.classList.remove('open');
      if (barBtn && !currentRoom) barBtn.classList.remove('active');
    }
  }

  // 13. UI: Inject "🎧 Jam" Button into YouTube Music Player Bar
  function injectPlayerBarButton() {
    if (document.getElementById('ytm-jam-bar-btn')) return;

    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons') ||
                          document.querySelector('ytmusic-player-bar #right-controls');
    if (!rightControls) return;

    const btn = document.createElement('button');
    btn.id = 'ytm-jam-bar-btn';
    btn.title = 'Open YouTube Music Jam';
    btn.innerHTML = `
      <span class="jam-status-dot"></span>
      <span>🎧 Jam</span>
    `;

    btn.addEventListener('click', () => toggleDrawer());
    rightControls.prepend(btn);
  }

  // 14. UI: Render In-Page Drawer Content
  function renderDrawerContent() {
    const container = document.getElementById('ytm-jam-drawer-content');
    if (!container) return;

    // View A: NOT IN ROOM
    if (!currentRoom) {
      if (document.getElementById('ytm-jam-join-input')) {
        return; // Already showing NOT IN ROOM form, keep user's typed text!
      }

      container.innerHTML = `
        <div class="ytm-jam-card">
          <div class="ytm-jam-card-title">Profile</div>
          <div class="ytm-jam-input-group">
            <input type="text" id="ytm-jam-name-input" class="ytm-jam-input" placeholder="Your Display Name" value="${escapeHtml(currentUserName)}" />
          </div>
        </div>

        <div class="ytm-jam-card">
          <div class="ytm-jam-card-title">Start a Jam Session</div>
          <p style="font-size:12px; color:#a1a1aa; margin:0 0 10px 0;">Listen together in real time. Share the room code with friends.</p>
          <button id="ytm-jam-create-btn" class="ytm-jam-btn-primary">
            <span>✨ Create New Jam Room</span>
          </button>
        </div>

        <div class="ytm-jam-divider"><span>OR</span></div>

        <div class="ytm-jam-card">
          <div class="ytm-jam-card-title">Join a Jam</div>
          <div class="ytm-jam-input-group">
            <input type="text" id="ytm-jam-join-input" class="ytm-jam-input" placeholder="Enter 6-char Room Code (e.g. JAM123)" />
            <button id="ytm-jam-join-btn" class="ytm-jam-btn-secondary">
              <span>🚀 Join Room</span>
            </button>
          </div>
        </div>
      `;

      // Event listeners for Not In Room
      const nameInput = document.getElementById('ytm-jam-name-input');
      if (nameInput) {
        nameInput.addEventListener('input', () => {
          currentUserName = nameInput.value.trim() || 'Aman';
          chrome.storage.local.set({ userName: currentUserName });
        });
      }

      const joinInput = document.getElementById('ytm-jam-join-input');
      if (joinInput) {
        joinInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const joinBtn = document.getElementById('ytm-jam-join-btn');
            if (joinBtn) joinBtn.click();
          }
        });
      }

      document.getElementById('ytm-jam-create-btn').addEventListener('click', () => {
        const name = nameInput ? nameInput.value.trim() : (currentUserName || 'Host');
        currentUserName = name;
        const code = generateRoomCode();
        joinRoom(code, name);
      });

      document.getElementById('ytm-jam-join-btn').addEventListener('click', () => {
        const name = nameInput.value.trim() || 'Guest';
        currentUserName = name;
        const code = document.getElementById('ytm-jam-join-input').value.trim().toUpperCase();
        if (code) joinRoom(code, name);
      });

      return;
    }

    // View B: IN ROOM
    const isHost = currentRoom.hostId === currentUserId;
    const participants = currentRoom.participants || [];
    const queue = currentRoom.queue || [];
    const currentState = currentRoom.currentState || {};

    let participantsHtml = participants.map(p => {
      const isSelf = p.userId === currentUserId;
      const initial = (p.userName || 'P')[0].toUpperCase();
      return `
        <div class="ytm-jam-participant-item">
          <div class="ytm-jam-avatar">${escapeHtml(initial)}</div>
          <span class="ytm-jam-participant-name">${escapeHtml(p.userName)}</span>
          ${p.isHost ? '<span class="ytm-jam-badge-host">👑 Host</span>' : ''}
          ${isSelf ? '<span class="ytm-jam-badge-you">You</span>' : ''}
        </div>
      `;
    }).join('');

    let queueHtml = '';
    if (queue.length === 0) {
      queueHtml = `
        <div class="ytm-jam-queue-empty">
          Shared queue is empty.<br/>Use <strong>+ Jam</strong> buttons on songs or import your Up Next list below!
        </div>
      `;
    } else {
      queueHtml = queue.map((item, idx) => `
        <div class="ytm-jam-queue-item" data-id="${item.id}" data-index="${idx}">
          <img class="ytm-jam-queue-thumb" src="${item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/default.jpg'}" />
          <div class="ytm-jam-queue-info">
            <div class="ytm-jam-queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="ytm-jam-queue-artist">${escapeHtml(item.artist)}</div>
            <div class="ytm-jam-queue-added-by">Added by ${escapeHtml(item.addedBy)}</div>
          </div>
          <div class="ytm-jam-queue-actions">
            <button class="ytm-jam-icon-btn play-btn" data-action="play" data-id="${item.id}" title="Play Now">▶</button>
            ${idx > 0 ? `<button class="ytm-jam-icon-btn" data-action="up" data-index="${idx}" title="Move Up">▲</button>` : ''}
            ${idx < queue.length - 1 ? `<button class="ytm-jam-icon-btn" data-action="down" data-index="${idx}" title="Move Down">▼</button>` : ''}
            <button class="ytm-jam-icon-btn remove-btn" data-action="remove" data-id="${item.id}" title="Remove">✕</button>
          </div>
        </div>
      `).join('');
    }

    container.innerHTML = `
      <!-- Room Info & Invite Card -->
      <div class="ytm-jam-card">
        <div class="ytm-jam-card-title">
          <span>Room Code</span>
          <span style="color:#22c55e;">● Connected</span>
        </div>
        <div class="ytm-jam-room-info">
          <span class="ytm-jam-room-code-badge">${escapeHtml(currentRoom.roomId)}</span>
          <button class="ytm-jam-copy-btn" id="ytm-jam-copy-link-btn">
            <span>📋 Copy Invite Link</span>
          </button>
        </div>

        <!-- Host Controls Toggle -->
        ${isHost ? `
          <div class="ytm-jam-toggle-row">
            <span>Allow guests to control playback</span>
            <label class="ytm-jam-switch">
              <input type="checkbox" id="ytm-jam-guest-control-toggle" ${currentRoom.allowGuestControl ? 'checked' : ''}>
              <span class="ytm-jam-slider"></span>
            </label>
          </div>
        ` : `
          <div class="ytm-jam-toggle-row" style="color:#71717a;">
            <span>Playback controls:</span>
            <span>${currentRoom.allowGuestControl ? '🔓 Everyone' : '🔒 Host Only'}</span>
          </div>
        `}
      </div>

      <!-- Now Playing Card -->
      <div class="ytm-jam-card">
        <div class="ytm-jam-card-title">Now Playing in Jam</div>
        <div class="ytm-jam-now-playing">
          <img class="ytm-jam-now-playing-art" src="${currentState.thumbnail || 'https://i.ytimg.com/vi/' + (currentState.videoId || 'default') + '/hqdefault.jpg'}" />
          <div class="ytm-jam-now-playing-meta">
            <div class="ytm-jam-now-playing-title">${escapeHtml(currentState.title || 'No track playing')}</div>
            <div class="ytm-jam-now-playing-artist">${escapeHtml(currentState.artist || 'Add a song to start')}</div>
          </div>
        </div>
      </div>

      <!-- Participants -->
      <div class="ytm-jam-card">
        <div class="ytm-jam-card-title">
          <span>Participants</span>
          <span>${participants.length}</span>
        </div>
        <div class="ytm-jam-participants-list">
          ${participantsHtml}
        </div>
      </div>

      <!-- Shared Jam Queue -->
      <div class="ytm-jam-card">
        <div class="ytm-jam-queue-header">
          <div class="ytm-jam-card-title" style="margin-bottom:0;">
            <span>Shared Queue (${queue.length})</span>
          </div>
          <button class="ytm-jam-import-btn" id="ytm-jam-import-up-next-btn">
            <span>📥 Clone Up Next</span>
          </button>
        </div>
        <div class="ytm-jam-queue-list">
          ${queueHtml}
        </div>
      </div>

      <!-- Leave Room Button -->
      <button class="ytm-jam-btn-leave" id="ytm-jam-leave-btn">Leave Jam Room</button>
    `;

    // Bind In-Room Listeners
    document.getElementById('ytm-jam-copy-link-btn').addEventListener('click', (e) => {
      const inviteUrl = `https://music.youtube.com/?jam=${currentRoom.roomId}`;
      navigator.clipboard.writeText(inviteUrl).then(() => {
        const btn = document.getElementById('ytm-jam-copy-link-btn');
        btn.classList.add('copied');
        btn.innerHTML = '<span>✓ Copied Link!</span>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<span>📋 Copy Invite Link</span>';
        }, 2000);
      });
    });

    if (isHost) {
      const toggle = document.getElementById('ytm-jam-guest-control-toggle');
      if (toggle) {
        toggle.addEventListener('change', () => {
          chrome.runtime.sendMessage({
            type: 'BG_TOGGLE_GUEST_CONTROL',
            allowGuestControl: toggle.checked
          });
        });
      }
    }

    document.getElementById('ytm-jam-import-up-next-btn').addEventListener('click', () => {
      cloneUpNextToJam();
    });

    document.getElementById('ytm-jam-leave-btn').addEventListener('click', () => {
      leaveRoom();
    });

    // Queue Item Action Listeners
    container.querySelectorAll('.ytm-jam-queue-item button').forEach(button => {
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
        } else if (action === 'down' && index < queue.length - 1) {
          chrome.runtime.sendMessage({ type: 'BG_REORDER_QUEUE', fromIndex: index, toIndex: index + 1 });
        }
      });
    });
  }

  // 14b. In-Page YouTube Music Native "Up Next" Jam Queue Injection
  function injectInPageJamQueue(forceRender = false) {
    const queueTarget = document.querySelector('ytmusic-player-queue #contents') ||
                        document.querySelector('ytmusic-player-queue #items') ||
                        document.querySelector('ytmusic-player-queue') ||
                        document.querySelector('#player-queue');
    if (!queueTarget) return;

    let panel = document.getElementById('ytm-jam-inpage-queue');
    let isNew = false;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ytm-jam-inpage-queue';
      if (queueTarget.firstChild) {
        queueTarget.insertBefore(panel, queueTarget.firstChild);
      } else {
        queueTarget.appendChild(panel);
      }
      isNew = true;
    }

    if (isNew || forceRender) {
      renderInPageJamQueue(panel);
    }
  }

  function renderInPageJamQueue(panel) {
    if (!panel) return;

    if (!currentRoom) {
      panel.innerHTML = `
        <div class="ytm-jam-inpage-header">
          <div class="ytm-jam-inpage-header-left">
            <span class="ytm-jam-inpage-title">🎧 YouTube Music Jam</span>
          </div>
          <button class="ytm-jam-inpage-btn" id="ytm-jam-inpage-open-drawer">✨ Open Jam</button>
        </div>
        <div class="ytm-jam-inpage-subtitle">
          Start or join a Jam session to share a synchronized live queue with friends!
        </div>
      `;
      const openBtn = panel.querySelector('#ytm-jam-inpage-open-drawer');
      if (openBtn) {
        openBtn.addEventListener('click', () => toggleDrawer(true));
      }
      return;
    }

    const queue = currentRoom.queue || [];
    const currentState = currentRoom.currentState || {};

    // Now Playing banner at top of in-page queue
    const nowPlayingHtml = currentState.videoId ? `
      <div class="ytm-jam-inpage-now-playing" style="display:flex; align-items:center; gap:10px; padding:8px 10px; margin-bottom:8px; background:rgba(255,0,51,0.08); border:1px solid rgba(255,0,51,0.25); border-radius:8px;">
        <img src="${currentState.thumbnail || 'https://i.ytimg.com/vi/' + currentState.videoId + '/hqdefault.jpg'}" style="width:38px; height:38px; border-radius:4px; object-fit:cover;" />
        <div style="flex:1; overflow:hidden;">
          <div style="font-size:10px; font-weight:700; color:#ff0033; letter-spacing:0.5px; margin-bottom:2px;">▶ NOW PLAYING IN JAM</div>
          <div style="font-size:12px; font-weight:600; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(currentState.title || 'Unknown Title')}</div>
          <div style="font-size:11px; color:#a1a1aa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(currentState.artist || 'Unknown Artist')}</div>
        </div>
      </div>
    ` : '';

    let itemsHtml = '';
    if (queue.length === 0) {
      itemsHtml = `
        <div class="ytm-jam-inpage-empty">
          Shared Jam Queue is empty.<br/>
          Click <strong>+ Jam</strong> on any track, or import your Up Next list below!
        </div>
      `;
    } else {
      itemsHtml = queue.map((item, idx) => `
        <div class="ytm-jam-inpage-row" data-id="${item.id}" data-index="${idx}">
          <span style="font-size:11px; font-weight:700; color:#71717a; min-width:18px;">#${idx + 1}</span>
          <img class="ytm-jam-inpage-thumb" src="${item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/default.jpg'}" />
          <div class="ytm-jam-inpage-meta">
            <div class="ytm-jam-inpage-track-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="ytm-jam-inpage-track-artist">${escapeHtml(item.artist)} • Added by ${escapeHtml(item.addedBy)}</div>
          </div>
          <div class="ytm-jam-inpage-actions">
            <button class="ytm-jam-inpage-action-btn play" data-action="play" data-id="${item.id}" title="Play Now for Everyone">▶</button>
            ${idx > 0 ? `<button class="ytm-jam-inpage-action-btn" data-action="up" data-index="${idx}" title="Move Up">▲</button>` : ''}
            ${idx < queue.length - 1 ? `<button class="ytm-jam-inpage-action-btn" data-action="down" data-index="${idx}" title="Move Down">▼</button>` : ''}
            <button class="ytm-jam-inpage-action-btn remove" data-action="remove" data-id="${item.id}" title="Remove from Jam">✕</button>
          </div>
        </div>
      `).join('');
    }

    panel.innerHTML = `
      <div class="ytm-jam-inpage-header">
        <div class="ytm-jam-inpage-header-left">
          <span class="ytm-jam-inpage-title">🎧 Jam Shared Queue</span>
          <span class="ytm-jam-inpage-badge">${escapeHtml(currentRoom.roomId)}</span>
          <span class="ytm-jam-inpage-count">${queue.length} track${queue.length === 1 ? '' : 's'}</span>
        </div>
        <div class="ytm-jam-inpage-header-right" style="display:flex; gap:6px;">
          <button class="ytm-jam-inpage-btn" id="ytm-jam-inpage-add-current-btn" title="Add Currently Playing Song to Jam Queue">➕ Add Playing</button>
          <button class="ytm-jam-inpage-btn" id="ytm-jam-inpage-import-btn" title="Import YouTube Music Up Next into Jam">📥 Clone Up Next</button>
          <button class="ytm-jam-inpage-btn" id="ytm-jam-inpage-drawer-btn" title="Open Jam Side Drawer">Sidebar ➔</button>
        </div>
      </div>
      ${nowPlayingHtml}
      <div class="ytm-jam-inpage-items">
        ${itemsHtml}
      </div>
    `;

    // Event listeners
    const addCurrentBtn = panel.querySelector('#ytm-jam-inpage-add-current-btn');
    if (addCurrentBtn) {
      addCurrentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = getCurrentVideoId();
        if (vid) {
          const meta = getCurrentTrackMetadata();
          chrome.runtime.sendMessage({
            type: 'BG_ADD_QUEUE',
            track: {
              videoId: vid,
              title: meta.title,
              artist: meta.artist,
              thumbnail: meta.thumbnail
            }
          }, () => {
            showToast(`Added "${meta.title}" to Jam Queue`);
          });
        } else {
          showToast('No song is currently playing', true);
        }
      });
    }

    const importBtn = panel.querySelector('#ytm-jam-inpage-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cloneUpNextToJam();
      });
    }

    const drawerBtn = panel.querySelector('#ytm-jam-inpage-drawer-btn');
    if (drawerBtn) {
      drawerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDrawer(true);
      });
    }

    // Queue action buttons
    panel.querySelectorAll('.ytm-jam-inpage-actions button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        const index = parseInt(btn.getAttribute('data-index'), 10);

        if (action === 'play') {
          chrome.runtime.sendMessage({ type: 'BG_PLAY_QUEUE', queueItemId: id });
        } else if (action === 'remove') {
          chrome.runtime.sendMessage({ type: 'BG_REMOVE_QUEUE', queueItemId: id });
        } else if (action === 'up' && index > 0) {
          chrome.runtime.sendMessage({ type: 'BG_REORDER_QUEUE', fromIndex: index, toIndex: index - 1 });
        } else if (action === 'down' && index < queue.length - 1) {
          chrome.runtime.sendMessage({ type: 'BG_REORDER_QUEUE', fromIndex: index, toIndex: index + 1 });
        }
      });
    });

    // Clicking row to play
    panel.querySelectorAll('.ytm-jam-inpage-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = row.getAttribute('data-id');
        if (id) {
          chrome.runtime.sendMessage({ type: 'BG_PLAY_QUEUE', queueItemId: id });
        }
      });
    });
  }

  // 14c. Synchronization Engine: Keeps Host and Guest in continuous sync
  function startSyncLoop() {
    setInterval(() => {
      if (!currentRoom) return;
      if (isSyncingFromRemote || isAdPlaying) return;

      const currentVid = getCurrentVideoId();
      const isHost = currentRoom.hostId === currentUserId;

      // 1. Host Only: Check if track changed locally on Host
      if (isHost && currentVid) {
        if (currentVid !== lastBroadcastedVideoId && currentVid !== currentRoom.currentState?.videoId) {
          const now = Date.now();
          if (now - lastTrackChangeSentAt > 4000) {
            lastTrackChangeSentAt = now;
            const meta = getCurrentTrackMetadata();
            lastBroadcastedVideoId = currentVid;
            console.log(`[YTM-Jam SyncLoop] Host track changed: ${currentVid}. Broadcasting to room...`);
            chrome.runtime.sendMessage({
              type: 'BG_SEND_SYNC',
              payload: {
                playbackAction: 'TRACK_CHANGE',
                videoId: currentVid,
                title: meta.title,
                artist: meta.artist,
                thumbnail: meta.thumbnail,
                currentTime: videoElement ? videoElement.currentTime : 0,
                duration: videoElement ? videoElement.duration : 0
              }
            });
            return;
          }
        }

        // 1b. Periodic heartbeat sync every 2s so all devices stay locked to the exact same line
        if (videoElement && !videoElement.paused) {
          const now = Date.now();
          if (now - lastHostHeartbeatAt > 2000) {
            lastHostHeartbeatAt = now;
            chrome.runtime.sendMessage({
              type: 'BG_SEND_SYNC',
              payload: {
                playbackAction: 'HEARTBEAT',
                videoId: currentVid,
                currentTime: videoElement.currentTime,
                duration: videoElement.duration || 0,
                isPlaying: true
              }
            });
          }
        }
      }

      // 2. If room has no active song, but Host is playing something, seed the room!
      if (isHost && !currentRoom.currentState?.videoId && currentVid) {
        const meta = getCurrentTrackMetadata();
        lastBroadcastedVideoId = currentVid;
        console.log(`[YTM-Jam SyncLoop] Seeding empty room with Host track: ${currentVid}`);
        chrome.runtime.sendMessage({
          type: 'BG_SEND_SYNC',
          payload: {
            playbackAction: 'TRACK_CHANGE',
            videoId: currentVid,
            title: meta.title,
            artist: meta.artist,
            thumbnail: meta.thumbnail,
            currentTime: videoElement ? videoElement.currentTime : 0,
            duration: videoElement ? videoElement.duration : 0
          }
        });
        return;
      }

      // 3. Guest: Follow room state and stay in sync!
      if (!isHost && currentRoom.currentState?.videoId) {
        const targetVid = currentRoom.currentState.videoId;
        if (currentVid !== targetVid) {
          console.log(`[YTM-Jam SyncLoop] Guest track out of sync (Local: ${currentVid}, Room: ${targetVid}). Correcting...`);
          const estTime = getEstimatedRoomTime(currentRoom.currentState);
          switchTrack(
            targetVid,
            estTime,
            currentRoom.currentState.isPlaying,
            currentRoom.currentState.title,
            currentRoom.currentState.artist,
            currentRoom.currentState.thumbnail
          );
          return;
        }

        // Same track: tight drift check against live estimated room time with 1.2s threshold and 2.5s cooldown
        if (videoElement && currentRoom.currentState) {
          const now = Date.now();
          const targetTime = getEstimatedRoomTime(currentRoom.currentState);
          const drift = Math.abs(videoElement.currentTime - targetTime);
          if (drift > 1.2 && now - lastDriftCorrectionAt > 2500 && now > ignoreLocalSeeksUntil) {
            lastDriftCorrectionAt = now;
            ignoreLocalSeeksUntil = now + 1500;
            console.log(`[YTM-Jam SyncLoop] Guest drift ${drift.toFixed(1)}s (Local: ${videoElement.currentTime.toFixed(1)}s, Room: ${targetTime.toFixed(1)}s). Snapping to same line...`);
            videoElement.currentTime = targetTime;
            sendToBridge({ action: 'CMD_SEEK', time: targetTime });
          }

          if (currentRoom.currentState.isPlaying && videoElement.paused) {
            videoElement.play().catch(showAutoplaySyncPrompt);
            sendToBridge({ action: 'CMD_PLAY' });
          } else if (!currentRoom.currentState.isPlaying && !videoElement.paused) {
            videoElement.pause();
            sendToBridge({ action: 'CMD_PAUSE' });
          }
        }
      }
    }, 1000);
  }

  function updateUI() {
    ensureDrawerInDOM();
    injectPlayerBarButton();
    injectInPageJamQueue(true);

    const barBtn = document.getElementById('ytm-jam-bar-btn');
    if (barBtn) {
      if (currentRoom) {
        barBtn.classList.add('active');
        barBtn.innerHTML = `
          <span class="jam-status-dot"></span>
          <span>🎧 Jam (${currentRoom.roomId})</span>
        `;
      } else {
        barBtn.classList.remove('active');
        barBtn.innerHTML = `
          <span class="jam-status-dot"></span>
          <span>🎧 Jam</span>
        `;
      }
    }

    if (isDrawerOpen) {
      renderDrawerContent();
    }
  }

  // 15. Room Management Helper Functions
  function joinRoom(roomId, userName) {
    if (!roomId) return;
    const cleanRoom = cleanRoomCode(roomId);
    if (!cleanRoom) return;

    const currentVid = getCurrentVideoId();
    const meta = getCurrentTrackMetadata();

    chrome.runtime.sendMessage({
      type: 'BG_JOIN_ROOM',
      roomId: cleanRoom,
      userName: userName || currentUserName,
      currentTrack: currentVid ? { videoId: currentVid, ...meta } : null
    }, (res) => {
      if (res && res.success) {
        showToast(`Connecting to room ${res.roomId}...`);
      }
    });
  }

  function leaveRoom() {
    chrome.runtime.sendMessage({ type: 'BG_LEAVE_ROOM' }, () => {
      currentRoom = null;
      updateUI();
    });
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // 16. "Clone My Up Next Playlist to Jam" Feature
  async function cloneUpNextToJam() {
    const queueElements = document.querySelectorAll('ytmusic-player-queue-item');
    if (!queueElements || queueElements.length === 0) {
      showToast('No Up Next songs found. Open the player queue first!', true);
      return;
    }

    if (!currentRoom) {
      const storeData = await chrome.storage.local.get(['lastRoomState', 'roomId']);
      if (storeData.lastRoomState) currentRoom = storeData.lastRoomState;
    }

    if (!currentRoom) {
      showToast('Join or create a Jam Room first!', true);
      toggleDrawer(true);
      return;
    }

    showToast('Reading Up Next playlist...');
    const scrapedTracks = [];
    const seen = new Set();

    for (const el of queueElements) {
      const track = await resolveTrackData(el);
      if (track && track.videoId && !seen.has(track.videoId)) {
        seen.add(track.videoId);
        scrapedTracks.push(track);
      }
    }

    if (scrapedTracks.length === 0) {
      showToast('Could not extract songs from Up Next.', true);
      return;
    }

    console.log(`[YTM-Jam Content] Cloning ${scrapedTracks.length} tracks to Jam queue...`);
    chrome.runtime.sendMessage({
      type: 'BG_BULK_ADD_QUEUE',
      tracks: scrapedTracks
    }, () => {
      showToast(`Imported ${scrapedTracks.length} tracks to Jam Queue!`);
    });
  }

  // 17. MutationObserver: Inject "+ Jam" Buttons on Song Rows Everywhere
  function observeSongRows() {
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      // Ignore mutations originated by our own injected elements
      const isOurMutation = mutations.every(m => {
        return m.target && (
          m.target.closest?.('#ytm-jam-drawer') ||
          m.target.closest?.('#ytm-jam-inpage-queue') ||
          m.target.closest?.('.ytm-jam-add-btn') ||
          m.target.closest?.('#ytm-jam-bar-btn')
        );
      });
      if (isOurMutation) return;

      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        injectQuickAddButtons();
        injectPlayerBarButton();
        injectInPageJamQueue(false);
      }, 500);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    injectQuickAddButtons();
    injectPlayerBarButton();
    injectInPageJamQueue(false);
  }

  function injectQuickAddButtons() {
    const rows = document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-player-queue-item');

    rows.forEach((row) => {
      if (row.querySelector('.ytm-jam-add-btn')) return;

      const addBtn = document.createElement('button');
      addBtn.className = 'ytm-jam-add-btn';
      addBtn.title = 'Add to Shared Jam Queue';
      addBtn.innerHTML = '<span>+ Jam</span>';

      addBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 1. Ensure current room is loaded
        if (!currentRoom) {
          const storeData = await chrome.storage.local.get(['lastRoomState', 'roomId']);
          if (storeData.lastRoomState) {
            currentRoom = storeData.lastRoomState;
          } else if (storeData.roomId) {
            const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'BG_GET_STATUS' }, r));
            if (res && res.currentRoom) currentRoom = res.currentRoom;
          }
        }

        if (!currentRoom) {
          showToast('Join or create a Jam Room first!', true);
          toggleDrawer(true);
          return;
        }

        addBtn.innerHTML = '<span>⏳ Adding...</span>';

        // 2. Resolve track data (checks stamped attribute or queries bridge)
        const trackData = await resolveTrackData(row);
        if (!trackData || !trackData.videoId) {
          addBtn.innerHTML = '<span>+ Jam</span>';
          showToast('Could not find video for this track.', true);
          return;
        }

        // 3. Send to background
        chrome.runtime.sendMessage({
          type: 'BG_ADD_QUEUE',
          track: trackData
        }, () => {
          addBtn.classList.add('added');
          addBtn.innerHTML = '<span>✓ Added</span>';
          showToast(`Added "${trackData.title}" to Jam Queue`);
          setTimeout(() => {
            addBtn.classList.remove('added');
            addBtn.innerHTML = '<span>+ Jam</span>';
          }, 1500);
        });
      });

      // Insert button in menu or flex column container
      const menu = row.querySelector('.menu, ytmusic-menu-renderer, .right-items');
      if (menu) {
        menu.parentNode.insertBefore(addBtn, menu);
      } else {
        row.appendChild(addBtn);
      }
    });
  }

  // 18. Toast Notification Helper
  function showToast(message, isError = false) {
    let toast = document.querySelector('.ytm-jam-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'ytm-jam-toast';
      document.body.appendChild(toast);
    }

    toast.style.borderColor = isError ? '#ef4444' : 'rgba(255, 255, 255, 0.1)';
    toast.innerHTML = `<span>${isError ? '⚠️' : '🎧'}</span> <span>${escapeHtml(message)}</span>`;
    toast.classList.add('show');

    if (toast.__timeout) clearTimeout(toast.__timeout);
    toast.__timeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
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

  // Start initialization
  attachPlayerListeners();
  observeSongRows();
  checkForUrlInvite();
  startSyncLoop();
  console.log('[YTM-Jam Content] Ready.');
})();