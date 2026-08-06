/**
 * print.js — the print dialog and the bytes that back it.
 *
 * Why this exists: printing a drawing is not "screenshot the canvas". The
 * canvas is a zoom-dependent raster, so printing it would hand the plotter
 * whatever resolution the user happened to be zoomed to. Everything here goes
 * through pdf-lib instead, so the printer receives the same vector content the
 * file holds, and a page that measures 1/4" = 1'-0" still measures that on
 * paper.
 *
 * The renderer decides *what* to print and produces finished bytes; main.js
 * only moves those bytes into a preview window and opens the OS dialog.
 */
(function (RP) {
  'use strict';

  function lib() {
    if (!window.PDFLib) throw new Error('pdf-lib is not loaded');
    return window.PDFLib;
  }

  // Paper sizes in PDF points (72/inch), portrait. Engineering sheets are here
  // because "fit to Letter" is not the only thing an electrical drawing gets
  // sent to.
  const PAPER = {
    letter:  { label: 'Letter — 8.5 × 11 in',  w: 612,    h: 792 },
    legal:   { label: 'Legal — 8.5 × 14 in',   w: 612,    h: 1008 },
    tabloid: { label: 'Tabloid — 11 × 17 in',  w: 792,    h: 1224 },
    a4:      { label: 'A4 — 210 × 297 mm',     w: 595.28, h: 841.89 },
    a3:      { label: 'A3 — 297 × 420 mm',     w: 841.89, h: 1190.55 },
    archc:   { label: 'ARCH C — 18 × 24 in',   w: 1296,   h: 1728 },
    archd:   { label: 'ARCH D — 24 × 36 in',   w: 1728,   h: 2592 }
  };

  const Print = {
    els: {},
    open: false,
    busy: false,

    // Defaults: actual size, because a scaled drawing that silently shrank to
    // fit Letter is a drawing someone will mis-measure off.
    opts: {
      range: 'all',       // 'all' | 'current' | 'visible' | 'custom'
      custom: '',
      markups: true,
      scale: 'actual',    // 'actual' | 'fit'
      paper: 'letter'
    },

    init() {
      this.els = {
        modal: RP.$('#printModal'),
        close: RP.$('#printClose'),
        cancel: RP.$('#printCancel'),
        go: RP.$('#printGo'),
        custom: RP.$('#printCustom'),
        paper: RP.$('#printPaper'),
        paperRow: RP.$('#printPaperRow'),
        markups: RP.$('#printMarkups'),
        summary: RP.$('#printSummary'),
        warn: RP.$('#printWarn')
      };
      if (!this.els.modal) return;

      const paper = this.els.paper;
      for (const [key, spec] of Object.entries(PAPER)) {
        paper.appendChild(RP.el('option', { value: key, text: spec.label }));
      }

      this.els.close.addEventListener('click', () => this.hide());
      this.els.cancel.addEventListener('click', () => this.hide());
      this.els.go.addEventListener('click', () => this.run());
      this.els.modal.addEventListener('mousedown', (event) => {
        if (event.target === this.els.modal) this.hide();
      });

      RP.$$('input[name="printRange"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          this.opts.range = radio.value;
          if (radio.value === 'custom') this.els.custom.focus();
          this.sync();
        });
      });
      RP.$$('input[name="printScale"]').forEach((radio) => {
        radio.addEventListener('change', () => { this.opts.scale = radio.value; this.sync(); });
      });
      this.els.custom.addEventListener('input', () => {
        this.opts.custom = this.els.custom.value;
        // Typing a range should select the radio that uses it.
        const radio = RP.$('input[name="printRange"][value="custom"]');
        if (radio && !radio.checked) { radio.checked = true; this.opts.range = 'custom'; }
        this.sync();
      });
      this.els.paper.addEventListener('change', () => { this.opts.paper = this.els.paper.value; this.sync(); });
      this.els.markups.addEventListener('change', () => { this.opts.markups = this.els.markups.checked; this.sync(); });

      this.els.modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); this.hide(); }
        if (event.key === 'Enter' && !this.busy) { event.preventDefault(); this.run(); }
      });

      RP.bus.on('doc:reset', () => this.hide());
    },

    // -----------------------------------------------------------------------
    // Page ranges
    // -----------------------------------------------------------------------

    /** Pages currently intersecting the viewport, in document order. */
    visiblePages() {
      const records = (RP.viewer && RP.viewer.pages) || [];
      const shown = records.filter((record) => record && record.visible).map((record) => record.index);
      return shown.length ? shown : [RP.viewer ? RP.viewer.currentPage : 0];
    },

    /** Parse "1-3, 5, 9-" into zero-based indices. Returns null if unusable. */
    parseCustom(text, count) {
      const out = [];
      const seen = new Set();
      const parts = String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return null;
      for (const part of parts) {
        const match = /^(\d+)?\s*(?:[-–]\s*(\d+)?)?$/.exec(part);
        if (!match) return null;
        const hasDash = /[-–]/.test(part);
        let from = match[1] ? parseInt(match[1], 10) : 1;
        let to = hasDash ? (match[2] ? parseInt(match[2], 10) : count) : from;
        if (!match[1] && !hasDash) return null;
        if (from > to) { const swap = from; from = to; to = swap; }
        for (let n = from; n <= to; n += 1) {
          const index = n - 1;
          if (index < 0 || index >= count) continue;
          if (seen.has(index)) continue;
          seen.add(index);
          out.push(index);
        }
      }
      return out.length ? out : null;
    },

    /** Zero-based page indices the current options select, or null if invalid. */
    resolvePages() {
      const count = RP.store.numPages || 0;
      if (!count) return null;
      switch (this.opts.range) {
        case 'current': return [RP.clamp(RP.viewer.currentPage, 0, count - 1)];
        case 'visible': return this.visiblePages().filter((i) => i >= 0 && i < count);
        case 'custom': return this.parseCustom(this.opts.custom, count);
        default: return Array.from({ length: count }, (unused, i) => i);
      }
    },

    // -----------------------------------------------------------------------
    // UI
    // -----------------------------------------------------------------------

    show() {
      if (!RP.store.doc) { RP.toast('Open a drawing first', 'warn'); return; }
      /* Printing goes through pdf-lib exactly as saving does — `buildPdf` for
         markups-on, `RP.pages.buildBytes` for markups-off — and pdf-lib cannot
         rewrite an encrypted file. The preview would come up empty or damaged,
         which on the way to a plotter is worse than being told no. */
      if (RP.store.encrypted) {
        RP.toast('A password-protected drawing cannot be printed from here — open an unprotected copy', 'warn');
        return;
      }
      if (!this.els.modal) return;
      this.opts.markups = this.els.markups.checked = !!RP.store.annotations.length;
      this.els.modal.hidden = false;
      this.open = true;
      this.sync();
      const checked = RP.$('input[name="printRange"]:checked');
      if (checked) checked.focus();
    },

    hide() {
      if (!this.els.modal) return;
      this.els.modal.hidden = true;
      this.open = false;
    },

    toggle() { this.open ? this.hide() : this.show(); },

    sync() {
      if (!this.els.modal || this.els.modal.hidden) return;
      const fit = this.opts.scale === 'fit';
      this.els.paperRow.hidden = !fit;

      const pages = this.resolvePages();
      const count = pages ? pages.length : 0;
      this.els.go.disabled = this.busy || !count;
      this.els.summary.textContent = !pages
        ? 'That page range does not match any pages.'
        : count === 1
          ? 'Printing 1 page' + (this.opts.markups ? ' with markups.' : ', markups hidden.')
          : 'Printing ' + count + ' pages' + (this.opts.markups ? ' with markups.' : ', markups hidden.');

      // Say the quiet part out loud: fitting rescales the drawing.
      this.els.warn.hidden = !fit;
    },

    // -----------------------------------------------------------------------
    // Bytes
    // -----------------------------------------------------------------------

    /**
     * The document as it should print, before any range or scale work.
     * With markups on this is the exporter's stamped output with `embed:false`
     * — a print copy has no business carrying the RedlineMarkup catalog entry.
     * With markups off it is rebuilt from the *stripped* base bytes, never from
     * `docBytes`, which may still have a previous save's stamps in its content
     * streams.
     */
    async sourceBytes() {
      const store = RP.store;
      if (this.opts.markups) return RP.exporter.buildPdf({ embed: false });
      await RP.pages.ensureBase();
      return RP.pages.buildBytes(store.baseBytes, store.pageOrder, store.sources);
    },

    /**
     * Copy the wanted pages into a fresh document, optionally rescaling each
     * onto a sheet of `paper`.
     *
     * Rotation is the trap here. `/Rotate` is applied *after* the content
     * stream, so all of the scaling maths has to happen in unrotated user
     * space: we work out how big the sheet needs to be before rotation, fit
     * the content into that, and let `/Rotate` (which `copyPages` preserves)
     * turn it on the paper as it always did. `embedPage` would have dropped
     * the rotation entirely and printed landscape sheets sideways.
     */
    async layout(bytes, pages, fitTo) {
      const { PDFDocument } = lib();
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const available = src.getPageCount();
      const wanted = pages.filter((index) => index >= 0 && index < available);
      if (!wanted.length) throw new Error('No printable pages in that range');

      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, wanted);

      for (const page of copied) {
        if (fitTo) this.fitPageTo(page, fitTo);
        out.addPage(page);
      }

      out.setProducer('Redline PDF');
      out.setTitle(RP.stripExt(RP.store.docName || 'drawing'));
      return out.save({ useObjectStreams: false });
    },

    /** Scale one page's content down onto `paper`, centred, rotation-aware. */
    fitPageTo(page, paper) {
      const box = page.getMediaBox();
      const width = box.width;
      const height = box.height;
      if (!width || !height) return;

      const rotation = ((page.getRotation().angle % 360) + 360) % 360;
      const turned = rotation === 90 || rotation === 270;

      // Pick the paper orientation that matches how the sheet is displayed,
      // then convert back into unrotated space to do the maths.
      const shownW = turned ? height : width;
      const shownH = turned ? width : height;
      const landscape = shownW > shownH;
      const paperW = landscape ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h);
      const paperH = landscape ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h);
      const targetW = turned ? paperH : paperW;
      const targetH = turned ? paperW : paperH;

      const factor = Math.min(targetW / width, targetH / height);

      // Move the content to the origin first: a CropBox-offset MediaBox would
      // otherwise scale its own offset and drift off the sheet.
      page.translateContent(-box.x, -box.y);
      page.scaleContent(factor, factor);
      page.translateContent((targetW - width * factor) / 2, (targetH - height * factor) / 2);
      page.setMediaBox(0, 0, targetW, targetH);
      page.setCropBox(0, 0, targetW, targetH);
      if (page.getBleedBox) {
        try { page.setBleedBox(0, 0, targetW, targetH); } catch (err) { /* optional box */ }
        try { page.setTrimBox(0, 0, targetW, targetH); } catch (err) { /* optional box */ }
      }
    },

    // -----------------------------------------------------------------------
    // Go
    // -----------------------------------------------------------------------

    async run() {
      if (this.busy) return;
      const pages = this.resolvePages();
      if (!pages || !pages.length) { RP.toast('That page range does not match any pages', 'warn'); return; }

      this.busy = true;
      this.els.go.disabled = true;
      RP.status('Preparing print…');
      try {
        const source = await this.sourceBytes();
        const fitTo = this.opts.scale === 'fit' ? PAPER[this.opts.paper] : null;
        const bytes = await this.layout(source, pages, fitTo);
        const name = RP.stripExt(RP.store.docName || 'drawing') + '.pdf';
        this.hide();
        await window.rp.print.document(bytes, name);
        RP.status('');
      } catch (err) {
        console.error(err);
        RP.status('');
        RP.toast('Could not prepare the print: ' + err.message, 'error');
      } finally {
        this.busy = false;
        if (this.els.go) this.els.go.disabled = false;
      }
    }
  };

  RP.print = Print;
  RP.print.PAPER = PAPER;

})(window.RP);
