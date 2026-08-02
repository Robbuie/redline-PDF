/* Diagnostics: capture everything that goes wrong, keep it on screen and on
   disk, and make it one click to copy. Renderer errors otherwise vanish into a
   DevTools console nobody has open. */
'use strict';

(function (RP) {

  const MAX_ENTRIES = 400;

  const Diag = {
    entries: [],
    info: {},
    pending: [],
    flushTimer: null,
    installed: false,

    install() {
      if (this.installed) return;
      this.installed = true;

      const wrap = (level) => {
        const original = console[level] ? console[level].bind(console) : () => {};
        console[level] = (...args) => {
          original(...args);
          if (level === 'error' || level === 'warn') this.record(level, args.map(fmt).join(' '));
        };
      };
      wrap('error');
      wrap('warn');

      window.addEventListener('error', (event) => {
        const where = event.filename ? ` (${short(event.filename)}:${event.lineno}:${event.colno})` : '';
        this.record('error', (event.message || 'Script error') + where +
          (event.error && event.error.stack ? '\n' + event.error.stack : ''));
      });

      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        this.record('error', 'Unhandled promise rejection: ' +
          (reason && reason.stack ? reason.stack : fmt(reason)));
      });

      this.record('info', 'Renderer started');
    },

    record(level, message) {
      const entry = { at: Date.now(), level, message: String(message) };
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
      this.pending.push(entry);
      this.scheduleFlush();
      if (level === 'error') RP.bus.emit('diag:error', entry);
      this.refreshIfOpen();
    },

    scheduleFlush() {
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const batch = this.pending.splice(0, this.pending.length);
        if (!batch.length || !window.rp || !window.rp.log) return;
        const text = batch.map((e) => `[${new Date(e.at).toISOString()}] ${e.level.toUpperCase()} ${e.message}`).join('\n') + '\n';
        window.rp.log.append(text).catch(() => { /* logging must never throw */ });
      }, 400);
    },

    async collectInfo() {
      const info = {
        app: 'Redline PDF',
        when: new Date().toString(),
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        pageUrl: location.href,
        pdfjs: RP.pdfjs ? RP.pdfjs.describe() : 'loader missing',
        pdfLib: window.PDFLib ? 'loaded' : 'MISSING',
        document: {
          name: RP.store ? RP.store.docName : null,
          pages: RP.store ? RP.store.numPages : 0,
          markups: RP.store ? RP.store.annotations.length : 0
        }
      };
      try {
        if (window.rp && window.rp.diag) Object.assign(info, await window.rp.diag.info());
      } catch (err) {
        info.mainProcess = 'diag:info failed — ' + err.message;
      }
      this.info = info;
      return info;
    },

    async snapshot() {
      const info = await this.collectInfo();
      const lines = [];
      lines.push('=== Redline PDF diagnostics ===');
      for (const [key, value] of Object.entries(info)) {
        lines.push(key.padEnd(18) + ' : ' + (typeof value === 'object' ? JSON.stringify(value) : value));
      }
      lines.push('');
      lines.push('=== Session log (' + this.entries.length + ' entries) ===');
      if (!this.entries.length) lines.push('(nothing recorded)');
      for (const entry of this.entries) {
        lines.push('[' + new Date(entry.at).toLocaleTimeString() + '] ' + entry.level.toUpperCase() + '  ' + entry.message);
      }
      return lines.join('\n');
    },

    // -- UI ----------------------------------------------------------------

    wire() {
      this.modal = RP.$('#diagModal');
      this.pre = RP.$('#diagText');
      RP.$('#btnDiag').addEventListener('click', () => this.open());
      RP.$('#diagClose').addEventListener('click', () => this.close());
      this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

      RP.$('#diagCopy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(await this.snapshot());
          RP.toast('Diagnostics copied to the clipboard', 'good');
        } catch (err) {
          RP.toast('Could not copy: ' + err.message, 'error');
        }
      });

      RP.$('#diagSave').addEventListener('click', async () => {
        try {
          const path = await window.rp.files.saveAsDialog({
            title: 'Save diagnostics',
            defaultPath: 'redline-pdf-diagnostics.txt',
            filters: [{ name: 'Text', extensions: ['txt'] }]
          });
          if (!path) return;
          await window.rp.files.writeText(path, await this.snapshot());
          RP.toast('Saved to ' + RP.basename(path), 'good');
        } catch (err) {
          RP.toast('Could not save: ' + err.message, 'error');
        }
      });

      RP.$('#diagReveal').addEventListener('click', () => {
        window.rp.log.reveal().catch((err) => RP.toast('Could not open the log folder: ' + err.message, 'error'));
      });

      document.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
          event.preventDefault();
          this.open();
        }
      });
    },

    async open() {
      if (!this.modal) return;
      this.modal.hidden = false;
      this.pre.textContent = 'Collecting…';
      this.pre.textContent = await this.snapshot();
    },

    close() {
      if (this.modal) this.modal.hidden = true;
    },

    async refreshIfOpen() {
      if (this.modal && !this.modal.hidden) {
        this.pre.textContent = await this.snapshot();
      }
    },

    // -- banner ------------------------------------------------------------

    banner(title, body) {
      const banner = RP.$('#errorBanner');
      if (!banner) return;
      RP.$('#bannerTitle').textContent = title;
      RP.$('#bannerBody').textContent = body;
      banner.hidden = false;
    },

    hideBanner() {
      const banner = RP.$('#errorBanner');
      if (banner) banner.hidden = true;
    },

    wireBanner() {
      RP.$('#bannerClose').addEventListener('click', () => this.hideBanner());
      RP.$('#bannerDetails').addEventListener('click', () => this.open());
    }
  };

  function fmt(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (err) { return String(value); }
  }

  function short(url) {
    return String(url || '').split(/[\\/]/).slice(-2).join('/');
  }

  RP.diag = Diag;
  Diag.install();

})(window.RP);
