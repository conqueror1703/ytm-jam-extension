# 🎧 YouTube Music Jam (YTM Jam)

> **Real-time synchronized listening and collaborative queue for YouTube Music** — the free, open-source Spotify Jam equivalent for YouTube Music.

![Version](https://img.shields.io/badge/version-1.0.0-red.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Status](https://img.shields.io/badge/deployment-100%25%20Free-success.svg)

---

## ✨ Features

- 🔄 **Real-Time Playback Synchronization**: Sub-second drift correction snaps participants to the host seamlessly.
- 🎶 **Collaborative Jam Queue**: Add songs directly from YouTube Music using in-page `+ Jam` badges or import from "Up Next".
- 👑 **Host & Guest Controls**: Host has full control; optional "Guest Controls" toggle allows friends to play, pause, seek, and reorder songs.
- 📱 **Native YTM Integration**: Floating mini-controller with live participant list directly inside [music.youtube.com](https://music.youtube.com).
- ⚙️ **Configurable WebSocket Server**: Switch seamlessly between local dev server (`ws://localhost:8080`) and your 24/7 free cloud backend (`wss://...`).
- 💰 **100% Free**: Zero developer fees, zero hosting costs.

---

## 🚀 Quick Setup & Free Deployment ($0)

Deploying YouTube Music Jam for you and your friends requires two simple pieces:
1. **The Sync Server** (Free 24/7 cloud host on [Render.com](https://render.com) or [Railway.app](https://railway.app)).
2. **The Extension** (Installed via zip file or Edge Add-ons store).

---

### Step 1: Deploy the WebSocket Backend (100% Free on Render.com)

Render provides a completely free Web Service tier that supports WebSockets 24/7:

1. **Push your code to GitHub**:
   - Create a new public or private repository on [GitHub](https://github.com/new) named `ytm-jam-extension`.
   - Push your code:
     ```bash
     git add .
     git commit -m "feat: initial release v1.0.0"
     git branch -M main
     git remote add origin https://github.com/<your-username>/ytm-jam-extension.git
     git push -u origin main
     ```

2. **Deploy on Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com/) and sign in (Free).
   - Click **New +** > **Web Service**.
   - Select **Build and deploy from a Git repository** and connect your `ytm-jam-extension` repo.
   - Configure the following settings:
     - **Name**: `ytm-jam-server` (or any name you prefer)
     - **Region**: Choose the closest region to you
     - **Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Instance Type**: **Free** ($0/month)
   - Click **Create Web Service**.

3. **Copy your Live URL**:
   - Render will deploy in ~1-2 minutes and give you an HTTPS address:
     `https://ytm-jam-server.onrender.com`
   - Your WebSocket URL is the same with `wss://`:
     `wss://ytm-jam-server.onrender.com`

---

### Step 2: Install the Extension (For You & Friends)

Anyone with Chrome, Brave, Edge, Opera, or Arc can install the extension in **30 seconds** without paying any store fee:

#### Method A: Load Unpacked from ZIP (Recommended & Instant)
1. Download or extract `ytm-jam-v1.0.0.zip`.
2. Open your browser's extension management page:
   - **Chrome / Brave**: `chrome://extensions`
   - **Microsoft Edge**: `edge://extensions`
   - **Arc**: `arc://extensions`
3. Turn on the **"Developer mode"** toggle (top-right corner).
4. Click **"Load unpacked"** and select the unzipped `ytm-jam-extension` folder.
5. Done! Pin the 🎧 icon to your toolbar.

#### Method B: Microsoft Edge Add-ons Store (Free Developer Account)
- Unlike Google Chrome's Web Store which charges a **$5 developer fee**, the [Microsoft Edge Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) is **100% free**!
- Once published to the Edge Store, **both Edge and Chrome users** can install it with one click:
  - Chrome users simply turn on *"Allow extensions from other stores"* in `chrome://extensions`.

---

### Step 3: Connect to your Cloud Server

1. Click the **🎧 YTM Jam** extension icon in your browser toolbar.
2. Click the **⚙️ (Settings)** icon in the header.
3. Paste your Render WebSocket URL:
   `wss://ytm-jam-server.onrender.com`
4. Click **"Save & Reconnect"**. The status dot will turn **green (Connected)**.
5. Create a room or share your 6-letter room code with your friends!

---

## 🛠 Local Development

To run both the server and extension locally on your machine:

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the local sync server**:
   ```bash
   npm start
   # Server runs on http://localhost:8080 and ws://localhost:8080
   ```

3. **Load the extension**:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" and select this project directory.

4. Open [music.youtube.com](https://music.youtube.com) and start listening!

---

## 📂 Architecture

- `server.js`: Node.js WebSocket & HTTP server. Maintains room states, heartbeat synchronization, and collaborative queues. Responds to HTTP health check requests for cloud platforms.
- `background.js`: Manifest V3 background service worker with auto-reconnect, keepalive alarms, and chrome storage integration.
- `content.js`: Main injected script inside YouTube Music tabs. Synchronizes playback (`play`, `pause`, `seek`, `trackChange`), renders floating Jam bar, and injects queue buttons.
- `page-bridge.js`: Injected in MAIN world context to communicate directly with YouTube Music's internal player APIs (`ytmusic-app`, `document.getElementById('movie_player')`).
- `popup.html` / `popup.js`: Extension popup UI for creating/joining rooms, managing participants, viewing the shared queue, and configuring server endpoints.

---

## 📄 License

MIT © Aman Singh
