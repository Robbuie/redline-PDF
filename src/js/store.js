/* Document + annotation state, with snapshot-based undo/redo.
   Geometry is always stored in PDF user space (points, origin bottom-left) so
   markups survive zooming, rotation and re-opening.

   There is one store per open document, created by `RP.createStore()` and owned
   by a tab (see tabs.js). `RP.store` is a *live pointer* to the focused tab's
   store, reassigned on every tab and pane switch — which is why every module
   reads `RP.store.x` at call time and never captures it at load time.

   A store belonging to a background tab must not drive the UI, so every bus
   event goes out through `emit()`, which stays silent unless this store is the
   focused one. The one thing that has to escape that gate is the dirty flag,
   because the tab strip shows it for tabs you are not looking at. */
'use strict';

(function (RP) {

  const MAX_HISTORY = 120;

  const TYPE_LABELS = {
    highlight: 'Highlight',
    strikeout: 'Strikeout',
    underline: 'Underline',
    cover: 'Cover',
    note: 'Sticky note',
    pen: 'Freehand',
    line: 'Line',
    arrow: 'Arrow',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    cloud: 'Revision cloud',
    text: 'Text',
    callout: 'Callout',
    measure: 'Measurement'
  };

  /* Review state. A markup is 'open' until somebody says otherwise, and the
     absence of the field means 'open' — that is what lets a drawing saved by
     0.5, which had no concept of status, open here with every markup reading
     as outstanding rather than as unset.

     The order is the order the UI offers them in, so it is a list and not a
     Set. */
  const STATUSES = ['open', 'closed', 'rejected'];

  const STATUS_LABELS = {
    open: 'Open',
    closed: 'Closed',
    rejected: 'Rejected'
  };

  /**
   * The status of a markup, normalised. Anything missing or unrecognised reads
   * as 'open' — a file written by a future version with a status this build has
   * never heard of must not draw as nothing, and must not be filtered out of
   * the list where nobody would find it again.
   */
  function statusOf(annot) {
    const value = annot && annot.status;
    return STATUSES.includes(value) ? value : 'open';
  }

  let nextStoreId = 1;

  function createStore() {

  const Store = {
    id: 'doc' + (nextStoreId++),
    doc: null,          // pdf.js PDFDocumentProxy
    docPath: null,      // absolute path on disk, null for unsaved/opened-from-bytes
    docName: '',
    docBytes: null,     // Uint8Array of the document as it currently stands
    baseBytes: null,    // docBytes with any previous Redline stamps removed
    pageOrder: null,    // page descriptors once the page manager has been used
    sources: null,      // {key: Uint8Array} extra PDFs pages were pulled from
    numPages: 0,
    annotations: [],
    selection: new Set(),
    dirty: false,
    savedTo: null,      // last path we wrote
    saveModeDecided: null, // 'copy' | 'overwrite' once the user answered "ask"
    scale: null,        // {pdfLength, realLength, unit} measure calibration
    history: [],
    future: [],
    author: '',

    // -- bus ---------------------------------------------------------------

    /**
     * Emit only while this store is the one on screen. A background tab can
     * still mutate — an autosave restore, a compare finishing, an undo issued
     * before the user flipped away — and letting those repaint the viewer or
     * the markup list would redraw the focused document with another one's
     * annotations.
     */
    emit(name, detail) {
      if (RP.store !== this) return;
      RP.bus.emit(name, detail);
    },

    /** True when this store is the one the toolbar and viewer are pointed at. */
    isActive() { return RP.store === this; },

    // -- lifecycle ---------------------------------------------------------

    reset() {
      this.doc = null;
      this.docPath = null;
      this.docName = '';
      this.docBytes = null;
      this.baseBytes = null;
      this.pageOrder = null;
      this.sources = null;
      this.numPages = 0;
      this.annotations = [];
      this.selection.clear();
      this.dirty = false;
      this.savedTo = null;
      this.saveModeDecided = null;
      this.scale = null;
      this.history = [];
      this.future = [];
      this.emit('doc:reset');
    },

    setDocument({ doc, path, name, bytes }) {
      this.doc = doc;
      this.docPath = path || null;
      this.docName = name || RP.basename(path) || 'Untitled.pdf';
      this.docBytes = bytes || null;
      this.baseBytes = null;
      this.pageOrder = null;
      this.sources = null;
      this.numPages = doc ? doc.numPages : 0;
      this.annotations = [];
      this.selection.clear();
      this.history = [];
      this.future = [];
      this.dirty = false;
      this.savedTo = null;
      this.saveModeDecided = null;
      this.scale = null;
      this.emit('doc:loaded', this);
    },

    // -- history -----------------------------------------------------------

    /* The page order rides along in every snapshot so that inserting, deleting,
       reordering and rotating pages undo through the same Ctrl+Z as markups. */
    snapshot() {
      return JSON.stringify({
        annotations: this.annotations,
        scale: this.scale,
        pageOrder: this.pageOrder
      });
    },

    /** Call before any mutation you want to be undoable. */
    checkpoint() {
      this.history.push(this.snapshot());
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.future.length = 0;
    },

    restore(snap) {
      const parsed = JSON.parse(snap);
      const orderBefore = JSON.stringify(this.pageOrder);
      this.annotations = parsed.annotations || [];
      this.scale = parsed.scale || null;
      if (parsed.pageOrder !== undefined) this.pageOrder = parsed.pageOrder;
      const alive = new Set(this.annotations.map((a) => a.id));
      for (const id of Array.from(this.selection)) if (!alive.has(id)) this.selection.delete(id);
      this.emit('annots:changed', { reason: 'history' });
      this.emit('selection:changed');
      // The document bytes are derived from pageOrder, so a history step that
      // moved pages has to rebuild them before the viewer means anything.
      if (JSON.stringify(this.pageOrder) !== orderBefore) {
        this.emit('pages:changed', { reason: 'history' });
      }
    },

    undo() {
      if (!this.history.length) return false;
      this.future.push(this.snapshot());
      this.restore(this.history.pop());
      this.markDirty();
      return true;
    },

    redo() {
      if (!this.future.length) return false;
      this.history.push(this.snapshot());
      this.restore(this.future.pop());
      this.markDirty();
      return true;
    },

    canUndo() { return this.history.length > 0; },
    canRedo() { return this.future.length > 0; },

    /**
     * The only state change that has to escape the active-store gate: a tab you
     * are not looking at still shows its unsaved dot in the strip, and the
     * window-close guard has to know about every dirty document, not just the
     * one on screen.
     */
    markDirty(value) {
      const next = value === undefined ? true : !!value;
      const changed = this.dirty !== next;
      this.dirty = next;
      if (changed || next) this.emit('dirty:changed', next);
      if (changed && RP.tabs) RP.tabs.syncStrip();
    },

    // -- annotations -------------------------------------------------------

    typeLabel(type) { return TYPE_LABELS[type] || type; },

    add(annot, opts) {
      if (!(opts && opts.noCheckpoint)) this.checkpoint();
      const record = Object.assign({
        id: RP.uid('mk'),
        created: Date.now(),
        modified: Date.now(),
        author: this.author || '',
        note: '',
        status: 'open'
      }, annot);
      this.annotations.push(record);
      this.markDirty();
      this.emit('annots:changed', { reason: 'add', annot: record });
      return record;
    },

    /** Bulk insert without a checkpoint per item (used when loading a file). */
    load(list) {
      // `status` is normalised on the way in rather than read through
      // `RP.statusOf` at every call site: a drawing saved before 0.6 has no
      // status at all, and a file written by a later version could carry one
      // this build does not know. Both have to end up as a value the filter,
      // the renderer and the exporter can all agree on.
      this.annotations = (list || []).map((a) => Object.assign(
        { id: RP.uid('mk') }, a, { status: statusOf(a) }
      ));
      this.history = [];
      this.future = [];
      this.selection.clear();
      this.emit('annots:changed', { reason: 'load' });
    },

    get(id) { return this.annotations.find((a) => a.id === id) || null; },

    forPage(pageIndex) {
      return this.annotations.filter((a) => a.page === pageIndex);
    },

    update(id, patch, opts) {
      const annot = this.get(id);
      if (!annot) return null;
      if (!(opts && opts.noCheckpoint)) this.checkpoint();
      Object.assign(annot, patch, { modified: Date.now() });
      this.markDirty();
      this.emit('annots:changed', { reason: 'update', annot });
      return annot;
    },

    /** Mutate in place during a drag; caller checkpoints once at drag start. */
    touch(annot) {
      annot.modified = Date.now();
      this.markDirty();
      this.emit('annots:changed', { reason: 'live', annot });
    },

    remove(ids) {
      const set = new Set([].concat(ids));
      if (!set.size) return 0;
      this.checkpoint();
      const before = this.annotations.length;
      this.annotations = this.annotations.filter((a) => !set.has(a.id));
      for (const id of set) this.selection.delete(id);
      const removed = before - this.annotations.length;
      if (removed) {
        this.markDirty();
        this.emit('annots:changed', { reason: 'remove' });
        this.emit('selection:changed');
      }
      return removed;
    },

    /**
     * Set the review status on one or many markups as a single undo step.
     *
     * Working through `update` per id would push a checkpoint each — Ctrl+Z
     * after closing out a multi-select would then step back through the
     * selection one markup at a time, which is not the action the user took.
     */
    setStatus(ids, status) {
      /* A status this build does not know is refused rather than coerced.
         `statusOf` normalises *reads* to 'open' so an unknown value can still
         be drawn and listed, but doing the same on a write would let a typo
         quietly reopen a closed markup — the one outcome a punch list cannot
         afford. */
      if (!STATUSES.includes(status)) return 0;
      const next = status;
      const set = new Set([].concat(ids));
      const targets = this.annotations.filter((a) => set.has(a.id) && statusOf(a) !== next);
      if (!targets.length) return 0;
      this.checkpoint();
      for (const annot of targets) {
        annot.status = next;
        annot.modified = Date.now();
      }
      this.markDirty();
      this.emit('annots:changed', { reason: 'status' });
      return targets.length;
    },

    /** How many of `list` sit at each status — the status bar's summary line. */
    statusCounts(list) {
      const counts = { open: 0, closed: 0, rejected: 0 };
      for (const annot of list || this.annotations) counts[statusOf(annot)] += 1;
      return counts;
    },

    // -- selection ---------------------------------------------------------

    select(id, additive) {
      if (!additive) this.selection.clear();
      if (id) this.selection.add(id);
      this.emit('selection:changed');
    },

    toggleSelect(id) {
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
      this.emit('selection:changed');
    },

    clearSelection() {
      if (!this.selection.size) return;
      this.selection.clear();
      this.emit('selection:changed');
    },

    selected() {
      return this.annotations.filter((a) => this.selection.has(a.id));
    },

    // -- measurement scale -------------------------------------------------

    setScale(scale) {
      this.checkpoint();
      this.scale = scale;
      this.markDirty();
      this.emit('scale:changed', scale);
    },

    /** Convert a length in PDF points to the calibrated real-world string. */
    formatLength(points) {
      if (!this.scale || !this.scale.pdfLength) {
        return (points / 72).toFixed(2) + ' in (paper)';
      }
      const value = points * (this.scale.realLength / this.scale.pdfLength);
      const decimals = value >= 100 ? 1 : 2;
      return value.toFixed(decimals) + ' ' + (this.scale.unit || '');
    },

    /**
     * Everything we persist inside the PDF so markups stay editable.
     *
     * Version 3 added `status`. The bump is a marker rather than a gate:
     * nothing reads it to decide how to parse, because `load` normalises a
     * missing status anyway. An older build reading one of these files keeps
     * the field — it copies whole annotation objects both in and out — so a
     * 0.5 round-trip preserves the statuses it cannot show, and only walks the
     * version number back to 2.
     */
    serialize() {
      return {
        version: 3,
        app: 'redline-pdf',
        savedAt: Date.now(),
        scale: this.scale,
        annotations: this.annotations.map((a) => {
          const copy = Object.assign({}, a);
          delete copy.id;
          return copy;
        })
      };
    }
  };

    return Store;
  }

  RP.createStore = createStore;

  /* The store the UI is pointed at. Reassigned by RP.tabs on every switch; it
     starts as an empty one so that boot, and anything that runs before a
     document exists, has something valid to read. */
  RP.store = createStore();
  RP.TYPE_LABELS = TYPE_LABELS;

  /* Status is read by render.js and exporter.js as well as by the UI, and both
     of those must agree with the model about what an absent one means, so the
     normaliser is shared rather than reimplemented per caller. */
  RP.STATUSES = STATUSES;
  RP.STATUS_LABELS = STATUS_LABELS;
  RP.statusOf = statusOf;

})(window.RP);
