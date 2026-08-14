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
    measure: 'Measurement',
    polyline: 'Polyline',
    polylength: 'Run length',
    area: 'Area'
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

  /* Grouping is **one field**, not a container annotation: markups sharing a
     `group` string are a group, and a group is nothing more than that. The
     alternative — a group markup owning a list of children — has to be kept in
     step with every path that already exists for a single markup (delete,
     status, page remap, extract, the exporter, the markup list), and every one
     of those is a place a child can be orphaned from a parent that still names
     it. A shared field cannot be inconsistent, because there is nothing for it
     to be inconsistent *with*.

     The model is deliberately flat: grouping a selection that already contains
     a group absorbs it rather than nesting, and ungrouping is one step rather
     than a walk up a tree. Nesting is the feature that turns "select this" into
     a question about which level you meant, and it is not one a drawing markup
     needs. */

  /** The group a markup belongs to, or null. Anything not a string is no group. */
  function groupOf(annot) {
    const value = annot && annot.group;
    return typeof value === 'string' && value ? value : null;
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
    numbering: null,    // page-number / Bates spec, or null for none
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
      this.numbering = null;
      this.history = [];
      this.future = [];
      this.emit('doc:reset');
    },

    setDocument({ doc, path, name, bytes, encrypted }) {
      this.doc = doc;
      this.docPath = path || null;
      /* Set once, at open, and never cleared while the document is open: it is
         a fact about the bytes, not a state of the session. Everything that
         writes a PDF from those bytes has to check it, because pdf-lib cannot
         rewrite an encrypted file and fails by producing a damaged one rather
         than by throwing. See `App.confirmWritable`. */
      this.encrypted = !!encrypted;
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
      this.numbering = null;
      this.emit('doc:loaded', this);
    },

    // -- history -----------------------------------------------------------

    /* The page order rides along in every snapshot so that inserting, deleting,
       reordering and rotating pages undo through the same Ctrl+Z as markups. */
    snapshot() {
      return JSON.stringify({
        annotations: this.annotations,
        scale: this.scale,
        pageOrder: this.pageOrder,
        numbering: this.numbering
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
      this.numbering = parsed.numbering || null;
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

    /**
     * The fields every markup gets whether or not the caller set them. Shared
     * by `add` and `addMany` rather than written out twice: a default added to
     * one and not the other is a field that exists on markups made by one route
     * and not the other, which nothing downstream would think to check for.
     */
    newRecord(annot) {
      return Object.assign({
        id: RP.uid('mk'),
        created: Date.now(),
        modified: Date.now(),
        author: this.author || '',
        note: '',
        status: 'open'
      }, annot);
    },

    add(annot, opts) {
      if (!(opts && opts.noCheckpoint)) this.checkpoint();
      const record = this.newRecord(annot);
      this.annotations.push(record);
      this.markDirty();
      this.emit('annots:changed', { reason: 'add', annot: record });
      return record;
    },

    /**
     * Insert several markups as one undo step and one repaint.
     *
     * `add` in a loop would checkpoint per item and emit `annots:changed` per
     * item — so `Ctrl+Z` after a paste would take the markups back one at a
     * time, and `redrawAll` plus the markup list would run once per markup.
     * Same reasoning as `setStatus`: the user made one gesture.
     */
    addMany(list) {
      const items = (list || []).filter(Boolean);
      if (!items.length) return [];
      this.checkpoint();
      const made = items.map((annot) => {
        const record = this.newRecord(annot);
        this.annotations.push(record);
        return record;
      });
      this.markDirty();
      this.emit('annots:changed', { reason: 'add-many', count: made.length });
      return made;
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
      // A file could arrive with a group of one — written by a build without
      // this normalisation, or left behind by an extract that took part of a
      // group's sheet. It is not a group here.
      this.dropOrphanGroups();
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
      // Part of a group deleted can leave one markup behind still claiming to
      // be in it. Same checkpoint, same repaint — see `dropOrphanGroups`.
      this.dropOrphanGroups();
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

    // -- groups ------------------------------------------------------------

    /** Every markup carrying `groupId`, in document order. */
    groupMembers(groupId) {
      if (!groupId) return [];
      return this.annotations.filter((a) => groupOf(a) === groupId);
    },

    /**
     * `ids` plus every markup grouped with one of them.
     *
     * This is what makes a group behave like one thing without anything below
     * the selection having to know groups exist: a click, a shift-click, a
     * marquee and a markup-list row all end up here, and `move`, `delete`,
     * `status`, `copy` and the style controls all read the selection.
     */
    expandGroups(ids) {
      const out = new Set([].concat(ids || []).filter(Boolean));
      const groups = new Set();
      for (const annot of this.annotations) {
        if (out.has(annot.id)) { const g = groupOf(annot); if (g) groups.add(g); }
      }
      if (!groups.size) return out;
      for (const annot of this.annotations) {
        if (groups.has(groupOf(annot))) out.add(annot.id);
      }
      return out;
    },

    /**
     * The selected groups on `pageIndex` as `{id, members}`, for the one frame
     * the viewer draws around each of them.
     *
     * Only fully selected groups count. Selection always expands, so a partial
     * one should not exist — but a frame drawn around markups that are not all
     * selected would claim a drag moves more than it does, and being wrong
     * about that is worse than drawing nothing.
     */
    selectedGroups(pageIndex) {
      const byGroup = new Map();
      for (const annot of this.annotations) {
        const g = groupOf(annot);
        if (!g) continue;
        if (pageIndex !== undefined && pageIndex !== null && annot.page !== pageIndex) continue;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(annot);
      }
      const out = [];
      for (const [id, members] of byGroup) {
        if (members.length < 2) continue;
        if (!members.every((a) => this.selection.has(a.id))) continue;
        out.push({ id, members });
      }
      return out;
    },

    /**
     * Drop the `group` field from any group left with fewer than two members.
     *
     * A group of one is not a group — it draws a frame around a single markup,
     * offers Ungroup on something that looks ungrouped, and survives into the
     * saved file for ever. Deleting part of a group is the way to make one, so
     * this runs on `remove`; `load` runs it too because a file written by
     * another build could arrive carrying one.
     *
     * Mutates in place without a checkpoint of its own — both callers have
     * already taken theirs, and this is part of the same step.
     */
    dropOrphanGroups() {
      const counts = new Map();
      for (const annot of this.annotations) {
        const g = groupOf(annot);
        if (g) counts.set(g, (counts.get(g) || 0) + 1);
      }
      let dropped = 0;
      for (const annot of this.annotations) {
        const g = groupOf(annot);
        if (g && counts.get(g) < 2) { delete annot.group; dropped += 1; }
      }
      return dropped;
    },

    // -- selection ---------------------------------------------------------

    select(id, additive) {
      if (!additive) this.selection.clear();
      if (id) for (const member of this.expandGroups([id])) this.selection.add(member);
      this.emit('selection:changed');
    },

    /**
     * Add several markups to the selection at once, groups and all.
     *
     * The marquee and Ctrl+A used to write into `store.selection` directly.
     * That is the one route into the selection that would not expand a group,
     * so a marquee clipping one member of a group would take that member alone
     * and then drag it out of its own group.
     *
     * Silent, unlike `select` and `toggleSelect`: both callers clear or gather
     * first and emit once when they are done, and a second event here would
     * repaint every page on screen twice per marquee.
     */
    addToSelection(ids) {
      const before = this.selection.size;
      for (const id of this.expandGroups(ids)) this.selection.add(id);
      return this.selection.size - before;
    },

    /**
     * Shift-click. A group toggles as a unit, and the *clicked* markup decides
     * which way — reading each member's own state instead would leave a group
     * whose members disagreed inverting into a different half of itself.
     */
    toggleSelect(id) {
      const members = this.expandGroups([id]);
      const on = this.selection.has(id);
      for (const member of members) {
        if (on) this.selection.delete(member);
        else this.selection.add(member);
      }
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

    // -- page numbering ----------------------------------------------------

    /**
     * Set or clear the page-number / Bates spec, as one undo step.
     *
     * `annots:changed` rather than an event of its own: the number is drawn on
     * the markup canvas and stamped by the exporter, so the two things that
     * have to hear about it are exactly the two things that listen to that
     * already. A separate event would mean a second listener in the viewer for
     * the same repaint.
     */
    setNumbering(spec) {
      const next = spec || null;
      if (JSON.stringify(this.numbering || null) === JSON.stringify(next)) return false;
      this.checkpoint();
      this.numbering = next;
      this.markDirty();
      this.emit('annots:changed', { reason: 'numbering' });
      return true;
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
     * The same for an area, given square PDF points.
     *
     * The calibration is a *linear* ratio and the unit it carries is a linear
     * unit, so both are squared here: the factor twice over, and a `²` onto
     * the unit. Applying the ratio once — which is the obvious mistake, since
     * it is the same field `formatLength` uses — under-reports a room by the
     * scale factor itself, and on a 1:100 drawing that is a hundredfold error
     * in a number somebody is going to order material against.
     *
     * `²` is U+00B2, which is inside WinAnsi, so the standard 14 fonts can
     * stamp this string into a PDF as it stands. Anything outside that
     * encoding throws in pdf-lib rather than substituting.
     */
    formatArea(pointsSq) {
      if (!this.scale || !this.scale.pdfLength) {
        return (pointsSq / 5184).toFixed(2) + ' in² (paper)';
      }
      const ratio = this.scale.realLength / this.scale.pdfLength;
      const value = pointsSq * ratio * ratio;
      const decimals = value >= 100 ? 1 : 2;
      return value.toFixed(decimals) + ' ' + (this.scale.unit || '') + '²';
    },

    /**
     * Everything we persist inside the PDF so markups stay editable.
     *
     * Version 3 added `status`; version 4 added `numbering`; version 5 added
     * `group`. The bump is a marker rather than a gate: nothing reads it to
     * decide how to parse, because `load` normalises a missing status anyway.
     * An older build reading one of these files keeps the field — it copies
     * whole annotation objects both in and out — so a 0.5 round-trip preserves
     * the statuses it cannot show, and only walks the version number back to 2.
     *
     * `group` survives that round trip for the same reason, which is the whole
     * argument for grouping being a field rather than a container annotation: a
     * build that has never heard of groups carries them through untouched,
     * whereas a container markup would be drawn as an unrecognised type or
     * dropped, and its children left naming a parent that no longer exists.
     *
     * `numbering` is a document-level field rather than a per-annotation one,
     * so an older build round-trips it as *nothing*: it reads the model, never
     * looks at the key, and writes its own model back without it. That is the
     * honest outcome — the numbers stay stamped in the page content either way,
     * and only the ability to re-edit them is lost.
     */
    serialize() {
      return {
        version: 5,
        app: 'redline-pdf',
        savedAt: Date.now(),
        scale: this.scale,
        numbering: this.numbering,
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

  /* Shared for the same reason `statusOf` is: render.js, viewer.js, tools.js
     and sidebar.js all have to agree about what counts as a group, and a second
     `annot.group && typeof …` test written out somewhere else is a second
     answer waiting to drift from this one. */
  RP.groupOf = groupOf;

})(window.RP);
