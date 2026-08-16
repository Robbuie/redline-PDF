/* Page management: insert, merge, delete, duplicate, reorder, rotate, number,
   split and extract.

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

    /**
     * Rotate each page by a delta of its own — `deltas` is a Map (or a plain
     * object) of page index -> degrees.
     *
     * Straightening a set needs this rather than `rotate`: one sheet is upside
     * down, the next is on its side, and turning them all by the same amount
     * would fix one and break the other. `rotate` is the same op with one
     * delta shared across the picked pages, and goes through here so there is
     * only ever one place that adds to a descriptor's `rot`.
     */
    turn(order, deltas) {
      const map = deltas instanceof Map
        ? deltas
        : new Map(Object.keys(deltas || {}).map((key) => [Number(key), deltas[key]]));
      const next = entriesOf(order).map((entry) => {
        const delta = map.get(entry.from);
        if (!delta) return entry;
        const item = Object.assign({}, entry.item, { rot: normaliseRot((entry.item.rot || 0) + delta) });
        return { item: item, from: entry.from, clonedFrom: -1 };
      });
      return finish(next, order.length);
    },

    rotate(order, indices, delta) {
      const deltas = new Map();
      for (const index of indices) deltas.set(index, delta);
      return ops.turn(order, deltas);
    }
  };

  // -------------------------------------------------------------------------
  // Orientation — pure, so `test/verify.js` can exercise it headless
  // -------------------------------------------------------------------------

  /* Below this many readable characters a page is reported as "could not
     tell" rather than straightened on the strength of a sheet number. */
  const MIN_ORIENT_CHARS = 24;
  /* And below this share of them agreeing. Drawings carry a genuine mix —
     dimension strings run up the sheet on a plan that is the right way up —
     so the question is never "is any text turned" but "which way does most of
     it read". */
  const MIN_ORIENT_SHARE = 0.6;
  /* Text laid at an angle belongs to no quarter turn. It still counts against
     the total, so a sheet annotated on the diagonal reports low confidence
     rather than a confident answer drawn from whatever else is on it. */
  const SKEW_TOLERANCE = 15;

  /** The smallest absolute angle between two headings, in degrees. */
  function angleGap(a, b) {
    return Math.abs((((a - b) % 360) + 540) % 360 - 180);
  }

  /**
   * Which way up a page reads, from the runs in its text layer.
   *
   * `getTextContent` reports each run's matrix in *unrotated* user space, so
   * `atan2(t[1], t[0])` is the direction the run reads before `/Rotate` is
   * applied — and `/Rotate` is applied after the content stream, so what the
   * reader actually sees is that heading turned clockwise by the page
   * rotation. Hence `displayed = (rotation - heading) mod 360`: zero is
   * upright, 180 is upside down, 90 and 270 are the two sideways cases. The
   * correction is the delta that cancels it, which is what `ops.turn` wants.
   *
   * Runs are weighted by how many characters they carry, not counted one
   * apiece: a title block is a handful of long runs and a schedule is hundreds
   * of short ones, and one run per vote would let the schedule outvote the
   * drawing it annotates.
   *
   * Returns `null` when there is not enough text to say, or when no quarter
   * turn carries a clear majority — "could not tell" and "already upright" are
   * different answers and the caller reports them differently.
   */
  function orientationOf(items, pageRotate, opts) {
    const options = opts || {};
    const minChars = options.minChars === undefined ? MIN_ORIENT_CHARS : options.minChars;
    const minShare = options.minShare === undefined ? MIN_ORIENT_SHARE : options.minShare;
    const rotation = normaliseRot(pageRotate || 0);
    const weights = { 0: 0, 90: 0, 180: 0, 270: 0 };
    let total = 0;

    for (const item of (items || [])) {
      const t = item && item.transform;
      if (!t || t.length < 4) continue;
      const chars = String(item.str === undefined ? '' : item.str).replace(/\s+/g, '').length;
      if (!chars) continue;
      const dx = Number(t[0]);
      const dy = Number(t[1]);
      if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) continue;
      total += chars;
      const heading = Math.atan2(dy, dx) * 180 / Math.PI;
      const snapped = normaliseRot(heading);
      if (angleGap(heading, snapped) > SKEW_TOLERANCE) continue;
      weights[((rotation - snapped) % 360 + 360) % 360] += chars;
    }

    if (total < minChars) return null;
    // Ties fall to the lower quarter, which favours 0 — leaving a page alone
    // is the safe answer when the sheet cannot make its mind up.
    let displayed = 0;
    for (const quarter of [90, 180, 270]) {
      if (weights[quarter] > weights[displayed]) displayed = quarter;
    }
    const share = weights[displayed] / total;
    if (!weights[displayed] || share < minShare) return null;
    return {
      delta: (360 - displayed) % 360,
      displayed: displayed,
      confidence: share,
      chars: total
    };
  }

  /**
   * One-based page numbers as a reader would write them: "4", "4 and 6",
   * "4, 7–9 and 12". Runs of three or more collapse; a run of two does not,
   * because "7–8" is longer to read than "7 and 8" and no shorter to print.
   */
  function describePages(indices) {
    const sorted = Array.from(new Set(indices || [])).sort((a, b) => a - b);
    if (!sorted.length) return '';
    const parts = [];
    let start = sorted[0];
    let previous = sorted[0];
    const flush = () => {
      if (previous - start >= 2) parts.push((start + 1) + '–' + (previous + 1));
      else for (let i = start; i <= previous; i += 1) parts.push(String(i + 1));
    };
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] === previous + 1) { previous = sorted[i]; continue; }
      flush();
      start = sorted[i];
      previous = sorted[i];
    }
    flush();
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  /**
   * Split a comma-separated list of ranges into one index list *per group*.
   *
   * `RP.print.parseCustom` flattens "1-4, 5-9" into one list, which is what a
   * print range means. A split means the opposite — each group is a file — so
   * each part is parsed on its own and the groups are kept apart. The syntax is
   * deliberately the same one the print dialog takes; two range grammars in one
   * app is one too many.
   */
  function parseGroups(text, count) {
    const parts = String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const groups = [];
    for (const part of parts) {
      const indices = RP.print.parseCustom(part, count);
      if (!indices) return null;
      groups.push(indices);
    }
    return groups;
  }

  /** Fixed-size chunks of `count` pages, `size` at a time. */
  function chunkGroups(count, size) {
    const step = Math.max(1, Math.round(size) || 1);
    const groups = [];
    for (let i = 0; i < count; i += step) {
      groups.push(Array.from({ length: Math.min(step, count - i) }, (unused, k) => i + k));
    }
    return groups;
  }

  /**
   * Chunks that begin at each of `starts` — "start a new file at these pages".
   * Page 0 always begins one whether or not it was selected, or the pages
   * before the first break would belong to no file at all.
   */
  function breakGroups(count, starts) {
    const breaks = Array.from(new Set([0].concat(starts || [])))
      .filter((index) => index >= 0 && index < count)
      .sort((a, b) => a - b);
    return breaks.map((from, i) => {
      const to = i + 1 < breaks.length ? breaks[i + 1] : count;
      return Array.from({ length: to - from }, (unused, k) => from + k);
    }).filter((group) => group.length);
  }

  /**
   * The numbering a subset of `picked` pages should carry.
   *
   * The first numbered page keeps the number it had in the parent and the rest
   * run on from it. For a contiguous run — which a split always is, and an
   * extract usually is — that is exactly right. For a scattered extract it
   * renumbers sequentially from that first number, which is what a fresh
   * document wants anyway; the alternative is a per-page override table for a
   * case nobody asked for.
   */
  function rebaseNumbering(spec, picked) {
    if (!spec) return null;
    const first = picked.findIndex((index) => RP.render.pageNumberText(spec, index) !== null);
    if (first < 0) return null;
    const full = RP.render.numberingSpec(spec);
    return Object.assign({}, full, {
      start: full.start + (picked[first] - Math.max(0, Math.round(full.from || 0))),
      from: first,
      to: picked.length - 1
    });
  }

  /**
   * Move annotations onto their pages' new indices, drop the ones whose page
   * is gone, and copy them onto freshly duplicated pages. Mutates the survivors
   * in place so anything holding a reference (a live drag, the markup list)
   * keeps pointing at the same object.
   */
  function remapAnnotations(annotations, map, clones) {
    const copies = [];
    for (const clone of clones || []) {
      /* Groups are re-keyed per duplicated page, one map per clone. A copy
         carrying the original's group id would put the two sheets' markups in
         one group — and a group is single-sheet by construction, so dragging
         the copy would move markups on the page it was duplicated from, which
         is not on screen. Same reasoning as the paste in `edit.js`. */
      const regroup = new Map();
      for (const annot of annotations) {
        if (annot.page !== clone.from) continue;
        const copy = Object.assign({}, annot, {
          id: RP.uid('mk'),
          page: clone.to,
          created: Date.now(),
          modified: Date.now()
        });
        const old = RP.groupOf(annot);
        if (old) {
          if (!regroup.has(old)) regroup.set(old, RP.uid('grp'));
          copy.group = regroup.get(old);
        }
        copies.push(copy);
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
      /* The overflow button is not in that loop: it opens a menu rather than
         running an operation, and `run` would hold the busy lock open for as
         long as the menu is on screen. */
      const more = RP.$('#pgMore');
      if (more) more.addEventListener('click', () => this.openDocumentMenu(more));

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
      enable('pgMore', has && !this.busy);
      enable('pgDelete', has && !this.busy && picked.length < total);
    },

    /** The whole-document operations, which do not fit six icons in a column. */
    openDocumentMenu(anchor) {
      const picked = this.selected();
      const many = picked.length > 1;
      const numbered = !!RP.store.numbering;
      RP.menu.openUnder(anchor, [
        {
          /* Scoped to the selection when there is one, because that is what
             every other row in this menu means — but the whole document
             otherwise, since "some sheets came in sideways" is a thing you
             notice about a set rather than about a page. */
          label: many ? 'Straighten selected pages…' : 'Straighten pages…',
          run: () => this.run(() => this.straightenPages(many ? picked : null))
        },
        { separator: true },
        { label: 'Insert pages from another PDF…', run: () => this.run(() => this.mergeFrom()) },
        { label: many ? 'Extract pages…' : 'Extract page…', run: () => this.run(() => this.extractSelected()) },
        { label: 'Split into separate PDFs…', run: () => this.run(() => this.splitDocument()) },
        { separator: true },
        {
          label: numbered ? 'Page numbering…' : 'Add page numbers…',
          run: () => this.run(() => this.numberPages())
        },
        numbered
          ? { label: 'Remove page numbers', run: () => this.run(() => this.clearNumbering()) }
          : null,
        { separator: true },
        { label: 'Select all pages', hint: 'Ctrl+A', run: () => this.selectAll() }
      ].filter(Boolean));
    },

    // -- applying a change -------------------------------------------------

    /**
     * Say no to something the user asked for, and stop.
     *
     * Distinct from throwing, which `run` catches and prefixes with "That page
     * change could not be applied" — right for a rebuild that failed, wrong for
     * a range that names no pages, where the app understood perfectly well and
     * is declining. The return value is `false` so a caller can `return` it.
     */
    refuse(message) {
      RP.toast(message, 'warn', 6000);
      RP.status('');
      return false;
    },

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
      // Deleting a sheet can take all but one member of a group with it — only
      // possible for a group that already reached across pages, which nothing
      // here makes, but a file from another build could carry one.
      store.dropOrphanGroups();
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
      return this.rotatePages(this.target(), delta);
    },

    /**
     * Rotate named pages, rather than whatever is selected.
     *
     * The viewer's context menu and the rotate shortcuts both mean *this*
     * sheet — the one under the pointer, or the one on screen — which is not
     * necessarily what the Pages panel has selected, and silently rotating a
     * page the user is not looking at is the worst outcome available here.
     */
    rotatePages(indices, delta) {
      const count = RP.store.numPages;
      const picked = (indices || []).filter((index) => index >= 0 && index < count);
      if (!picked.length) return false;
      const turned = normaliseRot(delta);
      return this.apply(
        (order) => ops.rotate(order, picked, delta),
        {
          status: 'Rotating…',
          select: () => picked,
          focus: () => picked[0],
          toast: () => picked.length + (picked.length === 1 ? ' page' : ' pages') +
            (turned === 180 ? ' turned over'
              : ' rotated ' + (turned === 90 ? 'clockwise' : 'anticlockwise'))
        }
      );
    },

    /**
     * Find the pages that came in sideways or upside down and turn them back.
     *
     * On demand rather than on open, and confirmed rather than applied: this
     * changes the drawing, and a scan of a whole sheet set is a trip through
     * the one pdf.js worker for every page in it. Nothing is guessed from the
     * raster — a page with no text layer is reported as one this could not
     * read, not straightened on a hunch, because the cost of turning a sheet
     * that was already right is a drawing that now needs fixing by hand.
     */
    async straightenPages(indices) {
      const store = RP.store;
      if (!store.doc) return false;
      const scope = (indices && indices.length)
        ? Array.from(new Set(indices)).sort((a, b) => a - b)
        : Array.from({ length: store.numPages }, (unused, i) => i);
      if (!scope.length) return false;

      const deltas = new Map();
      const unreadable = [];
      const unsure = [];
      for (let n = 0; n < scope.length; n += 1) {
        const index = scope[n];
        RP.status('Reading page orientation… ' + (n + 1) + ' of ' + scope.length);
        /* The viewer already caches `textContent` for any page whose layers
           have been built, and pdf.js caches the page proxy either way, so on
           a set the user has been through this is mostly free. */
        const record = RP.viewer.store === store ? RP.viewer.pages[index] : null;
        const proxy = (record && record.pageProxy) || await store.doc.getPage(index + 1);
        let content = record && record.textContent;
        if (!content) {
          try { content = await proxy.getTextContent(); } catch (err) { content = { items: [] }; }
          if (record) record.textContent = content;
        }
        const read = orientationOf(content.items, proxy.rotate || 0);
        if (!read) {
          ((content.items || []).length ? unsure : unreadable).push(index);
          continue;
        }
        if (read.delta) deltas.set(index, read.delta);
      }
      RP.status('');

      /* The scan is a long await and the user can switch tabs across it, which
         would leave `apply` turning pages on a drawing that was never
         measured. Same reasoning as `App.save` capturing its store. */
      if (RP.store !== store) {
        return this.refuse('You switched drawings while that was reading — nothing was rotated');
      }

      const skipped = unreadable.length + unsure.length;
      const skippedNote = !skipped ? ''
        : skipped + (skipped === 1 ? ' page has' : ' pages have') +
          ' no text this could read, and ' + (skipped === 1 ? 'was' : 'were') + ' left alone.';

      if (!deltas.size) {
        RP.toast(
          (skipped === scope.length
            ? 'Nothing to go on — ' + skippedNote.charAt(0).toLowerCase() + skippedNote.slice(1)
            : 'Every page this could read is already the right way up.' +
              (skippedNote ? ' ' + skippedNote : '')),
          skipped === scope.length ? 'warn' : 'good',
          7000
        );
        return false;
      }

      const over = [];
      const sideways = [];
      for (const [index, delta] of deltas) (delta === 180 ? over : sideways).push(index);
      const lines = [];
      if (over.length) {
        lines.push((over.length === 1 ? 'Page ' : 'Pages ') + describePages(over) +
          (over.length === 1 ? ' is' : ' are') + ' upside down.');
      }
      if (sideways.length) {
        lines.push((sideways.length === 1 ? 'Page ' : 'Pages ') + describePages(sideways) +
          (sideways.length === 1 ? ' is' : ' are') + ' sideways.');
      }
      if (skippedNote) lines.push(skippedNote);
      lines.push('Markups turn with their sheets. Ctrl+Z undoes this.');

      const answer = await window.rp.dialog.message({
        type: 'question',
        message: 'Straighten ' + deltas.size + (deltas.size === 1 ? ' page?' : ' pages?'),
        detail: lines.join('\n'),
        buttons: ['Straighten', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });
      if (answer.response !== 0) return false;
      if (RP.store !== store) return false;

      const touched = Array.from(deltas.keys()).sort((a, b) => a - b);
      return this.apply(
        (order) => ops.turn(order, deltas),
        {
          status: 'Straightening…',
          select: () => touched,
          focus: () => touched[0],
          toast: () => touched.length + (touched.length === 1 ? ' page' : ' pages') + ' straightened'
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

    // -- pulling pages in from another PDF ---------------------------------

    /**
     * Insert pages from a second PDF.
     *
     * The pages are *copied*, not linked: the bytes are held in `store.sources`
     * under a key the descriptors point at, and the file on disk is never read
     * again. Moving or deleting it afterwards changes nothing here, which is
     * the behaviour a sheet set assembled from half a dozen consultants' issues
     * has to have.
     *
     * The source stays in `sources` even after an undo takes its pages back
     * out, because redo has to be able to put them back. An entry nothing
     * points at is inert — it costs the memory of one PDF for the session.
     */
    async mergeFrom(at) {
      const store = RP.store;
      if (!store.doc) return false;
      await this.ensureBase();

      const picked = await window.rp.files.openDialog({ title: 'Choose a PDF to insert pages from' });
      if (!picked) return false;
      const bytes = new Uint8Array(picked.bytes);

      const { PDFDocument } = lib();
      let src;
      try {
        src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      } catch (err) {
        return this.refuse(picked.name + ' could not be read as a PDF: ' + err.message);
      }
      /* Same trap as saving. `ignoreEncryption` makes pdf-lib *parse* a
         protected file rather than decrypt one, so its content streams would be
         copied across still encrypted, under this document's (absent) /Encrypt
         dictionary — pages that render as nothing, with no error anywhere. */
      if (src.isEncrypted) {
        return this.refuse(picked.name + ' is password-protected, so its pages cannot be copied out of it');
      }
      const available = src.getPageCount();
      if (!available) return this.refuse(picked.name + ' has no pages');

      const selected = this.target();
      const after = selected.length ? selected[selected.length - 1] : store.numPages - 1;
      const answer = await RP.promptDialog({
        title: 'Insert pages from ' + picked.name,
        message: picked.name + ' has ' + available +
          (available === 1 ? ' page.' : ' pages.'),
        fields: [
          { name: 'range', label: 'Pages', value: '1-' + available, placeholder: 'e.g. 1-3, 7' },
          {
            name: 'where', label: 'Insert', type: 'select', value: 'after',
            options: [
              { value: 'after', label: 'After page ' + (after + 1) },
              { value: 'before', label: 'Before page ' + (after + 1) },
              { value: 'end', label: 'At the end' },
              { value: 'start', label: 'At the start' }
            ]
          },
          {
            type: 'note',
            label: 'The pages are copied in. This document does not keep a link to ' +
              picked.name + ', so moving or deleting it later changes nothing here.'
          }
        ],
        confirm: 'Insert',
        cancel: 'Cancel'
      });
      if (!answer) return false;

      // The dialog above is modal to the document but not to the tab strip, so
      // the drawing this was asked for can have been switched out from under
      // it. Same reasoning as `App.resolveTarget`.
      if (RP.store !== store) return false;

      const indices = RP.print.parseCustom(answer.range, available);
      if (!indices || !indices.length) {
        return this.refuse('"' + answer.range + '" does not name any pages in ' + picked.name);
      }

      const total = store.numPages;
      const where = at !== undefined ? at
        : answer.where === 'start' ? 0
          : answer.where === 'end' ? total
            : answer.where === 'before' ? after
              : after + 1;

      const key = RP.uid('src');
      store.sources = Object.assign({}, store.sources || {}, { [key]: bytes });
      const descriptors = indices.map((index) => ops.descriptor(key, index, 0));

      return this.apply(
        (order) => ops.insert(order, where, descriptors),
        {
          status: 'Inserting pages…',
          select: () => descriptors.map((unused, i) => where + i),
          focus: () => where,
          toast: () => indices.length + (indices.length === 1 ? ' page' : ' pages') +
            ' inserted from ' + picked.name
        }
      );
    },

    // -- writing pages back out --------------------------------------------

    /**
     * A subset of this document as its own finished PDF — stamped *and* still
     * re-editable.
     *
     * The obvious implementation stamps the whole drawing and copies pages out
     * of the result, which is what extract used to do. It cannot embed the
     * markup model, because the model's page indices no longer line up with the
     * smaller document; so the extract came out flattened, and a markup on it
     * could never be moved or answered again.
     *
     * Building the subset from the *stripped* base bytes instead and running
     * the exporter over it puts both halves back: the stamp for other viewers
     * and the model for this one, with the `contentRefs` that keep the next save
     * idempotent. Copying pages out of already-stamped bytes and embedding a
     * model alongside would produce exactly the double-markup file that
     * `splitSaved` exists to prevent.
     */
    async subsetPdf(picked, name) {
      const store = RP.store;
      await this.ensureBase();
      const order = picked.map((index) => store.pageOrder[index]).filter(Boolean);
      if (!order.length) throw new Error('No pages in that selection');

      const drawing = await buildBytes(store.baseBytes, order, store.sources);

      const map = new Array(store.pageOrder.length).fill(-1);
      picked.forEach((from, to) => { map[from] = to; });

      /* A real store rather than an object literal: `buildPdf` calls
         `serialize()` on it, and a second implementation of what gets embedded
         is a second thing to keep in step with the first. It is never the
         focused one, so every `emit` from it is a no-op. */
      const sub = RP.createStore();
      sub.docBytes = drawing;
      sub.docName = name || RP.store.docName;
      sub.numPages = order.length;
      sub.scale = store.scale;
      sub.author = store.author;
      sub.numbering = rebaseNumbering(store.numbering, picked);
      sub.annotations = remapAnnotations(
        store.annotations.map((annot) => Object.assign({}, annot)), map, []
      );
      return RP.exporter.buildPdf({ store: sub });
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
      const bytes = await this.subsetPdf(picked, RP.basename(path));
      await window.rp.files.write(path, bytes, false);
      RP.status('');
      RP.toast(picked.length + (picked.length === 1 ? ' page' : ' pages') +
        ' written to ' + RP.basename(path) + ', still editable', 'good');
      return true;
    },

    /** Split this document into several PDFs in a folder of the user's choosing. */
    async splitDocument() {
      const store = RP.store;
      if (!store.doc) return false;
      await this.ensureBase();

      const count = store.numPages;
      if (count < 2) {
        RP.toast('A one-page document has nothing to split', 'warn');
        return false;
      }
      const selected = this.selected();
      const answer = await RP.promptDialog({
        title: 'Split into separate PDFs',
        message: RP.stripExt(store.docName || 'drawing') + ' has ' + count + ' pages.',
        fields: [
          {
            name: 'mode', label: 'Split', type: 'select', value: selected.length ? 'breaks' : 'every',
            options: [
              { value: 'every', label: 'Into fixed-size files' },
              { value: 'breaks', label: 'Starting a new file at each selected page' },
              { value: 'ranges', label: 'At the ranges below' }
            ]
          },
          { name: 'size', label: 'Pages per file', value: 1 },
          { name: 'ranges', label: 'Ranges', value: '', placeholder: 'e.g. 1-4, 5-9, 10-' },
          {
            type: 'note',
            label: 'Each file is a finished drawing: the markups on its pages are stamped ' +
              'into it and stay editable here. This document is not changed.'
          }
        ],
        confirm: 'Choose folder…',
        cancel: 'Cancel'
      });
      if (!answer) return false;
      if (RP.store !== store) return false;

      let groups;
      if (answer.mode === 'ranges') {
        groups = parseGroups(answer.ranges, count);
        if (!groups) return this.refuse('"' + answer.ranges + '" is not a list of page ranges');
      } else if (answer.mode === 'breaks') {
        if (!selected.length) return this.refuse('Select the pages each new file should start at first');
        groups = breakGroups(count, selected);
      } else {
        const size = parseInt(answer.size, 10);
        if (!isFinite(size) || size < 1) return this.refuse('"' + answer.size + '" is not a number of pages');
        groups = chunkGroups(count, size);
      }
      if (groups.length < 2) {
        RP.toast('That would produce a single file — nothing to split', 'warn');
        return false;
      }

      const folder = await window.rp.files.chooseFolder({
        title: 'Where should the split files go?',
        defaultPath: RP.dirname(store.docPath || '')
      });
      if (!folder) return false;

      const base = RP.stripExt(store.docName || 'drawing');
      const paths = groups.map((group) => {
        const first = group[0] + 1;
        const last = group[group.length - 1] + 1;
        return RP.joinPath(folder, base + '-' + first + (last > first ? '-' + last : '') + '.pdf');
      });

      // Asked once for the whole set rather than once per file: a 40-part split
      // that stopped to ask forty times is a split nobody finishes.
      const clashes = [];
      for (const path of paths) {
        if (await window.rp.files.exists(path)) clashes.push(RP.basename(path));
      }
      if (clashes.length) {
        const confirmed = await window.rp.dialog.message({
          type: 'warning',
          message: 'Overwrite ' + clashes.length + (clashes.length === 1 ? ' file?' : ' files?'),
          detail: clashes.slice(0, 8).join('\n') +
            (clashes.length > 8 ? '\n…and ' + (clashes.length - 8) + ' more' : '') +
            '\n\nThese already exist in that folder and would be replaced.',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        });
        if (confirmed.response !== 0) return false;
      }

      for (let i = 0; i < groups.length; i += 1) {
        RP.status('Writing part ' + (i + 1) + ' of ' + groups.length + '…');
        const bytes = await this.subsetPdf(groups[i], RP.basename(paths[i]));
        await window.rp.files.write(paths[i], bytes, false);
      }
      RP.status('');
      RP.toast(groups.length + ' files written to ' + RP.basename(folder), 'good');
      return true;
    },

    // -- page numbering / Bates --------------------------------------------

    /**
     * Set or change the page numbering.
     *
     * Nothing is rebuilt: the spec sits on the store, the canvas draws it and
     * the exporter stamps it, so this is one checkpoint and one repaint however
     * long the sheet set is. It also means inserting a page renumbers the rest
     * for free, which is the whole reason it is not N annotations.
     */
    async numberPages() {
      const store = RP.store;
      if (!store.doc) return false;
      const count = store.numPages;
      const current = RP.render.numberingSpec(store.numbering) || RP.render.NUMBER_DEFAULTS;
      const answer = await RP.promptDialog({
        title: store.numbering ? 'Page numbering' : 'Add page numbers',
        message: 'Numbers are stamped into the pages when the drawing is saved or printed, ' +
          'and shown on screen in the meantime.',
        fields: [
          { name: 'prefix', label: 'Prefix', value: current.prefix, placeholder: 'e.g. ABC-' },
          { name: 'start', label: 'First number', value: current.start },
          { name: 'digits', label: 'Pad to digits', value: current.digits, placeholder: '0 for none' },
          { name: 'suffix', label: 'Suffix', value: current.suffix },
          {
            name: 'position', label: 'Position', type: 'select', value: current.position,
            options: RP.render.NUMBER_POSITIONS.map((key) => ({
              value: key,
              label: key.replace('-', ' ').replace(/^./, (c) => c.toUpperCase())
            }))
          },
          { name: 'size', label: 'Type size (pt)', value: current.size },
          { name: 'margin', label: 'Margin (pt)', value: current.margin },
          { name: 'from', label: 'From page', value: (Math.max(0, Math.round(current.from || 0)) + 1) },
          {
            name: 'to', label: 'To page',
            value: (current.to === undefined || current.to === null ? count : Math.round(current.to) + 1)
          }
        ],
        confirm: store.numbering ? 'Update' : 'Add numbers',
        cancel: 'Cancel'
      });
      if (!answer) return false;
      if (RP.store !== store) return false;

      const num = (value, fallback) => {
        const parsed = parseFloat(value);
        return isFinite(parsed) ? parsed : fallback;
      };
      const from = RP.clamp(Math.round(num(answer.from, 1)) - 1, 0, count - 1);
      const to = RP.clamp(Math.round(num(answer.to, count)) - 1, from, count - 1);
      const spec = {
        prefix: answer.prefix || '',
        suffix: answer.suffix || '',
        start: Math.round(num(answer.start, 1)),
        digits: RP.clamp(Math.round(num(answer.digits, 0)), 0, 12),
        position: answer.position,
        // Floors rather than refusals: a type size of zero is a number nobody
        // can read and a negative margin puts it off the sheet, and neither is
        // worth a second trip through the dialog.
        size: RP.clamp(num(answer.size, current.size), 4, 72),
        margin: RP.clamp(num(answer.margin, current.margin), 0, 200),
        color: current.color,
        from,
        to
      };
      // `setNumbering` checks before it checkpoints, so a dialog opened and
      // OK'd unaltered leaves no dead undo step for `Ctrl+Z` to appear to
      // ignore — and should not claim to have done anything either.
      if (!store.setNumbering(spec)) return false;
      const first = RP.render.pageNumberText(spec, from);
      RP.toast('Pages numbered from ' + first + ' on page ' + (from + 1), 'good');
      return true;
    },

    clearNumbering() {
      if (!RP.store.numbering) return false;
      RP.store.setNumbering(null);
      RP.toast('Page numbering removed', 'good');
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
        { label: 'Insert pages from another PDF…', run: () => this.mergeFrom(index + 1) },
        { label: many ? 'Duplicate pages' : 'Duplicate page', run: () => this.duplicateSelected() },
        { label: 'Rotate left', run: () => this.rotateSelected(-ROT_STEP) },
        { label: 'Rotate right', run: () => this.rotateSelected(ROT_STEP) },
        { label: many ? 'Turn pages over' : 'Turn page over', run: () => this.rotateSelected(180) },
        {
          label: many ? 'Straighten these pages…' : 'Straighten this page…',
          run: () => this.straightenPages(this.selected())
        },
        { separator: true },
        { label: many ? 'Extract pages…' : 'Extract page…', run: () => this.extractSelected() },
        { label: 'Split into separate PDFs…', run: () => this.splitDocument() },
        { label: RP.store.numbering ? 'Page numbering…' : 'Add page numbers…', run: () => this.numberPages() },
        { separator: true },
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

  /**
   * The page order, but only when it can be rebuilt from the drawing alone.
   *
   * The crash snapshot is JSON next to the settings file, and a merged-in
   * source is a whole PDF held in memory — base64-ing several of those into a
   * recovery record would put tens of megabytes on disk every autosave tick.
   * So an order that reaches outside the file is not persisted at all: the
   * markups still recover, and the pages come back as they are on disk, which
   * is honest. Returning a *partial* order would be worse than returning none —
   * it would rebuild the document with pages silently missing.
   */
  function recoverableOrder(store) {
    const order = store && store.pageOrder;
    if (!order || !order.length) return null;
    const external = order.some((item) => item.src !== 'base' && item.src !== 'blank');
    return external ? null : order;
  }

  RP.pages = Pages;
  RP.pages.ops = ops;
  RP.pages.buildBytes = buildBytes;
  RP.pages.remapAnnotations = remapAnnotations;
  RP.pages.recoverableOrder = recoverableOrder;
  // Pure, so `test/verify.js` can drive the split and extract maths headless.
  RP.pages.parseGroups = parseGroups;
  RP.pages.chunkGroups = chunkGroups;
  RP.pages.breakGroups = breakGroups;
  RP.pages.rebaseNumbering = rebaseNumbering;
  RP.pages.orientationOf = orientationOf;
  RP.pages.describePages = describePages;

})(window.RP);
