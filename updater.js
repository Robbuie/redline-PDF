/* Auto-update — the one network call this app makes.

   Redline PDF is otherwise entirely offline, so everything here is deliberately
   narrow: one check a few seconds after launch, only if the user has not turned
   it off, and nothing is ever downloaded without being asked for. There is no
   telemetry in either direction — a check is a GET of `latest.yml` from the
   GitHub release and nothing else.

   Builds are unsigned, so electron-updater has no publisher signature to verify
   and the trust boundary is HTTPS to github.com. That is a choice, written down
   here so it does not become an accident; signing the installer would let
   `verifyUpdateCodeSignature` do its job and is the upgrade path if this ever
   goes to anyone else's machine.

   Installing is queued rather than forced. `quitAndInstall` tears the windows
   down itself, which would drive straight through the renderer's unsaved-tab
   guard, so instead `autoInstallOnAppQuit` stages the installer and a quit is
   requested through the same path as the tray's Quit — the guard still runs and
   the user can still back out. */
'use strict';

const { app, dialog } = require('electron');

/* Long enough that the check never competes with opening the drawing someone
   double-clicked, short enough that a session started in the morning still
   sees it. */
const LAUNCH_DELAY_MS = 8000;

/**
 * @param host {{
 *   logMain: (level: string, message: string) => void,
 *   getWindow: () => Electron.BrowserWindow | null,
 *   getSettings: () => object,
 *   patchSettings: (patch: object) => void,
 *   requestQuit: () => void
 * }}
 */
function createUpdater(host) {
  let api = null;          // the electron-updater singleton, loaded on demand
  let busy = false;        // one check at a time
  let staged = null;       // version already downloaded and waiting for a quit

  function log(level, message) {
    try { host.logMain(level, '[updater] ' + message); } catch (err) { /* never fatal */ }
  }

  /** Non-null when updating cannot work at all, with the reason to show. */
  function unavailable() {
    if (!app.isPackaged) return 'Updates only run from an installed build.';
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      return 'This is the portable build — download the new exe and replace this one.';
    }
    return null;
  }

  /* Required lazily: a missing or broken dependency must cost the updater and
     nothing else. */
  function load() {
    if (api) return api;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m) => log('info', String(m)),
      warn: (m) => log('warn', String(m)),
      error: (m) => log('error', String(m)),
      debug: () => {}
    };
    api = autoUpdater;
    return api;
  }

  /**
   * Dotted-numeric comparison, which is all a release tag of ours ever is.
   * Anything unparseable sorts as "not newer" — a malformed feed should be
   * inert, not a prompt.
   */
  function isNewer(candidate, current) {
    const parse = (v) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10));
    const a = parse(candidate);
    const b = parse(current);
    if (a.some(isNaN) || b.some(isNaN) || !a.length) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const left = a[i] || 0;
      const right = b[i] || 0;
      if (left !== right) return left > right;
    }
    return false;
  }

  function say(opts) {
    const win = host.getWindow();
    return dialog.showMessageBox(win && !win.isDestroyed() ? win : null, opts);
  }

  function note(message, detail) {
    return say({ type: 'info', buttons: ['OK'], message, detail: detail || '' });
  }

  /** Ask, then download if wanted. Resolves once the user has decided. */
  async function offer(info) {
    const answer = await say({
      type: 'info',
      buttons: ['Download', 'Skip this version', 'Not now'],
      defaultId: 0,
      cancelId: 2,
      message: 'Redline PDF ' + info.version + ' is available',
      detail: 'You are on ' + app.getVersion() + '. The download happens in the '
        + 'background and installs the next time you quit — nothing is '
        + 'interrupted and no drawing is touched.'
    });

    if (answer.response === 1) {
      host.patchSettings({ skipVersion: info.version });
      log('info', 'user skipped ' + info.version);
      return { status: 'skipped', version: info.version };
    }
    if (answer.response !== 0) return { status: 'deferred', version: info.version };

    const result = await download();
    if (!result.ok) {
      await note('The update could not be downloaded', result.error);
      return { status: 'error', error: result.error };
    }

    staged = info.version;
    const next = await say({
      type: 'info',
      buttons: ['Quit and install', 'Install on next quit'],
      defaultId: 1,
      cancelId: 1,
      message: 'Redline PDF ' + info.version + ' is ready to install',
      detail: 'Installing needs the app closed. Quitting now still asks about '
        + 'any unsaved drawings first.'
    });
    if (next.response === 0) host.requestQuit();
    return { status: 'downloaded', version: info.version };
  }

  /** electron-updater reports completion by event, so bridge it to a promise. */
  function download() {
    const updater = load();
    return new Promise((resolve) => {
      const onDone = () => { cleanup(); resolve({ ok: true }); };
      const onError = (err) => {
        cleanup();
        resolve({ ok: false, error: String((err && err.message) || err) });
      };
      function cleanup() {
        updater.removeListener('update-downloaded', onDone);
        updater.removeListener('error', onError);
      }
      updater.on('update-downloaded', onDone);
      updater.on('error', onError);
      updater.downloadUpdate().catch(onError);
    });
  }

  /**
   * @param opts.manual  a check the user asked for: it reports "up to date",
   *                     ignores the off switch and a skipped version, and
   *                     surfaces its own failures. The launch check stays
   *                     silent about all three.
   */
  async function check(opts) {
    const manual = !!(opts && opts.manual);
    const reason = unavailable();
    if (reason) {
      log('info', 'skipped — ' + reason);
      if (manual) await note('Updates are not available for this build', reason);
      return { status: 'unavailable', reason };
    }
    if (busy) return { status: 'busy' };
    if (staged) {
      if (manual) await note('Redline PDF ' + staged + ' is already downloaded', 'It installs the next time you quit.');
      return { status: 'downloaded', version: staged };
    }

    const settings = host.getSettings() || {};
    if (!manual && settings.autoUpdate === false) return { status: 'disabled' };

    busy = true;
    try {
      const result = await load().checkForUpdates();
      const info = result && result.updateInfo;
      const version = info && info.version;

      if (!version || !isNewer(version, app.getVersion())) {
        log('info', 'up to date at ' + app.getVersion());
        if (manual) await note('Redline PDF is up to date', 'You are on version ' + app.getVersion() + '.');
        return { status: 'current' };
      }
      if (!manual && settings.skipVersion === version) {
        log('info', version + ' available but skipped by the user');
        return { status: 'skipped', version };
      }

      log('info', version + ' available');
      return await offer(info);
    } catch (err) {
      // Offline is the normal case, not an incident — it belongs in the log,
      // and in front of the user only if they asked.
      const message = String((err && err.message) || err);
      log('warn', 'check failed: ' + message);
      if (manual) await note('Could not check for updates', message);
      return { status: 'error', error: message };
    } finally {
      busy = false;
    }
  }

  return {
    check,

    /** Fire-and-forget: nothing waits on this and nothing fails because of it. */
    scheduleLaunchCheck() {
      const settings = host.getSettings() || {};
      if (settings.autoUpdate === false) { log('info', 'launch check disabled in settings'); return; }
      const timer = setTimeout(() => {
        check({ manual: false }).catch((err) => log('error', 'launch check threw: ' + err));
      }, LAUNCH_DELAY_MS);
      // A timer is not a reason to keep the process alive on its own.
      if (timer.unref) timer.unref();
    }
  };
}

module.exports = { createUpdater };
