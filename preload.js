'use strict';

const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;

// File.path was removed from the renderer in Electron 32; webUtils is the
// supported way to turn a dropped File into a real path.
const webUtils = electron.webUtils || null;

/** Unwrap the {ok, data, error} envelope used by every handler in main.js. */
async function call(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || ('IPC call failed: ' + channel));
  }
  return result.data;
}

contextBridge.exposeInMainWorld('rp', {
  readyInfo: () => call('app:ready-info'),

  settings: {
    get: () => call('settings:get'),
    patch: (patch) => call('settings:patch', patch)
  },

  recents: {
    add: (entry) => call('recents:add', entry),
    /** Record page/zoom for a drawing already in the list, in place. */
    rememberView: (entry) => call('recents:remember-view', entry),
    /** Pin keeps an entry out of the ageing cap; both return the new list. */
    pin: (filePath, pinned) => call('recents:pin', { path: filePath, pinned: !!pinned }),
    remove: (filePath) => call('recents:remove', filePath),
    clear: () => call('recents:clear')
  },

  clipboard: {
    writeText: (text) => call('clipboard:write-text', text),
    writeImage: (bytes) => call('clipboard:write-image', bytes)
  },

  updates: {
    /** Check now. Prompts happen in the main process; this returns the outcome. */
    check: () => call('update:check')
  },

  files: {
    openDialog: (opts) => call('dialog:open-pdf', opts),
    read: (filePath) => call('file:read', filePath),
    exists: (filePath) => call('file:exists', filePath),
    saveAsDialog: (opts) => call('dialog:save-as', opts),
    /** A destination folder — a split writes several files into one place. */
    chooseFolder: (opts) => call('dialog:choose-folder', opts),
    write: (filePath, bytes, backup) => call('file:write', { filePath, bytes, backup: !!backup }),
    writeText: (filePath, text) => call('file:write-text', { filePath, text }),
    reveal: (filePath) => call('shell:show-item', filePath)
  },

  recovery: {
    /** `extra` carries the rest of the session state: page order, scale, numbering. */
    write: (docPath, annotations, extra) => call('recovery:write',
      Object.assign({ docPath, annotations }, extra || {})),
    read: (docPath) => call('recovery:read', docPath),
    clear: (docPath) => call('recovery:clear', docPath)
  },

  dialog: {
    message: (opts) => call('dialog:message', opts)
  },

  links: {
    /** Open a link annotation's URL in the OS browser, after a confirm dialog. */
    openExternal: (url) => call('shell:open-external', url)
  },

  print: {
    /** Open the print preview for finished PDF bytes built by the renderer. */
    document: (bytes, name, opts) => call('print:document', {
      bytes,
      name,
      autoDialog: !opts || opts.autoDialog !== false
    }),
    /** Re-open the OS print dialog for the preview already on screen. */
    dialog: () => call('print:dialog'),
    close: () => call('print:close')
  },

  log: {
    append: (text) => call('log:append', text),
    path: () => call('log:path'),
    read: () => call('log:read'),
    reveal: () => call('log:reveal')
  },

  diag: {
    info: () => call('diag:info')
  },

  /** Absolute path of a dropped File, or null if this Electron cannot say. */
  pathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
    } catch (err) { /* fall through */ }
    return (file && file.path) || null;
  },

  window: {
    minimize: () => call('window:minimize'),
    toggleMaximize: () => call('window:toggle-maximize'),
    /** `{force: true}` once the renderer's per-tab close guard has cleared. */
    close: (opts) => call('window:close', { force: !!(opts && opts.force) }),
    /** Answer to `closeRequest` when the user backed out. */
    cancelClose: () => call('window:cancel-close'),
    isMaximized: () => call('window:is-maximized'),
    /** Presentation mode. Resolves to the state the window actually reached. */
    setFullScreen: (on) => call('window:set-fullscreen', !!on),
    setTitle: (title) => call('window:set-title', title)
  },

  on: {
    openFile: (handler) => ipcRenderer.on('app:open-file', (event, filePath) => handler(filePath)),
    windowState: (handler) => ipcRenderer.on('window:state', (event, state) => handler(state)),
    /** Main is asking whether every open tab is safe to close. */
    closeRequest: (handler) => ipcRenderer.on('app:close-request', () => handler())
  }
});
