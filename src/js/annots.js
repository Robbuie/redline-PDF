/* The annotations that were already in the file.

   Everything else in this app draws *our* markups. This module renders the
   ones somebody else made — Bluebeam and Acrobat comments, sticky notes,
   links, filled form fields — using pdf.js's own AnnotationLayer. Without it a
   reviewed drawing opens looking clean, which is a trust problem rather than a
   missing feature: you would sign off a sheet without ever seeing the other
   reviewer's redlines.

   Nothing here is editable. These are read-only overlays; RP.store never sees
   them and RP.exporter never writes them, so a save round-trips them untouched
   as part of the base bytes.

   The one place this module reaches outside the viewer is link handling. A PDF
   is untrusted input, so internal destinations resolve through RP.viewer and
   external URLs go out over IPC to the main process, which confirms the
   resolved href with the user before shell.openExternal. The renderer itself
   never navigates. */
'use strict';

(function (RP) {

  const Annots = {
    /** Class on the per-page div; RP.viewer creates it, this module fills it. */
    LAYER_CLASS: 'native-annots',

    /** Set false to stop building layers entirely (diagnostics escape hatch). */
    enabled: true,

    // Resolved once per document; pdf.js needs it to hide annotations that sit
    // on a switched-off optional-content group.
    _ocConfig: null,
    _ocDoc: null,

    init() {
      RP.bus.on('doc:reset', () => { this._ocConfig = null; this._ocDoc = null; });
    },

    // -- link service ------------------------------------------------------
    //
    // pdf.js talks to the host application through a "link service". Only the
    // methods its annotation elements actually call are implemented; anything
    // it might ask for beyond this is deliberately inert rather than guessed
    // at, because the caller is a file we did not write.

    linkService: {
      // pdf.js reads these off the service in a few places.
      externalLinkEnabled: true,
      isInPresentationMode: false,
      get pagesCount() { return RP.viewer.pages.length; },
      get page() { return RP.viewer.currentPage + 1; },
      set page(value) { RP.viewer.goToPage(Number(value) - 1); },
      get rotation() { return RP.viewer.rotation; },
      set rotation(value) { /* the view rotation is ours, not the document's */ },

      /** Anchors exist only so pdf.js has something to hang a click on. */
      getDestinationHash() { return '#'; },
      getAnchorUrl() { return '#'; },

      addLinkAttributes(link, url) {
        link.href = '#';
        link.title = url;                 // hover shows the *real* target
        link.rel = 'noopener noreferrer';
        link.dataset.externalUrl = url;
        link.onclick = () => { Annots.openExternal(url); return false; };
      },

      goToDestination(dest) { return Annots.goToDestination(dest); },
      executeNamedAction(action) { return Annots.executeNamedAction(action); },

      // Optional-content toggles and embedded attachments are out of scope; a
      // silent no-op is better than a half-working one.
      executeSetOCGState() { /* not supported */ },
      getAttachmentContent() { return Promise.resolve(null); }
    },

    /** Hand an external URL to the main process, which confirms it first. */
    async openExternal(url) {
      try {
        const result = await window.rp.links.openExternal(url);
        if (result && result.opened === false) RP.toast('Link not opened');
      } catch (err) {
        console.warn('Could not open link', url, err);
        RP.toast(err && err.message ? err.message : 'Could not open that link', 'warn');
      }
    },

    /** Follow an internal destination: scroll to the page, then to the spot. */
    async goToDestination(dest) {
      const doc = RP.store.doc;
      if (!doc || dest == null || dest === '') return;
      try {
        const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || !explicit.length) {
          RP.toast('That link has no destination in this document', 'warn');
          return;
        }
        const pageIndex = await resolvePageIndex(doc, explicit[0]);
        if (pageIndex == null) {
          RP.toast('That link points outside this document', 'warn');
          return;
        }
        const record = RP.viewer.pages[pageIndex];
        const rect = record ? destRect(explicit, record.pageProxy) : null;
        if (rect) RP.viewer.revealRect(pageIndex, rect);
        else RP.viewer.goToPage(pageIndex);
      } catch (err) {
        console.warn('Could not follow link destination', err);
        RP.toast('That link could not be followed', 'warn');
      }
    },

    executeNamedAction(action) {
      const viewer = RP.viewer;
      switch (action) {
        case 'GoToPage': case 'NextPage': viewer.goToPage(viewer.currentPage + 1); break;
        case 'PrevPage': viewer.goToPage(viewer.currentPage - 1); break;
        case 'FirstPage': viewer.goToPage(0); break;
        case 'LastPage': viewer.goToPage(viewer.pages.length - 1); break;
        case 'Print': if (RP.print && RP.print.show) RP.print.show(); break;
        case 'Find': if (RP.sidebar && RP.sidebar.show) RP.sidebar.show('search'); break;
        default: break;   // GoBack/GoForward and friends: no history to walk
      }
    },

    // -- layer building ----------------------------------------------------

    /**
     * (Re)build the native annotation layer for a rendered page.
     *
     * Called from RP.viewer.renderPage once the canvas is done, so the layer
     * is rebuilt on every zoom and rotation exactly like the text layer. The
     * parsed annotations are cached on the record; only the DOM is thrown away.
     */
    async build(record) {
      if (!this.enabled || !record || !record.nativeLayer) return;
      const layer = record.nativeLayer;

      if (!record.nativeAnnots) {
        try {
          record.nativeAnnots = await record.pageProxy.getAnnotations({ intent: 'display' });
        } catch (err) {
          console.warn('Could not read annotations on page ' + (record.index + 1), err);
          record.nativeAnnots = [];
        }
      }

      if (record.nativeLayerObj) {
        try { record.nativeLayerObj.destroy(); } catch (err) { /* ignore */ }
        record.nativeLayerObj = null;
      }
      layer.replaceChildren();
      layer.hidden = !record.nativeAnnots.length;
      if (!record.nativeAnnots.length) return;

      // pdf.js positions annotations top-down, so it wants the *unflipped*
      // viewport — the same one the canvas used, only with dontFlip set.
      const viewport = record.viewport.clone({ dontFlip: true });
      const params = {
        annotations: record.nativeAnnots,
        page: record.pageProxy,
        viewport,
        div: layer,
        linkService: this.linkService,
        imageResourcesPath: RP.pdfjs.imageResourcesPath(),
        // Widgets already come through the page canvas as their appearance
        // streams, which is the read-only display we want. Turning this on
        // would swap in live <input>s that look editable and are not.
        renderForms: false,
        annotationCanvasMap: record.annotCanvasMap || null,
        optionalContentConfig: await this.optionalContentConfig(),
        annotationStorage: null,
        downloadManager: null,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: null
      };

      try {
        if (RP.pdfjs.hasAnnotationLayerClass()) {
          // pdf.js v4+: an instance owns the div and can be destroyed.
          const instance = new pdfjsLib.AnnotationLayer(params);
          record.nativeLayerObj = instance;
          await instance.render(params);
        } else {
          // pdf.js v3: a namespace with a static render, no instance to keep.
          await pdfjsLib.AnnotationLayer.render(params);
          layer.setAttribute('data-main-rotation', String(viewport.rotation || 0));
        }
      } catch (err) {
        // A failed layer costs links and popups on one page, not the document.
        console.warn('Annotation layer failed on page ' + (record.index + 1), err);
        layer.replaceChildren();
      }
      RP.bus.emit('annotlayer:ready', record);
    },

    /** Cached per open document; rebuilding it per page is pure waste. */
    async optionalContentConfig() {
      const doc = RP.store.doc;
      if (!doc) return null;
      if (this._ocDoc === doc) return this._ocConfig;
      try {
        this._ocConfig = await doc.getOptionalContentConfig();
      } catch (err) {
        this._ocConfig = null;
      }
      this._ocDoc = doc;
      return this._ocConfig;
    },

    /** How many native annotations a page carries, once it has been read. */
    countOn(record) {
      return record && record.nativeAnnots ? record.nativeAnnots.length : 0;
    },

    // exposed for tests
    destRect,
    resolvePageIndex
  };

  /**
   * The first element of an explicit destination is either a page Ref (the
   * usual case) or a raw page number for remote/embedded-file destinations.
   */
  async function resolvePageIndex(doc, target) {
    if (target && typeof target === 'object') {
      try { return await doc.getPageIndex(target); } catch (err) { return null; }
    }
    if (Number.isInteger(target) && target >= 0 && target < doc.numPages) return target;
    return null;
  }

  /**
   * Explicit destination -> a PDF-user-space rect worth revealing, or null for
   * "the top of the page is enough".
   *
   * Destination coordinates are already in user space, which is what
   * RP.viewer.revealRect wants, so no conversion happens here — but a page
   * whose MediaBox does not start at (0,0) still has to be respected, hence
   * the clamp against pageProxy.view rather than against width/height.
   */
  function destRect(dest, pageProxy) {
    const name = dest[1] && dest[1].name;
    const view = (pageProxy && pageProxy.view) || [0, 0, 612, 792];
    const num = (value) => (typeof value === 'number' && isFinite(value) ? value : null);

    switch (name) {
      case 'XYZ': {
        const x = num(dest[2]);
        const y = num(dest[3]);
        if (x === null && y === null) return null;
        return point(x === null ? view[0] : x, y === null ? view[3] : y);
      }
      case 'FitH': case 'FitBH': {
        const y = num(dest[2]);
        return y === null ? null : point(view[0], y);
      }
      case 'FitV': case 'FitBV': {
        const x = num(dest[2]);
        return x === null ? null : point(x, view[3]);
      }
      case 'FitR': {
        const x0 = num(dest[2]);
        const y0 = num(dest[3]);
        const x1 = num(dest[4]);
        const y1 = num(dest[5]);
        if (x0 === null || y0 === null || x1 === null || y1 === null) return null;
        return {
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          w: Math.abs(x1 - x0),
          h: Math.abs(y1 - y0)
        };
      }
      default:
        // Fit, FitB and anything unrecognised: show the whole sheet.
        return null;
    }
  }

  /** A destination point becomes a zero-size rect, which revealRect centres. */
  function point(x, y) {
    return { x, y, w: 0, h: 0 };
  }

  RP.annots = Annots;

})(window.RP);
