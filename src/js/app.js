/* Application wiring: opening, saving, toolbar, shortcuts, settings. */
'use strict';

(function (RP) {

  const App = {
    settings: null,
    autosaveTimer: null,
    appVersion: '',

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    engineReady: false,

    /**
     * Boot in three independent stages. The UI is wired before anything that
     * can fail, so a broken PDF engine leaves you with a working window and a
     * readable error instead of a dead app.
     */
    async boot() {
      RP.diag.wire();
      RP.diag.wireBanner();

      // --- stage 1: chrome that must always work --------------------------
      try {
        this.wireWindowChrome();
        RP.sidebar.init();
        this.wireShortcuts();
      } catch (err) {
        console.error('Window chrome failed to initialise', err);
      }

      // --- stage 2: settings + the rest of the UI -------------------------
      let info = null;
      try {
        info = await window.rp.readyInfo();
        this.settings = info.settings;
        this.appVersion = info.version || '';
        RP.store.author = this.settings.defaultAuthor || info.userName || '';
        // A window restored maximized reached that state before the
        // `window:state` listener existed, so seed the button from ready-info.
        this.applyWindowState({ maximized: !!info.maximized });
      } catch (err) {
        console.error('Could not read settings from the main process', err);
        this.settings = FALLBACK_SETTINGS();
      }

      try {
        RP.annots.init();
        // Tools before tabs: creating the first pane calls `RP.tools.bindPane`.
        RP.tools.init();
        RP.tabs.init();
        RP.pages.init();
        RP.outline.init();
        RP.compare.init();
        RP.print.init();
        this.applyTheme(this.settings.theme);
        this.applyNight(this.settings.nightMode);
        this.buildSwatches();
        this.wireToolbar();
        this.wireSettings();
        this.wireDragDrop();
        this.wireBusListeners();
        RP.sidebar.renderRecents(this.settings.recents);
        this.updateSaveModeChip();
        this.startAutosave();
      } catch (err) {
        console.error('UI initialisation failed', err);
        RP.diag.banner('The interface did not fully load',
          err.message + ' — open Diagnostics for the full trace.');
      }

      // --- stage 3: the PDF engine ----------------------------------------
      try {
        await RP.pdfjs.load();
        this.engineReady = true;
        RP.diag.record('info', 'PDF.js ready: ' + RP.pdfjs.version + ' (' + RP.pdfjs.flavour + ')');
      } catch (err) {
        this.engineReady = false;
        const attempts = (err.attempts || []).join(' · ');
        RP.diag.record('error', 'PDF.js failed to load. Attempts: ' + attempts);
        RP.diag.banner(
          'PDF engine could not be loaded — you can look around, but PDFs will not open',
          'Run "npm install" in the project folder, then restart. If it persists, click Diagnostics and send me the text.'
        );
      }

      if (!window.PDFLib) {
        RP.diag.record('error', 'pdf-lib is missing — saving will not work');
        RP.diag.banner('pdf-lib is missing — markups cannot be saved',
          'node_modules/pdf-lib/dist/pdf-lib.min.js was not found. Run "npm install".');
      }

      try {
        // A file association or a second launch opens another tab rather than
        // replacing what you are already looking at.
        window.rp.on.openFile((path) => this.openPath(path));
        // The window cannot decide on its own whether it is safe to close now
        // that there may be several unsaved drawings behind it.
        window.rp.on.closeRequest(() => this.handleCloseRequest());
        if (info && info.startupFile) this.openPath(info.startupFile);
      } catch (err) {
        console.error('Startup file handling failed', err);
      }
    },

    /**
     * Main asks before it lets the window go, because Alt+F4 and the taskbar
     * both side-step the title-bar button. Answering is not optional — main
     * closes anyway after a timeout — so this must not be able to hang.
     */
    async handleCloseRequest() {
      let ok = true;
      try {
        ok = await RP.tabs.closeAll();
      } catch (err) {
        console.error('Close guard failed', err);
      }
      if (ok) window.rp.window.close({ force: true });
      else window.rp.window.cancelClose();
    },

    requireEngine() {
      if (this.engineReady) return true;
      RP.toast('The PDF engine is not loaded — run "npm install" and restart', 'error', 6000);
      RP.diag.open();
      return false;
    },

    applyTheme(theme) {
      document.body.className = theme === 'light' ? 'theme-light' : 'theme-dark';
      document.body.dataset.tool = RP.tools.tool;
    },

    // -----------------------------------------------------------------------
    // Opening
    // -----------------------------------------------------------------------

    async openDialog(opts) {
      if (!this.requireEngine()) return;
      const picked = await window.rp.files.openDialog({});
      if (picked) await this.loadDocument(picked, opts);
    },

    async openPath(path, opts) {
      if (!this.requireEngine()) return;
      try {
        const file = await window.rp.files.read(path);
        await this.loadDocument(file, opts);
      } catch (err) {
        RP.toast('Could not open that file: ' + err.message, 'error');
      }
    },

    /**
     * Open a drawing into a tab.
     *
     * Opening no longer replaces what is on screen, so there is no discard
     * prompt here any more — an unsaved drawing simply stays in its own tab.
     * The PDF is parsed *before* a tab is created so that a file that turns out
     * not to be readable leaves the view exactly as it was.
     */
    async loadDocument(file, opts) {
      const options = opts || {};

      // A drawing that is already open is raised rather than loaded twice:
      // two tabs over the same file would each hold their own markups and the
      // second save would silently throw the first one away.
      const already = RP.tabs.findByPath(file.path);
      if (already && !options.forceNew) {
        await RP.tabs.activate(already);
        RP.toast(file.name + ' is already open', 'warn');
        return already;
      }

      // Read before the recents list is touched below, which moves the entry.
      const remembered = this.rememberedView(file.path);
      const bytes = new Uint8Array(file.bytes);
      RP.status('Opening ' + file.name + '…');

      let doc;
      try {
        // pdf.js takes ownership of the buffer it is handed, so give it a copy
        // and keep the pristine original for pdf-lib.
        doc = await pdfjsLib.getDocument(RP.pdfjs.docParams({ data: bytes.slice(0) })).promise;
      } catch (err) {
        RP.toast('That file could not be read as a PDF: ' + err.message, 'error');
        RP.status('');
        return null;
      }

      // An empty starting tab is filled rather than added to, so the first
      // Open in a fresh window does not leave a blank tab behind it.
      const current = RP.tabs.active();
      const tab = options.tab ||
        (!options.newTab && current && !current.store.doc ? current : RP.tabs.create({ pane: options.pane }));
      RP.tabs.prepare(tab);

      const store = tab.store;
      store.setDocument({ doc, path: file.path, name: file.name, bytes });
      RP.compare.close();
      await RP.viewer.open(doc, store);
      const restored = this.restoreView(remembered);
      RP.search.reset();

      // Markups embedded by a previous Redline save.
      const embedded = await RP.exporter.readEmbeddedMarkup(bytes);
      if (embedded) {
        RP.store.load(embedded.annotations);
        RP.store.scale = embedded.scale || null;
        RP.store.markDirty(false);
        RP.toast(embedded.annotations.length + ' saved markups restored and editable', 'good');
      }

      // Crash-recovery snapshot newer than the file itself.
      if (file.path && this.settings.autosave) {
        try {
          const recovered = await window.rp.recovery.read(file.path);
          if (recovered && recovered.annotations && recovered.annotations.length) {
            const answer = await window.rp.dialog.message({
              type: 'question',
              message: 'Unsaved markups found',
              detail: 'Redline PDF has ' + recovered.annotations.length + ' markups for this drawing from ' +
                RP.fmtDate(recovered.savedAt) + ' that were never saved. Restore them?',
              buttons: ['Restore', 'Discard'],
              defaultId: 0,
              cancelId: 1
            });
            if (answer.response === 0) {
              RP.store.load(recovered.annotations);
              RP.store.markDirty(true);
            } else {
              await window.rp.recovery.clear(file.path);
            }
          }
        } catch (err) { /* recovery is best-effort */ }
      }

      // `setDocument` already announced the load, so this only has to bring the
      // tab strip, thumbnails and toolbar into line with the new session.
      RP.tabs.afterSwitch(tab, { emitLoaded: false, rebuilt: true });
      RP.status(restored ? 'Reopened at ' + restored : '');
      if (file.path) {
        this.settings.recents = await window.rp.recents.add({ path: file.path, name: file.name });
        RP.sidebar.renderRecents(this.settings.recents);
      }
      return tab;
    },

    // -----------------------------------------------------------------------
    // Where you were last time
    // -----------------------------------------------------------------------

    /** The recents entry for a path, if we are meant to be restoring views. */
    rememberedView(docPath) {
      if (!docPath || !this.settings || this.settings.restoreView === false) return null;
      const found = (this.settings.recents || []).find((entry) => entry.path === docPath);
      if (!found) return null;
      const page = Number(found.page);
      const zoom = Number(found.zoom);
      if (!Number.isFinite(page) && !Number.isFinite(zoom)) return null;
      return { page, zoom };
    },

    /**
     * Put the viewer back where it was. `RP.viewer.open` has just run its own
     * fit, so this deliberately overrides it — and setting an explicit zoom
     * clears `fitMode`, which is what stops the next window resize from
     * snapping the drawing back to fit-width.
     */
    restoreView(view) {
      if (!view || !RP.viewer.pages.length) return null;
      const parts = [];

      if (Number.isFinite(view.zoom) && view.zoom > 0) {
        // Cleared explicitly: setZoom bails out early when the remembered zoom
        // happens to match the fit it just applied, and would leave fitMode set
        // — so the next window resize would snap the drawing back to fit-width.
        RP.viewer.fitMode = null;
        RP.viewer.setZoom(view.zoom);
        parts.push(Math.round(RP.viewer.zoom * 100) + '%');
      }
      if (Number.isFinite(view.page) && view.page > 0) {
        RP.viewer.goToPage(view.page, { instant: true });
        parts.unshift('page ' + (RP.viewer.currentPage + 1));
      }
      return parts.length ? parts.join(' · ') : null;
    },

    /**
     * Record page and zoom against the recents entry. Debounced because it
     * rides on every scroll and every zoom step, and it writes in place so the
     * recents list neither reorders nor re-renders while you are reading.
     */
    rememberView: RP.debounce(function () {
      const store = RP.store;
      if (!store.docPath || !this.settings || this.settings.restoreView === false) return;
      const entry = (this.settings.recents || []).find((r) => r.path === store.docPath);
      if (entry) { entry.page = RP.viewer.currentPage; entry.zoom = RP.viewer.zoom; }
      window.rp.recents.rememberView({
        path: store.docPath,
        page: RP.viewer.currentPage,
        zoom: RP.viewer.zoom
      }).catch(() => { /* losing a scroll position is not worth a toast */ });
    }, 700),

    /* There is no "discard before opening" prompt any more: opening a second
       drawing no longer throws the first one away, it lands in its own tab.
       The prompts moved to where the work actually gets lost — closing a tab
       (RP.tabs.close) and closing the window (handleCloseRequest). */

    // -----------------------------------------------------------------------
    // Saving
    // -----------------------------------------------------------------------

    defaultCopyPath() {
      const path = RP.store.docPath;
      if (!path) return null;
      const dir = RP.dirname(path);
      const base = RP.stripExt(RP.basename(path));
      const name = /-markup$/i.test(base) ? base : base + '-markup';
      return RP.joinPath(dir, name + '.pdf');
    },

    async resolveTarget() {
      const store = RP.store;
      if (!store.docPath) {
        return { path: await this.pickSavePath(), backup: false };
      }

      let mode = this.settings.saveMode;
      if (mode === 'ask') {
        if (store.saveModeDecided) {
          mode = store.saveModeDecided;
        } else {
          const answer = await window.rp.dialog.message({
            type: 'question',
            message: 'How should this drawing be saved?',
            detail: 'Overwrite ' + store.docName + ', or write the markups to a separate copy?',
            buttons: ['New copy', 'Overwrite original', 'Cancel'],
            defaultId: 0,
            cancelId: 2
          });
          if (answer.response === 2) return null;
          mode = answer.response === 1 ? 'overwrite' : 'copy';
          store.saveModeDecided = mode;
        }
      }

      if (mode === 'overwrite') {
        return { path: store.docPath, backup: !!this.settings.backupOnOverwrite, overwrote: true };
      }
      // Repeat saves reuse the copy we already made, instead of stacking files.
      return { path: store.savedTo || this.defaultCopyPath(), backup: false };
    },

    async pickSavePath() {
      const suggestion = this.defaultCopyPath() || 'markup.pdf';
      return window.rp.files.saveAsDialog({ title: 'Save marked-up PDF', defaultPath: suggestion });
    },

    /** Returns false when the save did not happen, so the tab-close guard and
        the window-close guard can stop instead of discarding the work. */
    async save() {
      if (!RP.store.doc) return false;
      const target = await this.resolveTarget();
      if (!target || !target.path) return false;
      return this.writeTo(target.path, target.backup, target.overwrote);
    },

    async saveAs() {
      if (!RP.store.doc) return false;
      const path = await this.pickSavePath();
      if (!path) return false;
      return this.writeTo(path, false, false);
    },

    async writeTo(path, backup, overwrote) {
      RP.status('Saving…');
      // Captured up front: an await inside a save must not let a tab switch
      // land the bytes of one drawing on another one's store.
      const store = RP.store;
      try {
        const bytes = await RP.exporter.buildPdf({ store });
        await window.rp.files.write(path, bytes, backup);
        store.savedTo = path;
        store.markDirty(false);
        if (store.docPath) await window.rp.recovery.clear(store.docPath);
        RP.status('');
        RP.toast(
          (overwrote ? 'Saved over ' : 'Saved to ') + RP.basename(path) +
          (backup ? ' (original backed up)' : ''),
          'good'
        );
        this.updateTitle();
        return true;
      } catch (err) {
        console.error(err);
        RP.status('');
        RP.toast('Save failed: ' + err.message, 'error');
        return false;
      }
    },

    async exportCsv() {
      if (!RP.store.annotations.length) { RP.toast('No markups to export yet', 'warn'); return; }
      const suggestion = RP.joinPath(RP.dirname(RP.store.docPath || ''), RP.stripExt(RP.store.docName) + '-markups.csv');
      const path = await window.rp.files.saveAsDialog({
        title: 'Export markup summary',
        defaultPath: suggestion,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (!path) return;
      await window.rp.files.writeText(path, RP.exporter.toCsv());
      RP.toast('Markup summary written to ' + RP.basename(path), 'good');
    },

    async exportReport() {
      if (!RP.store.annotations.length) { RP.toast('No markups to export yet', 'warn'); return; }
      const suggestion = RP.joinPath(RP.dirname(RP.store.docPath || ''), RP.stripExt(RP.store.docName) + '-markup-report.pdf');
      const path = await window.rp.files.saveAsDialog({ title: 'Export markup report', defaultPath: suggestion });
      if (!path) return;
      const bytes = await RP.exporter.buildReportPdf();
      await window.rp.files.write(path, bytes, false);
      RP.toast('Report written to ' + RP.basename(path), 'good');
    },

    /* Snapshots are keyed by document path, so every open tab gets its own —
       a crash with six drawings up must not only recover the one that happened
       to be in front. */
    startAutosave() {
      clearInterval(this.autosaveTimer);
      if (!this.settings.autosave) return;
      this.autosaveTimer = setInterval(async () => {
        for (const tab of RP.tabs.all()) {
          const store = tab.store;
          if (!store.dirty || !store.docPath || !store.annotations.length) continue;
          try { await window.rp.recovery.write(store.docPath, store.annotations); } catch (err) { /* ignore */ }
        }
      }, Math.max(15000, this.settings.autosaveIntervalMs || 60000));
    },

    // -----------------------------------------------------------------------
    // Toolbar
    // -----------------------------------------------------------------------

    buildSwatches() {
      const host = RP.$('#swatches');
      host.innerHTML = '';
      for (const hex of RP.PALETTE) {
        host.appendChild(RP.el('button', {
          class: 'swatch' + (hex === RP.tools.style.color ? ' active' : ''),
          style: { background: hex },
          'data-color': hex,
          title: hex,
          onclick: () => this.pickColor(hex)
        }));
      }
      const custom = RP.el('button', { class: 'swatch custom', title: 'Custom colour', style: { background: 'conic-gradient(#f33,#fd0,#3d6,#28f,#c4f,#f33)' } });
      const input = RP.el('input', { type: 'color', value: RP.tools.style.color });
      input.addEventListener('input', () => this.pickColor(input.value));
      custom.appendChild(input);
      host.appendChild(custom);
    },

    pickColor(hex) {
      RP.tools.setColor(hex);
      RP.$$('#swatches .swatch').forEach((swatch) => {
        swatch.classList.toggle('active', swatch.dataset.color === hex);
      });
    },

    syncSwatchesToTool() {
      const active = RP.tools.activeColor();
      RP.$$('#swatches .swatch').forEach((swatch) => {
        swatch.classList.toggle('active', swatch.dataset.color === active);
      });
    },

    wireToolbar() {
      RP.$('#btnOpen').addEventListener('click', () => this.openDialog());
      RP.$('#btnOpenEmpty').addEventListener('click', () => this.openDialog());
      RP.$('#btnOpenRecent').addEventListener('click', (event) => {
        this.openRecentsMenu(event.currentTarget);
      });
      RP.$('#btnSave').addEventListener('click', () => this.save());
      RP.$('#btnSaveAs').addEventListener('click', () => this.saveAs());
      RP.$('#btnPrint').addEventListener('click', () => RP.print.show());
      RP.$('#btnExport').addEventListener('click', () => this.exportReport());
      RP.$('#btnExportCsv').addEventListener('click', () => this.exportCsv());
      RP.$('#btnExportReport').addEventListener('click', () => this.exportReport());

      RP.$$('.tbtn.tool[data-tool]').forEach((btn) => {
        btn.addEventListener('click', () => {
          RP.tools.setTool(btn.dataset.tool);
          this.syncSwatchesToTool();
        });
      });

      RP.$$('#hlModeGroup .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          RP.tools.setHighlightMode(chip.dataset.hlmode);
          RP.status(chip.dataset.hlmode === 'text'
            ? 'Drag across text to highlight the words'
            : 'Drag a box to highlight an area');
        });
      });

      const widthRange = RP.$('#widthRange');
      widthRange.addEventListener('input', () => {
        RP.$('#widthOut').textContent = widthRange.value;
        RP.tools.setWidth(Number(widthRange.value));
      });

      const opacityRange = RP.$('#opacityRange');
      opacityRange.addEventListener('input', () => {
        RP.$('#opacityOut').textContent = opacityRange.value;
        RP.tools.setOpacity(Number(opacityRange.value) / 100);
      });

      // Typography for text and callouts. These sit in their own toolbar group
      // that only appears for those two tools.
      const fontFamily = RP.$('#fontFamily');
      fontFamily.value = RP.tools.style.fontFamily;
      fontFamily.addEventListener('change', () => RP.tools.setTextStyle({ fontFamily: fontFamily.value }));

      const fontSize = RP.$('#fontSize');
      fontSize.value = String(RP.tools.style.fontSize);
      fontSize.addEventListener('change', () => {
        const size = Math.min(96, Math.max(4, Number(fontSize.value) || 12));
        fontSize.value = String(size);
        RP.tools.setTextStyle({ fontSize: size });
      });

      const fontBold = RP.$('#fontBold');
      fontBold.addEventListener('click', () => RP.tools.setTextStyle({ bold: !RP.tools.style.bold }));

      const textColor = RP.$('#textColor');
      textColor.value = RP.tools.style.textColor;
      textColor.addEventListener('input', () => RP.tools.setTextStyle({ textColor: textColor.value }));

      // Selecting a markup pulls the controls onto it, so the toolbar always
      // describes what you are looking at rather than what you last drew.
      RP.bus.on('selection:changed', () => {
        const picked = RP.store.selected().filter((a) => a.type === 'text' || a.type === 'callout');
        if (picked.length !== 1) return;
        const annot = picked[0];
        fontFamily.value = annot.fontFamily || 'sans';
        fontSize.value = String(annot.fontSize || 12);
        fontBold.classList.toggle('active', !!annot.bold);
        if (annot.type === 'callout') textColor.value = annot.textColor || RP.render.DEFAULT_TEXT_COLOR;
      });

      RP.$('#btnUndo').addEventListener('click', () => RP.store.undo());
      RP.$('#btnRedo').addEventListener('click', () => RP.store.redo());
      RP.$('#btnDelete').addEventListener('click', () => this.deleteSelection());

      RP.$('#btnZoomIn').addEventListener('click', () => RP.viewer.setZoom(RP.viewer.zoom * 1.2));
      RP.$('#btnZoomOut').addEventListener('click', () => RP.viewer.setZoom(RP.viewer.zoom / 1.2));
      RP.$('#btnFitWidth').addEventListener('click', () => RP.viewer.fitWidth());
      RP.$('#btnFitPage').addEventListener('click', () => RP.viewer.fitPage());
      RP.$('#btnRotate').addEventListener('click', () => RP.viewer.rotate());
      RP.$('#btnNight').addEventListener('click', () => this.toggleNight());

      const zoomInput = RP.$('#zoomInput');
      zoomInput.addEventListener('change', () => {
        const value = parseFloat(zoomInput.value);
        if (isFinite(value) && value > 0) RP.viewer.setZoom(value / 100);
        else this.updateStatus();
      });
      zoomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') zoomInput.blur(); });
      zoomInput.addEventListener('focus', () => zoomInput.select());
      RP.$('#zoomPresets').addEventListener('click', (event) => {
        this.openZoomMenu(event.currentTarget);
      });

      // Go-to-page. Committed on Enter and on blur, so both "type 42, Enter"
      // and "type 42, click the drawing" land where you meant.
      const pageInput = RP.$('#pageInput');
      const goToTyped = () => {
        const value = parseInt(pageInput.value, 10);
        if (Number.isFinite(value) && value >= 1) RP.viewer.goToPage(value - 1);
        // Whatever happened, redisplay the page the viewer is actually on —
        // a typo must not leave the box claiming otherwise.
        this.updateStatus();
      };
      pageInput.addEventListener('change', goToTyped);
      pageInput.addEventListener('focus', () => pageInput.select());
      pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); goToTyped(); pageInput.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); this.updateStatus(); pageInput.blur(); }
      });

      RP.$('#btnCompare').addEventListener('click', () => {
        RP.sidebar.show('compare');
        if (RP.compare.results.length) RP.compare.open();
      });
      RP.$('#btnSearch').addEventListener('click', () => RP.sidebar.show('search'));
      RP.$('#cmpCloud').addEventListener('click', () => {
        const count = RP.compare.cloudChanges();
        RP.compare.close();
        RP.toast(count ? count + ' revision clouds added to the drawing' : 'No changes to cloud', count ? 'good' : 'warn');
      });

      const searchInput = RP.$('#searchInput');
      const runSearch = RP.debounce(() => {
        RP.search.run(searchInput.value, {
          matchCase: RP.$('#searchCase').checked,
          wholeWord: RP.$('#searchWhole').checked
        });
      }, 260);
      searchInput.addEventListener('input', runSearch);
      RP.$('#searchCase').addEventListener('change', runSearch);
      RP.$('#searchWhole').addEventListener('change', runSearch);
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? RP.search.prev() : RP.search.next(); }
      });

      RP.$('#stSaveMode').addEventListener('click', () => this.cycleSaveMode());
      RP.$('#stScale').addEventListener('click', () => RP.tools.recalibrate());
    },

    deleteSelection() {
      const ids = Array.from(RP.store.selection);
      if (!ids.length) { RP.status('Nothing selected', 'warn'); return; }
      RP.store.remove(ids);
      RP.tools.closeNotePopup();
    },

    // -----------------------------------------------------------------------
    // Zoom presets
    // -----------------------------------------------------------------------

    /**
     * The fixed steps, plus the three fits. `fitMode` is checked rather than
     * the zoom number, because fit-width at 137% and a typed 137% are the same
     * magnification but not the same state — one survives a window resize.
     */
    openZoomMenu(anchor) {
      const viewer = RP.viewer;
      // The button is in the toolbar from boot, but `RP.viewer` is only
      // pointed at a pane once one exists.
      if (!viewer) { RP.status('Open a drawing first', 'warn'); return; }
      const steps = [25, 50, 75, 100, 125, 150, 200, 400];
      const current = Math.round(viewer.zoom * 100);

      RP.menu.openUnder(anchor, [
        {
          label: 'Fit width',
          hint: 'Ctrl+1',
          checked: viewer.fitMode === 'width',
          run: () => viewer.fitWidth()
        },
        {
          label: 'Fit page',
          hint: 'Ctrl+2',
          checked: viewer.fitMode === 'page',
          run: () => viewer.fitPage()
        },
        {
          label: 'Actual size',
          hint: 'Ctrl+0',
          checked: !viewer.fitMode && current === 100,
          run: () => { viewer.fitMode = null; viewer.setZoom(1); }
        },
        { separator: true }
      ].concat(steps.map((pct) => ({
        label: pct + '%',
        checked: !viewer.fitMode && current === pct,
        run: () => { viewer.fitMode = null; viewer.setZoom(pct / 100); }
      }))));
    },

    // -----------------------------------------------------------------------
    // Night mode
    // -----------------------------------------------------------------------

    /**
     * Inverts the drawing only. The filter is on `.pdf-canvas`; the markup
     * canvas is a sibling and is left alone, so a red cloud stays red instead
     * of arriving as cyan. See the rule in app.css.
     */
    applyNight(on) {
      document.body.classList.toggle('night', !!on);
      const button = RP.$('#btnNight');
      if (button) {
        button.classList.toggle('active', !!on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    },

    toggleNight() {
      const next = !document.body.classList.contains('night');
      this.applyNight(next);
      window.rp.settings.patch({ nightMode: next })
        .then((settings) => { this.settings = settings; })
        .catch(() => { /* the toggle already applied; persistence is best-effort */ });
      RP.status(next ? 'Night mode on — markups keep their colours' : 'Night mode off');
    },

    // -----------------------------------------------------------------------
    // Recents
    // -----------------------------------------------------------------------

    /** Drop the recents list under a toolbar button, with pin and remove. */
    openRecentsMenu(anchor) {
      const list = (this.settings.recents || []).slice(0, 12);
      if (!list.length) {
        RP.menu.openUnder(anchor, [
          { heading: 'Recent drawings' },
          { label: 'Nothing opened yet', disabled: true },
          { separator: true },
          { label: 'Open PDF…', hint: 'Ctrl+O', run: () => this.openDialog() }
        ]);
        return;
      }

      const items = [{ heading: 'Recent drawings' }];
      for (const entry of list) {
        items.push({
          label: entry.name || RP.basename(entry.path),
          hint: entry.pinned ? '' : RP.fmtRelative(entry.openedAt),
          run: () => this.openPath(entry.path),
          actions: [
            {
              text: '📌',
              title: entry.pinned ? 'Unpin' : 'Pin to the top of the list',
              on: !!entry.pinned,
              // Left open so several can be pinned in one visit; the menu is
              // rebuilt in place so the pins update as they are clicked.
              keepOpen: true,
              run: async () => {
                this.settings.recents = await window.rp.recents.pin(entry.path, !entry.pinned);
                RP.sidebar.renderRecents(this.settings.recents);
                this.openRecentsMenu(anchor);
              }
            },
            {
              text: '✕',
              title: 'Remove from this list',
              keepOpen: true,
              run: async () => {
                this.settings.recents = await window.rp.recents.remove(entry.path);
                RP.sidebar.renderRecents(this.settings.recents);
                this.openRecentsMenu(anchor);
              }
            }
          ]
        });
      }
      items.push({ separator: true });
      items.push({ label: 'Open PDF…', hint: 'Ctrl+O', run: () => this.openDialog() });
      items.push({
        label: 'Clear the list',
        danger: true,
        run: async () => {
          this.settings.recents = await window.rp.recents.clear();
          RP.sidebar.renderRecents(this.settings.recents);
        }
      });
      RP.menu.openUnder(anchor, items);
    },

    async cycleSaveMode() {
      const order = ['copy', 'overwrite', 'ask'];
      const next = order[(order.indexOf(this.settings.saveMode) + 1) % order.length];
      this.settings = await window.rp.settings.patch({ saveMode: next });
      RP.store.saveModeDecided = null;
      this.updateSaveModeChip();
      RP.toast('Save mode: ' + this.saveModeLabel(next), next === 'overwrite' ? 'warn' : '');
    },

    saveModeLabel(mode) {
      if (mode === 'overwrite') return 'overwrite original';
      if (mode === 'ask') return 'ask each time';
      return 'new copy';
    },

    updateSaveModeChip() {
      const chip = RP.$('#stSaveMode');
      const mode = this.settings.saveMode;
      chip.textContent = 'Save → ' + this.saveModeLabel(mode);
      chip.classList.toggle('overwrite', mode === 'overwrite');
      RP.$$('input[name="saveMode"]').forEach((radio) => { radio.checked = radio.value === mode; });
    },

    // -----------------------------------------------------------------------
    // Shortcuts
    // -----------------------------------------------------------------------

    wireShortcuts() {
      const toolKeys = {
        v: 'select', h: 'highlight', n: 'note', p: 'pen', l: 'line', a: 'arrow',
        r: 'rect', e: 'ellipse', c: 'cloud', t: 'text', o: 'callout', m: 'measure',
        g: 'pan', z: 'zoomrect'
      };

      document.addEventListener('keydown', (event) => {
        const target = event.target;
        const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
        const ctrl = event.ctrlKey || event.metaKey;

        if (ctrl) {
          const key = event.key.toLowerCase();
          if (key === 'o') { event.preventDefault(); this.openDialog(); return; }
          if (key === 's') { event.preventDefault(); event.shiftKey ? this.saveAs() : this.save(); return; }
          // Always swallow Ctrl+P: Chromium's own print would raster the canvas.
          if (key === 'p') { event.preventDefault(); RP.print.show(); return; }
          if (key === 'z' && !event.shiftKey) { event.preventDefault(); RP.store.undo(); return; }
          if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); RP.store.redo(); return; }
          if (key === 'f') { event.preventDefault(); RP.sidebar.show('search'); return; }
          // Copy is only ours when the press did not start in a field, where
          // the browser's own copy is the right one.
          if (key === 'c' && !typing) {
            if (RP.clip.copySelection()) event.preventDefault();
            return;
          }
          if (key === 'g') { event.preventDefault(); this.focusPageInput(); return; }
          if (key === 'n' && event.shiftKey) { event.preventDefault(); this.toggleNight(); return; }
          if (key === '0') { event.preventDefault(); RP.viewer.fitMode = null; RP.viewer.setZoom(1); return; }
          if (key === '1') { event.preventDefault(); RP.viewer.fitWidth(); return; }
          if (key === '2') { event.preventDefault(); RP.viewer.fitPage(); return; }
          if (key === '=' || key === '+') { event.preventDefault(); RP.viewer.setZoom(RP.viewer.zoom * 1.2); return; }
          if (key === '-') { event.preventDefault(); RP.viewer.setZoom(RP.viewer.zoom / 1.2); return; }
          if (key === 'a' && !typing) {
            event.preventDefault();
            for (const annot of RP.store.forPage(RP.viewer.currentPage)) RP.store.selection.add(annot.id);
            RP.bus.emit('selection:changed');
            return;
          }
          return;
        }

        if (typing) return;

        if (event.key === 'Escape') {
          if (RP.print.open) { RP.print.hide(); return; }
          if (RP.compare.active) { RP.compare.close(); return; }
          RP.tools.closeNotePopup();
          RP.store.clearSelection();
          RP.tools.setTool('select');
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          this.deleteSelection();
          return;
        }
        if (event.key === 'PageDown') { event.preventDefault(); RP.viewer.goToPage(RP.viewer.currentPage + 1); return; }
        if (event.key === 'PageUp') { event.preventDefault(); RP.viewer.goToPage(RP.viewer.currentPage - 1); return; }
        if (event.key === 'Home') { event.preventDefault(); RP.viewer.goToPage(0); return; }
        if (event.key === 'End') {
          event.preventDefault();
          RP.viewer.goToPage(RP.viewer.pages.length - 1);
          return;
        }
        if (event.key === 'F3') { event.preventDefault(); event.shiftKey ? RP.search.prev() : RP.search.next(); return; }
        // `?` is Shift+/ on most layouts, so match the character, not the code.
        if (event.key === '?') { event.preventDefault(); RP.keys.toggle(); return; }

        const tool = toolKeys[event.key.toLowerCase()];
        if (tool) {
          RP.tools.setTool(tool);
          this.syncSwatchesToTool();
        }
      });
    },

    // -----------------------------------------------------------------------
    // Settings modal
    // -----------------------------------------------------------------------

    wireSettings() {
      const modal = RP.$('#settingsModal');
      const open = () => {
        RP.$('#optBackup').checked = !!this.settings.backupOnOverwrite;
        RP.$('#optAutosave').checked = !!this.settings.autosave;
        RP.$('#optResident').checked = !!this.settings.stayResident;
        RP.$('#optRestoreView').checked = this.settings.restoreView !== false;
        RP.$('#optAuthor').value = this.settings.defaultAuthor || RP.store.author || '';
        RP.$('#optTheme').value = this.settings.theme || 'dark';
        RP.$('#optAutoUpdate').checked = this.settings.autoUpdate !== false;
        RP.$('#appVersionLabel').textContent = 'Version ' + (this.appVersion || '—');
        this.updateSaveModeChip();
        modal.hidden = false;
      };
      RP.$('#btnSettings').addEventListener('click', open);
      RP.$('#settingsClose').addEventListener('click', () => { modal.hidden = true; });
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

      const patch = async (values) => {
        this.settings = await window.rp.settings.patch(values);
        this.updateSaveModeChip();
      };

      RP.$$('input[name="saveMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) { RP.store.saveModeDecided = null; patch({ saveMode: radio.value }); }
        });
      });
      RP.$('#optBackup').addEventListener('change', (e) => patch({ backupOnOverwrite: e.target.checked }));
      RP.$('#optAutosave').addEventListener('change', (e) => {
        patch({ autosave: e.target.checked }).then(() => this.startAutosave());
      });
      RP.$('#optResident').addEventListener('change', (e) => patch({ stayResident: e.target.checked }));
      // Turning updates back on clears any version the user told it to skip,
      // otherwise re-enabling the check would silently stay quiet about it.
      RP.$('#optAutoUpdate').addEventListener('change', (e) => patch(
        e.target.checked ? { autoUpdate: true, skipVersion: null } : { autoUpdate: false }
      ));
      RP.$('#btnCheckUpdates').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        RP.status('Checking for updates…');
        try {
          // Everything worth reading is a native dialog raised by the main
          // process; the toast is only here for the states that show nothing.
          const result = await window.rp.updates.check();
          if (result && result.status === 'busy') RP.toast('A check is already running', 'warn');
        } catch (err) {
          RP.toast('Update check failed: ' + err.message, 'error');
        } finally {
          button.disabled = false;
          RP.status('');
        }
      });
      RP.$('#optRestoreView').addEventListener('change', (e) => patch({ restoreView: e.target.checked }));
      RP.$('#optAuthor').addEventListener('change', (e) => {
        // Every open drawing, not just the one in front — the author is a
        // property of the person, not of the document.
        for (const tab of RP.tabs.all()) tab.store.author = e.target.value;
        RP.store.author = e.target.value;
        patch({ defaultAuthor: e.target.value });
      });
      RP.$('#optTheme').addEventListener('change', (e) => {
        this.applyTheme(e.target.value);
        patch({ theme: e.target.value });
      });
    },

    // -----------------------------------------------------------------------
    // Drag & drop, window chrome, live status
    // -----------------------------------------------------------------------

    wireDragDrop() {
      const veil = RP.$('#dropVeil');
      let depth = 0;
      window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        depth += 1;
        veil.hidden = false;
      });
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        depth = Math.max(0, depth - 1);
        if (!depth) veil.hidden = true;
      });
      window.addEventListener('drop', async (e) => {
        e.preventDefault();
        depth = 0;
        veil.hidden = true;
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        if (!/\.pdf$/i.test(file.name)) { RP.toast('Only PDF files can be opened', 'warn'); return; }
        // Dropping onto a pane opens there, so a drop on the right-hand pane of
        // a split puts the drawing where you aimed it.
        const pane = RP.tabs.paneAt(e.clientX, e.clientY);
        const droppedPath = window.rp.pathForFile(file);
        if (droppedPath) { await this.openPath(droppedPath, { pane }); return; }
        const buffer = await file.arrayBuffer();
        await this.loadDocument({ path: null, name: file.name, bytes: new Uint8Array(buffer) }, { pane });
      });
    },

    wireWindowChrome() {
      RP.$('#winMin').addEventListener('click', () => window.rp.window.minimize());
      RP.$('#winMax').addEventListener('click', () => window.rp.window.toggleMaximize());
      // Same guard as Alt+F4 and the taskbar, rather than a second copy of it.
      RP.$('#winClose').addEventListener('click', () => this.handleCloseRequest());
      window.rp.on.windowState((state) => this.applyWindowState(state));
    },

    applyWindowState(state) {
      const btn = RP.$('#winMax');
      if (!btn) return;
      btn.innerHTML = '';
      btn.appendChild(RP.icon(state && state.maximized ? 'restore' : 'max'));
    },

    wireBusListeners() {
      RP.bus.on('zoom:changed', () => { this.updateStatus(); this.rememberView(); });
      RP.bus.on('page:changed', () => { this.updateStatus(); this.rememberView(); });
      RP.bus.on('scale:changed', () => this.updateStatus());
      RP.bus.on('dirty:changed', () => this.updateTitle());
      RP.bus.on('annots:changed', () => {
        RP.$('#btnUndo').disabled = !RP.store.canUndo();
        RP.$('#btnRedo').disabled = !RP.store.canRedo();
      });
      RP.bus.on('tool:changed', () => this.syncSwatchesToTool());
      RP.bus.on('viewer:ready', () => this.updateStatus());
      RP.bus.on('doc:loaded', () => this.updateStatus());
      RP.bus.on('selection:changed', () => this.updateSelectionStatus());
      // A markup's own text is part of how the status bar describes it, so an
      // edit has to refresh the line as well as a change of selection.
      RP.bus.on('annots:changed', () => this.updateSelectionStatus());
      RP.bus.on('pages:rebuilt', () => this.updateStatus());
    },

    updateTitle() {
      const store = RP.store;
      const open = RP.tabs ? RP.tabs.all().length : 0;
      RP.$('#tbDocName').textContent = store.docName || 'No document';
      RP.$('#tbDirty').hidden = !store.dirty;
      if (RP.tabs) RP.tabs.syncStrip();
      window.rp.window.setTitle(
        (store.dirty ? '• ' : '') + (store.docName || 'Redline PDF') +
        (open > 1 ? '  (' + open + ' open)' : '') + ' — Redline PDF'
      );
    },

    /** Ctrl+G. Selecting the contents means you can just type the sheet number. */
    focusPageInput() {
      const input = RP.$('#pageInput');
      if (!input || input.disabled) { RP.status('Open a drawing first', 'warn'); return; }
      input.focus();
      input.select();
    },

    updateStatus() {
      const store = RP.store;
      if (!RP.viewer) return;
      const zoomPct = Math.round(RP.viewer.zoom * 100);
      RP.$('#zoomInput').value = String(zoomPct);
      RP.$('#stZoom').textContent = zoomPct + '%' +
        (RP.viewer.fitMode === 'width' ? '  fit width'
          : RP.viewer.fitMode === 'page' ? '  fit page' : '');

      // The page box is an input, so it must not be rewritten under someone
      // who is halfway through typing a sheet number into it.
      const pageInput = RP.$('#pageInput');
      const pageOf = RP.$('#stPageOf');
      if (pageInput && document.activeElement !== pageInput) {
        pageInput.value = store.numPages ? String(RP.viewer.currentPage + 1) : '';
      }
      if (pageInput) pageInput.disabled = !store.numPages;
      if (pageOf) pageOf.textContent = 'of ' + (store.numPages || '—');

      RP.$('#stScale').textContent = store.scale
        ? 'Scale: 1 pt = ' + (store.scale.realLength / store.scale.pdfLength).toPrecision(3) + ' ' + store.scale.unit
        : 'Scale: not calibrated';

      this.updateDims();
      this.updateSelectionStatus();
    },

    /**
     * The current sheet's size. Read off the *unscaled* viewport so it reports
     * the paper, not the zoom, and rounded to the nearest tenth of an inch
     * because plotted sheets are never exactly 34.000 in.
     */
    updateDims() {
      const node = RP.$('#stDims');
      if (!node) return;
      const record = RP.viewer.pages[RP.viewer.currentPage];
      if (!record || !record.baseViewport) { node.textContent = ''; return; }
      const w = record.baseViewport.width / 72;
      const h = record.baseViewport.height / 72;
      const round = (n) => (Math.round(n * 10) / 10).toFixed(1);
      node.textContent = round(w) + ' × ' + round(h) + ' in';
      node.title = 'Sheet size: ' +
        Math.round(record.baseViewport.width) + ' × ' + Math.round(record.baseViewport.height) + ' pt';
    },

    /** What is selected, in one line, so the status bar answers "what is this". */
    updateSelectionStatus() {
      const node = RP.$('#stSel');
      if (!node) return;
      const selected = RP.store.selected();
      if (!selected.length) { node.textContent = ''; node.title = ''; return; }
      if (selected.length > 1) {
        node.textContent = selected.length + ' markups selected';
        node.title = '';
        return;
      }
      const annot = selected[0];
      const body = RP.sidebar.describe(annot);
      node.textContent = RP.store.typeLabel(annot.type) + (body ? ' — ' + body : '');
      node.title = node.textContent;
    }
  };

  function FALLBACK_SETTINGS() {
    return {
      theme: 'dark', saveMode: 'copy', backupOnOverwrite: true, autosave: false,
      autosaveIntervalMs: 60000, stayResident: false, defaultAuthor: '',
      restoreView: true, nightMode: false, autoUpdate: true, skipVersion: null, recents: []
    };
  }

  RP.app = App;

  window.addEventListener('DOMContentLoaded', () => {
    App.boot().catch((err) => {
      console.error('Startup failed', err);
      RP.diag.banner('Startup failed', err.message + ' — click Diagnostics for the details.');
    });
  });

})(window.RP);
