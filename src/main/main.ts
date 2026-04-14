import { app, BrowserWindow, ipcMain, session, globalShortcut, protocol, net, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { BrowserManager } from './services/BrowserManager.js';
import { KOWALSKI_VIEWPORT } from '../shared/viewportConfig.js';

// --- GLOBAL ELECTRON FIXES ---
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ... (imports remain) ...

// ... (inside setupIPCHandlers) ...


import { SecureKeyManager } from './services/SecureKeyManager.js';
import { UsageService } from './services/UsageService.js';
import { RunManager } from './services/RunManager.js';
import { SessionMemory } from './services/SessionMemory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { createRequire } from 'module';
const require = createRequire(import.meta.url);


// Disable macOS window restoration prompt after force-quit
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Register custom protocol scheme for serving local images
// MUST be called before app.on('ready')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kowalski-local',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
]);

// Track quitting state so we can actually quit when Cmd+Q is pressed
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
const SHARED_PARTITION = 'persist:instagram_shared';

const createWindow = () => {
  // Window content area matches the screencast viewport exactly (1280×900).
  mainWindow = new BrowserWindow({
    width: KOWALSKI_VIEWPORT.width,
    height: KOWALSKI_VIEWPORT.height,
    useContentSize: true,
    minWidth: KOWALSKI_VIEWPORT.width,
    minHeight: KOWALSKI_VIEWPORT.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Kowalski',
    backgroundColor: '#F9F8F5', // Warm Alabaster for LCD antialiasing
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      webviewTag: true,
      partition: SHARED_PARTITION
    }
    // No `icon` on macOS: the dock/finder icon comes from the .app bundle's
    // Contents/Resources/icon.icns, which electron-builder writes from
    // package.json's `build.mac.icon`. Passing a path here is redundant and
    // can throw "Failed to load image from path" at runtime.
  });

  // Share window ref with RunManager and BrowserManager (for screencast IPC)
  RunManager.getInstance().setMainWindow(mainWindow);
  BrowserManager.getInstance().setMainWindow(mainWindow);

  // Prevent title from being updated by the renderer (React)

  // Prevent title from being updated by the renderer (React)
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // Load the index.html of the app.
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = process.env.VITE_DEV_SERVER_URL;
    console.log("Creating window with URL:", url);
    mainWindow.loadURL(url);
    // Open the DevTools.
    // mainWindow.webContents.openDevTools();
  } else {
    // Use the custom scheme so react-router's BrowserRouter sees a clean
    // pathname (e.g. "/") rather than a long file:// URL that matches nothing.
    const url = 'kowalski-local://app/';
    console.log("Loading renderer via custom scheme:", url);
    mainWindow.loadURL(url);
  }

  // --- DIAGNOSTIC LISTENERS ---
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('✅ did-finish-load: Main window content loaded successfully.');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`❌ did-fail-load: Error ${errorCode} (${errorDescription}) loading ${validatedURL}`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    console.log('✅ dom-ready: DOM is ready.');
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`💀 render-process-gone: Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
  });
  // --- WINDOW LIFECYCLE ---
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
    // Clear reference in RunManager to be safe
    RunManager.getInstance().setMainWindow(null);
  });
  // -------------------------
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  // Register kowalski-local:// protocol handler for serving local images
  // Maps: kowalski-local://{recordId}/images/{filename} -> {userData}/analysis_records/{recordId}/images/{filename}

  // Path to the built renderer bundle (Vite output). In a packaged app this
  // is Contents/Resources/app/dist; in dev it's <repo>/dist.
  const rendererDistDir = path.join(__dirname, '../../dist');

  // Define the protocol handler function (reused for both sessions)
  const protocolHandler = (request: Electron.ProtocolRequest, callback: (response: Electron.ProtocolResponse) => void) => {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const rawPath = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;

    // Renderer bundle served via kowalski-local://app/... so react-router
    // has a clean pathname to match against.
    if (hostname === 'app') {
      const candidate = rawPath ? path.join(rendererDistDir, rawPath) : path.join(rendererDistDir, 'index.html');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        callback({ path: candidate });
      } else {
        // SPA fallback — unknown path, hand the router index.html.
        callback({ path: path.join(rendererDistDir, 'index.html') });
      }
      return;
    }

    // URL format: kowalski-local://{recordId}/images/{filename}
    // hostname = recordId, pathname = /images/{filename}
    const recordId = hostname;
    const filePath = rawPath;

    const userDataPath = app.getPath('userData');
    const fullPath = path.join(userDataPath, 'analysis_records', recordId, filePath);

    console.log(`📷 Protocol request: ${request.url}`);
    console.log(`📷 Resolved path: ${fullPath}`);

    // Check if file exists
    if (fs.existsSync(fullPath)) {
      console.log(`📷 File exists, serving: ${fullPath}`);
      callback({ path: fullPath });
    } else {
      console.error(`❌ Protocol error: File not found: ${fullPath}`);
      console.error(`❌ RecordId: ${recordId}, FilePath: ${filePath}`);

      // Debug: List directory contents
      const recordsDir = path.join(userDataPath, 'analysis_records');
      if (fs.existsSync(recordsDir)) {
        console.log(`📂 Contents of analysis_records: ${fs.readdirSync(recordsDir).join(', ')}`);
        const recordDir = path.join(recordsDir, recordId);
        if (fs.existsSync(recordDir)) {
          console.log(`📂 Contents of ${recordId}: ${fs.readdirSync(recordDir).join(', ')}`);
          const imagesDir = path.join(recordDir, 'images');
          if (fs.existsSync(imagesDir)) {
            console.log(`📂 Contents of images: ${fs.readdirSync(imagesDir).join(', ')}`);
          }
        }
      }

      callback({ error: -6 }); // NET_ERR_FILE_NOT_FOUND
    }
  };

  // Register on default session (for any windows not using custom partition)
  protocol.registerFileProtocol('kowalski-local', protocolHandler);
  console.log('✅ Registered kowalski-local protocol on default session');

  // CRITICAL: Also register on the shared partition session (for main window)
  // The main window uses partition: SHARED_PARTITION, which has its own isolated session
  // Without this, protocol requests from the renderer never reach the handler
  session.fromPartition(SHARED_PARTITION).protocol.registerFileProtocol('kowalski-local', protocolHandler);
  console.log(`✅ Registered kowalski-local protocol on partition: ${SHARED_PARTITION}`);

  createWindow();

  console.log('Session persistence enabled.');

  // Delay service initialization to avoid EINTR during Electron startup
  setTimeout(() => {
    // Initialize Usage Service (Checks for monthly reset)
    UsageService.getInstance().initialize().catch(err => {
      console.error('UsageService init failed:', err);
    });
  }, 2000);

  // === SHORTCUTS ===
  // Cmd+Shift+H: Start run
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    console.log('🚀 Run Triggered (Cmd+Shift+H)');
    RunManager.getInstance().startRun();
  });

  // Cmd+Shift+K: Stop active run
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    console.log('🛑 Stop Triggered (Cmd+Shift+K)');
    RunManager.getInstance().stopRun();
  });

  // Cmd+Shift+S: Stories-only run
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    console.log('📖 Stories-Only Run Triggered (Cmd+Shift+S)');
    RunManager.getInstance().startRun({ phases: ['stories'] });
  });

  // Cmd+Shift+F: Feed-only run
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    console.log('📰 Feed-Only Run Triggered (Cmd+Shift+F)');
    RunManager.getInstance().startRun({ phases: ['feed'] });
  });

  // Cmd+Shift+R: Reset session memory
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    console.log('🧠 Reset Session Memory Triggered (Cmd+Shift+R)');
    new SessionMemory().resetMemory();
  });

  // MIGRATION: Ensure storage directory exists
  const userDataPath = app.getPath('userData');
  const recordsPath = path.join(userDataPath, 'analysis_records');
  if (!fs.existsSync(recordsPath)) {
    fs.mkdirSync(recordsPath, { recursive: true });
    console.log('📂 Created analysis_records directory');
  }

  // MIGRATION: Clean Slate for File-Based Storage
  // Clearing legacy store to prevent UI errors with missing files.
  // TEMPORARY MIGRATION CLEANUP (Removed to prevent data loss on restart)
  // The previous block wiped data on every boot.
  // Data persistence is now safely handled by the File-Per-Analysis model.
  setupIPCHandlers();
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  RunManager.getInstance().stopRun();
});

// DIRECT GUEST ATTACHMENT: The Nuclear Option
// [REMOVED] DIRECT GUEST ATTACHMENT (Legacy Webview Cookie Sniffer)
// The login flow is now handled by BrowserManager Overlay.

// [REMOVED] Helper to save session
// saveSessionAndNotify logic deleted.

function setupIPCHandlers() {
  ipcMain.handle('reset-session', async () => {
    console.log('🧹 Starting session reset...');

    // 1. Delete session.json
    try {
      const userDataPath = app.getPath('userData');

      // 1. Delete legacy session.json (if exists)
      const sessionPath = path.join(userDataPath, 'session.json');
      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
        console.log('✅ Deleted legacy session.json');
      }

      // 1.5 Close & Wipe BrowserManager Data
      await BrowserManager.getInstance().clearData();
    } catch (e) {
      console.error('⚠️ Failed to delete session.json:', e);
    }

    // 2. Clear Electron Cache (may fail due to file locks, non-critical)
    try {
      await session.defaultSession.clearStorageData();
      console.log('✅ Cleared default session storage');
    } catch (e) {
      console.error('⚠️ Failed to clear default session storage:', e);
    }

    try {
      await session.fromPartition(SHARED_PARTITION).clearStorageData();
      console.log('✅ Cleared shared partition storage');
    } catch (e) {
      console.error('⚠️ Failed to clear shared partition storage:', e);
    }

    // 3. Clear electron-store (critical)
    try {
      const { default: Store } = await import('electron-store');
      const store: any = new Store();
      store.clear();
      store.delete('analyses');
      store.delete('settings');
      console.log('✅ Cleared electron-store');
    } catch (e) {
      console.error('❌ Failed to clear electron-store:', e);
      return false;
    }

    // 4. Delete analysis_records folder (contains individual analysis JSON files)
    try {
      const userDataPath = app.getPath('userData');
      const recordsPath = path.join(userDataPath, 'analysis_records');
      if (fs.existsSync(recordsPath)) {
        fs.rmSync(recordsPath, { recursive: true, force: true });
        console.log('✅ Deleted analysis_records folder');
      }
    } catch (e) {
      console.error('⚠️ Failed to delete analysis_records:', e);
      // Non-critical, continue with reset
    }

    console.log('🎉 Session reset complete');
    return true;
  });

  // --- Electron Store Handlers ---
  ipcMain.handle('settings:get', async () => {
    const { default: Store } = await import('electron-store');
    const store: any = new Store();
    return store.get('settings') || {};
  });

  ipcMain.handle('settings:set', async (_event, newSettings) => {
    const { default: Store } = await import('electron-store');
    const store: any = new Store();
    store.set('settings', newSettings);
    return true;
  });

  ipcMain.handle('settings:patch', async (_event, updates) => {
    const { default: Store } = await import('electron-store');
    const store: any = new Store();
    const current = (store.get('settings') as object) || {};
    const merged = { ...current, ...updates };
    store.set('settings', merged);
    return merged;
  });

  ipcMain.handle('analyses:get', async () => {
    const { default: Store } = await import('electron-store');
    const store: any = new Store();
    return store.get('analyses') || [];
  });

  ipcMain.handle('analyses:set', async (_event, analyses) => {
    const { default: Store } = await import('electron-store');
    const store: any = new Store();
    store.set('analyses', analyses);
    return true;
    return true;
  });

  ipcMain.handle('analyses:get-content', async (_event, id) => {
    try {
      const userDataPath = app.getPath('userData');
      const filePath = path.join(userDataPath, 'analysis_records', `${id}.json`);

      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
      return null;
    } catch (e) {
      console.error(`❌ Failed to load analysis content for ${id}:`, e);
      return null;
    }
  });

  // --- Run Handlers ---
  // Fire-and-forget: startRun() is a long-lived async operation (minutes).
  // Awaiting it here would block the IPC response and can interfere with
  // subsequent invoke() calls from the renderer (e.g. run:stop).
  // The renderer is notified of progress via separate IPC events (run-started,
  // kowalski:screencastEnded, run-complete, analysis-ready).
  ipcMain.handle('run:start', () => {
    RunManager.getInstance().startRun();
  });

  ipcMain.handle('run:stop', () => {
    RunManager.getInstance().stopRun();
  });

  ipcMain.handle('run:skipToFeed', () => {
    RunManager.getInstance().skipToFeed();
  });

  ipcMain.handle('run:status', () => {
    return RunManager.getInstance().getStatus();
  });

  // Renderer forwards `navigator.onLine` transitions; on offline we abort any
  // active run immediately so the UI can flip to the failed screen without
  // waiting for fetch timeouts.
  ipcMain.on('network:offline', () => {
    RunManager.getInstance().notifyOffline();
  });

  // --- Login Screencast + Input Forwarding ---
  ipcMain.handle('login:startScreencast', () => {
    BrowserManager.getInstance().startLoginScreencast();
  });

  ipcMain.handle('login:stopScreencast', () => {
    BrowserManager.getInstance().stopLoginScreencast();
  });

  ipcMain.on('kowalski:input', (_event, payload) => {
    BrowserManager.getInstance().dispatchInput(payload);
  });

  ipcMain.on('kowalski:paste', (_event, text?: string) => {
    const pasteText = text || clipboard.readText();
    if (pasteText) {
      BrowserManager.getInstance().dispatchInput({ type: 'paste', text: pasteText });
    }
  });

  ipcMain.on('kowalski:copySelection', async () => {
    try {
      const ctx = BrowserManager.getInstance().getContext();
      if (!ctx) return;
      const pages = ctx.pages();
      const page = pages[0];
      if (!page) return;
      const text = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      if (text) {
        clipboard.writeText(text);
      }
    } catch {
      // Page may be closed — swallow
    }
  });

  // --- Secure Storage Handlers ---
  ipcMain.handle('settings:set-secure', async (_event, { apiKey }) => {
    return SecureKeyManager.getInstance().setKey(apiKey);
  });

  ipcMain.handle('settings:check-key-status', async () => {
    return SecureKeyManager.getInstance().getKeyStatus();
  });

  ipcMain.handle('settings:get-secure', async () => {
    return SecureKeyManager.getInstance().getKey();
  });

  ipcMain.handle('settings:validate-api-key', async (_event, { apiKey }) => {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      if (response.status === 401) return { valid: false, error: 'invalid_key' };
      if (!response.ok) return { valid: false, error: 'api_error' };
      return { valid: true };
    } catch (error: any) {
      return { valid: false, error: 'network_error' };
    }
  });
  ipcMain.handle('clear-instagram-session', async () => {
    console.log('🧹 Clearing Instagram Session only...');
    try {
      // 1. Delete session.json
      const userDataPath = app.getPath('userData');
      const sessionPath = path.join(userDataPath, 'session.json');
      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
      }

      // 2. Clear ONLY the Instagram View partition
      await session.fromPartition(SHARED_PARTITION).clearStorageData();

      // 3. Clear the Playwright persistent browser profile (kowalski_browser/)
      // This ensures Switch Account launches a fresh browser without cached login
      await BrowserManager.getInstance().clearData();

      // DO NOT clear defaultSession (preserves LocalStorage/Settings)
      return true;
    } catch (e) {
      console.error('Clear Instagram Session Error:', e);
      return false;
    }
  });

  // --- Instagram Session Status Check ---
  // Reads the Chromium SQLite cookies database directly (no network activity)
  ipcMain.handle('check-instagram-session', async () => {
    try {
      const userDataPath = app.getPath('userData');
      const persistentContextPath = path.join(userDataPath, 'kowalski_browser');

      // Quick check: if no profile exists at all, definitely not logged in
      if (!fs.existsSync(persistentContextPath)) {
        return { isActive: false, reason: 'no_profile' };
      }

      // Check Chromium's SQLite cookies database for Instagram sessionid
      const cookiesDbPath = path.join(persistentContextPath, 'Default', 'Cookies');
      if (!fs.existsSync(cookiesDbPath)) {
        return { isActive: false, reason: 'no_cookies_db' };
      }

      try {
        // Copy the database to a temp location (Chromium may have it locked)
        const tempDbPath = path.join(userDataPath, 'cookies_check_temp.db');
        console.log('🔍 Session check: Copying cookies from', cookiesDbPath, 'to', tempDbPath);
        fs.copyFileSync(cookiesDbPath, tempDbPath);

        const Database = require('better-sqlite3');
        const db = new Database(tempDbPath, { readonly: true });

        // Query for Instagram sessionid cookie
        // Chromium stores cookies with host_key like ".instagram.com"
        const stmt = db.prepare(`
          SELECT name, host_key, value, encrypted_value, expires_utc
          FROM cookies
          WHERE host_key LIKE '%instagram.com' AND name = 'sessionid'
        `);
        const rows = stmt.all();
        console.log('🔍 Session check: Query returned', rows.length, 'rows');
        if (rows.length > 0) {
          console.log('🔍 Session check: Cookie data:', JSON.stringify(rows[0], (key, value) =>
            key === 'encrypted_value' ? `[Buffer ${value?.length || 0} bytes]` : value
          ));
        }
        db.close();

        // Clean up temp file
        try { fs.unlinkSync(tempDbPath); } catch {}

        if (rows.length > 0) {
          const cookie = rows[0];
          // Check if cookie has expired (expires_utc is in microseconds since 1601-01-01)
          // A value of 0 means session cookie (expires when browser closes)
          if (cookie.expires_utc > 0) {
            // Convert Chromium timestamp to JS timestamp
            // Chromium epoch is 1601-01-01, JS epoch is 1970-01-01
            const chromiumEpochDiff = 11644473600000000; // microseconds
            const expiresMs = (cookie.expires_utc - chromiumEpochDiff) / 1000;
            console.log('🔍 Session check: expires_utc =', cookie.expires_utc, '-> expiresMs =', expiresMs, '-> Date.now() =', Date.now());
            if (Date.now() > expiresMs) {
              console.log('❌ Session check: sessionid cookie EXPIRED');
              return { isActive: false, reason: 'session_expired' };
            }
          }

          // Cookie exists and is not expired - check if it has a value
          // Note: Modern Chrome encrypts cookie values, so encrypted_value may have data
          // even if value is empty. The presence of the row is what matters.
          console.log('✅ Session check: sessionid cookie FOUND (valid)');
          return { isActive: true, reason: 'sessionid_cookie_valid' };
        } else {
          console.log('❌ Session check: No sessionid cookie found');
          return { isActive: false, reason: 'no_sessionid_cookie' };
        }
      } catch (dbErr) {
        console.error('⚠️ Failed to read cookies database:', dbErr);
        return { isActive: false, reason: 'db_read_error' };
      }
    } catch (e) {
      console.error('❌ Error checking Instagram session:', e);
      return { isActive: false, reason: 'error' };
    }
  });
}

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    // If window exists but is hidden, show it
    mainWindow?.show();
  }
});
