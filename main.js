'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, protocol, net, screen,
  clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { createUpdater } = require('./updater');
const fsp = fs.promises;

const IS_DEV = process.argv.includes('--dev');
const START_HIDDEN = process.argv.includes('--tray');

// PDF.js is ESM from v4 onward, and ES modules cannot be loaded over file://
// (opaque origin). Serving the renderer from a privileged custom scheme gives
// it a real origin, so modules, module workers and fetch all behave.
const APP_SCHEME = 'app';
const APP_ORIGIN = APP_SCHEME + '://redline';

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let mainWindow = null;
let tray = null;
let updater = null;

/* Close guard. The renderer owns the "are all tabs safe to close" decision, so
   the first `close` is bounced back to it (see the handler in createWindow). */
let closeApproved = false;
let closeAsking = false;
let closeAskTimer = null;
const CLOSE_GUARD_MS = 8000;
let settings = null;
let quitting = false;
/** Path handed to us before the renderer was ready. */
let pendingOpenPath = null;

// Print jobs live in memory only, keyed by a random token, and are served to
// the preview window over app://. Nothing hits the disk, so there is no temp
// file to leak or clean up if the app dies mid-preview.
const printJobs = new Map();   // token -> {bytes: Buffer, name: string}
const PRINT_ROUTE = '__print/';
let printWindow = null;

// ---------------------------------------------------------------------------
// Settings / recents store  (plain JSON in userData)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  // Appearance is four independent axes — see src/js/appearance.js, which owns
  // the catalog of valid values and normalises anything it does not recognise.
  theme: 'dark',               // dark | light | paper | blueprint | contrast
  accent: 'redline',           // the one colour every tint in the UI derives from
  density: 'normal',           // compact | normal | large — chrome metrics only
  paperMode: 'normal',         // normal | invert | grey | soft | contrast

  saveMode: 'copy',            // 'copy' | 'overwrite' | 'ask'
  backupOnOverwrite: true,
  autosave: true,
  autosaveIntervalMs: 60000,
  stayResident: false,         // keep running in tray for instant open
  defaultAuthor: '',
  lastTool: 'select',
  toolDefaults: {},
  restoreView: true,           // reopen a drawing at the page and zoom you left
  // Superseded by `paperMode` in 0.13 and kept only so a settings file written
  // by an older build still carries its answer across the upgrade;
  // `RP.appearance.paperModeOf` folds it in. Nothing writes it any more.
  nightMode: false,
  autoUpdate: true,            // the app's only network call — see updater.js
  skipVersion: null,           // a release the user asked not to be told about

  recents: [],                 // [{path, name, page, zoom, openedAt, pinned}]
  window: { x: null, y: null, width: 1440, height: 920, maximized: false },
  compare: { tolerance: 2, autoAlign: true, inkThreshold: 200 }
};

const MIN_WIN_WIDTH = 940;
const MIN_WIN_HEIGHT = 600;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const stored = JSON.parse(raw);
    settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    settings.compare = Object.assign({}, DEFAULT_SETTINGS.compare, settings.compare || {});
    settings.window = Object.assign({}, DEFAULT_SETTINGS.window, settings.window || {});
    // Night mode became one of five paper modes in 0.13. The migration has to
    // happen here, against the *stored* object: by the time the defaults have
    // been merged in, `paperMode` is present whether the user ever set it or
    // not, and the old answer would be read as an explicit "no filter" —
    // which is a setting silently reverting on upgrade, and gets reported as
    // the app forgetting rather than as a migration that was missed.
    if (stored.paperMode === undefined && stored.nightMode) settings.paperMode = 'invert';
  } catch (err) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
  if (!Array.isArray(settings.recents)) settings.recents = [];
  return settings;
}

let saveSettingsTimer = null;
function writeSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist settings:', err);
  }
}

function saveSettings() {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(writeSettings, 150);
}

/** Write now. Anything recorded while the app is closing has no later chance. */
function flushSettings() {
  if (saveSettingsTimer) { clearTimeout(saveSettingsTimer); saveSettingsTimer = null; }
  writeSettings();
}

const RECENTS_MAX = 20;

/**
 * Trim the list to `RECENTS_MAX` *unpinned* entries. A pin is the user saying
 * "keep this one", so pinned drawings are never aged out — otherwise opening
 * twenty other sheets would silently drop the baseline someone pinned last
 * month, which is exactly the entry a pin exists to protect.
 */
function trimRecents(list) {
  let kept = 0;
  return list.filter((entry) => {
    if (entry.pinned) return true;
    kept += 1;
    return kept <= RECENTS_MAX;
  });
}

/**
 * The list as it should be *shown*: pinned drawings first, then most-recent.
 *
 * Storage stays in plain most-recently-used order, because that is what the
 * ageing in `trimRecents` reads. This is a view over it, and it is what every
 * consumer — tray submenu, toolbar dropdown, empty state — is handed.
 */
function sortedRecents() {
  return settings.recents.slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.openedAt || 0) - (a.openedAt || 0);
  });
}

function rememberRecent(entry) {
  if (!entry || !entry.path) return;
  // Carry the remembered view across, or reopening a drawing would forget the
  // page and zoom it is being reopened *at*. `pinned` rides along for the same
  // reason: reopening a pinned drawing must not unpin it.
  const previous = settings.recents.find((r) => r.path === entry.path) || {};
  const list = settings.recents.filter((r) => r.path !== entry.path);
  list.unshift(Object.assign(
    { page: previous.page, zoom: previous.zoom, pinned: !!previous.pinned },
    { name: path.basename(entry.path), openedAt: Date.now() },
    entry
  ));
  settings.recents = trimRecents(list);
  saveSettings();
  refreshTrayMenu();
}

/**
 * Update where in a drawing the user is, without touching the list order or
 * `openedAt` — this fires on every scroll and zoom, and shuffling the recents
 * list underneath the user each time would be maddening.
 */
function rememberRecentView(entry) {
  if (!entry || !entry.path) return;
  const found = settings.recents.find((r) => r.path === entry.path);
  if (!found) return;
  if (Number.isFinite(entry.page)) found.page = entry.page;
  if (Number.isFinite(entry.zoom)) found.zoom = entry.zoom;
  saveSettings();
}

// ---------------------------------------------------------------------------
// Autosave / crash recovery scratch area
// ---------------------------------------------------------------------------

function recoveryDir() {
  return path.join(app.getPath('userData'), 'recovery');
}

// ---------------------------------------------------------------------------
// Log file — the renderer streams its console into this, so problems can be
// reported without anyone having to open DevTools.
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 1024 * 1024;

function logPath() {
  return path.join(app.getPath('userData'), 'redline-pdf.log');
}

function appendLog(text) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
    } catch (err) { /* no log yet */ }
    fs.appendFileSync(file, text, 'utf8');
  } catch (err) {
    console.error('Could not write the log file:', err);
  }
}

function logMain(level, message) {
  const line = `[${new Date().toISOString()}] MAIN ${level.toUpperCase()} ${message}\n`;
  appendLog(line);
  if (level === 'error') console.error(message);
}

process.on('uncaughtException', (err) => {
  logMain('error', 'uncaughtException: ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (reason) => {
  logMain('error', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason));
});

function recoveryKey(docPath) {
  return Buffer.from(String(docPath)).toString('base64').replace(/[/+=]/g, '_') + '.json';
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Turn the saved bounds into something that is actually on a screen that
 * exists. A window remembered on a monitor that has since been unplugged would
 * otherwise open at coordinates nothing can reach, so the size and position are
 * both clamped into the work area of whichever display it lands nearest.
 */
function startupBounds() {
  const saved = Object.assign({}, DEFAULT_SETTINGS.window, settings.window || {});
  const width = Math.max(MIN_WIN_WIDTH, Math.round(saved.width) || DEFAULT_SETTINGS.window.width);
  const height = Math.max(MIN_WIN_HEIGHT, Math.round(saved.height) || DEFAULT_SETTINGS.window.height);

  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { width, height };

  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width, height }).workArea;
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return {
    width: w,
    height: h,
    x: Math.round(Math.min(Math.max(saved.x, area.x), area.x + area.width - w)),
    y: Math.round(Math.min(Math.max(saved.y, area.y), area.y + area.height - h))
  };
}

/**
 * `getNormalBounds` rather than `getBounds`: a maximized or minimized window
 * must still record the size to restore *to*, not the size it currently fills.
 */
function rememberWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  if (!bounds || !bounds.width || !bounds.height) return;
  settings.window = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized()
  };
  saveSettings();
}

function createWindow() {
  const startMaximized = !!(settings.window && settings.window.maximized);
  mainWindow = new BrowserWindow(Object.assign(startupBounds(), {
    minWidth: MIN_WIN_WIDTH,
    minHeight: MIN_WIN_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#14161a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  }));

  if (startMaximized) mainWindow.maximize();

  loadRenderer();

  mainWindow.webContents.on('did-fail-load', (event, code, description, url) => {
    logMain('error', `did-fail-load ${code} ${description} ${url}`);
    // If the custom scheme failed for any reason, fall back to file:// so the
    // user still gets a window (PDF.js will then report the module problem).
    if (url && url.startsWith(APP_ORIGIN)) {
      logMain('warn', 'falling back to file:// renderer');
      mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logMain('error', 'render-process-gone: ' + JSON.stringify(details));
  });

  // Electron changed this signature: older builds emit
  // (event, level, message, line, sourceId), newer ones (event, details).
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args[1];
    let level;
    let message;
    let line;
    let source;
    if (details && typeof details === 'object' && 'message' in details) {
      ({ level, message, lineNumber: line, sourceId: source } = details);
    } else {
      [, level, message, line, source] = args;
    }
    const isError = level === 'error' || level === 3 || level === 2;
    if (isError) logMain('error', `renderer console: ${message} (${source}:${line})`);
  });

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('maximize', () => {
    send('window:state', { maximized: true });
    rememberWindowBounds();
  });
  mainWindow.on('unmaximize', () => {
    send('window:state', { maximized: false });
    rememberWindowBounds();
  });

  /* Fullscreen can also be left by the OS — the title-bar gesture, a second
     display being unplugged, Windows' own accelerator. The renderer is the
     half of presentation mode that hid the toolbars, so it has to be told, or
     the app comes back windowed with no way to reach anything. */
  mainWindow.on('leave-full-screen', () => send('window:state', { fullScreen: false }));
  mainWindow.on('enter-full-screen', () => send('window:state', { fullScreen: true }));

  // Resize and move fire continuously; `saveSettings` is already debounced, so
  // the disk only sees the position the drag came to rest at.
  mainWindow.on('resize', rememberWindowBounds);
  mainWindow.on('move', rememberWindowBounds);

  mainWindow.on('close', (event) => {
    // Written synchronously: hiding to tray or quitting both end here, and a
    // debounced write would lose the last move.
    rememberWindowBounds();
    flushSettings();

    /* Several drawings can be open at once now, so whether it is safe to close
       is a question only the renderer can answer — and `close` cannot be
       awaited. The first attempt is therefore refused and handed over; the
       renderer walks its tabs and comes back through `window:close` with
       `force`. A renderer that never answers must not be able to trap the
       window, hence the timeout. */
    if (!closeApproved && mainWindow && !mainWindow.webContents.isDestroyed()) {
      event.preventDefault();
      if (closeAsking) return;
      closeAsking = true;
      send('app:close-request');
      closeAskTimer = setTimeout(() => {
        logMain('warn', 'renderer did not answer the close guard; closing anyway');
        closeApproved = true;
        closeAsking = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, CLOSE_GUARD_MS);
      return;
    }

    // A preview outliving its document is just a stale sheet of paper on
    // screen, and it would also keep `window-all-closed` from firing.
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    if (!quitting && settings.stayResident) {
      event.preventDefault();
      // Hiding to tray keeps the documents open, so the next close has to ask
      // again rather than sail through on a stale approval.
      closeApproved = false;
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never let the page navigate away from the app shell, and never open a URL
  // from here either: the only legitimate source of one is a link annotation
  // in an untrusted PDF, and that route goes through `shell:open-external`,
  // which shows the user the resolved href first. Anything arriving here has
  // side-stepped that, so it is refused and logged rather than followed.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logMain('warn', 'blocked window.open from the renderer: ' + url);
    return { action: 'deny' };
  });
}

function loadRenderer() {
  if (!mainWindow) return;
  mainWindow.loadURL(APP_ORIGIN + '/src/index.html').catch((err) => {
    logMain('error', 'loadURL failed, falling back to file://: ' + err.message);
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  });
}

/**
 * MIME types matter here: a module script served as octet-stream is rejected
 * by Chromium, which is exactly the failure mode we are trying to design out.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm'
};

/** Serve the app directory over the privileged app:// scheme. */
function registerAppProtocol() {
  try {
    protocol.handle(APP_SCHEME, async (request) => {
      let rel;
      let target;
      try {
        const url = new URL(request.url);
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        target = path.resolve(__dirname, rel);
      } catch (err) {
        return new Response('Bad request', { status: 400 });
      }

      // Print jobs are served from memory, before any path resolution, so a
      // token can never be coaxed into reading a file off disk.
      if (rel.startsWith(PRINT_ROUTE)) {
        const token = rel.slice(PRINT_ROUTE.length).replace(/\.pdf$/i, '');
        const job = printJobs.get(token);
        if (!job) return new Response('Print job expired', { status: 404 });
        return new Response(job.bytes, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'inline; filename="' + job.name.replace(/["\\]/g, '') + '"',
            'cache-control': 'no-store'
          }
        });
      }

      // Never serve anything outside the installed app directory.
      const root = path.resolve(__dirname);
      if (target !== root && !target.startsWith(root + path.sep)) {
        logMain('warn', 'blocked out-of-tree request: ' + request.url);
        return new Response('Forbidden', { status: 403 });
      }

      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      try {
        const data = await fsp.readFile(target);
        return new Response(data, {
          status: 200,
          headers: { 'content-type': type, 'cache-control': 'no-cache' }
        });
      } catch (err) {
        logMain('error', `app:// miss ${request.url} -> ${target} (${err.code || err.message})`);
        try {
          // Last resort: let Electron try, in case we are inside an asar.
          return await net.fetch(pathToFileURL(target).toString());
        } catch (inner) {
          return new Response('Not found: ' + target, { status: 404 });
        }
      }
    });
    logMain('info', 'app:// protocol registered for ' + __dirname);
    return true;
  } catch (err) {
    logMain('error', 'protocol.handle failed: ' + (err && err.stack ? err.stack : err));
    return false;
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * Hand the OS print dialog a webContents whose *top-level document is the PDF*.
 * That is the only way Chromium prints the vector content rather than a raster
 * of a page that happens to contain a PDF, which is why the preview window
 * loads the bytes directly instead of wrapping them in an <embed>.
 */
function printPreviewWindow(win) {
  if (!win || win.isDestroyed()) return Promise.resolve({ printed: false, reason: 'preview closed' });
  return new Promise((resolve) => {
    try {
      win.webContents.print({ silent: false, printBackground: true }, (printed, reason) => {
        if (!printed && reason && reason !== 'cancelled') logMain('warn', 'print failed: ' + reason);
        resolve({ printed: !!printed, reason: reason || null });
      });
    } catch (err) {
      logMain('error', 'print threw: ' + (err && err.stack ? err.stack : err));
      resolve({ printed: false, reason: String(err && err.message ? err.message : err) });
    }
  });
}

function printMenuFor(win) {
  return Menu.buildFromTemplate([
    {
      label: '&Print',
      submenu: [
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => printPreviewWindow(win) },
        { type: 'separator' },
        { label: 'Close preview', accelerator: 'CmdOrCtrl+W', click: () => { if (!win.isDestroyed()) win.close(); } }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]);
}

function openPrintPreview(bytes, name, options) {
  const opts = options || {};
  const token = crypto.randomBytes(16).toString('hex');
  printJobs.set(token, { bytes: Buffer.from(bytes), name: name || 'document.pdf' });

  // Only ever one preview at a time; a second print replaces the first.
  if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();

  printWindow = new BrowserWindow({
    width: 960,
    height: 940,
    minWidth: 520,
    minHeight: 420,
    show: false,
    parent: mainWindow || undefined,
    backgroundColor: '#14161a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'Print preview — ' + (name || 'document.pdf'),
    webPreferences: {
      // The Chromium PDF viewer is what renders the preview and carries the
      // print button. No preload here: this window has no app code in it, and
      // no Node reaches it. `javascript` stays on — the viewer is itself a
      // scripted internal page and turning it off leaves a blank window.
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  printWindow.setMenu(printMenuFor(printWindow));

  // A preview shows one document and goes nowhere else.
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_ORIGIN + '/' + PRINT_ROUTE + token + '.pdf') event.preventDefault();
  });

  const clear = () => {
    printJobs.delete(token);
    if (printWindow && printWindow.isDestroyed()) printWindow = null;
  };
  printWindow.on('closed', () => { printJobs.delete(token); printWindow = null; });
  printWindow.webContents.on('render-process-gone', (event, details) => {
    logMain('error', 'print preview process gone: ' + JSON.stringify(details));
    clear();
  });

  // The PDF viewer rewrites document.title to the filename; put ours back.
  const retitle = () => {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.setTitle('Print preview — ' + (name || 'document.pdf') +
        '   ·   Ctrl+P to print, Esc to close');
    }
  };
  printWindow.on('page-title-updated', (event) => { event.preventDefault(); retitle(); });

  // Escape closes, which users expect from a preview and the plugin will not do.
  printWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    }
  });

  printWindow.once('ready-to-show', () => {
    retitle();
    printWindow.show();
    printWindow.focus();
    // Jumping straight to the OS dialog is what people expect from Ctrl+P;
    // the preview stays behind it so they can check before committing.
    if (opts.autoDialog !== false) {
      setTimeout(() => printPreviewWindow(printWindow), 250);
    }
  });

  printWindow.loadURL(APP_ORIGIN + '/' + PRINT_ROUTE + token + '.pdf');
  return { token };
}

/**
 * Recents, pinned first, as a tray submenu. The point of staying resident is
 * opening a drawing fast, and the fastest route is the one that skips the file
 * dialog entirely.
 */
function trayRecentsSubmenu() {
  const list = sortedRecents().slice(0, 10);
  if (!list.length) return [{ label: 'No recent drawings', enabled: false }];
  return list.map((entry) => ({
    label: (entry.pinned ? '📌  ' : '') + (entry.name || path.basename(entry.path)),
    toolTip: entry.path,
    // Same route a double-clicked .pdf takes: it raises the window, and it
    // covers the case where the tray outlived the window and the renderer is
    // not listening yet.
    click: () => deliverOpenPath(entry.path)
  }));
}

function trayMenuTemplate() {
  return [
    { label: 'Open Redline PDF', click: showWindow },
    { label: 'Open Recent', submenu: trayRecentsSubmenu() },
    { type: 'separator' },
    {
      label: 'Check for updates…',
      click: () => { if (updater) updater.check({ manual: true }); }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ];
}

/** No-op until the tray exists, so every recents mutation can just call it. */
function refreshTrayMenu() {
  if (!tray) return;
  try { tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate())); } catch (err) { /* ignore */ }
}

function setupTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('Redline PDF');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.on('double-click', showWindow);
}

// ---------------------------------------------------------------------------
// File-association plumbing
// ---------------------------------------------------------------------------

function pdfFromArgv(argv) {
  const candidates = (argv || []).slice(1).filter((a) => !a.startsWith('--') && /\.pdf$/i.test(a));
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch (err) { /* ignore */ }
  }
  return null;
}

function deliverOpenPath(filePath) {
  if (!filePath) return;
  pendingOpenPath = filePath;
  showWindow();
  send('app:open-file', filePath);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    showWindow();
    const filePath = pdfFromArgv(argv);
    if (filePath) deliverOpenPath(filePath);
  });

  // macOS / dock open
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    deliverOpenPath(filePath);
  });

  app.whenReady().then(() => {
    loadSettings();
    fs.mkdirSync(recoveryDir(), { recursive: true });
    logMain('info', `starting Redline PDF ${app.getVersion()} — Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
    registerAppProtocol();
    createWindow();
    if (settings.stayResident) setupTray();
    pendingOpenPath = pdfFromArgv(process.argv);

    // Its own stage, like every other thing that can throw at startup: a
    // missing electron-updater must cost the update check and nothing else.
    try {
      updater = createUpdater({
        logMain,
        getWindow: () => mainWindow,
        getSettings: () => settings,
        patchSettings: (patch) => { settings = Object.assign(settings, patch || {}); saveSettings(); },
        // The same route the tray's Quit takes, so the renderer's unsaved-tab
        // guard still runs and a cancel still cancels.
        requestQuit: () => { quitting = true; app.quit(); }
      });
      updater.scheduleLaunchCheck();
    } catch (err) {
      logMain('error', 'updater setup failed: ' + (err && err.stack ? err.stack : err));
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    rememberWindowBounds();
    flushSettings();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !settings?.stayResident) app.quit();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }

/** Settings as the renderer wants them: recents already in display order. */
function settingsForRenderer() {
  return Object.assign({}, settings, { recents: sortedRecents() });
}

ipcMain.handle('app:ready-info', async () => {
  const startupFile = pendingOpenPath;
  pendingOpenPath = null;
  return ok({
    // Recents go out in display order so no consumer has to re-sort them; the
    // entries are the same objects, so in-place view updates still land.
    settings: settingsForRenderer(),
    startupFile,
    version: app.getVersion(),
    platform: process.platform,
    // The renderer draws its own titlebar buttons, and a window restored
    // maximized was already maximized before anyone was listening for
    // `window:state`, so the initial state has to be reported here.
    maximized: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
    userName: process.env.USERNAME || process.env.USER || ''
  });
});

ipcMain.handle('settings:patch', async (event, patch) => {
  try {
    settings = Object.assign(settings, patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'stayResident')) {
      if (patch.stayResident) setupTray();
      else if (tray) { tray.destroy(); tray = null; }
    }
    saveSettings();
    return ok(settingsForRenderer());
  } catch (err) { return fail(err); }
});

ipcMain.handle('settings:get', async () => ok(settingsForRenderer()));

ipcMain.handle('recents:add', async (event, entry) => {
  try { rememberRecent(entry); return ok(sortedRecents()); } catch (err) { return fail(err); }
});

ipcMain.handle('recents:remember-view', async (event, entry) => {
  try { rememberRecentView(entry); return ok(true); } catch (err) { return fail(err); }
});

/** Pin or unpin one entry. Pinned entries are exempt from the ageing cap. */
ipcMain.handle('recents:pin', async (event, payload) => {
  try {
    const found = settings.recents.find((r) => r.path === (payload && payload.path));
    if (!found) return ok(sortedRecents());
    found.pinned = !!(payload && payload.pinned);
    // Unpinning re-exposes the entry to the cap, so re-trim rather than let an
    // over-long list survive until the next open.
    if (!found.pinned) settings.recents = trimRecents(settings.recents);
    saveSettings();
    refreshTrayMenu();
    return ok(sortedRecents());
  } catch (err) { return fail(err); }
});

/** Drop one entry. This is a list the user curates, not a log. */
ipcMain.handle('recents:remove', async (event, filePath) => {
  try {
    settings.recents = settings.recents.filter((r) => r.path !== filePath);
    saveSettings();
    refreshTrayMenu();
    return ok(sortedRecents());
  } catch (err) { return fail(err); }
});

ipcMain.handle('recents:clear', async () => {
  settings.recents = [];
  saveSettings();
  refreshTrayMenu();
  return ok([]);
});

ipcMain.handle('dialog:open-pdf', async (event, opts) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePaths.length) return ok(null);
    const filePath = result.filePaths[0];
    const buffer = await fsp.readFile(filePath);
    return ok({ path: filePath, name: path.basename(filePath), bytes: buffer });
  } catch (err) { return fail(err); }
});

ipcMain.handle('file:read', async (event, filePath) => {
  try {
    const buffer = await fsp.readFile(filePath);
    return ok({ path: filePath, name: path.basename(filePath), bytes: buffer });
  } catch (err) { return fail(err); }
});

ipcMain.handle('file:exists', async (event, filePath) => {
  try { return ok(fs.existsSync(filePath)); } catch (err) { return fail(err); }
});

ipcMain.handle('dialog:save-as', async (event, opts) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: (opts && opts.title) || 'Save As',
      defaultPath: opts && opts.defaultPath,
      filters: (opts && opts.filters) || [{ name: 'PDF Documents', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return ok(null);
    return ok(result.filePath);
  } catch (err) { return fail(err); }
});

/** A destination folder. Splitting a drawing writes several files into one. */
ipcMain.handle('dialog:choose-folder', async (event, opts) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || 'Choose a folder',
      defaultPath: (opts && opts.defaultPath) || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return ok(null);
    return ok(result.filePaths[0]);
  } catch (err) { return fail(err); }
});

/**
 * Write bytes to disk. When `backup` is set and the target already exists, an
 * untouched copy is preserved once as <name>.bak.pdf before the first overwrite.
 */
ipcMain.handle('file:write', async (event, payload) => {
  try {
    const { filePath, bytes, backup } = payload;
    if (backup && fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const backupPath = filePath.slice(0, filePath.length - ext.length) + '.bak' + ext;
      if (!fs.existsSync(backupPath)) await fsp.copyFile(filePath, backupPath);
    }
    // Write to a sibling temp file then rename, so a crash mid-write cannot
    // truncate the user's drawing.
    const tempPath = filePath + '.tmp-' + Date.now();
    await fsp.writeFile(tempPath, Buffer.from(bytes));
    await fsp.rename(tempPath, filePath);
    return ok({ filePath });
  } catch (err) { return fail(err); }
});

ipcMain.handle('file:write-text', async (event, payload) => {
  try {
    await fsp.writeFile(payload.filePath, payload.text, 'utf8');
    return ok({ filePath: payload.filePath });
  } catch (err) { return fail(err); }
});

ipcMain.handle('shell:show-item', async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return ok(true);
});

/**
 * Follow a link annotation that points out of the document.
 *
 * A PDF is untrusted input, so this is deliberately narrow: the renderer never
 * navigates, the scheme is allow-listed, and the user sees the *resolved* href
 * — not the link text, which a hostile file controls — before anything opens.
 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

ipcMain.handle('shell:open-external', async (event, rawUrl) => {
  try {
    let url;
    try { url = new URL(String(rawUrl)); } catch (err) { return fail('Not a usable link: ' + rawUrl); }
    if (!EXTERNAL_SCHEMES.has(url.protocol.toLowerCase())) {
      logMain('warn', 'blocked link scheme ' + url.protocol + ' from a PDF');
      return fail('Links of type "' + url.protocol.replace(':', '') + '" are not opened.');
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Open link', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Open external link',
      message: 'This link is inside the PDF and opens outside Redline PDF.',
      detail: url.href
    });
    if (response !== 0) return ok({ opened: false });
    await shell.openExternal(url.href);
    return ok({ opened: true });
  } catch (err) { return fail(err); }
});

/**
 * Copy text out of a drawing.
 *
 * This goes through main rather than `navigator.clipboard` because the renderer
 * copy path needs no user-activation gesture here — Ctrl+C and a context-menu
 * item both land on it — and because `document.execCommand('copy')` cannot see
 * a selection that has already been collapsed by a tool.
 */
ipcMain.handle('clipboard:write-text', async (event, text) => {
  try {
    clipboard.writeText(String(text === null || text === undefined ? '' : text));
    return ok(true);
  } catch (err) { return fail(err); }
});

/**
 * Copy a region of a drawing as a picture.
 *
 * The renderer hands over PNG bytes rather than a data URL: a detail off an
 * E-size sheet runs to several megabytes, and base64 would inflate that by a
 * third to cross the bridge as a string. `nativeImage` is what puts a real
 * bitmap on the Windows clipboard — writing a data URL as *text* is what a
 * naive version of this does, and it pastes into an email as gibberish.
 */
ipcMain.handle('clipboard:write-image', async (event, bytes) => {
  try {
    const buffer = Buffer.from(bytes);
    if (!buffer.length) return fail(new Error('No image data'));
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return fail(new Error('That region could not be turned into an image'));
    clipboard.writeImage(image);
    return ok(true);
  } catch (err) { return fail(err); }
});

/* A check the user asked for. Everything it has to say it says in a native
   dialog from updater.js, so the renderer only needs the outcome for a toast. */
ipcMain.handle('update:check', async () => {
  try {
    if (!updater) return ok({ status: 'unavailable', reason: 'The updater did not load.' });
    return ok(await updater.check({ manual: true }));
  } catch (err) { return fail(err); }
});

ipcMain.handle('dialog:message', async (event, opts) => {
  const result = await dialog.showMessageBox(mainWindow, Object.assign({
    type: 'question',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0
  }, opts || {}));
  return ok(result);
});

// --- autosave / recovery ---------------------------------------------------

ipcMain.handle('recovery:write', async (event, payload) => {
  try {
    const file = path.join(recoveryDir(), recoveryKey(payload.docPath));
    /* The page order rides along with the markups because a drawing whose only
       unsaved change is a reordered or merged page set is still unsaved work.
       It is written only when the renderer says it can be rebuilt from the file
       alone — see `RP.pages.recoverableOrder`; the bytes of a merged-in source
       are deliberately never persisted here. */
    await fsp.writeFile(file, JSON.stringify({
      docPath: payload.docPath,
      savedAt: Date.now(),
      annotations: payload.annotations || [],
      pageOrder: payload.pageOrder || null,
      scale: payload.scale || null,
      numbering: payload.numbering || null
    }), 'utf8');
    return ok(true);
  } catch (err) { return fail(err); }
});

ipcMain.handle('recovery:read', async (event, docPath) => {
  try {
    const file = path.join(recoveryDir(), recoveryKey(docPath));
    if (!fs.existsSync(file)) return ok(null);
    return ok(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch (err) { return fail(err); }
});

ipcMain.handle('recovery:clear', async (event, docPath) => {
  try {
    const file = path.join(recoveryDir(), recoveryKey(docPath));
    if (fs.existsSync(file)) await fsp.unlink(file);
    return ok(true);
  } catch (err) { return fail(err); }
});

// --- logging / diagnostics -------------------------------------------------

ipcMain.handle('log:append', async (event, text) => {
  appendLog(String(text || ''));
  return ok(true);
});

ipcMain.handle('log:path', async () => ok(logPath()));

ipcMain.handle('log:read', async () => {
  try {
    if (!fs.existsSync(logPath())) return ok('');
    const text = await fsp.readFile(logPath(), 'utf8');
    return ok(text.slice(-200000));
  } catch (err) { return fail(err); }
});

ipcMain.handle('log:reveal', async () => {
  try {
    const file = logPath();
    if (!fs.existsSync(file)) appendLog('(log created on demand)\n');
    shell.showItemInFolder(file);
    return ok(true);
  } catch (err) { return fail(err); }
});

ipcMain.handle('diag:info', async () => {
  const nodeModules = path.join(__dirname, 'node_modules');
  const readVersion = (pkg) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(nodeModules, pkg, 'package.json'), 'utf8')).version;
    } catch (err) {
      return 'NOT INSTALLED (' + err.code + ')';
    }
  };
  const exists = (rel) => (fs.existsSync(path.join(nodeModules, rel)) ? 'present' : 'missing');

  /* Canvas rasterisation is the app's hot path, so whether Chromium accepted
     this machine's GPU is a first-class diagnostic. A blocklisted driver drops
     2d canvas onto software rendering, and the same drawing that is fine on one
     PC then crawls on another with no other visible difference. */
  let gpu = {};
  try {
    const status = app.getGPUFeatureStatus() || {};
    gpu = {
      canvas: status.gpu_compositing || 'unknown',
      '2d canvas': status['2d_canvas'] || status.canvas_oop_rasterization || 'unknown',
      rasterization: status.rasterization || 'unknown',
      webgl: status.webgl || 'unknown'
    };
  } catch (err) {
    gpu = { error: err.message };
  }

  return ok({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    appPath: __dirname,
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    logFile: logPath(),
    gpu,
    installed: {
      'pdfjs-dist': readVersion('pdfjs-dist'),
      'pdf-lib': readVersion('pdf-lib')
    },
    files: {
      'pdfjs build/pdf.mjs': exists('pdfjs-dist/build/pdf.mjs'),
      'pdfjs build/pdf.js': exists('pdfjs-dist/build/pdf.js'),
      'pdfjs build/pdf.worker.mjs': exists('pdfjs-dist/build/pdf.worker.mjs'),
      'pdf-lib dist/pdf-lib.min.js': exists('pdf-lib/dist/pdf-lib.min.js')
    },
    settings: { saveMode: settings.saveMode, theme: settings.theme, stayResident: settings.stayResident }
  });
});

// --- printing --------------------------------------------------------------

/**
 * Open the print preview for a set of already-stamped PDF bytes. The renderer
 * decides what to print (range, markups, scale) and hands us finished bytes;
 * main only ever moves them to a window and calls the OS dialog.
 */
ipcMain.handle('print:document', async (event, payload) => {
  try {
    const { bytes, name, autoDialog } = payload || {};
    if (!bytes || !bytes.length) throw new Error('Nothing to print');
    const job = openPrintPreview(bytes, name || 'document.pdf', { autoDialog });
    return ok({ token: job.token });
  } catch (err) {
    logMain('error', 'print:document failed: ' + (err && err.stack ? err.stack : err));
    return fail(err);
  }
});

/** Re-open the OS dialog for the preview that is already on screen. */
ipcMain.handle('print:dialog', async () => {
  try {
    if (!printWindow || printWindow.isDestroyed()) throw new Error('No print preview is open');
    return ok(await printPreviewWindow(printWindow));
  } catch (err) { return fail(err); }
});

ipcMain.handle('print:close', async () => {
  try {
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    return ok(true);
  } catch (err) { return fail(err); }
});

// --- window chrome ---------------------------------------------------------

ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); return ok(true); });
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return ok(false);
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return ok(mainWindow.isMaximized());
});
/**
 * `force` is set by the renderer once its close guard has cleared every tab.
 * Without it the `close` handler below bounces straight back to the renderer
 * and the window would never actually go.
 */
ipcMain.handle('window:close', (event, opts) => {
  if (opts && opts.force) closeApproved = true;
  mainWindow?.close();
  return ok(true);
});

/**
 * The renderer decided not to close after all. `quitting` is cleared too: the
 * request may have come from the tray's Quit, and refusing the only window's
 * close cancels the quit — leaving the flag set would let the *next* close slip
 * past the guard.
 */
ipcMain.handle('window:cancel-close', () => {
  closeAsking = false;
  quitting = false;
  if (closeAskTimer) { clearTimeout(closeAskTimer); closeAskTimer = null; }
  return ok(true);
});
ipcMain.handle('window:is-maximized', () => ok(!!mainWindow?.isMaximized()));
/**
 * Presentation mode. The renderer owns the decision — it is the half that
 * hides the toolbars — so this only moves the window and reports back what it
 * actually managed, which is not always what was asked for on a display that
 * refuses fullscreen.
 */
ipcMain.handle('window:set-fullscreen', (event, on) => {
  if (!mainWindow) return ok(false);
  mainWindow.setFullScreen(!!on);
  return ok(mainWindow.isFullScreen());
});
ipcMain.handle('window:set-title', (event, title) => {
  mainWindow?.setTitle(title || 'Redline PDF');
  return ok(true);
});
