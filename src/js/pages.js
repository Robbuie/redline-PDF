/* Page management: insert, delete, duplicate, reorder, rotate and extract.

   The open document is treated as a *derived* artifact. `store.baseBytes` holds
   the file with any previous Redline stamps taken back out, `store.pageOrder`
   is a plain list of descriptors saying which source page goes where, and the
   working PDF is rebuilt from the two whenever that list changes.

   Keeping the structure as data rather than mutating bytes in place is what
   lets page edits ride the existing snapshot undo alongside markups: the order
   travels inside every `store.checkpoint()`, and `store.restore()` asks for a
   rebuild when a history step moved pages.

   A descriptor is:
     { uid, src: 'base'|<sourceKey>, srcIndex, rot, blank: {w,h}|null }
   where `rot` is a delta in degrees applied on top of the source page's own
   /Rotate, so rotating never disturbs annotation coordinates. */
'use strict';

(function (RP) {

  const ROT_STEP = 90;

  function lib() {
    if (!window.PDFLib) throw new Error('pdf-lib failed to load');
    return window.PDFLib;
  }

  // -------------------------------------------------------------------------
  // Order maths — pure, so `test/verify.js` can exercise it headless
  // -------------------------------------------------------------------------

  /**
   * Turn a working list of `{item, from}` entries into the shape every caller
   * wants: the new order, an old-index -> new-index map (-1 where a page was
   * dropped) and the clone pairs so annotations can be copied along.
   */
  function finish(next, oldLength) {
    const order = next.map((entry) => entry.item);
    const map = new Array(oldLength).fill(-1);
    const clones = [];
    next.forEach((entry, index) => {
      if (entry.from >= 0) map[entry.from] = index;
      if (entry.clonedFrom >= 0) clones.push({ from: entry.clonedFrom, to: index });
    });
    return { order, map, clones };
  }

  function entriesOf(order) {
    return order.map((item, from) => ({ item, from, clonedFrom: -1 }));
  }

  function normaliseRot(value) {
    return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  }

  const ops = {
    descriptor(src, srcIndex, rot) {
      return { uid: RP.uid('pg'), src: src, srcIndex: srcIndex, rot: normaliseRot(rot || 0), blank: null };
    },

    blank(width, height) {
      return {
        uid: RP.uid('pg'), src: 'blank', srcIndex: -1, rot: 0,
        blank: { w: Math.round(width) || 612, h: Math.round(height) || 792 }
      };
    },

    /** The identity order for a freshly opened document. */
    fromDocument(count) {
      const order = [];
      for (let i = 0; i < count; i += 1) order.push(ops.descriptor('base', i, 0));
      return order;
    },

    remove(order, indices) {
      const doomed = new Set(indices);
      const next = entriesOf(order).filter((entry) => !doomed.has(entry.from));
      return finish(next, order.length);
    },

    duplicate(order, indices) {
      const wanted = new Set(indices);
      const next = [];
      entriesOf(order).forEach((entry) => {
        next.push(entry);
        if (!wanted.has(entry.from)) return;
        const copy = Object.assign({}, entry.item, { uid: RP.uid('pg') });
        next.push({ item: copy, from: -1, clonedFrom: entry.from });
      });
      return finish(next, order.length);
    },

    insert(order, at, descriptors) {
      const list = [].concat(descriptors);
      const entries = entriesOf(order);
      const where = RP.clamp(at, 0, entries.length);
      const made = list.map((item) => ({ item: item, from: -1, clonedFrom: -1 }));
      const next = entries.slice(0, where).concat(made, entries.slice(where));
      return finish(next, order.length);
    },

    /** Move `indices` so they land at insertion point `at` in the old order. */
    move(order, indices, at) {
      const moving = new Set(indices);
      const entries = entriesOf(order);
      const picked = entries.filter((entry) => moving.has(entry.from));
      const rest = entries.filter((entry) => !moving.has(entry.from));
      if (!picked.length) return finish(entries, order.length);
      const removedBefore = indices.filter((index) => index < at).length;
      const where = RP.clamp(at - removedBefore, 0, rest.length);
      const next = rest.slice(0, where).concat(picked, rest.slice(where));
      return finish(next, order.length);
    },

    rotate(order, indices, delta) {
      const wanted = new Set(indices);
      const next = entriesOf(order).map((entry) => {
        if (!wanted.has(entry.from)) return entry;
        const item = Object.assign({}, entry.item, { rot: normaliseRot((entry.item.rot || 0) + delta) });
        return { item: item, from: entry.from, clonedFrom: -1 };
      });
      return finish(next, order.length);
    }
  };

  /**
   * Move annotations onto their pages' new indices, drop the ones whose page
   * is gone, and copy them onto freshly duplicated pages. Mutates the survivors
   * in place so anything holding a reference (a live drag, the markup list)
   * keeps pointing at the same object.
   */
  function remapAnnotations(annotations, map, clones) {
    const copies = [];
    for (const clone of clones || []) {
      for (const annot of annotations) {
        if (annot.page !== clone.from) continue;
        copies.push(Object.assign({}, annot, {
          id: RP.uid('mk'),
          page: clone.to,
          created: Date.now(),
          modified: Date.now()
        }));
      }
    }
    const kept = annotations.filter((annot) => map[annot.page] >= 0);
    for (const annot of kept) annot.page = map[annot.page];
    return kept.concat(copies).sort((a, b) => a.page - b.page);
  }

  // -------------------------------------------------------------------------
  // Rebuilding the bytes
  // -------------------------------------------------------------------------

  /**
   * Assemble a PDF from `order`. Pages are copied per *occurrence*, never
   * shared: pdf-lib's copier caches by source object, so asking for the same
   * index twice in one `copyPages` call hands back the same page node and a
   * duplicated page would alias its original.
   */
  async function buildBytes(baseBytes, order, sources) {
    const { PDFDocument, degrees } = lib();
    if (!order || !order.length) throw new Error('A document needs at least one page');

    const loaded = new Map();
    const docFor = async (key) => {
      if (loaded.has(key)) return loaded.get(key);
      const bytes = key === 'base' ? baseBytes : (sources || {})[key];
      if (!bytes) throw new Error('Missing page source: ' + key);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      loaded.set(key, doc);
      return doc;
    };

    // Work out how many copies of each source page we need, then take them in
    // passes: pass 0 covers every page once, pass 1 only the ones wanted twice.
    const wanted = new Map();
    for (const item of order) {
      if (item.blank) continue;
      if (!wanted.has(item.src)) wanted.set(item.src, new Map());
      const counts = wanted.get(item.src);
      counts.set(item.srcIndex, (counts.get(item.srcIndex) || 0) + 1);
    }

    const out = await PDFDocument.create();
    const pool = new Map(); // src -> Map(srcIndex -> [copied pages])

    for (const [key, counts] of wanted) {
      const src = await docFor(key);
      const available = src.getPageCount();
      const byIndex = new Map();
      const passes = Math.max.apply(null, Array.from(counts.values()));
      for (let pass = 0; pass < passes; pass += 1) {
        const indices = [];
        for (const [index, count] of counts) {
          if (count <= pass) continue;
          if (index < 0 || index >= available) throw new Error('Page ' + (index + 1) + ' is not in ' + key);
          indices.push(index);
        }
        indices.sort((a, b) => a - b);
        const copied = await out.copyPages(src, indices);
        indices.forEach((index, i) => {
          if (!byIndex.has(index)) byIndex.set(index, []);
          byIndex.get(index).push(copied[i]);
        });
      }
      pool.set(key, byIndex);
    }

    const taken = new Map();
    for (const item of order) {
      let page;
      if (item.blank) {
        page = out.addPage([item.blank.w, item.blank.h]);
      } else {
        const key = item.src + '#' + item.srcIndex;
        const used = taken.get(key) || 0;
        page = pool.get(item.src).get(item.srcIndex)[used];
        taken.set(key, used + 1);
        out.addPage(page);
      }
      if (item.rot) {
        page.setRotation(degrees(normaliseRot((page.getRotation().angle || 0) + item.rot)));
      }
    }

    out.setProducer('Redline PDF');
    return out.save({ useObjectStreams: false });
  }

  // -------------------------------------------------------------------------
  // The module proper
  // -------------------------------------------------------------------------

  const Pages = {
    selection: new Set(),
    anchor: null,
    busy: false,
    suppressClick: false,
    dropAt: null,
    els: {},

    init() {
      this.els.host = RP.$('#thumbList');
      this.els.count = RP.$('#thumbCount');
      this.els.tools = RP.$('#pageTools');
      if (!this.els.host) return;

      this.els.indicator = RP.el('div', { class: 'thumb-drop', hidden: true });
      this.els.host.appendChild(this.els.indicator);

      const actions = {
        pgInsert: () => this.insertBlank(),
        pgDuplicate: () => this.duplicateSelected(),
        pgRotateCcw: () => this.rotateSelected(-ROT_STEP),
        pgRotateCw: () => this.rotateSelected(ROT_STEP),
        pgExtract: () => this.extractSelected(),
        pgDelete: () => this.deleteSelected()
      };
      for (const id of Object.keys(actions)) {
        const button = RP.$('#' + id);
        if (button) button.addEventListener('click', () => this.run(actions[id]));
      }

      this.els.host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
      this.els.host.addEventListener('contextmenu', (event) => this.onContextMenu(event));
      this.els.host.addEventListener('keydown', (event) => this.onKeyDown(event));

      RP.bus.on('thumbs:built', () => this.sync());
      RP.bus.on('doc:loaded', () => { this.selection.clear(); this.anchor = null; this.sync(); });
      RP.bus.on('pages:changed', (info) => {
        // A history step changed the order; the bytes have to catch up.
        if (info && info.reason === 'history') this.run(() => this.rebuild());
      });
      this.sync();
    },

    // -- selection ---------------------------------------------------------

    /** Called by the viewer. Returns true when the click was a selection
        gesture and the viewer should not scroll to that page. */
    handleThumbClick(index, event) {
      if (this.suppressClick) { this.suppressClick = false; return true; }
      if (event.shiftKey && this.anchor !== null) {
        this.selection.clear();
        const from = Math.min(this.anchor, index);
        const to = Math.max(this.anchor, index);
        for (let i = from; i <= to; i += 1) this.selection.add(i);
        this.sync();
        return true;
      }
      if (event.ctrlKey || event.metaKey) {
        if (this.selection.has(index)) this.selection.delete(index);
        else this.selection.add(index);
        this.anchor = index;
        this.sync();
        return true;
      }
      this.selection.clear();
      this.selection.add(index);
      this.anchor = index;
      this.sync();
      return false;
    },

    selected() {
      const count = RP.store.numPages;
      return Array.from(this.selection).filter((i) => i < count).sort((a, b) => a - b);
    },

    /** The pages an action applies to: the selection, or the current page. */
    target() {
      const picked = this.selected();
      if (picked.length) return picked;
      return RP.store.numPages ? [RP.viewer.currentPage] : [];
    },

    selectRange(indices) {
      this.selection.clear();
      for (const index of indices) this.selection.add(index);
      this.anchor = indices.length ? indices[0] : null;
    },

    selectAll() {
      this.selectRange(RP.store.pageOrder
        ? RP.store.pageOrder.map((item, i) => i)
        : RP.viewer.pages.map((record) => record.index));
      this.sync();
    },

    sync() {
      const host = this.els.host;
      if (!host) return;
      for (const record of RP.viewer.pages) {
        if (!record.thumbButton) continue;
        record.thumbButton.classList.toggle('selected', this.selection.has(record.index));
      }
      const picked = this.selected();
      const total = RP.store.numPages;
      if (this.els.count) {
        this.els.count.textContent = !total ? ''
          : picked.length > 1 ? picked.length + ' of ' + total + ' selected'
            : total + (total === 1 ? ' page' : ' pages');
      }
      const enable = (id, on) => {
        const button = RP.$('#' + id);
        if (button) button.disabled = !on;
      };
      const has = total > 0;
      enable('pgInsert', has && !this.busy);
      enable('pgDuplicate', has && !this.busy);
      enable('pgRotateCcw', has && !this.busy);
      enable('pgRotateCw', has && !this.busy);
      enable('pgExtract', has && !this.busy);
      enable('pgDelete', has && !this.busy && picked.length < total);
    },

    // -- applying a change -------------------------------------------------

    /** Serialise page work: two rebuilds at once would race on store.doc. */
    async run(fn) {
      if (this.busy) return false;
      this.busy = true;
      this.sync();
      try {
        return await fn();
      } catch (err) {
        console.error('Page operation failed', err);
        RP.toast('That page change could not be applied: ' + err.message, 'error', 6000);
        RP.status('');
        return false;
      } finally {
        this.busy = false;
        this.sync();
      }
    },

    /** Fill in baseBytes and the identity page order on first use. */
    async ensureBase() {
      const store = RP.store;
      if (!store.docBytes) throw new Error('No document is open');
      /* Every page operation rebuilds the file through pdf-lib, which cannot
         read an encrypted one — it would strip to garbage here and rebuild a
         damaged document from it. Thrown rather than returned so it lands in
         `run()`'s catch and reaches the user as a toast, whichever of the
         half-dozen page operations asked for it. */
      if (store.encrypted) {
        throw new Error('this drawing is password-protected, so its pages cannot be changed');
      }
      if (!store.baseBytes) store.baseBytes = await RP.exporter.stripToBaseBytes(store.docBytes);
      if (!store.pageOrder) store.pageOrder = ops.fromDocument(store.numPages);
      return store.baseBytes;
    },

    /**
     * Run a pure order op and commit it. The new bytes are built *before*
     * anything is written to the store, so a failure part-way leaves the open
     * document exactly as it was.
     */
    async apply(mutate, opts) {
      const options = opts || {};
      const store = RP.store;
      if (!store.doc) return false;
      await this.ensureBase();

      const result = mutate(store.pageOrder);
      if (!result || !result.order.length) return false;
      if (JSON.stringify(result.order) === JSON.stringify(store.pageOrder)) return false;

      RP.status(options.status || 'Applying page change…');
      const bytes = await buildBytes(store.baseBytes, result.order, store.sources);

      store.checkpoint();
      store.pageOrder = result.order;
      store.annotations = remapAnnotations(store.annotations, result.map, result.clones);
      store.selection.clear();
      if (options.select) this.selectRange(options.select(result));
      await this.reload(bytes, { focus: options.focus ? options.focus(result) : undefined });
      store.markDirty(true);
      RP.status('');
      if (options.toast) RP.toast(options.toast(result), 'good');
      return true;
    },

    /** Rebuild from the current order — used after an undo/redo. */
    async rebuild() {
      const store = RP.store;
      if (!store.pageOrder || !store.baseBytes) return false;
      RP.status('Rebuilding document…');
      const bytes = await buildBytes(store.baseBytes, store.pageOrder, store.sources);
      await this.reload(bytes, {});
      RP.status('');
      return true;
    },

    /** Swap the freshly built bytes in, keeping zoom, fit mode and position. */
    async reload(bytes, opts) {
      const options = opts || {};
      const store = RP.store;
      const viewer = RP.viewer;
      const keepZoom = viewer.zoom;
      const keepFit = viewer.fitMode;
      const wasOn = viewer.currentPage;

      const doc = await pdfjsLib.getDocument(RP.pdfjs.docParams({ data: bytes.slice(0) })).promise;
      const previous = store.doc;
      store.doc = doc;
      store.docBytes = bytes;
      store.numPages = doc.numPages;

      RP.compare.close();
      viewer.zoom = keepZoom;
      viewer.fitMode = keepFit;
      // Named store: page edits only ever apply to the focused tab, and the
      // pane has to be told which document it is now showing.
      await viewer.open(doc, store);
      RP.search.reset();
      if (previous && previous.destroy) {
        try { await previous.destroy(); } catch (err) { /* the old proxy is done with */ }
      }

      const focus = options.focus === undefined ? wasOn : options.focus;
      viewer.goToPage(RP.clamp(focus, 0, doc.numPages - 1), { instant: true });
      RP.bus.emit('annots:changed', { reason: 'pages' });
      RP.bus.emit('pages:rebuilt', store.pageOrder);
      this.sync();
    },

    // -- operations --------------------------------------------------------

    /** Size a blank page to match the page it is being filed next to. */
    blankSizeAt(index) {
      const record = RP.viewer.pages[RP.clamp(index, 0, RP.viewer.pages.length - 1)];
      if (!record) return { w: 612, h: 792 };
      const view = record.pageProxy.getViewport({ scale: 1, rotation: record.pageProxy.rotate || 0 });
      return { w: view.width, h: view.height };
    },

    insertBlank(at) {
      const picked = this.target();
      const where = at === undefined
        ? (picked.length ? picked[picked.length - 1] + 1 : RP.store.numPages)
        : at;
      const size = this.blankSizeAt(where - 1 >= 0 ? where - 1 : 0);
      return this.apply(
        (order) => ops.insert(order, where, ops.blank(size.w, size.h)),
        {
          status: 'Inserting a page…',
          select: () => [where],
          focus: () => where,
          toast: () => 'Blank page inserted at ' + (where + 1)
        }
      );
    },

    duplicateSelected() {
      const picked = this.target();
      if (!picked.length) return false;
      return this.apply(
        (order) => ops.duplicate(order, picked),
        {
          status: 'Duplicating…',
          select: (result) => result.clones.map((clone) => clone.to),
          focus: (result) => result.clones.length ? result.clones[0].to : undefined,
          toast: (result) => result.clones.length + (result.clones.length === 1 ? ' page' : ' pages') +
            ' duplicated, markups and all'
        }
      );
    },

    rotateSelected(delta) {
      const picked = this.target();
      if (!picked.length) return false;
      return this.apply(
        (order) => ops.rotate(order, picked, delta),
        {
          status: 'Rotating…',
          select: () => picked,
          focus: () => picked[0],
          toast: () => picked.length + (picked.length === 1 ? ' page' : ' pages') +
            ' rotated ' + (delta > 0 ? 'clockwise' : 'anticlockwise')
        }
      );
    },

    async deleteSelected() {
      const picked = this.target();
      if (!picked.length) return false;
      if (picked.length >= RP.store.numPages) {
        RP.toast('A document has to keep at least one page', 'warn');
        return false;
      }
      const doomed = new Set(picked);
      const marked = RP.store.annotations.filter((annot) => doomed.has(annot.page)).length;
      if (marked) {
        const answer = await window.rp.dialog.message({
          type: 'warning',
          message: 'Delete ' + picked.length + (picked.length === 1 ? ' page' : ' pages') + '?',
          detail: marked + (marked === 1 ? ' markup is' : ' markups are') +
            ' on ' + (picked.length === 1 ? 'that page' : 'those pages') +
            ' and will go with ' + (picked.length === 1 ? 'it' : 'them') + '. Ctrl+Z undoes this.',
          buttons: ['Delete', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        });
        if (answer.response !== 0) return false;
      }
      return this.apply(
        (order) => ops.remove(order, picked),
        {
          status: 'Removing pages…',
          select: () => [],
          focus: () => RP.clamp(picked[0], 0, RP.store.numPages - picked.length - 1),
          toast: () => picked.length + (picked.length === 1 ? ' page' : ' pages') + ' removed'
        }
      );
    },

    moveSelection(at) {
      const picked = this.target();
      if (!picked.length) return false;
      return this.apply(
        (order) => ops.move(order, picked, at),
        {
          status: 'Reordering…',
          select: (result) => picked.map((index) => result.map[index]),
          focus: (result) => result.map[picked[0]],
          toast: () => picked.length + (picked.length === 1 ? ' page' : ' pages') + ' moved'
        }
      );
    },

    /** Write the chosen pages out as their own PDF, markups included. */
    async extractSelected() {
      const picked = this.target();
      if (!picked.length) return false;
      const store = RP.store;
      const base = RP.stripExt(store.docName || 'drawing');
      const label = picked.length === 1 ? 'page-' + (picked[0] + 1) : 'pages-' + picked.length;
      const suggestion = RP.joinPath(RP.dirname(store.docPath || ''), base + '-' + label + '.pdf');
      const path = await window.rp.files.saveAsDialog({
        title: 'Extract pages to a new PDF',
        defaultPath: suggestion
      });
      if (!path) return false;

      RP.status('Extracting…');
      const { PDFDocument } = lib();
      // Stamp markups first so the extract is a faithful copy of what is on
      // screen; the model is not embedded because its page indices would no
      // longer line up with the smaller document.
      const marked = await RP.exporter.buildPdf({ embed: false });
      const src = await PDFDocument.load(marked, { ignoreEncryption: true, updateMetadata: false });
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, picked);
      for (const page of copied) out.addPage(page);
      out.setProducer('Redline PDF');
      await window.rp.files.write(path, await out.save({ useObjectStreams: false }), false);
      RP.status('');
      RP.toast(picked.length + (picked.length === 1 ? ' page' : ' pages') + ' written to ' + RP.basename(path), 'good');
      return true;
    },

    // -- drag to reorder ---------------------------------------------------

    onPointerDown(event) {
      if (event.button !== 0 || this.busy) return;
      const button = event.target.closest && event.target.closest('.thumb');
      if (!button) return;
      const index = Number(button.dataset.page);
      const start = { x: event.clientX, y: event.clientY };
      let dragging = false;

      const move = (moveEvent) => {
        if (!dragging) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 6) return;
          dragging = true;
          if (!this.selection.has(index)) {
            this.selection.clear();
            this.selection.add(index);
            this.anchor = index;
            this.sync();
          }
          this.els.host.classList.add('reordering');
        }
        this.dropAt = this.dropTargetFor(moveEvent.clientY);
        this.showIndicator(this.dropAt);
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!dragging) return;
        this.els.host.classList.remove('reordering');
        this.hideIndicator();
        this.suppressClick = true;
        const at = this.dropAt;
        this.dropAt = null;
        if (at !== null) this.run(() => this.moveSelection(at));
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },

    /** Insertion index for a pointer at `clientY`. */
    dropTargetFor(clientY) {
      const records = RP.viewer.pages;
      for (const record of records) {
        if (!record.thumbButton) continue;
        const rect = record.thumbButton.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) return record.index;
      }
      return records.length;
    },

    showIndicator(at) {
      const indicator = this.els.indicator;
      const records = RP.viewer.pages;
      if (!indicator || !records.length) return;
      // buildThumbs clears the list wholesale, taking the indicator with it.
      if (!indicator.isConnected) this.els.host.appendChild(indicator);
      let top;
      if (at >= records.length) {
        const last = records[records.length - 1].thumbButton;
        top = last.offsetTop + last.offsetHeight + 3;
      } else {
        top = records[at].thumbButton.offsetTop - 5;
      }
      indicator.style.top = top + 'px';
      indicator.hidden = false;
    },

    hideIndicator() {
      if (this.els.indicator) this.els.indicator.hidden = true;
    },

    // -- context menu ------------------------------------------------------

    onContextMenu(event) {
      const button = event.target.closest && event.target.closest('.thumb');
      if (!button) return;
      event.preventDefault();
      const index = Number(button.dataset.page);
      if (!this.selection.has(index)) {
        this.selection.clear();
        this.selection.add(index);
        this.anchor = index;
        this.sync();
      }
      const many = this.selected().length > 1;
      this.openMenu(event.clientX, event.clientY, [
        { label: 'Insert blank page after', run: () => this.insertBlank() },
        { label: many ? 'Duplicate pages' : 'Duplicate page', run: () => this.duplicateSelected() },
        { label: 'Rotate left', run: () => this.rotateSelected(-ROT_STEP) },
        { label: 'Rotate right', run: () => this.rotateSelected(ROT_STEP) },
        { label: many ? 'Extract pages…' : 'Extract page…', run: () => this.extractSelected() },
        { label: many ? 'Delete pages' : 'Delete page', run: () => this.deleteSelected(), danger: true }
      ]);
    },

    /* The popup itself lives in RP.menu — the viewer needs the same thing, and
       two implementations would mean two sets of dismiss listeners arguing
       over one outside-click. Every action here still goes through `this.run`,
       which is the async/busy guard the page operations need. */
    openMenu(x, y, items) {
      RP.menu.open(x, y, items.map((item) => (
        item.separator ? item : Object.assign({}, item, { run: () => this.run(item.run) })
      )));
    },

    closeMenu() { RP.menu.close(); },

    // -- keyboard ----------------------------------------------------------

    onKeyDown(event) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        this.run(() => this.deleteSelected());
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        this.selectAll();
      }
    }
  };

  RP.pages = Pages;
  RP.pages.ops = ops;
  RP.pages.buildBytes = buildBytes;
  RP.pages.remapAnnotations = remapAnnotations;

})(window.RP);
