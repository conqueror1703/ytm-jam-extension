/**
 * YouTube Music Jam - Main World Page Bridge
 * Injected into the MAIN world (window context) to interact directly with:
 * 1. #movie_player internal API (.loadVideoById, .playVideo, .pauseVideo, .seekTo, .getVideoData, .getPlaylist)
 * 2. YouTube Music Polymer custom elements, queue items, and navigation
 */

(function () {
  if (window.__YTM_JAM_BRIDGE_LOADED__) return;
  window.__YTM_JAM_BRIDGE_LOADED__ = true;

  console.log('[YTM-Jam Bridge] Loaded into MAIN world context.');

  function getPlayer() {
    return document.getElementById('movie_player') || document.querySelector('ytmusic-player#player');
  }

  function getHtml5Video() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  // Hook into YouTube player events when available
  let isListenerAttached = false;
  let lastKnownVideoId = null;

  function syncPlayerStateToDom() {
    const player = getPlayer();
    const video = getHtml5Video();
    if (!player && !video) return;

    let vid = null;
    let title = '';
    let artist = '';
    let currentTime = 0;
    let duration = 0;
    let isPlaying = false;

    if (player && typeof player.getVideoData === 'function') {
      try {
        const vd = player.getVideoData();
        if (vd && vd.video_id) vid = vd.video_id;
        if (vd && vd.title) title = vd.title;
        if (vd && vd.author) artist = vd.author;
      } catch (_) {}
    }
    if (!vid && video) {
      const params = new URLSearchParams(window.location.search);
      vid = params.get('v');
    }

    if (player && typeof player.getCurrentTime === 'function') {
      try { currentTime = player.getCurrentTime(); } catch (_) {}
    } else if (video) {
      currentTime = video.currentTime;
    }

    if (player && typeof player.getDuration === 'function') {
      try { duration = player.getDuration(); } catch (_) {}
    } else if (video) {
      duration = video.duration || 0;
    }

    if (player && typeof player.getPlayerState === 'function') {
      try { isPlaying = (player.getPlayerState() === 1); } catch (_) {}
    } else if (video) {
      isPlaying = !video.paused;
    }

    if (vid) {
      document.documentElement.dataset.ytmCurrentVideoId = vid;
      document.documentElement.dataset.ytmIsPlaying = isPlaying ? 'true' : 'false';
      document.documentElement.dataset.ytmCurrentTime = String(currentTime);
      document.documentElement.dataset.ytmDuration = String(duration);
      if (title) document.documentElement.dataset.ytmTitle = title;
      if (artist) document.documentElement.dataset.ytmArtist = artist;

      if (lastKnownVideoId !== vid) {
        const prev = lastKnownVideoId;
        lastKnownVideoId = vid;
        window.postMessage({
          source: 'YTM_JAM_PAGE',
          action: 'ON_TRACK_CHANGED',
          videoId: vid,
          previousVideoId: prev,
          title,
          artist,
          currentTime,
          duration,
          isPlaying
        }, '*');
      }
    }
  }

  setInterval(syncPlayerStateToDom, 500);

  function tryAttachPlayerListeners() {
    const player = getPlayer();
    if (!player || typeof player.addEventListener !== 'function') {
      setTimeout(tryAttachPlayerListeners, 1000);
      return;
    }
    if (isListenerAttached) return;

    try {
      player.addEventListener('onStateChange', (state) => {
        // state: 0 = ended, 1 = playing, 2 = paused, 3 = buffering, 5 = cued
        syncPlayerStateToDom();
        window.postMessage({
          source: 'YTM_JAM_PAGE',
          action: 'ON_PLAYER_STATE_CHANGE',
          state: state,
          currentTime: player.getCurrentTime ? player.getCurrentTime() : 0,
          duration: player.getDuration ? player.getDuration() : 0,
          videoData: player.getVideoData ? player.getVideoData() : null
        }, '*');
      });

      player.addEventListener('onAdStateChange', (adState) => {
        window.postMessage({
          source: 'YTM_JAM_PAGE',
          action: 'ON_AD_STATE_CHANGE',
          adState: adState
        }, '*');
      });

      isListenerAttached = true;
      console.log('[YTM-Jam Bridge] Attached onStateChange listener to #movie_player');
    } catch (err) {
      console.warn('[YTM-Jam Bridge] Could not attach player listener yet:', err);
      setTimeout(tryAttachPlayerListeners, 2000);
    }
  }

  tryAttachPlayerListeners();

  /**
   * Deep recursive scanner to find YouTube video ID in Polymer data objects
   * Handles playlistPanelVideoRenderer, playlistPanelVideoWrapperRenderer,
  /**
   * Deep recursive scanner to find YouTube video ID in Polymer data objects
   * Handles playlistPanelVideoRenderer, playlistPanelVideoWrapperRenderer,
   * musicResponsiveListItemRenderer, navigationEndpoints, and flexColumns.
   */
  function findVideoIdDeep(target) {
    if (!target) return null;
    const visited = new Set();

    function scan(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      if (visited.has(obj)) return null;
      visited.add(obj);

      // Direct videoId keys
      if (typeof obj.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(obj.videoId)) {
        return obj.videoId;
      }
      if (typeof obj.video_id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(obj.video_id)) {
        return obj.video_id;
      }

      // WatchEndpoint checks
      if (obj.watchEndpoint && typeof obj.watchEndpoint.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(obj.watchEndpoint.videoId)) {
        return obj.watchEndpoint.videoId;
      }
      if (obj.navigationEndpoint?.watchEndpoint?.videoId && /^[a-zA-Z0-9_-]{11}$/.test(obj.navigationEndpoint.watchEndpoint.videoId)) {
        return obj.navigationEndpoint.watchEndpoint.videoId;
      }
      if (obj.playNavigationEndpoint?.watchEndpoint?.videoId && /^[a-zA-Z0-9_-]{11}$/.test(obj.playNavigationEndpoint.watchEndpoint.videoId)) {
        return obj.playNavigationEndpoint.watchEndpoint.videoId;
      }
      if (obj.endpoint?.watchEndpoint?.videoId && /^[a-zA-Z0-9_-]{11}$/.test(obj.endpoint.watchEndpoint.videoId)) {
        return obj.endpoint.watchEndpoint.videoId;
      }
      if (obj.defaultNavigationEndpoint?.watchEndpoint?.videoId && /^[a-zA-Z0-9_-]{11}$/.test(obj.defaultNavigationEndpoint.watchEndpoint.videoId)) {
        return obj.defaultNavigationEndpoint.watchEndpoint.videoId;
      }

      // Priority YouTube Music Polymer object properties
      const priorityKeys = [
        'item',
        'items',
        'queueItem',
        'contents',
        'playlistPanelVideoRenderer',
        'playlistPanelVideoWrapperRenderer',
        'musicResponsiveListItemRenderer',
        'primaryRenderer',
        'data',
        '__data',
        'playlistItemData',
        'itemData',
        'model',
        'overlay',
        'musicItemThumbnailOverlayRenderer',
        'content',
        'musicPlayButtonRenderer',
        'endpoint',
        'navigationEndpoint',
        'playNavigationEndpoint',
        'defaultNavigationEndpoint',
        'menu',
        'menuRenderer',
        'menuNavigationItemRenderer',
        'flexColumns',
        'musicResponsiveListItemFlexColumnRenderer',
        'text',
        'runs'
      ];

      for (const key of priorityKeys) {
        if (obj[key]) {
          const res = scan(obj[key], depth + 1);
          if (res) return res;
        }
      }

      // If array, scan elements
      if (Array.isArray(obj)) {
        for (let i = 0; i < Math.min(obj.length, 25); i++) {
          const res = scan(obj[i], depth + 1);
          if (res) return res;
        }
      }

      // General object scan
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          if (!priorityKeys.includes(k) && typeof obj[k] === 'object' && obj[k] !== null) {
            const res = scan(obj[k], depth + 1);
            if (res) return res;
          }
        }
      }

      return null;
    }

    return scan(target, 0);
  }

  /**
   * Helper to find title string in a Polymer data object
   */
  function findTitleDeep(target) {
    if (!target) return '';
    try {
      if (typeof target.title === 'string') return target.title;
      if (target.title?.runs?.[0]?.text) return target.title.runs[0].text;
      if (target.playlistPanelVideoRenderer?.title?.runs?.[0]?.text) {
        return target.playlistPanelVideoRenderer.title.runs[0].text;
      }
    } catch (_) {}
    return '';
  }

  /**
   * Extract video ID and metadata from any YouTube Music custom element
   */
  function extractDataFromElement(el) {
    if (!el) return null;

    let videoId = null;
    const player = getPlayer();

    // Strategy 1: Deep scan element's Polymer properties (el.data, el.item, el.__data, etc.)
    videoId = findVideoIdDeep(el.data) ||
              findVideoIdDeep(el.item) ||
              findVideoIdDeep(el.playlistPanelVideoRenderer) ||
              findVideoIdDeep(el.playlistItemData) ||
              findVideoIdDeep(el.itemData) ||
              findVideoIdDeep(el.model) ||
              findVideoIdDeep(el.__data) ||
              findVideoIdDeep(el);

    // Strategy 2: Deep scan child components (play button, menu renderer, etc.)
    if (!videoId) {
      const playBtn = el.querySelector('ytmusic-play-button-renderer');
      if (playBtn) {
        videoId = findVideoIdDeep(playBtn.endpoint) ||
                  findVideoIdDeep(playBtn.navigationEndpoint) ||
                  findVideoIdDeep(playBtn.playNavigationEndpoint) ||
                  findVideoIdDeep(playBtn.data) ||
                  findVideoIdDeep(playBtn.__data) ||
                  findVideoIdDeep(playBtn);
      }
    }

    if (!videoId) {
      const menu = el.querySelector('ytmusic-menu-renderer');
      if (menu) {
        videoId = findVideoIdDeep(menu.data) ||
                  findVideoIdDeep(menu.__data) ||
                  findVideoIdDeep(menu.items) ||
                  findVideoIdDeep(menu);
      }
    }

    // Strategy 3: Scan HTML links
    if (!videoId) {
      const links = el.querySelectorAll('a[href*="watch?v="]');
      for (const link of links) {
        const match = link.href && link.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (match) {
          videoId = match[1];
          break;
        }
      }
    }

    // Strategy 4: Scan thumbnail image URL (including vi_webp)
    if (!videoId) {
      const imgs = el.querySelectorAll('img[src]');
      for (const img of imgs) {
        const match = img.src && img.src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})/);
        if (match) {
          videoId = match[1];
          break;
        }
      }
    }

    // Strategy 5: Query memory queue array from ytmusic-player-queue component!
    if (!videoId && el.tagName && el.tagName.toLowerCase() === 'ytmusic-player-queue-item') {
      try {
        const queueComponent = document.querySelector('ytmusic-player-queue');
        const queueData = queueComponent?.items || queueComponent?.data?.items || queueComponent?.__data?.items;
        if (Array.isArray(queueData)) {
          // A. By index
          const allDomItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
          const idx = (typeof el.index === 'number') ? el.index : allDomItems.indexOf(el);
          if (idx >= 0 && idx < queueData.length) {
            videoId = findVideoIdDeep(queueData[idx]);
          }

          // B. By Title matching
          if (!videoId) {
            const rawTitle = el.querySelector('.title, yt-formatted-string.title')?.textContent?.trim();
            if (rawTitle) {
              for (const qItem of queueData) {
                const qTitle = findTitleDeep(qItem);
                if (qTitle && qTitle.toLowerCase() === rawTitle.toLowerCase()) {
                  videoId = findVideoIdDeep(qItem);
                  if (videoId) break;
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    // Strategy 6: Check YouTube Player Playlist Mapping by Queue Index
    if (!videoId && player && typeof player.getPlaylist === 'function') {
      try {
        const playlist = player.getPlaylist();
        const allDomItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
        const idx = (typeof el.index === 'number') ? el.index : allDomItems.indexOf(el);
        if (Array.isArray(playlist) && idx >= 0 && playlist[idx]) {
          videoId = playlist[idx];
        }
      } catch (_) {}
    }

    // Strategy 7: Regex on row outerHTML
    if (!videoId && el.outerHTML) {
      const match = el.outerHTML.match(/[?&]v=([a-zA-Z0-9_-]{11})|\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})|"videoId":\s*"([a-zA-Z0-9_-]{11})"/);
      if (match) {
        videoId = match[1] || match[2] || match[3];
      }
    }

    // Strategy 8: If currently playing track
    if (!videoId && (el.classList.contains('selected') || el.getAttribute('play-button-state') === 'playing')) {
      if (player && typeof player.getVideoData === 'function') {
        const vData = player.getVideoData();
        if (vData && vData.video_id) videoId = vData.video_id;
      }
    }

    // Extract Title
    let title = 'Unknown Title';
    const titleEl = el.querySelector('.song-title, yt-formatted-string.song-title, .title, yt-formatted-string.title, .song-info .title');
    if (titleEl && titleEl.textContent.trim()) {
      title = titleEl.textContent.trim();
    } else {
      const dataTitle = el.data?.playlistPanelVideoRenderer?.title?.runs?.[0]?.text ||
                        el.data?.title?.runs?.[0]?.text;
      if (dataTitle) title = dataTitle;
    }

    // Extract Artist
    let artist = 'Unknown Artist';
    const artistEl = el.querySelector('.byline, yt-formatted-string.byline, .song-info .byline, .author, .artist-name');
    if (artistEl && artistEl.textContent.trim()) {
      artist = artistEl.textContent.trim().split('•')[0].trim();
    } else {
      const dataArtist = el.data?.playlistPanelVideoRenderer?.shortBylineText?.runs?.[0]?.text ||
                         el.data?.playlistPanelVideoRenderer?.longBylineText?.runs?.[0]?.text ||
                         el.data?.shortBylineText?.runs?.[0]?.text;
      if (dataArtist) artist = dataArtist;
    }

    // Fallback innerText
    if ((!title || title === 'Unknown Title') || (!artist || artist === 'Unknown Artist')) {
      if (el.innerText) {
        const lines = el.innerText.split('\n')
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

    // Extract Thumbnail
    let thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
    const imgEl = el.querySelector('img');
    if (imgEl && imgEl.src && !imgEl.src.startsWith('data:')) {
      thumbnail = imgEl.src;
    } else {
      const thumbs = el.data?.playlistPanelVideoRenderer?.thumbnail?.thumbnails ||
                     el.data?.thumbnail?.thumbnails;
      if (Array.isArray(thumbs) && thumbs.length > 0) {
        thumbnail = thumbs[thumbs.length - 1].url;
      }
    }

    return { videoId, title, artist, thumbnail };
  }

  // Note: Song row extraction is performed on-demand when requested via CMD_EXTRACT_ROW_DATA

  // Helper to instantly update YouTube Music's player bar UI
  function updatePlayerBarUI(vid, songTitle, songArtist, songThumb) {
    if (songTitle && songTitle !== 'Unknown Title') {
      document.title = `${songTitle} - ${songArtist && songArtist !== 'Unknown Artist' ? songArtist + ' - ' : ''}YouTube Music`;
      const titleEls = document.querySelectorAll('ytmusic-player-bar .title, ytmusic-player-bar yt-formatted-string.title');
      titleEls.forEach(el => { el.textContent = songTitle; el.title = songTitle; });
    }
    if (songArtist && songArtist !== 'Unknown Artist') {
      const bylineEls = document.querySelectorAll('ytmusic-player-bar .byline, ytmusic-player-bar yt-formatted-string.byline');
      bylineEls.forEach(el => { el.textContent = songArtist; el.title = songArtist; });
    }
    if (songThumb) {
      const thumbEls = document.querySelectorAll('ytmusic-player-bar img.image, ytmusic-player-bar .thumbnail img');
      thumbEls.forEach(img => { img.src = songThumb; });
    }
    if (vid) {
      if (songTitle) document.documentElement.dataset.ytmTitle = songTitle;
      if (songArtist) document.documentElement.dataset.ytmArtist = songArtist;
    }
  }

  // Handle messages from content script
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'YTM_JAM_CONTENT') return;

    const { action, videoId, startTime, time, autoplay, title, artist, thumbnail, requestId, selector, rowId } = event.data;
    const player = getPlayer();
    const video = getHtml5Video();

    // 1. Seamless Track Switching via SPA API & DOM Matching
    if (action === 'CMD_LOAD_VIDEO') {
      if (!videoId) return;
      console.log(`[YTM-Jam Bridge] Loading track: ${videoId} ("${title || ''} - ${artist || ''}") at ${startTime || 0}s`);

      // Update player bar UI immediately so the user sees the song info right away
      updatePlayerBarUI(videoId, title, artist, thumbnail);

      // Strategy A: Check if a matching queue item exists in the DOM and click it
      const match = document.querySelector(
        `ytmusic-player-queue-item[data-ytm-video-id="${videoId}"], ` +
        `[data-ytm-video-id="${videoId}"], ` +
        `a[href*="watch?v=${videoId}"]`
      );
      if (match) {
        const row = match.closest('ytmusic-player-queue-item, ytmusic-responsive-list-item-renderer') || match;
        const playBtn = row.querySelector('ytmusic-play-button-renderer') || row;
        console.log('[YTM-Jam Bridge] Found matching song in DOM, clicking play button...');
        playBtn.click();
        if (startTime > 1.5) {
          setTimeout(() => {
            try { player?.seekTo?.(startTime, true); } catch (_) {}
          }, 600);
        }
        return;
      }

      // Strategy B: Use #movie_player API to stream the audio/video immediately
      let loadedViaApi = false;
      if (player && typeof player.loadVideoById === 'function') {
        try {
          player.loadVideoById({
            videoId: videoId,
            startSeconds: startTime || 0
          });
          loadedViaApi = true;
        } catch (e1) {
          try {
            player.loadVideoById(videoId, startTime || 0);
            loadedViaApi = true;
          } catch (e2) {
            console.warn('[YTM-Jam Bridge] loadVideoById error:', e2);
          }
        }
      }

      if (loadedViaApi && autoplay !== false && player && typeof player.playVideo === 'function') {
        setTimeout(() => {
          try { player.playVideo(); } catch (_) {}
        }, 150);
      }

      // Strategy C: Update URL in address bar without full page reload
      try {
        const navUrl = `/watch?v=${videoId}` + (startTime > 1.5 ? `&t=${Math.floor(startTime)}` : '');
        window.history.replaceState(null, '', navUrl);
      } catch (_) {}

      // Strategy D: Dispatch YouTube Music Polymer navigation event & trigger click on synthetic anchor
      try {
        const navUrl = `/watch?v=${videoId}` + (startTime > 1.5 ? `&t=${Math.floor(startTime)}` : '');
        const link = document.createElement('a');
        link.className = 'yt-simple-endpoint style-scope ytmusic-player-bar';
        link.href = navUrl;
        link.style.display = 'none';
        (document.body || document.documentElement).appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 600);
      } catch (_) {}

      try {
        const navEvent = new CustomEvent('yt-navigate', {
          detail: {
            endpoint: {
              watchEndpoint: {
                videoId: videoId,
                startTime: startTime || 0
              }
            }
          },
          bubbles: true
        });
        document.dispatchEvent(navEvent);
      } catch (err) {
        console.warn('[YTM-Jam Bridge] yt-navigate fallback failed:', err);
      }
    }

    // 2. Play
    if (action === 'CMD_PLAY') {
      if (player && typeof player.playVideo === 'function') {
        try { player.playVideo(); } catch (_) {}
      } else if (video && video.paused) {
        video.play().catch(() => {});
      }
    }

    // 3. Pause
    if (action === 'CMD_PAUSE') {
      if (player && typeof player.pauseVideo === 'function') {
        try { player.pauseVideo(); } catch (_) {}
      } else if (video && !video.paused) {
        video.pause();
      }
    }

    // 4. Seek
    if (action === 'CMD_SEEK') {
      const targetTime = typeof time === 'number' ? time : 0;
      if (player && typeof player.seekTo === 'function') {
        try { player.seekTo(targetTime, true); } catch (_) {}
      }
      if (video) {
        try { video.currentTime = targetTime; } catch (_) {}
      }
    }

    // 5. Get Video & Player State Data
    if (action === 'CMD_GET_PLAYER_DATA') {
      let videoData = null;
      let currentTime = 0;
      let duration = 0;
      let isPlaying = false;

      if (player) {
        try {
          if (typeof player.getVideoData === 'function') videoData = player.getVideoData();
          if (typeof player.getCurrentTime === 'function') currentTime = player.getCurrentTime();
          if (typeof player.getDuration === 'function') duration = player.getDuration();
          if (typeof player.getPlayerState === 'function') isPlaying = (player.getPlayerState() === 1);
        } catch (_) {}
      }

      if (!videoData && video) {
        currentTime = video.currentTime;
        duration = video.duration || 0;
        isPlaying = !video.paused;
      }

      window.postMessage({
        source: 'YTM_JAM_PAGE',
        action: 'RESP_PLAYER_DATA',
        requestId: requestId,
        data: {
          videoId: videoData?.video_id || null,
          title: videoData?.title || '',
          artist: videoData?.author || '',
          currentTime,
          duration,
          isPlaying
        }
      }, '*');
    }

    // 6. Direct Row Data Extraction on Demand
    if (action === 'CMD_EXTRACT_ROW_DATA') {
      let el = null;
      if (rowId) {
        el = document.querySelector(`[data-jam-row-id="${rowId}"]`);
      } else if (selector) {
        el = document.querySelector(selector);
      }

      const extracted = extractDataFromElement(el);

      window.postMessage({
        source: 'YTM_JAM_PAGE',
        action: 'RESP_ROW_DATA',
        requestId: requestId,
        data: extracted
      }, '*');
    }
  });

  // Announce ready state
  window.postMessage({ source: 'YTM_JAM_PAGE', action: 'BRIDGE_READY' }, '*');
})();
