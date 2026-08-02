/* Continuous-scroll PDF viewer: lazy page rendering, HiDPI canvases,
   a real text layer for selection/search, and a per-page annotation overlay.

   One viewer per *pane*, not per document. A pane owns a scroll container and
   the page DOM inside it; `RP.viewer` is a live pointer to the focused pane's
   viewer, reassigned alongside `RP.store` (see tabs.js). Switching tabs inside
   a pane tears the page DOM down and rebuilds it from the incoming document's
   pdf.js proxies — pdf.js caches those on the PDFDocumentProxy, so this is a
   re-layout, not a re-parse.

   A viewer draws `this.store`, never `RP.store`: in a split, the pane you are
   not focused on still has to paint its own document's markups. Anything that
   belongs to the shared chrome instead — thumbnails, search hit flashes, the
   in-progress tool preview — is gated on `isActive()`. */
'use strict';

(function (RP) {

  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;
  const THUMB_WIDTH = 190;

  /**
   * @param {HTMLElement} root a `.pane` element holding `.viewer > .pages`
   * @param {object} store the document store this pane is currently showing
   */
  function createViewer(root, store) {

  const Viewer = {
    root,
    store: store || RP.store,
    zoom: 1,
    rotation: 0,
    fitMode: 'width',
    pages: [],          // page records, index 0-based
    currentPage: 0,
    dpr: Math.min(window.devicePixelRatio || 1, 2),

    els: {},

    /** True when this pane is the one the toolbar and sidebar act on. */
    isActive() { return RP.viewer === this; },

    /** Bus events describe the focused pane only; a background pane is silent. */
    emit(name, detail) {
      if (!this.isActive()) return;
      RP.bus.emit(name, detail);
    },

    init() {
      this.els.viewer = this.root.querySelector('.viewer');
      this.els.pages = this.root.querySelector('.pages');
      this.els.thumbs = RP.$('#thumbList');
      this.els.empty = RP.$('#emptyState');

      this.pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.page);
          const record = this.pages[index];
          if (!record) continue;
          record.visible = entry.isIntersecting;
          if (entry.isIntersecting) this.renderPage(index);
        }
      }, { root: this.els.viewer, rootMargin: '600px 0px' });

      this.thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.renderThumb(Number(entry.target.dataset.page));
        }
      }, { root: this.els.thumbs, rootMargin: '400px 0px' });

      this.els.viewer.addEventListener('scroll', RP.throttleRaf(() => this.onScroll()), { passive: true });

      /* Zoom by wheel and by trackpad.

         A pinch on a precision trackpad reaches the page as a wheel event with
         `ctrlKey` synthesised by the OS — the same shape as a real Ctrl+wheel,
         which is why one handler covers both. The difference is granularity: a
         mouse notch arrives as one large deltaY, a pinch as a stream of small
         ones. Using the fixed 1.12 step for both makes a pinch feel like it
         leaps, so the factor is derived from the delta and only clamped at the
         ends, which leaves a mouse notch at roughly its old step. */
      this.els.viewer.addEventListener('wheel', (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        // deltaMode 1 is lines, 2 is pages; normalise both to pixel-ish units.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
        const delta = RP.clamp(event.deltaY * unit, -80, 80);
        const factor = Math.exp(-delta / 340);
        this.setZoom(this.zoom * factor, { anchor: { x: event.clientX, y: event.clientY } });
      }, { passive: false });

      /* Safari/Chromium also emit non-standard gesture events for a trackpad
         pinch on some platforms, and they arrive *instead of* the wheel stream
         rather than alongside it. Harmless where they never fire. */
      let gestureBase = 1;
      this.els.viewer.addEventListener('gesturestart', (event) => {
        event.preventDefault();
        gestureBase = this.zoom;
      });
      this.els.viewer.addEventListener('gesturechange', (event) => {
        event.preventDefault();
        // These events carry no coordinates on some builds; fall back to the
        // pane centre, which is what `setZoom` uses when given no anchor.
        const anchor = Number.isFinite(event.clientX)
          ? { x: event.clientX, y: event.clientY }
          : null;
        this.setZoom(gestureBase * event.scale, anchor ? { anchor } : {});
      });

      window.addEventListener('resize', RP.debounce(() => {
        if (this.fitMode) this.applyFit();
      }, 120));

      // Only the focused pane's document can have changed under these, and a
      // background pane's canvases are already correct for its own store.
      RP.bus.on('annots:changed', () => { if (this.isActive()) this.redrawAll(); });
      RP.bus.on('selection:changed', () => { if (this.isActive()) this.redrawAll(); });
      return this;
    },

    // -- document ----------------------------------------------------------

    /**
     * Scroll offset is not derivable from zoom and page number — at 400% on an
     * E-size sheet the horizontal position is most of what you were looking at
     * — so it is captured here and restored verbatim after the rebuild.
     */
    viewState() {
      return {
        zoom: this.zoom,
        rotation: this.rotation,
        fitMode: this.fitMode,
        currentPage: this.currentPage,
        scrollTop: this.els.viewer ? this.els.viewer.scrollTop : 0,
        scrollLeft: this.els.viewer ? this.els.viewer.scrollLeft : 0
      };
    },

    /** Re-apply a `viewState()`. Call after `open()` has laid the pages out. */
    applyViewState(state) {
      if (!state || !this.pages.length) return false;
      this.rotation = state.rotation || 0;
      if (Number.isFinite(state.zoom) && state.zoom > 0) {
        // Explicitly cleared: setZoom bails out early when the incoming zoom
        // matches the fit it just applied, which would leave fitMode set and
        // let the next resize snap the drawing back to fit-width.
        this.fitMode = null;
        this.setZoom(state.zoom);
      }
      this.fitMode = state.fitMode || null;
      this.currentPage = RP.clamp(state.currentPage || 0, 0, this.pages.length - 1);
      this.els.viewer.scrollTop = state.scrollTop || 0;
      this.els.viewer.scrollLeft = state.scrollLeft || 0;
      this.highlightThumb();
      this.emit('page:changed', this.currentPage);
      return true;
    },

    async open(doc, store) {
      if (store) this.store = store;
      this.destroyPages();
      if (this.els.empty) this.els.empty.hidden = true;
      const count = doc.numPages;
      const records = [];

      for (let i = 0; i < count; i += 1) {
        const pageProxy = await doc.getPage(i + 1);
        const baseViewport = pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(pageProxy) });
        const container = RP.el('div', { class: 'page', 'data-page': String(i) });
        const pdfCanvas = RP.el('canvas', { class: 'pdf-canvas' });
        const textLayer = RP.el('div', { class: 'text-layer' });
        // The annotations that came with the file, between the text layer and
        // our own markup canvas. RP.annots owns everything inside it.
        const nativeLayer = RP.el('div', { class: RP.annots.LAYER_CLASS, hidden: true });
        const annotCanvas = RP.el('canvas', { class: 'annot-canvas' });
        const inkLayer = RP.el('div', { class: 'ink-layer' });
        const tag = RP.el('span', { class: 'page-tag', text: 'Page ' + (i + 1) });
        container.append(pdfCanvas, textLayer, nativeLayer, annotCanvas, inkLayer, tag);
        this.els.pages.appendChild(container);

        records.push({
          index: i,
          pageProxy,
          baseViewport,
          viewport: null,
          container,
          pdfCanvas,
          annotCanvas,
          textLayer,
          nativeLayer,
          inkLayer,
          rendered: false,
          renderTask: null,
          textContent: null,
          nativeAnnots: null,     // parsed once, the DOM is rebuilt per zoom
          nativeLayerObj: null,
          annotCanvasMap: null,
          visible: false
        });
      }

      this.pages = records;
      this.currentPage = 0;
      this.layout();
      for (const record of records) this.pageObserver.observe(record.container);
      this.buildThumbs();
      this.applyFit();
      this.emit('viewer:ready', this);
    },

    destroyPages() {
      for (const record of this.pages) {
        if (record.renderTask) { try { record.renderTask.cancel(); } catch (err) { /* ignore */ } }
        if (record.nativeLayerObj) { try { record.nativeLayerObj.destroy(); } catch (err) { /* ignore */ } }
        this.pageObserver.unobserve(record.container);
      }
      this.pages = [];
      this.els.pages.innerHTML = '';
      if (this.els.thumbs) this.els.thumbs.innerHTML = '';
    },

    /** Empty the pane. Whether the empty state shows is RP.tabs' decision — a
        pane with no document in a split is closed, not left blank. */
    close() {
      this.destroyPages();
      this.store = RP.createStore();
    },

    /** Drop everything this pane holds, including its observers. */
    destroy() {
      this.destroyPages();
      if (this.pageObserver) this.pageObserver.disconnect();
      if (this.thumbObserver) this.thumbObserver.disconnect();
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    },

    // -- layout / zoom -----------------------------------------------------

    /**
     * A page's own /Rotate plus whatever the user has turned the view by.
     * pdf.js takes `rotation` as an absolute value, so passing the view
     * rotation alone would quietly flatten pages that are stored rotated —
     * which is most scanned or plotted drawings.
     */
    rotationOf(pageProxy) {
      return (((pageProxy && pageProxy.rotate) || 0) + this.rotation + 360) % 360;
    },

    layout() {
      for (const record of this.pages) {
        const viewport = record.pageProxy.getViewport({
          scale: this.zoom, rotation: this.rotationOf(record.pageProxy)
        });
        record.viewport = viewport;
        const w = Math.floor(viewport.width);
        const h = Math.floor(viewport.height);
        record.container.style.width = w + 'px';
        record.container.style.height = h + 'px';
        // PDF.js text layers are positioned with CSS custom properties. v3 uses
        // --scale-factor, v4+ uses --total-scale-factor and rounds against
        // --scale-round-*, which must be defined or the calc() is invalid.
        record.container.style.setProperty('--scale-factor', String(this.zoom));
        record.container.style.setProperty('--total-scale-factor', String(this.zoom));
        record.container.style.setProperty('--scale-round-x', '1px');
        record.container.style.setProperty('--scale-round-y', '1px');
        for (const canvas of [record.pdfCanvas, record.annotCanvas]) {
          canvas.style.width = w + 'px';
          canvas.style.height = h + 'px';
        }
        record.rendered = false;
        if (record.renderTask) { try { record.renderTask.cancel(); } catch (err) { /* ignore */ } }
        record.renderTask = null;
      }
      for (const record of this.pages) {
        if (record.visible) this.renderPage(record.index);
      }
      this.redrawAll();
      this.emit('zoom:changed', this.zoom);
    },

    setZoom(value, opts) {
      const options = opts || {};
      const next = RP.clamp(value, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(next - this.zoom) < 0.0005) return;

      const viewerEl = this.els.viewer;
      const anchor = options.anchor || {
        x: viewerEl.getBoundingClientRect().left + viewerEl.clientWidth / 2,
        y: viewerEl.getBoundingClientRect().top + viewerEl.clientHeight / 2
      };
      const rect = viewerEl.getBoundingClientRect();
      const relX = anchor.x - rect.left + viewerEl.scrollLeft;
      const relY = anchor.y - rect.top + viewerEl.scrollTop;
      const ratio = next / this.zoom;

      this.zoom = next;
      if (!options.keepFit) this.fitMode = null;
      this.layout();

      viewerEl.scrollLeft = relX * ratio - (anchor.x - rect.left);
      viewerEl.scrollTop = relY * ratio - (anchor.y - rect.top);
    },

    applyFit() {
      if (!this.pages.length || !this.fitMode) return;
      const record = this.pages[this.currentPage] || this.pages[0];
      const available = this.els.viewer.clientWidth - 60;
      const availableH = this.els.viewer.clientHeight - 60;
      const base = record.pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(record.pageProxy) });
      let target = available / base.width;
      if (this.fitMode === 'page') target = Math.min(target, availableH / base.height);
      const mode = this.fitMode;
      this.setZoom(target, { keepFit: true });
      this.fitMode = mode;
    },

    fitWidth() { this.fitMode = 'width'; this.applyFit(); },
    fitPage() { this.fitMode = 'page'; this.applyFit(); },

    /**
     * Zoom so a PDF-space rect on `pageIndex` fills the viewport.
     *
     * The factor is worked out in CSS pixels at the *current* zoom, because
     * that is the space `vpRect` reports in and it already accounts for page
     * rotation. Scrolling is left to `revealRect`, which runs after `layout()`
     * has rebuilt the viewports, so it centres against the new geometry.
     */
    zoomToRect(pageIndex, rect) {
      const record = this.pages[pageIndex];
      if (!record || !record.viewport || !rect) return;
      const view = RP.render.vpRect(record.viewport, rect);
      if (view.w < 2 || view.h < 2) return;

      const padding = 28;
      const availableW = Math.max(60, this.els.viewer.clientWidth - padding);
      const availableH = Math.max(60, this.els.viewer.clientHeight - padding);
      const factor = Math.min(availableW / view.w, availableH / view.h);

      this.fitMode = null;
      this.setZoom(this.zoom * factor);
      this.revealRect(pageIndex, rect, { instant: true });
    },

    rotate() {
      this.rotation = (this.rotation + 90) % 360;
      for (const record of this.pages) {
        record.baseViewport = record.pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(record.pageProxy) });
      }
      this.layout();
      this.buildThumbs();
    },

    // -- rendering ---------------------------------------------------------

    async renderPage(index) {
      const record = this.pages[index];
      if (!record || record.rendered || record.renderTask) return;
      const viewport = record.viewport;
      const dpr = this.dpr;

      record.container.classList.add('rendering');
      record.pdfCanvas.width = Math.floor(viewport.width * dpr);
      record.pdfCanvas.height = Math.floor(viewport.height * dpr);
      record.annotCanvas.width = record.pdfCanvas.width;
      record.annotCanvas.height = record.pdfCanvas.height;

      const ctx = record.pdfCanvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, record.pdfCanvas.width, record.pdfCanvas.height);

      // Some native annotations (Bluebeam stamps, free text with its own
      // appearance) are rendered onto a canvas of their own rather than into
      // the page content. pdf.js hands those back through this map and the
      // annotation layer adopts them; without it they are simply missing.
      record.annotCanvasMap = new Map();

      const task = record.pageProxy.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        annotationCanvasMap: record.annotCanvasMap
      });
      record.renderTask = task;

      try {
        await task.promise;
        record.rendered = true;
        record.container.classList.remove('rendering');
        await this.buildTextLayer(record);
        await RP.annots.build(record);
        this.redrawPage(index);
      } catch (err) {
        if (!err || err.name !== 'RenderingCancelledException') console.error('Page render failed', err);
        record.container.classList.remove('rendering');
      } finally {
        record.renderTask = null;
      }
    },

    async buildTextLayer(record) {
      if (!record.textContent) {
        try {
          record.textContent = await record.pageProxy.getTextContent();
        } catch (err) {
          record.textContent = { items: [], styles: {} };
        }
      }
      record.textLayer.innerHTML = '';
      record.textDivs = [];
      try {
        if (RP.pdfjs.hasTextLayerClass()) {
          // pdf.js v4+
          const layer = new pdfjsLib.TextLayer({
            textContentSource: record.textContent,
            container: record.textLayer,
            viewport: record.viewport
          });
          await layer.render();
          record.textDivs = layer.textDivs || [];
        } else {
          // pdf.js v3
          const task = pdfjsLib.renderTextLayer({
            textContentSource: record.textContent,
            textContent: record.textContent,
            container: record.textLayer,
            viewport: record.viewport,
            textDivs: record.textDivs
          });
          await (task && task.promise ? task.promise : task);
        }
      } catch (err) {
        // A missing text layer only costs selection/search on that page.
        console.warn('Text layer failed on page ' + (record.index + 1), err);
      }
      this.emit('textlayer:ready', record);
    },

    redrawPage(index) {
      const record = this.pages[index];
      if (!record || !record.viewport) return;
      const canvas = record.annotCanvas;
      if (!canvas.width) return;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const store = this.store;
      for (const annot of store.forPage(index)) {
        RP.render.drawAnnotation(ctx, annot, record.viewport, {
          selected: store.selection.has(annot.id)
        });
      }
      if (this.isActive()) {
        if (RP.search && RP.search.drawHits) RP.search.drawHits(ctx, record);
        if (RP.tools && RP.tools.drawPreview) RP.tools.drawPreview(ctx, record);
      }
    },

    redrawAll() {
      for (const record of this.pages) {
        if (record.visible || record.rendered) this.redrawPage(record.index);
      }
      this.updateThumbBadges();
    },

    // -- navigation --------------------------------------------------------

    onScroll() {
      if (!this.pages.length) return;
      const viewerRect = this.els.viewer.getBoundingClientRect();
      const probe = viewerRect.top + Math.min(140, viewerRect.height * 0.3);
      let current = this.currentPage;
      for (const record of this.pages) {
        const rect = record.container.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom >= probe) { current = record.index; break; }
        if (rect.top > probe) { current = Math.max(0, record.index - 1); break; }
        current = record.index;
      }
      if (current !== this.currentPage) {
        this.currentPage = current;
        this.highlightThumb();
        this.emit('page:changed', current);
      }
    },

    goToPage(index, opts) {
      const record = this.pages[RP.clamp(index, 0, this.pages.length - 1)];
      if (!record) return;
      const behavior = opts && opts.instant ? 'auto' : 'smooth';
      const top = record.container.offsetTop - 16;
      this.els.viewer.scrollTo({ top, behavior });
      this.currentPage = record.index;
      this.highlightThumb();
      this.emit('page:changed', record.index);
    },

    /** Scroll so a PDF-space rect on `pageIndex` is centred and flash it. */
    revealRect(pageIndex, rect, opts) {
      const record = this.pages[pageIndex];
      if (!record) return;
      const view = RP.render.vpRect(record.viewport, rect);
      const viewer = this.els.viewer;
      const targetTop = record.container.offsetTop + view.y - viewer.clientHeight / 2 + view.h / 2;
      const targetLeft = record.container.offsetLeft + view.x - viewer.clientWidth / 2 + view.w / 2;
      viewer.scrollTo({
        top: Math.max(0, targetTop),
        left: Math.max(0, targetLeft),
        behavior: (opts && opts.instant) ? 'auto' : 'smooth'
      });
      this.currentPage = pageIndex;
      this.highlightThumb();
    },

    // -- coordinate helpers ------------------------------------------------

    /** Client (mouse) coords -> PDF user-space point on a given page. */
    clientToPdf(record, clientX, clientY) {
      const rect = record.container.getBoundingClientRect();
      const p = record.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
      return [p[0], p[1]];
    },

    /** Length in CSS px -> length in PDF points. */
    pxToPdf(px) { return px / this.zoom; },

    pageAt(clientX, clientY) {
      for (const record of this.pages) {
        const rect = record.container.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return record;
        }
      }
      return null;
    },

    // -- thumbnails --------------------------------------------------------

    buildThumbs() {
      const host = this.els.thumbs;
      if (!host || !this.isActive()) return;
      host.innerHTML = '';
      for (const record of this.pages) {
        const base = record.pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(record.pageProxy) });
        const scale = THUMB_WIDTH / base.width;
        const canvas = RP.el('canvas');
        canvas.width = Math.floor(base.width * scale);
        canvas.height = Math.floor(base.height * scale);
        const button = RP.el('button', {
          class: 'thumb placeholder',
          'data-page': String(record.index),
          onclick: (event) => {
            // The page manager claims modifier-clicks for multi-select; a plain
            // click still means "take me to that page".
            if (RP.pages && RP.pages.handleThumbClick(record.index, event)) return;
            this.goToPage(record.index);
          }
        }, [canvas, RP.el('span', { class: 'thumb-label', text: String(record.index + 1) })]);
        host.appendChild(button);
        record.thumbButton = button;
        record.thumbCanvas = canvas;
        record.thumbScale = scale;
        record.thumbRendered = false;
        this.thumbObserver.observe(button);
      }
      const count = RP.$('#thumbCount');
      if (count) count.textContent = this.pages.length + ' pages';
      this.highlightThumb();
      this.updateThumbBadges();
      this.emit('thumbs:built', this.pages.length);
    },

    async renderThumb(index) {
      const record = this.pages[index];
      if (!record || record.thumbRendered || !record.thumbCanvas) return;
      record.thumbRendered = true;
      const viewport = record.pageProxy.getViewport({
        scale: record.thumbScale, rotation: this.rotationOf(record.pageProxy)
      });
      const ctx = record.thumbCanvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, record.thumbCanvas.width, record.thumbCanvas.height);
      try {
        await record.pageProxy.render({ canvasContext: ctx, viewport }).promise;
        record.thumbButton.classList.remove('placeholder');
      } catch (err) {
        record.thumbRendered = false;
      }
    },

    highlightThumb() {
      if (!this.isActive()) return;
      for (const record of this.pages) {
        if (!record.thumbButton) continue;
        record.thumbButton.classList.toggle('current', record.index === this.currentPage);
      }
      const current = this.pages[this.currentPage];
      if (current && current.thumbButton) {
        const host = this.els.thumbs;
        const top = current.thumbButton.offsetTop;
        if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - 60) {
          host.scrollTo({ top: top - host.clientHeight / 2, behavior: 'smooth' });
        }
      }
    },

    updateThumbBadges() {
      if (!this.isActive()) return;
      const counts = new Map();
      for (const annot of this.store.annotations) {
        counts.set(annot.page, (counts.get(annot.page) || 0) + 1);
      }
      for (const record of this.pages) {
        if (!record.thumbButton) continue;
        const existing = record.thumbButton.querySelector('.thumb-badge');
        const count = counts.get(record.index) || 0;
        if (!count) { if (existing) existing.remove(); continue; }
        if (existing) existing.textContent = String(count);
        else record.thumbButton.appendChild(RP.el('span', { class: 'thumb-badge', text: String(count) }));
      }
    }
  };

    return Viewer;
  }

  RP.createViewer = createViewer;
  /* Set by RP.panes once the first pane exists; until then nothing can call it. */
  RP.viewer = null;
  RP.MIN_ZOOM = MIN_ZOOM;
  RP.MAX_ZOOM = MAX_ZOOM;

})(window.RP);
