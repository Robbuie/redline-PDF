/* PDF viewer: lazy page rendering, HiDPI canvases, a real text layer for
   selection/search, and a per-page annotation overlay.

   The page column is a list of *rows*, not of pages. A row holds one page in
   the single-page modes and two in a facing spread, and `RP.views` decides the
   grouping — including the cover page sitting alone, which is why a page's row
   is never `index >> 1`. In the paged modes only the current row is in the
   column at all; the rest are `hidden`, which is also what makes the
   IntersectionObserver release their canvases without a special case.

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

  /* Canvas retention.

     Nothing frees a page canvas on its own: a page that scrolls out of range
     keeps its bitmap at full resolution. An E-size sheet at fit-width on a
     1600px pane is ~13 megapixels per canvas and there are two per page, so a
     77-sheet set scrolled end to end is well over a gigabyte of live backing
     store. Chromium starts evicting under that and every subsequent render
     crawls — which reads as "pages take forever to load", getting worse the
     longer the document has been open.

     So retained pages are capped by a pixel budget (counting both canvases) and
     the ones furthest from the viewport are released first. Releasing costs
     nothing lasting: pdf.js still holds the parsed page proxy, so coming back
     is a re-raster, not a re-parse. MIN_RETAINED_PAGES is the floor for sheets
     large enough that a single page blows the whole budget. */
  const CANVAS_BUDGET_PX = 64e6;   // ~256 MB of backing store at 4 bytes/px
  const MIN_RETAINED_PAGES = 3;

  /* The point past which the page floor stops overriding the pixel budget.
     MIN_RETAINED_PAGES on its own is a floor on the wrong unit: three ANSI E
     sheets are hundreds of megabytes between them, so on exactly the documents
     the budget was written for it was not enforcing anything. Beyond this the
     floor gives way and only the sheet under the viewport is exempt. */
  const FLOOR_CEILING_PX = CANVAS_BUDGET_PX * 2;

  /* How far a refused canvas may be scaled back before the page gives up and
     says so. An eighth of the requested dpr is already a visibly soft sheet;
     past that it is not a page anyone can read, and continuing to halve just
     turns a reportable failure into a slow one. */
  const MIN_RASTER_BACKOFF = 1 / 8;

  /* pdf.js has one worker. Letting a 600px scroll burst start six full-page
     renders at once only makes the sheet you are looking at wait behind five
     you are not. */
  const MAX_PAGE_RENDERS = 2;

  /* One at a time, and one only. Building a text layer is `getTextContent` on
     that same worker followed by a few thousand absolutely positioned divs
     going into the document — the second half is main-thread DOM work that
     nothing else can proceed through, so running two concurrently buys
     nothing and lengthens the stall. */
  const MAX_LAYER_BUILDS = 1;

  /* Run something when the main thread is not busy, but do not let it be
     starved: a long scroll on a large set can keep the thread busy for
     seconds, and a text layer that never arrives is a page you cannot select
     on. Falls back to a timeout where `requestIdleCallback` is missing. */
  function whenIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 250 });
    } else {
      setTimeout(fn, 1);
    }
  }

  /* How much of the gutter above a page to leave showing when navigating to
     it, and how far the landing may drift before `confirmLanding` steps in.
     The tolerance is a page, not a pixel count: a few pixels of overshoot is
     normal and correcting it would fight the browser's own scroll animation. */
  const PAGE_LEAD = 16;
  const LANDING_CHECK_MS = 550;

  /* In a paged mode there is nothing below the last row to scroll onto, so a
     wheel at the bottom edge steps to the next row instead. The cooldown is
     what stops one flick of an inertial trackpad from turning five sheets. */
  const PAGE_FLIP_MS = 320;

  /* Zoom is a stream, not an event.

     A wheel notch, a trackpad pinch and a held-down Ctrl+= all arrive far
     faster than a page can be rastered, and every step invalidates every
     bitmap in the column. Re-rastering per step means each render is
     cancelled by the next one, so the sheet stays blank for as long as the
     gesture lasts and the worker does nothing but throw work away — which is
     what "zoom runs poorly" actually is.

     So the geometry is applied immediately (the existing bitmap is stretched
     by CSS, which is what makes the zoom feel live) and the raster is left
     until the gesture settles. A brief soft page is the correct trade: it is
     what every other PDF viewer does, and the alternative is no page at all. */
  const ZOOM_SETTLE_MS = 150;

  /* The detail overlay.
     ---------------------------------------------------------------------------
     `rasterPlan` clamps the whole-page raster so the browser will actually
     hand the canvas over, and on a large-format sheet that clamp is severe: an
     ANSI E drawing at 400% comes out at about 0.44 device pixels per CSS
     pixel, which is a sheet you can see the shape of and not read. The page is
     one canvas and the page will not fit in one — but the *viewport* always
     will, and pdf.js renders a crop through the same `transform` parameter
     `snapshot.js` has used since 0.8.

     So a capped page gets a second pair of canvases over the first, covering
     the visible crop at the full dpr. Deliberately an overlay and not a
     replacement: the whole-page pair underneath still covers the page box, so
     scrolling ahead of the tile shows a soft sheet rather than a blank one,
     the retention sweep and every conversion in `render.js` carry on working
     against a canvas that means what it always meant, and the failure mode of
     everything below is "you get 0.14's behaviour".

     Settled, never streamed. A tile taken per scroll frame is the zoom problem
     again on the other axis — each crop cancelled by the next, the one worker
     doing nothing but throwing work away. It is taken once the view stops
     moving, and a scroll away from it *marks* it rather than dropping it: the
     crop is positioned inside the page and therefore scrolls with the page, so
     what is left of it on screen is still exactly right, and releasing early
     trades a sharp region for a soft one at the moment the user stopped to
     look at something. A zoom is the other case and does drop it outright —
     there the CSS box itself has changed, so the crop is a piece of the
     drawing at the wrong scale over the top of the right one. */
  const DETAIL_SETTLE_MS = 220;

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
    fitMode: 'width',   // 'width' | 'page' | 'visible' | null
    viewMode: 'continuous',
    pages: [],          // page records, index 0-based
    rows: [],           // [{index, pages: [record], el}] — see RP.views.rowsFor
    currentPage: 0,
    userScrollAt: 0,    // last gesture that means "I am steering now"
    landingTimer: 0,    // pending goToPage landing check
    flipAt: 0,          // last wheel-driven row step, for the flip cooldown

    /* A streaming zoom: steps held for the next frame, and the raster held
       until the stream stops. See ZOOM_SETTLE_MS. */
    zoomFrame: 0,
    pendingZoomFactor: 0,
    pendingZoomTo: 0,
    pendingZoomAnchor: null,
    rasterTimer: 0,

    dpr: Math.min(window.devicePixelRatio || 1, 2),

    renderQueue: [],    // page indices waiting on a raster slot
    activeRenders: 0,
    layerQueue: [],     // page indices waiting on a text/annotation layer
    activeLayers: 0,
    thumbQueue: [],
    activeThumbs: 0,
    detailTimer: 0,     // pending detail-tile pass, once the view settles
    detailBusy: false,  // one crop at a time; they share the page worker
    pageTops: null,     // cached container offsets; null means re-measure
    pageLefts: null,    // and across, for the tile maths — a spread's second
                        // sheet does not start at x = 0
    thumbCurrent: -1,
    badgeFrame: 0,

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
          if (!entry.isIntersecting) continue;
          // A page that was released while off-screen, or whose markups changed
          // behind your back, comes back through here rather than being kept
          // painted the whole time.
          if (record.rendered) {
            if (record.annotDirty) this.redrawPage(index);
            // Rendered but with no text layer: either it was skipped on the
            // way past because the page was never on screen, or the page was
            // released and re-rastered. Either way this is where it is caught.
            if (!record.layersBuilt) this.requestLayers(index);
          } else this.requestPage(index);
        }
        this.retainCanvases();
      }, { root: this.els.viewer, rootMargin: '600px 0px' });

      this.thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.requestThumb(Number(entry.target.dataset.page));
        }
      }, { root: this.els.thumbs, rootMargin: '400px 0px' });

      this.els.viewer.addEventListener('scroll', RP.throttleRaf(() => this.onScroll()), { passive: true });

      /* A deliberate scroll of your own outranks a pending landing check —
         click a thumbnail, then flick the wheel, and the correction below must
         not drag you back to where you no longer are. */
      const noteUserScroll = () => { this.userScrollAt = Date.now(); };
      for (const type of ['wheel', 'pointerdown', 'keydown']) {
        this.els.viewer.addEventListener(type, noteUserScroll, { passive: true, capture: true });
      }

      /* Zoom by wheel and by trackpad.

         A pinch on a precision trackpad reaches the page as a wheel event with
         `ctrlKey` synthesised by the OS — the same shape as a real Ctrl+wheel,
         which is why one handler covers both. The difference is granularity: a
         mouse notch arrives as one large deltaY, a pinch as a stream of small
         ones. Using the fixed 1.12 step for both makes a pinch feel like it
         leaps, so the factor is derived from the delta and only clamped at the
         ends, which leaves a mouse notch at roughly its old step.

         A pinch also arrives *many times per frame*, and each `setZoom` is a
         full pass over the column writing geometry onto every page — several
         forced layouts per frame on a 77-sheet set, which is a gesture that
         stutters. The factors are compounded and flushed once per animation
         frame instead. The arithmetic is multiplicative, so a frame's worth
         of notches applied together is exactly the zoom they would have
         reached one at a time. */
      this.els.viewer.addEventListener('wheel', (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        // deltaMode 1 is lines, 2 is pages; normalise both to pixel-ish units.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
        const delta = RP.clamp(event.deltaY * unit, -80, 80);
        this.queueZoom(Math.exp(-delta / 340), { x: event.clientX, y: event.clientY });
      }, { passive: false });

      /* Paged modes: a wheel with nowhere left to scroll turns the sheet.
         Without this a fit-page single-page view is inert to the wheel, which
         reads as a broken scroll rather than as a deliberate layout. The
         edge test is done *before* the browser has scrolled, so a flick that
         still has column to travel scrolls it first and only turns on the
         next one. */
      this.els.viewer.addEventListener('wheel', (event) => {
        if (event.ctrlKey || !RP.views.isPaged(this.viewMode)) return;
        if (Math.abs(event.deltaY) < 1) return;
        const viewer = this.els.viewer;
        const atEnd = event.deltaY > 0
          ? viewer.scrollTop >= this.maxScrollTop() - 1
          : viewer.scrollTop <= 1;
        if (!atEnd) return;
        const now = Date.now();
        if (now - this.flipAt < PAGE_FLIP_MS) return;
        if (!this.stepRow(event.deltaY > 0 ? 1 : -1)) return;
        this.flipAt = now;
      }, { passive: true });

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
        // Same stream, same treatment as the wheel — but an absolute target,
        // since `event.scale` is measured against the start of the gesture
        // and compounding it would apply the whole pinch twice.
        this.queueZoomTo(gestureBase * event.scale, anchor);
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
        viewMode: this.viewMode,
        currentPage: this.currentPage,
        scrollTop: this.els.viewer ? this.els.viewer.scrollTop : 0,
        scrollLeft: this.els.viewer ? this.els.viewer.scrollLeft : 0
      };
    },

    /** Re-apply a `viewState()`. Call after `open()` has laid the pages out. */
    applyViewState(state) {
      if (!state || !this.pages.length) return false;
      this.rotation = state.rotation || 0;
      // Before the zoom, not after: the mode decides how many pages share a
      // row and therefore what a fit is a fit *to*.
      const mode = RP.views.normalize(state.viewMode);
      if (mode !== this.viewMode) { this.viewMode = mode; this.buildRows(); }
      if (Number.isFinite(state.zoom) && state.zoom > 0) {
        // Explicitly cleared: setZoom bails out early when the incoming zoom
        // matches the fit it just applied, which would leave fitMode set and
        // let the next resize snap the drawing back to fit-width.
        this.fitMode = null;
        this.setZoom(state.zoom);
      }
      this.fitMode = state.fitMode || null;
      this.currentPage = RP.clamp(state.currentPage || 0, 0, this.pages.length - 1);
      // A paged mode restores by showing the row, not by restoring a scrollTop
      // measured against a column that no longer exists.
      if (RP.views.isPaged(this.viewMode)) this.showRow(this.rowIndexOf(this.currentPage));
      this.els.viewer.scrollTop = state.scrollTop || 0;
      this.els.viewer.scrollLeft = state.scrollLeft || 0;
      this.highlightThumb();
      this.emit('page:changed', this.currentPage);
      this.emit('viewmode:changed', this.viewMode);
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
        /* The sharp crop, over the top of both. Carries `pdf-canvas` so the
           paper display filters reach it — they are scoped to that class and a
           detail canvas the invert mode did not reach would be a bright
           rectangle in the middle of an inverted sheet. The markup half
           carries `annot-canvas` for the opposite reason: no filter may touch
           it, or the redlines inside the tile come back a different colour
           from the ones outside it. */
        const detailCanvas = RP.el('canvas', { class: 'pdf-canvas detail', hidden: true });
        const detailAnnot = RP.el('canvas', { class: 'annot-canvas detail', hidden: true });
        const inkLayer = RP.el('div', { class: 'ink-layer' });
        const tag = RP.el('span', { class: 'page-tag', text: 'Page ' + (i + 1) });
        container.append(pdfCanvas, textLayer, nativeLayer, annotCanvas,
          detailCanvas, detailAnnot, inkLayer, tag);
        // Parented by `buildRows` below — the column holds rows, not pages.

        records.push({
          index: i,
          pageProxy,
          baseViewport,
          viewport: null,
          container,
          pdfCanvas,
          annotCanvas,
          detailCanvas,
          detailAnnot,
          tile: null,             // the crop the detail pair currently holds
          tileStale: false,       // ...and the view has since moved off it
          detailScale: 0,         // the density that crop was taken at
          detailTask: null,
          /* Stood down for this zoom: the browser refused the canvas, or there
             was nothing to gain by taking it. Cleared by `layout()`, because
             both are answers about a zoom rather than about the sheet. */
          detailOff: false,
          textLayer,
          nativeLayer,
          inkLayer,
          rendered: false,
          renderTask: null,
          rasterScale: 0,         // what the raster was actually taken at
          layersBuilt: false,     // text + native annotation layers are current
          layerTask: false,
          annotDirty: false,      // markups changed while this page was off-screen
          textContent: null,
          nativeAnnots: null,     // parsed once, the DOM is rebuilt per zoom
          nativeLayerObj: null,
          annotCanvasMap: null,
          contentBox: undefined,  // fit-visible ink box; undefined = not measured
          visible: false
        });
      }

      this.pages = records;
      this.currentPage = 0;
      this.thumbCurrent = -1;
      this.buildRows();
      this.layout();
      for (const record of records) this.pageObserver.observe(record.container);
      this.buildThumbs();
      this.applyFit();
      this.emit('viewer:ready', this);
    },

    // -- rows ---------------------------------------------------------------

    /**
     * Re-parent the page containers into rows for the current view mode.
     *
     * The page DOM itself is reused: a row change is a move, not a rebuild, so
     * nothing is re-rastered and nothing is re-parsed. `layout()` is what
     * re-sizes them afterwards, and the caller runs it — switching mode and
     * changing zoom both end up there and one pass is enough for both.
     */
    buildRows() {
      const host = this.els.pages;
      if (!host) { this.rows = []; return; }
      const groups = RP.views.rowsFor(this.pages.length, this.viewMode);
      host.innerHTML = '';
      this.rows = groups.map((indices, rowIndex) => {
        const el = RP.el('div', { class: 'page-row', 'data-row': String(rowIndex) });
        const pages = [];
        for (const index of indices) {
          const record = this.pages[index];
          if (!record) continue;
          record.row = rowIndex;
          el.appendChild(record.container);
          pages.push(record);
        }
        host.appendChild(el);
        return { index: rowIndex, pages, el };
      });
      host.classList.toggle('paged', RP.views.isPaged(this.viewMode));
      this.pageTops = null;
      if (RP.views.isPaged(this.viewMode)) this.showRow(this.rowIndexOf(this.currentPage));
      else for (const row of this.rows) row.el.hidden = false;
    },

    /** Which row a page index sits in. Arithmetic, so it works before layout. */
    rowIndexOf(pageIndex) {
      return RP.views.rowOfPage(RP.clamp(pageIndex, 0, Math.max(0, this.pages.length - 1)), this.viewMode);
    },

    /**
     * Show one row and hide the rest. Paged modes only.
     *
     * `record.visible` is set here rather than being left to the observer,
     * which does not report until the next frame: `pumpRenders` skips records
     * that are not visible, so a row shown and immediately requested would
     * queue and then drop every page in it. The observer still runs and still
     * has the last word — this only stops the gap.
     */
    showRow(rowIndex) {
      if (!this.rows.length) return;
      const wanted = RP.clamp(rowIndex, 0, this.rows.length - 1);
      for (const row of this.rows) {
        const on = row.index === wanted;
        row.el.hidden = !on;
        for (const record of row.pages) {
          record.visible = on;
          if (!on) this.releasePage(record);
        }
      }
      this.pageTops = null;
      for (const record of this.rows[wanted].pages) this.requestPage(record.index);
    },

    /**
     * Switch layout. Keeps the sheet you were on, and re-applies the fit
     * because a spread is a different thing to fit than a single page.
     */
    setViewMode(mode) {
      const next = RP.views.normalize(mode);
      if (next === this.viewMode) return;
      this.viewMode = next;
      if (!this.pages.length) { this.emit('viewmode:changed', next); return; }
      this.currentPage = RP.views.rowStartOf(this.currentPage, next);
      this.buildRows();
      this.layout();
      if (this.fitMode) this.applyFit();
      this.goToPage(this.currentPage, { instant: true });
      this.emit('viewmode:changed', next);
    },

    destroyPages() {
      for (const record of this.pages) {
        if (record.renderTask) { try { record.renderTask.cancel(); } catch (err) { /* ignore */ } }
        if (record.detailTask) { try { record.detailTask.cancel(); } catch (err) { /* ignore */ } }
        if (record.nativeLayerObj) { try { record.nativeLayerObj.destroy(); } catch (err) { /* ignore */ } }
        this.pageObserver.unobserve(record.container);
      }
      this.renderQueue = [];
      this.layerQueue = [];
      this.thumbQueue = [];
      this.pageTops = null;
      this.thumbCurrent = -1;
      if (this.landingTimer) { clearTimeout(this.landingTimer); this.landingTimer = 0; }
      // A pending raster, crop or zoom step belongs to the document being torn
      // down. `detailBusy` is cleared too: the render it was holding the slot
      // for is cancelled below with the page it belongs to, and a slot left
      // occupied would stop the incoming document ever taking a crop.
      if (this.rasterTimer) { clearTimeout(this.rasterTimer); this.rasterTimer = 0; }
      if (this.detailTimer) { clearTimeout(this.detailTimer); this.detailTimer = 0; }
      this.detailBusy = false;
      if (this.zoomFrame) { cancelAnimationFrame(this.zoomFrame); this.zoomFrame = 0; }
      this.pendingZoomFactor = 0;
      this.pendingZoomTo = 0;
      this.pendingZoomAnchor = null;
      this.pages = [];
      this.rows = [];
      this.els.pages.innerHTML = '';
      this.els.pages.classList.remove('paged');
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
      if (this.badgeFrame) { cancelAnimationFrame(this.badgeFrame); this.badgeFrame = 0; }
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

    /**
     * Re-size every page to the current zoom and rotation.
     *
     * `opts.defer` keeps the geometry and skips the raster: the page keeps
     * the bitmap it has, stretched to the new box by CSS, and `scheduleRaster`
     * takes it again once the input stops arriving. Only a streaming zoom
     * passes it — everything else wants the sharp page immediately.
     */
    layout(opts) {
      // Every queued raster is for the old scale and would be thrown away, and
      // so is every queued layer — both are positioned against viewports this
      // pass replaces.
      this.renderQueue = [];
      this.layerQueue = [];
      this.pageTops = null;
      const defer = !!(opts && opts.defer);
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
        record.annotDirty = true;
        /* Both layers are positioned against the viewport this pass is
           replacing, so they are rebuilt rather than reused. A build in flight
           notices the same way — it compares viewport identity across its
           awaits. */
        record.layersBuilt = false;
        /* A new zoom is a new question. A sheet the browser refused at 400% is
           usually fine at 100%, so the backoff and the failed state do not
           survive a re-layout — otherwise zooming back out would leave the
           page reporting a failure it is no longer having. */
        record.rasterBackoff = 0;
        record.needsRetry = false;
        if (record.renderFailed) {
          record.renderFailed = false;
          record.container.classList.remove('render-failed');
        }
        if (record.renderTask) { try { record.renderTask.cancel(); } catch (err) { /* ignore */ } }
        record.renderTask = null;
        /* The sharp crop is a crop of the *old* geometry — its canvas is sized
           and positioned in CSS pixels at the zoom it was taken at, so left up
           it would be a piece of the drawing at the wrong scale sitting on top
           of the right one. `detailOff` goes with it: a tile the browser
           refused at 400%, or one that was not worth taking at 100%, is a
           question about a zoom that no longer applies. */
        this.releaseDetail(record);
        record.detailOff = false;
        // A zoom invalidates every bitmap. The off-screen ones are not being
        // repainted this pass, so hand their memory back now rather than
        // carrying a document's worth of stale full-resolution canvases into
        // the next eviction sweep.
        if (!record.visible) this.releasePage(record);
      }
      if (defer) this.scheduleRaster();
      else this.rasterNow();
      this.emit('zoom:changed', this.zoom);
    },

    /** Raster what is on screen and repaint its markups. */
    rasterNow() {
      if (this.rasterTimer) { clearTimeout(this.rasterTimer); this.rasterTimer = 0; }
      for (const record of this.pages) {
        if (record.visible) this.requestPage(record.index);
      }
      this.redrawAll();
      // The sharp crop waits on the whole-page raster it sits over — `pumpDetail`
      // refuses to start while one is pending, and this is only the timer.
      this.scheduleDetail();
    },

    /**
     * Raster once the zoom stops moving.
     *
     * Every step of a gesture invalidates every bitmap, so rastering per step
     * means each render is cancelled by the next and the sheet stays blank
     * for the length of the gesture. The timer restarts on each step, so the
     * work happens exactly once, at the zoom the user actually stopped at.
     */
    scheduleRaster() {
      if (this.rasterTimer) clearTimeout(this.rasterTimer);
      this.rasterTimer = setTimeout(() => {
        this.rasterTimer = 0;
        this.rasterNow();
      }, ZOOM_SETTLE_MS);
    },

    /**
     * Take a zoom step from a streaming input and apply it on the next frame.
     *
     * `factor` compounds, because that is what a wheel notch and a pinch both
     * are: a multiplier on the zoom in force. Several in one frame multiply
     * out to the same place they would have reached applied one at a time,
     * so nothing is lost by holding them — only the redundant layouts.
     */
    queueZoom(factor, anchor) {
      this.pendingZoomTo = 0;
      this.pendingZoomFactor = (this.pendingZoomFactor || 1) * factor;
      this.pendingZoomAnchor = anchor || this.pendingZoomAnchor;
      this.scheduleZoomFlush();
    },

    /** The same, for an input that reports an absolute zoom rather than a
        step — a trackpad `gesturechange` measures its scale from the start of
        the pinch, so the newest value replaces the pending one. */
    queueZoomTo(value, anchor) {
      this.pendingZoomFactor = 0;
      this.pendingZoomTo = value;
      this.pendingZoomAnchor = anchor || this.pendingZoomAnchor;
      this.scheduleZoomFlush();
    },

    scheduleZoomFlush() {
      if (this.zoomFrame) return;
      this.zoomFrame = requestAnimationFrame(() => {
        this.zoomFrame = 0;
        const anchor = this.pendingZoomAnchor;
        const target = this.pendingZoomTo || this.zoom * (this.pendingZoomFactor || 1);
        this.pendingZoomTo = 0;
        this.pendingZoomFactor = 0;
        this.pendingZoomAnchor = null;
        // `defer`: the gesture is still running as far as we know, so stretch
        // what is already on the canvas and raster when it stops.
        this.setZoom(target, anchor ? { anchor, defer: true } : { defer: true });
      });
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
      this.layout({ defer: !!options.defer });

      viewerEl.scrollLeft = relX * ratio - (anchor.x - rect.left);
      viewerEl.scrollTop = relY * ratio - (anchor.y - rect.top);
    },

    /**
     * The pages a fit is a fit *to* — the whole row, not one page.
     *
     * A facing spread is two sheets and a gutter across the pane; fitting the
     * left-hand one alone puts the right-hand one off the edge, which is the
     * obvious version of this and is wrong at every zoom.
     */
    fitRow() {
      const row = this.rows[this.rowIndexOf(this.currentPage)];
      if (row && row.pages.length) return row.pages;
      const record = this.pages[this.currentPage] || this.pages[0];
      return record ? [record] : [];
    },

    applyFit() {
      if (!this.pages.length || !this.fitMode) return;
      const records = this.fitRow();
      if (!records.length) return;

      const widths = [];
      const heights = [];
      for (const record of records) {
        const base = record.pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(record.pageProxy) });
        // Fit-visible fits the ink rather than the paper. An unmeasured or
        // blank page falls back to its page box, so the fit is never worse
        // than fit-width while the measurement is still in flight.
        const box = this.fitMode === 'visible' ? record.contentBox : null;
        widths.push(box ? base.width * box.w : base.width);
        heights.push(box ? base.height * box.h : base.height);
      }

      const target = RP.views.fitScale(widths, heights, {
        availWidth: this.els.viewer.clientWidth - RP.views.COLUMN_PAD,
        availHeight: this.els.viewer.clientHeight - RP.views.COLUMN_PAD,
        gap: RP.views.SPREAD_GAP,
        mode: this.fitMode === 'page' ? 'page' : 'width'
      });

      const mode = this.fitMode;
      this.setZoom(target, { keepFit: true });
      this.fitMode = mode;
      if (mode === 'visible') this.revealContent(records);
    },

    fitWidth() { this.fitMode = 'width'; this.applyFit(); },
    fitPage() { this.fitMode = 'page'; this.applyFit(); },

    /**
     * Fit the ink on the sheet rather than the sheet.
     *
     * Measuring is a render, so it is asynchronous and cached per page; the
     * fit is applied twice — once immediately from whatever is already known
     * (page box on a first visit) and again when the measurement lands. That
     * is deliberately visible: a fit that waited on a raster would read as a
     * dead button on the sheet where it matters most.
     */
    fitVisible() {
      this.fitMode = 'visible';
      this.applyFit();
      const records = this.fitRow();
      const pending = records.filter((record) => record.contentBox === undefined);
      if (!pending.length) return;
      Promise.all(pending.map((record) => this.measureContent(record))).then(() => {
        // Still on the same sheet in the same mode, or the user has moved on
        // and re-fitting would yank the view out from under them.
        if (this.fitMode !== 'visible') return;
        if (this.fitRow().some((record) => pending.indexOf(record) !== -1)) this.applyFit();
      });
    },

    /**
     * The ink bounding box of a page, as fractions of its viewport.
     *
     * Rendered small and on its own rather than read back off the page canvas:
     * the page canvas may not be rastered when the fit is asked for, is at
     * whatever zoom the user happens to be at, and carries the markup canvas's
     * sibling — none of which the measurement wants. `MEASURE_PX` is small
     * enough that this is cheap against the single pdf.js worker and large
     * enough that a hairline border survives it.
     */
    measureContent(record) {
      if (record.contentBox !== undefined) return Promise.resolve(record.contentBox);
      if (record.measuring) return record.measuring;
      const MEASURE_PX = 220;
      const base = record.pageProxy.getViewport({ scale: 1, rotation: this.rotationOf(record.pageProxy) });
      const scale = MEASURE_PX / Math.max(1, base.width);
      const viewport = record.pageProxy.getViewport({ scale, rotation: this.rotationOf(record.pageProxy) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      record.measuring = record.pageProxy.render({ canvasContext: ctx, viewport }).promise
        .then(() => {
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const box = RP.views.inkBoxOf(data, canvas.width, canvas.height);
          // A sheet whose ink already fills it has nothing to gain, and a
          // blank one has nothing to fit — both fall back to the page box.
          record.contentBox = (!box || (box.w > canvas.width * 0.97 && box.h > canvas.height * 0.97))
            ? null
            : {
              x: box.x / canvas.width,
              y: box.y / canvas.height,
              w: box.w / canvas.width,
              h: box.h / canvas.height
            };
          return record.contentBox;
        })
        .catch(() => { record.contentBox = null; return null; })
        .then((box) => { record.measuring = null; return box; });

      return record.measuring;
    },

    /** Put the measured ink of a fitted row in the middle of the pane. */
    revealContent(records) {
      const record = records.find((r) => r.contentBox) || null;
      if (!record || !record.viewport) return;
      const viewer = this.els.viewer;
      const box = record.contentBox;
      const left = this.leftOf(record) + box.x * record.viewport.width;
      const top = this.topOf(record) + box.y * record.viewport.height;
      viewer.scrollTo({
        top: RP.clamp(top - 8, 0, this.maxScrollTop()),
        left: Math.max(0, left - 8),
        behavior: 'auto'
      });
    },

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
        // The ink box is a fraction of the *rotated* viewport, so turning the
        // view invalidates it. Cheap to take again; wrong to keep.
        record.contentBox = undefined;
      }
      this.layout();
      this.buildThumbs();
      if (this.fitMode) this.applyFit();
    },

    // -- rendering ---------------------------------------------------------

    /**
     * Ask for a page to be rastered. Goes through the queue rather than
     * straight to `renderPage` so a burst of observer callbacks cannot start
     * more work than the single pdf.js worker can usefully carry.
     */
    requestPage(index) {
      const record = this.pages[index];
      if (!record || record.rendered || record.renderTask) return;
      // `buildRows` shows a row before `layout()` has sized anything, so the
      // first pass through here on open has no viewport to render against.
      // `layout()` re-requests every visible page, so nothing is lost.
      if (!record.viewport) return;
      if (this.renderQueue.indexOf(index) === -1) this.renderQueue.push(index);
      this.pumpRenders();
    },

    /** The queue is a priority list, not a FIFO: nearest the viewport wins. */
    pumpRenders() {
      while (this.activeRenders < MAX_PAGE_RENDERS && this.renderQueue.length) {
        this.renderQueue.sort((a, b) =>
          Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage));
        const index = this.renderQueue.shift();
        const record = this.pages[index];
        // Scrolled back out, or already dealt with, between queue and slot.
        if (!record || !record.visible || record.rendered || record.renderTask) continue;
        this.activeRenders += 1;
        const done = () => {
          this.activeRenders -= 1;
          this.retainCanvases();
          /* A raster the browser refused, backing off to a smaller one. It goes
             back through the queue rather than retrying inside the slot: the
             sheet that gets refused is a large one, and holding a slot open
             through two more attempts at it stalls the pages behind it. */
          if (record.needsRetry) { record.needsRetry = false; this.requestPage(index); }
          this.pumpRenders();
          this.pumpLayers();
          this.pumpThumbs();
          /* And ask for the sharp crop. `pumpDetail` will not start while a
             raster is pending, so the moment a slot clears is the moment worth
             asking again — the alternative is relying on the capped render's
             own success path, and on a single large sheet there is no later
             render to carry the request. */
          this.scheduleDetail();
        };
        /* **Both arms.** `renderPage` handles its own render errors, but it
           can still reject before it reaches its `try` — `getContext` returns
           null on a surface the browser will not back, and that is a
           TypeError one line later. `.then(done)` alone drops the slot on the
           floor there, and `activeRenders` never comes back down: with two
           slots the app carries on looking fine, one page at a time, while
           `pumpDetail` — which waits for the count to reach zero — is switched
           off for the rest of the session. That is a large-format sheet that
           stays soft at every zoom with nothing on screen to explain it, and
           it is why `pumpLayers` has counted both arms since it was written. */
        this.renderPage(index).then(done, (err) => {
          console.error('Page render failed', err);
          done();
        });
      }
      if (!this.activeRenders && !this.renderQueue.length) this.pumpLayers();
    },

    /**
     * Queue a page's text layer and native annotation layer.
     *
     * Separate from the raster queue because they are separate costs with
     * different urgency. The raster is the sheet; without it there is nothing
     * on screen. The text layer is what makes the words on the sheet
     * selectable and is worth nothing until someone reaches for them — and on
     * a CAD export it is the more expensive of the two by a wide margin.
     *
     * `search.js` builds its own index straight off `record.textContent`, so
     * search does not wait on any of this.
     */
    requestLayers(index) {
      const record = this.pages[index];
      if (!record || !record.rendered || record.layersBuilt || record.layerTask) return;
      if (this.layerQueue.indexOf(index) === -1) this.layerQueue.push(index);
      this.pumpLayers();
    },

    /**
     * Build layers one page at a time, behind every pending raster, and only
     * for pages still on screen.
     *
     * Behind the rasters because a page with no bitmap is a blank sheet and a
     * page with no text layer is merely a sheet you cannot select on yet. On
     * screen only because the observer prefetches 600px past the viewport in
     * both directions and in a split there are two panes doing it — building
     * text layers for all of that is most of what made a large set feel like
     * it was loading in slow motion.
     *
     * Through the idle callback where there is one: this is main-thread DOM
     * work measured in hundreds of milliseconds on a plotted sheet, and
     * landing it mid-scroll is a dropped frame the user reads as jank. The
     * timeout is what stops it being starved outright during a long scroll.
     */
    pumpLayers() {
      if (this.activeRenders || this.renderQueue.length) return;
      while (this.activeLayers < MAX_LAYER_BUILDS && this.layerQueue.length) {
        this.layerQueue.sort((a, b) =>
          Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage));
        const index = this.layerQueue.shift();
        const record = this.pages[index];
        if (!record || !record.visible || !record.rendered || record.layersBuilt) continue;
        this.activeLayers += 1;
        record.layerTask = true;
        /* Settled, not resolved. There is one slot, so a build that rejects
           and is not counted back leaves `activeLayers` stuck at 1 and every
           later page silently never becomes selectable — a stall that would
           look like the deferral itself being broken rather than like one page
           throwing. `buildLayers` swallows its own failures too; this is the
           structural guarantee behind that. */
        const done = () => {
          this.activeLayers -= 1;
          record.layerTask = false;
          this.pumpLayers();
          this.pumpThumbs();
        };
        whenIdle(() => { this.buildLayers(index).then(done, done); });
      }
      if (!this.activeLayers && !this.layerQueue.length) this.pumpThumbs();
    },

    /**
     * The text layer and the native annotation layer for one page.
     *
     * Both are positioned against `record.viewport`, so both are wrong the
     * moment `layout()` runs — and `layout()` can run in the middle of either,
     * since this is deliberately no longer inside the render slot that used to
     * serialise it. The viewport is therefore captured and re-checked across
     * every await: `layout()` replaces the object outright, so identity is the
     * whole test.
     */
    async buildLayers(index) {
      const record = this.pages[index];
      if (!record || !record.rendered) return;
      const viewport = record.viewport;

      await this.buildTextLayer(record);
      if (record.viewport !== viewport || !record.rendered) return;

      try {
        await RP.annots.build(record);
      } catch (err) {
        // A page whose own annotations could not be laid out is still a page.
        // `buildTextLayer` already swallows its own failures for the same
        // reason: losing selection or a link on one sheet is not worth losing
        // the sheet over.
        console.warn('Annotation layer failed on page ' + (record.index + 1), err);
      }
      if (record.viewport !== viewport || !record.rendered) return;

      record.layersBuilt = true;
    },

    requestThumb(index) {
      const record = this.pages[index];
      if (!record || record.thumbRendered || !record.thumbCanvas) return;
      if (this.thumbQueue.indexOf(index) === -1) this.thumbQueue.push(index);
      this.pumpThumbs();
    },

    /**
     * Thumbnails queue *behind* pages and behind layers, never alongside them.
     * They share the one pdf.js worker, and opening the panel on a 77-sheet
     * set otherwise fires a burst of thumb rasters that the page you are
     * actually reading has to wait out. One at a time, and only when nothing
     * real is pending.
     */
    pumpThumbs() {
      if (this.activeRenders || this.renderQueue.length) return;
      if (this.activeLayers || this.layerQueue.length) return;
      while (this.activeThumbs < 1 && this.thumbQueue.length) {
        const index = this.thumbQueue.shift();
        const record = this.pages[index];
        if (!record || record.thumbRendered || !record.thumbCanvas) continue;
        this.activeThumbs += 1;
        this.renderThumb(index).then(() => {
          this.activeThumbs -= 1;
          this.pumpThumbs();
        });
      }
    },

    // -- the detail overlay ------------------------------------------------

    /** The visible box, in the scroller's own coordinates. */
    detailView() {
      const viewer = this.els.viewer;
      if (!viewer) return null;
      const w = viewer.clientWidth || 0;
      const h = viewer.clientHeight || 0;
      if (w <= 0 || h <= 0) return null;
      return { x: viewer.scrollLeft || 0, y: viewer.scrollTop || 0, w, h };
    },

    /**
     * A page's box in the same coordinates.
     *
     * Off the cached measurements, not off a live rect: this is read once per
     * page per scroll frame and `onScroll` must not measure the DOM. The cache
     * is filled by `measurePages` and invalidated by everything that moves a
     * page, so a null here means "re-measure", not "unknown".
     */
    pageBox(record) {
      if (!record || !record.viewport) return null;
      if (!this.pageTops || this.pageTops.length !== this.pages.length) this.measurePages();
      const y = this.pageTops[record.index];
      const x = this.pageLefts ? this.pageLefts[record.index] : 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      // Floored, because that is what `layout()` wrote onto the container: a
      // tile measured against the unrounded viewport can overhang the page box
      // by a fraction of a pixel on two sides.
      return {
        x, y,
        w: Math.floor(record.viewport.width),
        h: Math.floor(record.viewport.height)
      };
    },

    /**
     * Does this sheet want a sharp crop?
     *
     * Only if its own raster was clamped. An ordinary sheet is already at the
     * device pixel ratio and a second canvas over it would be the same pixels
     * again for the same memory — the overlay exists for the sheets `rasterPlan`
     * had to compromise, and on every other document this returns false and
     * nothing below ever runs.
     */
    wantsDetail(record) {
      return !!record && record.visible && record.rendered && !record.detailOff
        && !!record.rasterScale && record.rasterScale < this.dpr - 1e-9;
    },

    /**
     * Drop a page's sharp crop and hand its backing store back.
     *
     * Zeroing both dimensions for the same reason `releasePage` does — a
     * `clearRect` leaves the memory allocated, and a viewport-sized pair at the
     * device pixel ratio is the largest single thing this app holds.
     */
    releaseDetail(record) {
      if (!record || !record.detailCanvas) return;
      if (record.detailTask) { try { record.detailTask.cancel(); } catch (err) { /* ignore */ } }
      record.detailTask = null;
      record.tile = null;
      record.tileStale = false;
      record.detailScale = 0;
      for (const canvas of [record.detailCanvas, record.detailAnnot]) {
        if (!canvas) continue;
        canvas.hidden = true;
        canvas.width = 0;
        canvas.height = 0;
      }
    },

    /**
     * Note tiles that no longer cover the view, and ask for the next pass.
     *
     * Deliberately does *not* release: the crop is positioned inside the page
     * and therefore scrolls with it, so the part of it still on screen is
     * still exactly right. Dropping it the moment the view moved would turn
     * every scroll into a soft flash of a region that was already sharp. It is
     * marked stale instead and replaced in place once the view settles.
     */
    refreshDetail() {
      const view = this.detailView();
      if (!view) return;
      let wanted = false;
      for (const record of this.pages) {
        const has = !!record.tile;
        if (!has && !this.wantsDetail(record)) continue;
        const box = this.pageBox(record);
        if (!box) continue;
        if (!has) {
          // A sheet that has none yet only counts if some of it is off screen —
          // `detailTile` returns null when the base canvas already is the tile.
          if (RP.views.detailTile(box, view)) wanted = true;
          continue;
        }
        if (RP.views.tileCovers(record.tile, box, view)) continue;
        record.tileStale = true;
        wanted = true;
      }
      if (wanted) this.scheduleDetail();
    },

    /** Take the crop once the view stops moving. Same reasoning as
        `scheduleRaster`, and a longer settle because this one is a bonus:
        there is already a sheet on screen either way. */
    scheduleDetail() {
      if (this.detailTimer) clearTimeout(this.detailTimer);
      this.detailTimer = setTimeout(() => {
        this.detailTimer = 0;
        this.pumpDetail();
      }, DETAIL_SETTLE_MS);
    },

    /**
     * Render the next sheet's crop. One at a time, behind every pending page.
     *
     * The ordering is the same one thumbnails sit at the bottom of: there is
     * one pdf.js worker, and a sheet with no bitmap at all outranks a sheet
     * that is merely soft. A page that turns out not to need a tile is skipped
     * rather than returned on — in a facing spread the sheet next to it may
     * still want one.
     */
    pumpDetail() {
      if (this.detailBusy) return;
      /* Still behind the rasters, but **re-armed rather than dropped**, and
         measured off the pages rather than off `activeRenders`.
         Two separate mistakes lived on this line. It returned outright, so a
         pass that happened to land while a sheet was still drawing threw the
         request away — and the only thing that ever asked again was a *later*
         capped render succeeding, which on a single large sheet never comes.
         And it trusted a counter: one leaked slot (see `pumpRenders`) pinned
         it above zero and stood the overlay down for the rest of the session.
         A count that has drifted is exactly the thing that must not be able to
         switch a feature off silently, so the question asked here is the one
         that was always meant — is a sheet on screen still being drawn — and
         the answer is read off the records themselves. */
      if (this.renderQueue.length || this.pages.some((r) => r.visible && r.renderTask)) {
        this.scheduleDetail();
        return;
      }
      const view = this.detailView();
      if (!view) return;

      for (const record of this.pages) {
        if (record.tile && !record.tileStale) continue;
        if (!this.wantsDetail(record)) continue;
        const box = this.pageBox(record);
        if (!box) continue;
        const tile = RP.views.detailTile(box, view);
        // The whole sheet is on screen, so the base canvas already is the tile.
        // Not a failure and not a reason to stop looking at the next page.
        if (!tile) continue;

        const plan = RP.views.rasterPlan(tile.w, tile.h, this.dpr,
          { maxPixels: RP.views.MAX_TILE_PIXELS });
        /* Not worth the trip through the worker. The crop is capped too — a
           viewport on a 4K pane is a 25 megapixel canvas at dpr 2 — so on a
           sheet that is only slightly over the whole-page limit the two land in
           the same place, and re-rendering to gain nothing is the sheet you are
           reading queueing behind a copy of itself. */
        if (plan.scale < (record.rasterScale || 0) * RP.views.MIN_TILE_GAIN) {
          record.detailOff = true;
          continue;
        }

        this.detailBusy = true;
        const done = () => {
          this.detailBusy = false;
          this.retainCanvases();
          // A spread has two sheets, and a continuous column at low zoom can
          // have more.
          this.pumpDetail();
        };
        this.renderDetail(record, tile, plan).then(done, done);
        return;
      }
    },

    /**
     * The sharp crop itself.
     *
     * pdf.js renders a sub-region through `transform`, which it prepends to the
     * viewport transform: scaling by the plan and translating by the crop
     * origin puts the wanted region at the canvas origin, so the page is drawn
     * only where the canvas is rather than drawn whole and cut down. Exactly
     * the shape `RP.snapshot.render` uses, and for the same reason.
     *
     * **No `annotationCanvasMap`**, unlike `renderPage` — again as in
     * `snapshot.js`. The map is how pdf.js hands back annotations that render
     * onto a canvas of their own (Bluebeam stamps, some free text) for the live
     * annotation layer to adopt. That layer has already adopted the ones from
     * the base render and is positioned over both canvases; handing this pass a
     * second map would divert those marks into canvases nothing reads and leave
     * a stamped sheet with a hole where the stamp is inside the tile and the
     * stamp outside it.
     */
    async renderDetail(record, tile, plan) {
      const viewport = record.viewport;
      const k = plan.scale;

      /* The old crop goes now rather than on success: the canvas is about to be
         resized, which clears it, so there is nothing left to keep. Hidden
         rather than left blank, so what shows through for the length of this
         render is the soft base — the same page, slightly less sharp — instead
         of a white rectangle over the middle of the drawing. */
      record.tile = null;
      record.tileStale = false;
      record.detailCanvas.hidden = true;
      record.detailAnnot.hidden = true;

      record.detailCanvas.width = plan.width;
      record.detailCanvas.height = plan.height;
      record.detailAnnot.width = plan.width;
      record.detailAnnot.height = plan.height;
      for (const canvas of [record.detailCanvas, record.detailAnnot]) {
        canvas.style.left = tile.x + 'px';
        canvas.style.top = tile.y + 'px';
        canvas.style.width = tile.w + 'px';
        canvas.style.height = tile.h + 'px';
      }

      const ctx = record.detailCanvas.getContext('2d', { alpha: false });
      // No context at all, same as the base raster. Nothing is lost by standing
      // down — the soft sheet underneath is still on screen.
      if (!ctx) { record.detailOff = true; this.releaseDetail(record); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, plan.width, plan.height);
      // Same probe as the base raster: a surface the browser would not back
      // reads transparent while `canvas.width` reports what was assigned. Here
      // it costs nothing to lose — the base is still on screen — so it is a
      // silent stand-down rather than the notice `rasterRefused` puts up.
      if (!this.canvasTookTheFill(ctx, record.detailCanvas)) {
        record.detailOff = true;
        this.releaseDetail(record);
        return;
      }

      const transform = [k, 0, 0, k, -tile.x * k, -tile.y * k];
      const task = record.pageProxy.render({ canvasContext: ctx, viewport, transform });
      record.detailTask = task;

      try {
        await task.promise;
        /* Viewport identity, the same test `buildLayers` makes: `layout()`
           replaces the object outright, so a zoom that landed mid-render means
           this crop is measured in CSS pixels that no longer exist. */
        if (record.viewport !== viewport || !record.rendered) { this.releaseDetail(record); return; }
        if (!this.canvasTookTheFill(ctx, record.detailCanvas)) {
          record.detailOff = true;
          this.releaseDetail(record);
          return;
        }
        record.tile = tile;
        record.detailScale = k;
        record.detailCanvas.hidden = false;
        record.detailAnnot.hidden = false;
        this.redrawDetail(record);
      } catch (err) {
        // A cancelled crop is a zoom or a tab switch, not a fault. Anything
        // else stands the overlay down for this zoom rather than retrying into
        // the same failure.
        if (!err || err.name !== 'RenderingCancelledException') record.detailOff = true;
        this.releaseDetail(record);
      } finally {
        record.detailTask = null;
      }
    },

    /**
     * Repaint the markups inside a sharp crop.
     *
     * The crop is on top of the base pair, so markups painted only onto the
     * base would be covered by it and the tile would show the selection state
     * from whenever it was taken. Same annotations, same code, different
     * density and an origin at the crop rather than at the sheet.
     */
    redrawDetail(record) {
      if (!record || !record.tile || !record.detailAnnot || !record.detailAnnot.width) return;
      const canvas = record.detailAnnot;
      const ctx = canvas.getContext('2d');
      const k = record.detailScale || this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, -record.tile.x * k, -record.tile.y * k);
      this.paintMarkups(ctx, record);
    },

    /**
     * Drop a page's bitmaps and layers, keeping its box in the scroll column.
     *
     * Zeroing both canvas dimensions is what actually returns the backing
     * store — `clearRect` leaves it allocated. The CSS width/height set by
     * `layout()` stay, so the page keeps its size and nothing reflows. The
     * parsed page proxy and extracted `textContent` are kept, so coming back is
     * a re-raster rather than a re-parse.
     */
    releasePage(record) {
      if (!record) return;
      if (record.renderTask) { try { record.renderTask.cancel(); } catch (err) { /* ignore */ } }
      record.renderTask = null;
      record.rendered = false;
      record.annotDirty = true;
      // The layers go with the bitmap below, so the page has to be able to ask
      // for them again when it comes back. A build already in flight checks
      // `rendered` across its awaits and drops what it was doing.
      record.layersBuilt = false;
      // The sharp crop is a crop *of* the bitmap being dropped. It is also the
      // single largest allocation on the page, so a release that left it behind
      // would hand back the smaller half of the memory.
      this.releaseDetail(record);
      for (const canvas of [record.pdfCanvas, record.annotCanvas]) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (record.nativeLayerObj) { try { record.nativeLayerObj.destroy(); } catch (err) { /* ignore */ } }
      record.nativeLayerObj = null;
      // `nativeAnnots` is parsed data, not DOM — keeping it is the whole point
      // of the cache. Only the rendered layer goes.
      if (record.nativeLayer) {
        record.nativeLayer.innerHTML = '';
        record.nativeLayer.hidden = true;
      }
      if (record.textLayer) record.textLayer.innerHTML = '';
      record.textDivs = [];
      record.annotCanvasMap = null;
    },

    /** Backing store a page is holding, in pixels, counting both pairs. */
    pixelsOf(record) {
      let pixels = 0;
      if (record.pdfCanvas && record.pdfCanvas.width) {
        pixels += record.pdfCanvas.width * record.pdfCanvas.height * 2;
      }
      /* The crop counts against the same budget as the sheet it sits on — it
         is the same kind of memory and, on a large-format drawing at a high
         zoom, it is the larger of the two. Counting only the base is how the
         budget quietly stopped being a budget the last time. */
      if (record.detailCanvas && record.detailCanvas.width) {
        pixels += record.detailCanvas.width * record.detailCanvas.height * 2;
      }
      return pixels;
    },

    /** What the retention budget is currently holding. Reported by diag.js. */
    rasterStats() {
      let held = 0;
      let pixels = 0;
      let capped = 0;
      let failed = 0;
      let detailed = 0;
      for (const record of this.pages) {
        // Counted whether or not the page currently holds a bitmap: a sheet
        // that was refused outright has no canvas and is exactly the one worth
        // reporting.
        if (record.renderFailed) failed += 1;
        if (record.rasterScale && record.rasterScale < this.dpr - 1e-9) capped += 1;
        if (record.tile) detailed += 1;
        pixels += this.pixelsOf(record);
        if (!record.pdfCanvas || !record.pdfCanvas.width) continue;
        held += 1;
      }
      return {
        pages: this.pages.length,
        rastered: held,
        // Sheets too large to raster at full resolution, and sheets the browser
        // would not give a canvas for at all. Both read as "blank page" on
        // screen without this, which is why they are here.
        capped,
        failed,
        /* How many of the capped ones the overlay is currently rescuing.
           `capped` high with `detailed` at zero on a sheet that is plainly on
           screen is the signature of the crop being refused or stood down, and
           the difference between the two numbers is not visible from a
           screenshot of a soft page. */
        detailed,
        approxMB: Math.round(pixels * 4 / 1e6),
        budgetMB: Math.round(CANVAS_BUDGET_PX * 4 / 1e6),
        queued: this.renderQueue.length,
        active: this.activeRenders,
        // Pages rastered but not yet selectable. A long tail here on a set
        // that is otherwise drawn is the signature of a CAD export with a very
        // heavy text layer.
        layersQueued: this.layerQueue.length,
        thumbsQueued: this.thumbQueue.length
      };
    },

    /** Release rastered pages furthest from the viewport until under budget. */
    retainCanvases() {
      /* The crop first, and unconditionally: it belongs to a viewport, so a
         page that has scrolled out of the viewport has no use for one whatever
         the budget says. Doing it here rather than only in `releasePage` is
         what keeps the largest allocation in the app tied to the view instead
         of to the eviction ordering — a sheet inside MIN_RETAINED_PAGES is
         never released, and would otherwise carry a viewport-sized pair of
         canvases for the rest of the session. */
      for (const record of this.pages) {
        if (record.tile && !record.visible) this.releaseDetail(record);
      }
      const live = this.pages.filter((record) => record.rendered || record.renderTask);
      if (live.length <= MIN_RETAINED_PAGES) return;
      live.sort((a, b) =>
        Math.abs(a.index - this.currentPage) - Math.abs(b.index - this.currentPage));

      let held = 0;
      for (let i = 0; i < live.length; i += 1) {
        const record = live[i];
        // Two canvases per page, always the same size as each other — and the
        // sharp crop's pair on top of them where there is one.
        held += this.pixelsOf(record);

        /* The floor is a floor on *pages*, which on a large-format sheet used
           to mean the budget was not a budget at all: three pages that are
           tens of megapixels each ran to several hundred megabytes with
           nothing able to evict them, which is the thrash the budget exists to
           prevent. So the floor now stops applying once what it is holding is
           itself well past the budget — with the single nearest page always
           exempt, because evicting the sheet under the viewport means
           re-rendering it on the next scroll frame, forever. */
        const floored = i === 0 || (i < MIN_RETAINED_PAGES && held <= FLOOR_CEILING_PX);
        /* `held` is what would be held if everything down to here survived, and
           it keeps counting pages that are exempt — a visible sheet costs the
           same memory as any other. Not decremented on eviction, or a page
           further from the viewport could be kept because a nearer one was
           just dropped, which inverts the whole ordering. */
        if (held <= CANVAS_BUDGET_PX || floored) continue;
        if (record.visible || record.renderTask) continue;
        this.releasePage(record);
      }
    },

    /**
     * Did the browser actually give us the canvas we asked for?
     *
     * A refused allocation does not throw and does not come back with zeroed
     * dimensions — `canvas.width` reads back whatever was assigned and the
     * context is there. What is missing is the drawing surface, so nothing
     * painted onto it lands. The white fill that every render starts with is
     * therefore also the probe: one pixel of it read back is the difference
     * between "this sheet is blank" and "this sheet was never drawn", and the
     * two need different answers on screen.
     *
     * Same idea as the zero-ink / near-total-ink checks in `compare.js`, and
     * for the same reason — a failed raster that goes unnoticed gets reported
     * as a fault in the drawing.
     */
    canvasTookTheFill(ctx, canvas) {
      if (!canvas || !canvas.width || !canvas.height) return false;
      // A stubbed context (test/verify.js) has no pixels to read and is not
      // what this guard is about.
      if (!ctx || typeof ctx.getImageData !== 'function') return true;
      try {
        const px = ctx.getImageData(0, 0, 1, 1).data;
        return px[3] !== 0 && px[0] > 250 && px[1] > 250 && px[2] > 250;
      } catch (err) {
        // Chromium throws here on a canvas it could not back at all.
        return false;
      }
    },

    async renderPage(index) {
      const record = this.pages[index];
      if (!record || record.rendered || record.renderTask) return;
      const viewport = record.viewport;

      /* The raster is capped, the layout is not.
         `rasterPlan` clamps the backing store against the limits Chromium
         refuses past — silently, which is what made this a blank page rather
         than an error. The CSS box was set by `layout()` and stays at the full
         zoom, so a capped page is stretched rather than missing. `rasterScale`
         is what everything painting into these canvases has to transform by;
         it is the requested dpr on every ordinary sheet. */
      const dpr = this.dpr * (record.rasterBackoff || 1);
      const plan = RP.views.rasterPlan(viewport.width, viewport.height, dpr);
      record.rasterScale = plan.scale;

      record.container.classList.add('rendering');
      record.container.classList.remove('render-failed');
      record.pdfCanvas.width = plan.width;
      record.pdfCanvas.height = plan.height;
      record.annotCanvas.width = record.pdfCanvas.width;
      record.annotCanvas.height = record.pdfCanvas.height;

      /* The other half of the refusal, and the one that is not silent: where
         `canvasTookTheFill` catches a surface that was handed over and never
         backed, this catches one the browser would not even give a context
         for. It returns null rather than throwing, so the throw lands on the
         next line instead — outside every `try` in here, which used to take
         the render slot with it. Same answer as a failed probe: back off and
         come round again with a smaller ask. */
      const ctx = record.pdfCanvas.getContext('2d', { alpha: false });
      if (!ctx) { this.rasterRefused(record, plan); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, record.pdfCanvas.width, record.pdfCanvas.height);

      // Before spending a render on it. A sheet this large is exactly the one
      // that takes ten seconds to draw, and drawing it into a surface that was
      // never allocated wastes the whole of that on the one worker.
      if (!this.canvasTookTheFill(ctx, record.pdfCanvas)) {
        this.rasterRefused(record, plan);
        return;
      }

      // Some native annotations (Bluebeam stamps, free text with its own
      // appearance) are rendered onto a canvas of their own rather than into
      // the page content. pdf.js hands those back through this map and the
      // annotation layer adopts them; without it they are simply missing.
      record.annotCanvasMap = new Map();

      const task = record.pageProxy.render({
        canvasContext: ctx,
        viewport,
        transform: plan.scale !== 1 ? [plan.scale, 0, 0, plan.scale, 0, 0] : null,
        annotationCanvasMap: record.annotCanvasMap
      });
      record.renderTask = task;

      try {
        await task.promise;
        // The surface can still be dropped mid-render under memory pressure,
        // and the promise resolves either way.
        if (!this.canvasTookTheFill(ctx, record.pdfCanvas)) {
          this.rasterRefused(record, plan);
          return;
        }
        record.rendered = true;
        record.rasterBackoff = 0;
        record.container.classList.remove('rendering');
        this.redrawPage(index);
        /* The text and annotation layers are queued, not awaited.
           They used to be built here, inside the render slot, so
           `activeRenders` stayed occupied for the whole chain — and on a
           drawing exported from CAD that chain is the expensive part, not the
           raster: the plotter emits text as thousands of short runs, so
           `getTextContent` is a long trip through the one worker and
           `TextLayer.render` is a few thousand absolutely positioned divs
           behind it. With two render slots, two of those held up the sheet the
           user was actually waiting for. See `pumpLayers`. */
        this.requestLayers(index);
        /* And the sharp crop, if this sheet turned out to be one of the large
           ones. `plan.capped` is the whole test — this is the only place that
           knows the raster was compromised, and the overlay exists for exactly
           the sheets where it was. */
        if (plan.capped) this.scheduleDetail();
      } catch (err) {
        if (!err || err.name !== 'RenderingCancelledException') console.error('Page render failed', err);
        record.container.classList.remove('rendering');
      } finally {
        record.renderTask = null;
      }
    },

    /**
     * A canvas the browser would not back. Ask for half as much, once or twice,
     * and then say so rather than leaving a white page on screen.
     *
     * The backoff is on the record instead of being a local retry loop because
     * the retry has to go back through the queue: this page is holding one of
     * two render slots and a sheet big enough to be refused is a sheet other
     * pages are waiting behind. `pumpRenders` re-requests it once the slot is
     * free — see `needsRetry` there.
     */
    rasterRefused(record, plan) {
      record.rendered = false;
      record.renderTask = null;
      record.annotDirty = true;
      record.container.classList.remove('rendering');

      const next = (record.rasterBackoff || 1) / 2;
      if (next >= MIN_RASTER_BACKOFF) {
        record.rasterBackoff = next;
        record.needsRetry = true;
        return;
      }

      /* Out of room to give. The page keeps its box in the column so nothing
         reflows, and says what happened — a drawing that could not be drawn is
         not the same as a drawing with nothing on it, and without this the two
         are identical on screen. */
      record.rasterBackoff = 0;
      record.renderFailed = true;
      record.container.classList.add('render-failed');
      console.error('Page ' + (record.index + 1) + ' could not be rastered: the browser refused a '
        + plan.width + 'x' + plan.height + ' canvas (' + Math.round(plan.width * plan.height / 1e6)
        + ' MP). Zoom out and try again.');
    },

    async buildTextLayer(record) {
      /* `getTextContent` is a trip through the same worker the rasters use,
         and on a sheet plotted out of CAD it is not a cheap one — the text
         arrives as thousands of short runs rather than as paragraphs. It is
         cached on the record and survives a release for exactly that reason,
         so this is paid once per page per document rather than once per
         raster. `search.js` reads the same cache. */
      const viewport = record.viewport;
      if (!record.textContent) {
        try {
          record.textContent = await record.pageProxy.getTextContent();
        } catch (err) {
          record.textContent = { items: [], styles: {} };
        }
      }
      // Zoomed, rotated or torn down while that was in flight. The layer is
      // positioned against the viewport, so building it now would place every
      // run against geometry that has already been replaced.
      if (record.viewport !== viewport) return;
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
      if (!canvas.width) return;   // released, or not rastered yet
      record.annotDirty = false;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      /* The markup canvas is the same size as the page canvas, so it is capped
         with it — `rasterScale` rather than `this.dpr`. Painting at the raw dpr
         over a capped raster puts every markup at the wrong scale on exactly
         the large-format sheets this is meant to rescue. */
      const scale = record.rasterScale || this.dpr;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      this.paintMarkups(ctx, record);
      /* The sharp crop sits on top of this canvas and carries its own copy of
         everything just painted. Skipping it here would leave the markups
         inside the tile showing whatever state they were in when the crop was
         taken — a selection that will not clear, over the one part of the sheet
         the user is looking closely at. */
      this.redrawDetail(record);
    },

    /**
     * Everything this app draws over a page, in page CSS-pixel space.
     *
     * Taken out of `redrawPage` because it is painted twice on a large sheet —
     * once onto the whole-page markup canvas and once onto the sharp crop over
     * it, at a different density and a different origin. The two must not be
     * able to disagree about what a page has on it, which is the same reason
     * `render.js` is shared with the exporter.
     */
    paintMarkups(ctx, record) {
      const index = record.index;
      const store = this.store;
      /* Before the markups, because a number is part of the sheet rather than
         something drawn over it — and because a markup deliberately placed over
         the number should cover it, the way it will on paper. This pane's store
         again, not `RP.store`: only one of two split drawings may be numbered. */
      RP.render.drawPageNumber(ctx, record.viewport, store, index);
      /* A selected group gets one frame with one set of handles, so its
         members' own chrome is suppressed — eight handles per markup times six
         markups is not a thing anybody can aim at, and it would say the group
         can be resized member by member, which it deliberately cannot. */
      const groups = store.selectedGroups(index);
      const framed = new Set();
      for (const group of groups) for (const annot of group.members) framed.add(annot.id);
      for (const annot of store.forPage(index)) {
        RP.render.drawAnnotation(ctx, annot, record.viewport, {
          selected: store.selection.has(annot.id) && !framed.has(annot.id),
          // This pane's store, not `RP.store`: a measurement is labelled
          // through its own document's calibration, and in a split the two
          // drawings do not share one.
          store
        });
      }
      // After the markups, or a member drawn later would paint over its frame.
      for (const group of groups) {
        RP.render.drawGroupSelection(ctx, RP.render.groupBox(group.members), record.viewport);
      }
      if (this.isActive()) {
        if (RP.search && RP.search.drawHits) RP.search.drawHits(ctx, record);
        // The standing area text selection. Like the search hits it is state
        // of the *focused* document, not of this pane's — a split showing two
        // drawings must not paint one's selection over the other.
        if (RP.textsel && RP.textsel.draw) RP.textsel.draw(ctx, record);
        if (RP.tools && RP.tools.drawPreview) RP.tools.drawPreview(ctx, record);
      }
    },

    /**
     * Repaint the markup layer of the pages actually on screen, and mark the
     * rest so they repaint when they come back.
     *
     * `selection:changed` fires on every click. The old version repainted every
     * page still holding a raster, so once a long document had been scrolled
     * through that was 77 canvas clears and redraws per click.
     */
    redrawAll() {
      for (const record of this.pages) {
        if (record.visible && record.rendered) this.redrawPage(record.index);
        else record.annotDirty = true;
      }
      this.updateThumbBadges();
    },

    // -- navigation --------------------------------------------------------

    /**
     * Page tops only move when `layout()` runs, so they are measured once and
     * cached. Asking all 77 containers for a bounding rect on every scroll
     * frame forced a layout per page per frame, which is most of the jank on a
     * long sheet set.
     */
    measurePages() {
      this.pageTops = this.pages.map((record) => this.topOf(record));
      /* Filled in the same pass, and only here, so the two arrays cannot drift:
         everything that moves a page nulls `pageTops`, and every reader of
         either re-measures when it finds that null. Across as well as down
         because the detail tile is a box, and because the second sheet of a
         spread does not start at x = 0. */
      this.pageLefts = this.pages.map((record) => this.leftOf(record));
    },

    /**
     * A page's top in the scroller's own coordinates.
     *
     * Measured from live rects rather than `offsetTop`, which is relative to
     * whatever the *offsetParent* happens to be. `.viewer` is `position:
     * relative` today so the two agree, but a positioned wrapper appearing
     * anywhere between `.viewer` and `.page` — a split pane, an overlay, a
     * future panel — silently reparents the measurement and every page top
     * comes back short. That reads as "clicking a thumbnail lands on the
     * wrong page", which is a long way from the CSS that caused it.
     */
    topOf(record) {
      const viewer = this.els.viewer;
      return record.container.getBoundingClientRect().top
        - viewer.getBoundingClientRect().top
        + viewer.scrollTop;
    },

    /** The same measurement across. A spread's second page is not at x = 0. */
    leftOf(record) {
      const viewer = this.els.viewer;
      return record.container.getBoundingClientRect().left
        - viewer.getBoundingClientRect().left
        + viewer.scrollLeft;
    },

    /** Largest scrollTop the container will actually accept. */
    maxScrollTop() {
      const viewer = this.els.viewer;
      return Math.max(0, viewer.scrollHeight - viewer.clientHeight);
    },

    /** Which page a given scroll offset is "on". Shared by the scroll handler
        and the landing check so the two cannot disagree. */
    pageIndexAt(scrollTop) {
      if (!this.pages.length) return 0;
      /* In a paged mode the hidden rows are `display: none`, so their pages
         measure as zero-height boxes at the top of the column and the tops
         stop being sorted — the binary search below would answer nonsense.
         There is only one row on screen anyway, so the question has one
         answer and it is the state we already hold. */
      if (RP.views.isPaged(this.viewMode)) return this.currentPage;
      if (!this.pageTops || this.pageTops.length !== this.pages.length) this.measurePages();
      const probe = scrollTop + Math.min(140, this.els.viewer.clientHeight * 0.3);
      // Last page whose top is at or above the probe line.
      let lo = 0;
      let hi = this.pages.length - 1;
      let current = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.pageTops[mid] <= probe) { current = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return current;
    },

    onScroll() {
      if (!this.pages.length) return;
      // A spread reports itself by its left-hand sheet: "page 3 of 10" while
      // 2 and 3 are both in front of you would be true of the wrong one.
      const current = RP.views.rowStartOf(
        this.pageIndexAt(this.els.viewer.scrollTop), this.viewMode);

      if (current !== this.currentPage) {
        this.currentPage = current;
        this.highlightThumb();
        this.emit('page:changed', current);
      }

      /* Scrolling is the other half of the detail overlay: the crop covers the
         viewport, so moving the viewport is what makes it stale. Cheap enough
         to sit here — it reads the cached page boxes and does no DOM
         measurement of its own, and the render it leads to is behind
         DETAIL_SETTLE_MS rather than on this frame. */
      this.refreshDetail();
    },

    goToPage(index, opts) {
      const record = this.pages[RP.clamp(index, 0, this.pages.length - 1)];
      if (!record) return;
      const behavior = opts && opts.instant ? 'auto' : 'smooth';

      /* Paged: the row is swapped rather than scrolled to. There is no column
         to travel down, so a smooth scroll has nothing to animate and the
         landing check below has nothing to check. */
      if (RP.views.isPaged(this.viewMode)) {
        this.showRow(this.rowIndexOf(record.index));
        this.els.viewer.scrollTo({ top: 0, behavior: 'auto' });
        this.currentPage = RP.views.rowStartOf(record.index, this.viewMode);
        this.highlightThumb();
        this.emit('page:changed', this.currentPage);
        return;
      }

      const top = RP.clamp(this.topOf(record) - PAGE_LEAD, 0, this.maxScrollTop());
      this.els.viewer.scrollTo({ top, behavior });
      this.currentPage = RP.views.rowStartOf(record.index, this.viewMode);
      this.highlightThumb();
      this.emit('page:changed', this.currentPage);
      this.confirmLanding(record.index, top);
    },

    /**
     * Move by a *row*, which is what PageUp/PageDown mean once two sheets can
     * share one. Stepping by a page index instead would leave a spread where
     * it was, because the page next door is already on screen.
     */
    stepRow(delta, opts) {
      if (!this.pages.length) return false;
      const rows = RP.views.rowsFor(this.pages.length, this.viewMode);
      const from = this.rowIndexOf(this.currentPage);
      const to = RP.clamp(from + delta, 0, rows.length - 1);
      if (to === from) return false;
      this.goToPage(rows[to][0], opts || { instant: true });
      return true;
    },

    /**
     * Scroll the pane by a step, in CSS pixels. Returns false when it could not
     * move that way.
     *
     * That return value is the whole point: it is what lets the arrow keys
     * scroll a sheet that is bigger than the pane and *turn* to the next one
     * once the bottom of the paper is reached, rather than being a dead key in
     * single-page mode. Nothing here focuses the scroller, because nothing in
     * this app puts focus inside it — `.viewer` has no `tabindex`, so the
     * browser's own arrow-key scrolling never fires and the step has to be
     * issued by hand.
     */
    nudgeScroll(dx, dy) {
      const scroller = this.els.viewer;
      if (!scroller) return false;
      const maxTop = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
      const maxLeft = Math.max(0, (scroller.scrollWidth || 0) - (scroller.clientWidth || 0));
      const top = RP.clamp(scroller.scrollTop + (dy || 0), 0, maxTop);
      const left = RP.clamp(scroller.scrollLeft + (dx || 0), 0, maxLeft);
      // A sub-pixel move is not a move: `scrollTop` is fractional at fractional
      // zooms, and treating a rounding difference as movement would make the
      // key stop turning the sheet at the very bottom of the column.
      const moved = Math.abs(top - scroller.scrollTop) > 0.5 || Math.abs(left - scroller.scrollLeft) > 0.5;
      if (!moved) return false;
      scroller.scrollTo({ top, left, behavior: 'auto' });
      return true;
    },

    /**
     * Verify that the scroll actually arrived, and say so in the diagnostics
     * log when it did not.
     *
     * A smooth scroll is a browser animation, not an assignment: anything that
     * relayouts the column while it is running moves the target under it, and
     * the page tops we aimed at are only as good as the measurement that
     * produced them. A landing on the wrong *page* is corrected outright —
     * silently ending up a sheet away from the one you clicked is the worst
     * possible failure here. A few pixels of drift is left alone; fighting the
     * animation over it would be visible jitter for no gain.
     */
    confirmLanding(index, wanted) {
      if (this.landingTimer) clearTimeout(this.landingTimer);
      const startedAt = Date.now();
      this.landingTimer = setTimeout(() => {
        this.landingTimer = 0;
        const record = this.pages[index];
        if (!record || !this.isActive()) return;
        // The user took over mid-flight; where they are now is where they want.
        if (this.userScrollAt > startedAt) return;

        const viewer = this.els.viewer;
        const landed = this.pageIndexAt(viewer.scrollTop);
        if (landed === index) return;

        if (RP.diag) RP.diag.record('warn',
          'Page navigation landed on page ' + (landed + 1) + ', not ' + (index + 1) +
          ' — aimed at ' + Math.round(wanted) + ', ended at ' + Math.round(viewer.scrollTop) +
          '; page top now ' + Math.round(this.topOf(record)) +
          ', offsetTop ' + record.container.offsetTop +
          ', scrollHeight ' + viewer.scrollHeight + ', clientHeight ' + viewer.clientHeight +
          ', zoom ' + this.zoom.toFixed(3) + ', dpr ' + (window.devicePixelRatio || 1));

        // Re-measure before the retry: whatever moved is still moved.
        this.pageTops = null;
        viewer.scrollTo({
          top: RP.clamp(this.topOf(record) - PAGE_LEAD, 0, this.maxScrollTop()),
          behavior: 'auto'
        });
        this.currentPage = index;
        this.highlightThumb();
        this.emit('page:changed', index);
      }, LANDING_CHECK_MS);
    },

    /** Scroll so a PDF-space rect on `pageIndex` is centred and flash it. */
    revealRect(pageIndex, rect, opts) {
      const record = this.pages[pageIndex];
      if (!record) return;
      // A markup on a hidden row cannot be revealed by scrolling to it —
      // jumping from the list or a search hit has to bring its row up first.
      if (RP.views.isPaged(this.viewMode) && this.rowIndexOf(pageIndex) !== this.rowIndexOf(this.currentPage)) {
        this.showRow(this.rowIndexOf(pageIndex));
      }
      const view = RP.render.vpRect(record.viewport, rect);
      const viewer = this.els.viewer;
      const targetTop = this.topOf(record) + view.y - viewer.clientHeight / 2 + view.h / 2;
      const targetLeft = this.leftOf(record) + view.x - viewer.clientWidth / 2 + view.w / 2;
      viewer.scrollTo({
        top: RP.clamp(targetTop, 0, this.maxScrollTop()),
        left: Math.max(0, targetLeft),
        behavior: (opts && opts.instant) ? 'auto' : 'smooth'
      });
      this.currentPage = RP.views.rowStartOf(pageIndex, this.viewMode);
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
      /* O(1) in the common case. The `parentNode` check matters in a split:
         `elementFromPoint` happily returns the *other* pane's page, and the
         loop below is still needed for points in the gutter between pages or
         under an overlay that is not part of one. */
      const hit = document.elementFromPoint(clientX, clientY);
      const container = hit && hit.closest ? hit.closest('.page') : null;
      // Two hops now, not one: pages hang off a `.page-row`, not off `.pages`.
      if (container && container.parentNode && container.parentNode.parentNode === this.els.pages) {
        const record = this.pages[Number(container.dataset.page)];
        if (record) return record;
      }
      for (const record of this.pages) {
        const rect = record.container.getBoundingClientRect();
        // A hidden row measures as a zero box at the origin, which would
        // otherwise claim a press at the very top-left of the window.
        if (!rect.width || !rect.height) continue;
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
      this.thumbQueue = [];
      this.thumbCurrent = -1;
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

    /** Only the two buttons that changed, not a class write per page. */
    highlightThumb() {
      if (!this.isActive()) return;
      const previous = this.pages[this.thumbCurrent];
      if (previous && previous.thumbButton) previous.thumbButton.classList.remove('current');
      this.thumbCurrent = this.currentPage;

      const current = this.pages[this.currentPage];
      if (current && current.thumbButton) {
        current.thumbButton.classList.add('current');
        const host = this.els.thumbs;
        const top = current.thumbButton.offsetTop;
        if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - 60) {
          host.scrollTo({ top: top - host.clientHeight / 2, behavior: 'smooth' });
        }
      }
    },

    /* Badges are recounted from the whole annotation list, and `redrawAll` asks
       for them on every selection change. Coalesced to one pass per frame. */
    updateThumbBadges() {
      if (!this.isActive() || this.badgeFrame) return;
      this.badgeFrame = requestAnimationFrame(() => {
        this.badgeFrame = 0;
        this.paintThumbBadges();
      });
    },

    paintThumbBadges() {
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
