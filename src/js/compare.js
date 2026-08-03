/* Revision compare.

   The point of this module is to show TRUE differences, not scanner noise or
   sub-pixel plotting shifts. The pipeline per page pair is:

     1. render both revisions to the same pixel grid — the baseline sheet is
        fitted and *centred* on that grid, because a re-issued sheet is often a
        different size and anchoring it in a corner makes every mark disagree
     2. reduce each to a binary "ink" mask (everything darker than a threshold)
     3. sanity-check both masks. A render that comes back empty or solid black
        is a failure, not a result: reporting a whole sheet as changed because
        the second file did not paint is worse than reporting nothing. Such a
        pair is retried once at a smaller grid and then declared unreadable.
     4. estimate and cancel any global shift — first coarsely from the ink
        bounding boxes, which also recovers a re-plot scale change, then finely
        by projection correlation
     5. dilate each mask by the tolerance radius, then
          removed = inkA AND NOT dilated(inkB)
          added   = inkB AND NOT dilated(inkA)
        so a line that merely moved half a pixel cancels out completely
     6. drop specks below the minimum change size
     7. cluster what survives into labelled change regions you can click through

   Readability note: an edited *number* has its old and new glyphs in the same
   place, so any wash of colour over the region turns into mud. The overlay
   therefore paints ink only — no translucent fills — and the real answer to
   "what did it change to" is the region inspector, which crops the same patch
   out of both revisions and shows them side by side, magnified.
*/
'use strict';

(function (RP) {

  const WORK_DPI = 150;
  const MAX_PIXELS = 6.5e6;
  const RETRY_PIXELS = 1.6e6;  // second attempt when a render came back unusable
  const MERGE_GAP = 16;        // px: how close two change blobs must be to merge
  const CACHE_LIMIT = 3;
  const RENDER_TIMEOUT_MS = 45000;
  const FLOODED_INK = 0.97;    // a mask this solid means the canvas failed, not that the sheet is black
  const SHIFT_LIMIT = 14;      // fine correlation search, in px, after the coarse align
  const INSPECT_PAD = 26;      // px of context around a region in the inspector

  const Compare = {
    baseline: null,          // {path, name, doc}
    running: false,
    results: [],             // per page: {page, regions, added, removed, shift, unreadable}
    cache: new Map(),        // page -> full render result (holds canvases)
    changeList: [],          // flattened [{page, index}] for prev/next stepping
    pageIndex: 0,
    mode: 'overlay',
    options: { tolerance: 2, autoAlign: true, minSize: 6, inkThreshold: 200 },
    active: false,
    inspecting: null,        // {page, regionIndex}
    inspectZoom: 0,          // 0 = auto-fit

    init() {
      RP.$('#btnPickBaseline').addEventListener('click', () => this.pickBaseline());
      RP.$('#btnRunCompare').addEventListener('click', () => this.run());
      RP.$('#cmpClose').addEventListener('click', () => this.close());
      RP.$('#cmpPrev').addEventListener('click', () => this.showPage(this.pageIndex - 1));
      RP.$('#cmpNext').addEventListener('click', () => this.showPage(this.pageIndex + 1));

      RP.$$('.cmp-view-modes .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          this.mode = chip.dataset.mode;
          RP.$$('.cmp-view-modes .chip').forEach((c) => c.classList.toggle('active', c === chip));
          this.showPage(this.pageIndex);
        });
      });

      const tol = RP.$('#cmpTolerance');
      tol.addEventListener('input', () => {
        this.options.tolerance = Number(tol.value);
        RP.$('#cmpToleranceOut').textContent = tol.value + ' px';
      });
      const minSize = RP.$('#cmpMinSize');
      minSize.addEventListener('input', () => {
        this.options.minSize = Number(minSize.value);
        RP.$('#cmpMinSizeOut').textContent = minSize.value + ' px';
      });
      RP.$('#cmpAutoAlign').addEventListener('change', (e) => {
        this.options.autoAlign = e.target.checked;
      });

      this.initInspector();

      RP.bus.on('doc:loaded', () => {
        RP.$('#cmpCurrentName').textContent = RP.store.docName || '— none —';
        this.updateRunState();
        this.clearResults();
        RP.$('#cmpResults').innerHTML = '';
      });
    },

    initInspector() {
      const close = RP.$('#cmpInspectClose');
      if (!close) return;   // markup not present (older index.html) — inspector simply stays off
      close.addEventListener('click', () => this.closeInspector());
      RP.$('#cmpInspectPrev').addEventListener('click', () => this.stepInspector(-1));
      RP.$('#cmpInspectNext').addEventListener('click', () => this.stepInspector(1));
      const zoom = RP.$('#cmpInspectZoom');
      zoom.addEventListener('input', () => {
        this.inspectZoom = Number(zoom.value);
        RP.$('#cmpInspectZoomOut').textContent = Number(zoom.value).toFixed(1) + '×';
        this.drawInspector();
      });
      RP.$('#cmpInspectFit').addEventListener('click', () => {
        this.inspectZoom = 0;
        this.drawInspector();
      });
    },

    updateRunState() {
      const ready = !!(this.baseline && RP.store.doc);
      RP.$('#btnRunCompare').disabled = !ready || this.running;
    },

    async pickBaseline() {
      const picked = await window.rp.files.openDialog({ title: 'Choose the baseline (older) revision' });
      if (!picked) return;
      try {
        const doc = await pdfjsLib.getDocument(
          RP.pdfjs.docParams({ data: new Uint8Array(picked.bytes) })
        ).promise;
        this.baseline = { path: picked.path, name: picked.name, doc };
        RP.$('#cmpBaselineName').textContent = picked.name + '  (' + doc.numPages + ' pages)';
        this.updateRunState();
      } catch (err) {
        RP.toast('Could not read that PDF: ' + err.message, 'error');
      }
    },

    // ---------------------------------------------------------------------
    // Run
    // ---------------------------------------------------------------------

    async run() {
      if (!this.baseline || !RP.store.doc || this.running) return;
      this.running = true;
      this.updateRunState();
      this.clearResults();

      const progress = RP.$('#cmpProgress');
      const bar = progress.querySelector('i');
      const label = progress.querySelector('span');
      progress.hidden = false;

      const pageCount = Math.max(this.baseline.doc.numPages, RP.store.doc.numPages);

      for (let i = 0; i < pageCount; i += 1) {
        label.textContent = 'Comparing page ' + (i + 1) + ' of ' + pageCount + '…';
        bar.style.width = Math.round((i / pageCount) * 100) + '%';
        await RP.nextFrame();

        try {
          const result = await this.computePage(i, {});
          this.results.push(this.summarize(result));
        } catch (err) {
          console.error('Compare failed on page ' + (i + 1), err);
          this.results.push({
            page: i, regions: [], added: 0, removed: 0,
            unreadable: 'error', detail: err.message
          });
        }
      }

      bar.style.width = '100%';
      label.textContent = 'Done.';
      setTimeout(() => { progress.hidden = true; }, 900);

      this.running = false;
      this.updateRunState();
      this.renderSummary();
      this.open();
      this.showPage(this.firstChangedPage());
    },

    summarize(result) {
      return {
        page: result.page,
        regions: result.regions,
        added: result.addedPixels,
        removed: result.removedPixels,
        shift: result.shift,
        fit: result.fit,
        onlyIn: result.onlyIn,
        oneBlank: !!result.oneBlank,
        unreadable: result.unreadable || null,
        detail: result.detail || '',
        width: result.width,
        height: result.height,
        scale: result.scale
      };
    },

    firstChangedPage() {
      const found = this.results.find((r) => r.regions && r.regions.length);
      return found ? found.page : 0;
    },

    // ---------------------------------------------------------------------
    // Per-page pipeline
    // ---------------------------------------------------------------------

    /**
     * Render one page to a binary ink mask.
     *
     * With no `target` this establishes the reference grid. With a `target` the
     * page is fitted onto that same grid and CENTRED — a re-issued sheet is
     * routinely a different size, and pinning it to a corner used to make every
     * mark on the page disagree with its twin.
     */
    async renderToMask(doc, pageNumber, target, opts) {
      const o = opts || {};
      if (pageNumber > doc.numPages) return null;
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });

      let width, height, scale, offsetX = 0, offsetY = 0;
      if (target) {
        width = target.width;
        height = target.height;
        const fit = fitOntoGrid(base.width, base.height, width, height);
        scale = fit.scale * (o.scaleAdjust || 1);
        offsetX = (width - base.width * scale) / 2 + (o.offsetX || 0);
        offsetY = (height - base.height * scale) / 2 + (o.offsetY || 0);
      } else {
        const budget = o.maxPixels || MAX_PIXELS;
        scale = Math.min(WORK_DPI / 72, Math.sqrt(budget / (base.width * base.height)));
        width = Math.max(1, Math.round(base.width * scale));
        height = Math.max(1, Math.round(base.height * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx) throw new Error('the browser refused a ' + width + '×' + height + ' canvas');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);

      const viewport = page.getViewport({ scale });
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, Math.round(offsetX), Math.round(offsetY)]
      });
      await withTimeout(task, RENDER_TIMEOUT_MS);
      try { page.cleanup(); } catch (err) { /* pdf.js may refuse mid-flight; harmless */ }

      const image = ctx.getImageData(0, 0, width, height);
      const mask = new Uint8Array(width * height);
      const threshold = this.options.inkThreshold;
      const data = image.data;
      let ink = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        // perceptual luminance; alpha is 255 because the canvas is opaque
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        if (lum < threshold) { mask[p] = 1; ink += 1; }
      }
      return {
        mask, width, height, scale, canvas, ink,
        coverage: ink / (width * height),
        pageWidth: base.width,
        pageHeight: base.height
      };
    },

    /** Render both revisions of one page onto a shared grid at the given budget. */
    async renderPair(pageIndex, maxPixels) {
      const currentDoc = RP.store.doc;
      const baseDoc = this.baseline.doc;
      const pageNumber = pageIndex + 1;
      const hasCurrent = pageNumber <= currentDoc.numPages;
      const hasBase = pageNumber <= baseDoc.numPages;

      const reference = hasCurrent
        ? await this.renderToMask(currentDoc, pageNumber, null, { maxPixels })
        : await this.renderToMask(baseDoc, pageNumber, null, { maxPixels });
      const other = (hasCurrent && hasBase)
        ? await this.renderToMask(baseDoc, pageNumber, reference, {})
        : null;

      return { reference, other, hasCurrent, hasBase };
    },

    async computePage(pageIndex, opts) {
      const cached = this.cache.get(pageIndex);
      if (cached) return cached;

      const budgets = [MAX_PIXELS, RETRY_PIXELS];
      let pair = null;
      let verdict = null;

      for (let attempt = 0; attempt < budgets.length; attempt += 1) {
        if (pair) releasePair(pair);
        const last = attempt === budgets.length - 1;
        try {
          pair = await this.renderPair(pageIndex, budgets[attempt]);
          verdict = judgePair(pair, last);
        } catch (err) {
          // A timeout or a refused canvas is worth one more go on a smaller
          // grid; it is never worth reporting as "the whole sheet changed".
          console.warn('Compare render failed on page ' + (pageIndex + 1), err);
          pair = null;
          verdict = { ok: false, reason: 'error', detail: err.message };
        }
        if (verdict.ok) break;
      }

      if (!verdict.ok) {
        releasePair(pair);
        const result = {
          page: pageIndex,
          width: 0, height: 0, scale: 1,
          canvasA: null, canvasB: null, composite: null,
          regions: [],
          addedPixels: 0, removedPixels: 0,
          shift: { dx: 0, dy: 0 },
          onlyIn: null,
          unreadable: verdict.reason,
          detail: verdict.detail
        };
        this.remember(pageIndex, result, opts);
        return result;
      }

      const result = pair.hasCurrent && pair.hasBase
        ? await this.diffPair(pageIndex, pair, verdict)
        : this.wholePageResult(pageIndex, pair);

      this.remember(pageIndex, result, opts);
      return result;
    },

    wholePageResult(pageIndex, pair) {
      const reference = pair.reference;
      const inCurrent = pair.hasCurrent;
      return {
        page: pageIndex,
        width: reference.width, height: reference.height, scale: reference.scale,
        canvasA: pair.hasBase ? reference.canvas : null,
        canvasB: inCurrent ? reference.canvas : null,
        composite: this.compositeWholePage(reference, inCurrent ? 'added' : 'removed'),
        regions: [{
          x: 0, y: 0, w: reference.width, h: reference.height,
          kind: inCurrent ? 'added' : 'removed',
          pixels: reference.ink,
          note: inCurrent ? 'Page only exists in the current revision' : 'Page only exists in the baseline'
        }],
        addedPixels: inCurrent ? reference.ink : 0,
        removedPixels: inCurrent ? 0 : reference.ink,
        shift: { dx: 0, dy: 0 },
        onlyIn: inCurrent ? 'current' : 'baseline'
      };
    },

    async diffPair(pageIndex, pair, verdict) {
      const reference = pair.reference;
      let other = pair.other;
      const width = reference.width;
      const height = reference.height;

      const currentMask = reference.mask;
      let fit = { scale: 1, dx: 0, dy: 0, rescaled: false };
      let shift = { dx: 0, dy: 0 };

      if (this.options.autoAlign && !verdict.empty) {
        const refBox = inkBBox(currentMask, width, height);
        const baseBox = inkBBox(other.mask, width, height);
        const correction = fitCorrection(refBox, baseBox, width, height);

        // A re-plotted sheet is scaled, not merely shifted. Re-render the
        // baseline at the corrected scale rather than trying to fix it up in
        // mask space, where resampling a 1px line destroys it.
        if (correction && correction.rescale) {
          const rerendered = await this.renderToMask(
            this.baseline.doc, pageIndex + 1, reference,
            { scaleAdjust: correction.scale, offsetX: correction.offsetX, offsetY: correction.offsetY }
          );
          if (rerendered && maskHealth(rerendered).ok) {
            releaseCanvas(other.canvas);
            other = rerendered;
            fit = { scale: correction.scale, dx: 0, dy: 0, rescaled: true };
          } else if (rerendered) {
            releaseCanvas(rerendered.canvas);
          }
        } else if (correction && correction.usableShift) {
          fit = { scale: 1, dx: correction.dx, dy: correction.dy, rescaled: false };
        }
      }

      let alignedBase = (fit.dx || fit.dy)
        ? shiftMask(other.mask, width, height, fit.dx, fit.dy)
        : other.mask;

      if (this.options.autoAlign && !verdict.empty) {
        shift = estimateShift(alignedBase, currentMask, width, height, SHIFT_LIMIT);
        if (shift.dx || shift.dy) alignedBase = shiftMask(alignedBase, width, height, shift.dx, shift.dy);
      }

      const radius = Math.max(0, this.options.tolerance);
      const dilatedBase = radius ? dilate(alignedBase, width, height, radius) : alignedBase;
      const dilatedCurrent = radius ? dilate(currentMask, width, height, radius) : currentMask;

      const removed = new Uint8Array(width * height);
      const added = new Uint8Array(width * height);
      let removedCount = 0;
      let addedCount = 0;
      for (let i = 0; i < removed.length; i += 1) {
        if (alignedBase[i] && !dilatedCurrent[i]) { removed[i] = 1; removedCount += 1; }
        if (currentMask[i] && !dilatedBase[i]) { added[i] = 1; addedCount += 1; }
      }

      const minSize = Math.max(1, this.options.minSize);
      const removedBlobs = labelBlobs(removed, width, height, minSize);
      const addedBlobs = labelBlobs(added, width, height, minSize);
      const regions = mergeRegions(removedBlobs, addedBlobs, MERGE_GAP, width, height);

      const composite = this.composite(alignedBase, currentMask, removed, added, width, height);

      return {
        page: pageIndex,
        width, height,
        scale: reference.scale,
        canvasA: other.canvas,
        canvasB: reference.canvas,
        composite,
        regions,
        addedPixels: addedCount,
        removedPixels: removedCount,
        shift: { dx: fit.dx + shift.dx, dy: fit.dy + shift.dy },
        fit,
        oneBlank: !!verdict.oneBlank,
        sizeMismatch: Math.abs(other.pageWidth / other.pageHeight - reference.pageWidth / reference.pageHeight) > 0.01,
        onlyIn: null
      };
    },

    remember(pageIndex, result, opts) {
      this.cache.set(pageIndex, result);
      if (this.cache.size > CACHE_LIMIT && !(opts && opts.keepAll)) {
        for (const key of this.cache.keys()) {
          if (key === pageIndex) continue;
          releaseResult(this.cache.get(key));
          this.cache.delete(key);
          break;
        }
      }
    },

    clearResults() {
      for (const result of this.cache.values()) releaseResult(result);
      this.cache.clear();
      this.results = [];
      this.changeList = [];
      this.closeInspector();
    },

    /**
     * Build the colour-coded overlay bitmap.
     *
     * Deliberately ink only. An earlier version painted a translucent block over
     * every blob so changes would read at fit-page zoom; on an edited dimension
     * or panel number, where the old and new glyphs sit on top of each other,
     * two overlapping washes turned the whole area to mud. Regions are called
     * out with an outline in `pane()` instead, and the inspector is where you
     * actually read the values.
     */
    composite(baseMask, currentMask, removed, added, width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(width, height);
      const data = image.data;

      for (let i = 0, p = 0; p < removed.length; p += 1, i += 4) {
        let r = 255, g = 255, b = 255;
        // Kept context stays pale so real changes are the only saturated ink.
        if (baseMask[p] || currentMask[p]) { r = 214; g = 219; b = 226; }
        if (removed[p]) { r = 224; g = 26; b = 26; }
        if (added[p]) { r = 0; g = 112; b = 232; }
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      return canvas;
    },

    compositeWholePage(reference, kind) {
      const canvas = document.createElement('canvas');
      canvas.width = reference.width;
      canvas.height = reference.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(reference.canvas, 0, 0);
      ctx.fillStyle = kind === 'added' ? 'rgba(47,143,255,.16)' : 'rgba(255,47,47,.16)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    },

    // ---------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------

    open() {
      this.active = true;
      RP.$('#compareOverlay').hidden = false;
    },

    close() {
      this.active = false;
      this.closeInspector();
      RP.$('#compareOverlay').hidden = true;
    },

    /* A comparison is expensive enough that losing it to a tab switch would
       make the feature unusable alongside tabs, so the whole run rides on the
       tab it belongs to. The overlay is torn down either way — it covers the
       pane, and a pane showing a different document must not keep it. */

    stash() {
      const state = {
        baseline: this.baseline,
        results: this.results,
        cache: this.cache,
        changeList: this.changeList,
        pageIndex: this.pageIndex,
        active: this.active
      };
      this.close();
      this.baseline = null;
      this.results = [];
      this.changeList = [];
      this.cache = new Map();   // handed to the tab, not released
      this.pageIndex = 0;
      return state;
    },

    unstash(state) {
      this.baseline = (state && state.baseline) || null;
      this.results = (state && state.results) || [];
      this.cache = (state && state.cache) || new Map();
      this.changeList = (state && state.changeList) || [];
      this.pageIndex = (state && state.pageIndex) || 0;
      RP.$('#cmpBaselineName').textContent = this.baseline
        ? this.baseline.name + '  (' + this.baseline.doc.numPages + ' pages)'
        : '— none —';
      RP.$('#cmpCurrentName').textContent = RP.store.docName || '— none —';
      RP.$('#cmpResults').innerHTML = '';
      if (this.results.length) this.renderSummary();
      this.updateRunState();
      if (state && state.active && this.results.length) { this.open(); this.showPage(this.pageIndex); }
    },

    async showPage(index) {
      if (!this.results.length) return;
      const clamped = RP.clamp(index, 0, this.results.length - 1);
      this.pageIndex = clamped;
      RP.$('#cmpPageLabel').textContent = (clamped + 1) + ' / ' + this.results.length;

      const stage = RP.$('#cmpStage');
      stage.innerHTML = '';
      stage.appendChild(RP.el('div', { class: 'side-empty', text: 'Rendering page ' + (clamped + 1) + '…' }));

      let result;
      try {
        result = await this.computePage(clamped, {});
      } catch (err) {
        stage.innerHTML = '';
        stage.appendChild(RP.el('div', { class: 'side-empty', text: 'Could not render this page: ' + err.message }));
        return;
      }

      stage.innerHTML = '';
      if (result.unreadable) {
        stage.appendChild(RP.el('div', { class: 'cmp-unreadable' }, [
          RP.el('b', { text: 'Page ' + (clamped + 1) + ' could not be compared.' }),
          RP.el('p', { text: unreadableText(result) })
        ]));
        return;
      }

      if (this.mode === 'side') {
        stage.appendChild(this.pane('Baseline', result.canvasA, result, 'removed'));
        stage.appendChild(this.pane('Current', result.canvasB, result, 'added'));
      } else if (this.mode === 'swipe') {
        stage.appendChild(this.swipePane(result));
      } else {
        stage.appendChild(this.pane('Differences', result.composite, result, 'both'));
      }
      this.markActiveRegionRows();
      if (this.inspecting && this.inspecting.page === clamped) this.drawInspector();
    },

    pane(caption, sourceCanvas, result, kindFilter) {
      const wrap = RP.el('div', { class: 'cmp-pane' });
      wrap.appendChild(RP.el('span', { class: 'cap', text: caption }));
      const canvas = RP.el('canvas');
      const maxWidth = Math.max(320, (RP.$('#cmpStage').clientWidth - 80) / (this.mode === 'side' ? 2 : 1));
      const scale = Math.min(1, maxWidth / result.width);
      canvas.width = result.width;
      canvas.height = result.height;
      canvas.style.width = Math.round(result.width * scale) + 'px';
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (sourceCanvas) ctx.drawImage(sourceCanvas, 0, 0);

      // outline every change region
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      for (const region of result.regions) {
        if (kindFilter !== 'both' && region.kind !== kindFilter && region.kind !== 'changed') continue;
        ctx.strokeStyle = region.kind === 'added' ? '#2f8fff' : region.kind === 'removed' ? '#ff2f2f' : '#f2c14e';
        ctx.strokeRect(region.x - 4, region.y - 4, region.w + 8, region.h + 8);
      }
      ctx.setLineDash([]);

      // Clicking a change on the sheet opens the same inspector the list rows do.
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width * result.width;
        const py = (e.clientY - rect.top) / rect.height * result.height;
        const hit = regionAt(result.regions, px, py, 8);
        if (hit >= 0) this.focusRegion(result.page, hit);
      });
      canvas.style.cursor = result.regions.length ? 'zoom-in' : 'default';

      wrap.appendChild(canvas);
      wrap.dataset.scale = String(scale);
      return wrap;
    },

    swipePane(result) {
      const maxWidth = Math.max(320, RP.$('#cmpStage').clientWidth - 80);
      const scale = Math.min(1, maxWidth / result.width);
      const w = Math.round(result.width * scale);
      const h = Math.round(result.height * scale);

      const wrap = RP.el('div', { class: 'cmp-pane cmp-swipe', style: { width: w + 'px', height: h + 'px' } });
      const under = RP.el('canvas', { style: { width: w + 'px', height: h + 'px', position: 'absolute', inset: '0' } });
      under.width = result.width; under.height = result.height;
      const underCtx = under.getContext('2d');
      underCtx.fillStyle = '#fff'; underCtx.fillRect(0, 0, under.width, under.height);
      if (result.canvasA) underCtx.drawImage(result.canvasA, 0, 0);

      const topWrap = RP.el('div', { class: 'top', style: { width: '50%' } });
      const over = RP.el('canvas', { style: { width: w + 'px', height: h + 'px' } });
      over.width = result.width; over.height = result.height;
      const overCtx = over.getContext('2d');
      overCtx.fillStyle = '#fff'; overCtx.fillRect(0, 0, over.width, over.height);
      if (result.canvasB) overCtx.drawImage(result.canvasB, 0, 0);
      topWrap.appendChild(over);

      const handle = RP.el('div', { class: 'handle', style: { left: '50%' } });
      wrap.append(under, topWrap, handle,
        RP.el('span', { class: 'cap', text: 'Baseline  ◂ swipe ▸  Current' }));

      let dragging = false;
      const move = (clientX) => {
        const rect = wrap.getBoundingClientRect();
        const pct = RP.clamp((clientX - rect.left) / rect.width, 0, 1);
        topWrap.style.width = (pct * 100) + '%';
        handle.style.left = (pct * 100) + '%';
      };
      handle.addEventListener('pointerdown', (e) => { dragging = true; handle.setPointerCapture(e.pointerId); });
      handle.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
      handle.addEventListener('pointerup', () => { dragging = false; });
      wrap.addEventListener('click', (e) => { if (e.target === wrap) move(e.clientX); });
      return wrap;
    },

    renderSummary() {
      const host = RP.$('#cmpResults');
      host.innerHTML = '';

      this.changeList = [];
      for (const result of this.results) {
        if (!result.regions) continue;
        result.regions.forEach((region, i) => this.changeList.push({ page: result.page, index: i }));
      }

      const totalRegions = this.changeList.length;
      const changedPages = this.results.filter((r) => r.regions && r.regions.length).length;
      const shifted = this.results.filter((r) => r.shift && (r.shift.dx || r.shift.dy)).length;
      const rescaled = this.results.filter((r) => r.fit && r.fit.rescaled).length;
      const unreadable = this.results.filter((r) => r.unreadable);
      const oneBlank = this.results.filter((r) => r.oneBlank).length;

      const summary = RP.el('div', { class: 'cmp-summary' });
      const notes = [];
      if (shifted) notes.push(shifted + ' page' + (shifted === 1 ? ' was' : 's were') + ' auto-aligned for a plot shift.');
      if (rescaled) notes.push(rescaled + ' page' + (rescaled === 1 ? ' was' : 's were') + ' re-scaled to match a different sheet size.');
      if (oneBlank) {
        notes.push('<b class="warn">' + oneBlank + ' page' + (oneBlank === 1 ? '' : 's') +
          ' had one revision render empty</b>, so everything on the other side reads as a change. ' +
          'Check those pages by eye before trusting them.');
      }

      if (unreadable.length) {
        notes.push('<b class="warn">' + unreadable.length + ' page' + (unreadable.length === 1 ? '' : 's') +
          ' could not be compared</b> and are reported as neither changed nor unchanged.');
      }

      if (!totalRegions && !unreadable.length) {
        summary.innerHTML = '<b>No true differences found.</b><br>Every mark in both revisions lines up within the tolerance you set.';
      } else {
        summary.innerHTML =
          '<b>' + totalRegions + ' change region' + (totalRegions === 1 ? '' : 's') + '</b> across ' +
          changedPages + ' page' + (changedPages === 1 ? '' : 's') + '.<br>' +
          '<span class="tag added">added</span> content is in the current revision only; ' +
          '<span class="tag removed">removed</span> was in the baseline only.' +
          (notes.length ? '<br>' + notes.join('<br>') : '');
      }
      host.appendChild(summary);

      for (const result of this.results) {
        const hasRegions = result.regions && result.regions.length;
        if (!hasRegions && !result.unreadable) continue;

        host.appendChild(RP.el('div', {
          class: 'side-head',
          style: { padding: '10px 4px 4px' }
        }, [RP.el('h2', { text: 'Page ' + (result.page + 1) })]));

        if (result.unreadable) {
          host.appendChild(RP.el('div', { class: 'cmp-note', text: unreadableText(result) }));
          continue;
        }

        result.regions.forEach((region, i) => {
          const size = Math.round(region.w) + '×' + Math.round(region.h) + ' px';
          host.appendChild(RP.el('button', {
            class: 'cmp-row',
            'data-page': String(result.page),
            'data-region': String(i),
            onclick: () => this.focusRegion(result.page, i)
          }, [
            RP.el('span', { class: 'pg', text: '#' + (i + 1) }),
            RP.el('span', { class: 'desc', text: region.note || (region.kind === 'changed' ? 'Modified content' : region.kind === 'added' ? 'New content' : 'Deleted content') }),
            RP.el('span', { class: 'kind ' + region.kind, text: size })
          ]));
        });
      }

      if (!totalRegions && !unreadable.length) {
        host.appendChild(RP.el('div', {
          class: 'side-empty',
          text: 'Tip: lower the tolerance if you expect fine changes, or raise it if scanner noise is coming through.'
        }));
      }
    },

    async focusRegion(page, regionIndex) {
      this.open();
      if (page !== this.pageIndex) await this.showPage(page);
      const result = this.cache.get(page);
      if (!result || !result.regions[regionIndex]) return;
      const region = result.regions[regionIndex];
      const pane = RP.$('#cmpStage .cmp-pane');

      if (pane) {
        const canvas = pane.querySelector('canvas');
        const scale = canvas.clientWidth / result.width;
        const ring = RP.el('div', {
          class: 'cmp-focus-ring',
          style: {
            left: (region.x * scale - 6) + 'px',
            top: (region.y * scale - 6) + 'px',
            width: (region.w * scale + 12) + 'px',
            height: (region.h * scale + 12) + 'px'
          }
        });
        pane.appendChild(ring);
        setTimeout(() => ring.remove(), 2600);

        const stage = RP.$('#cmpStage');
        stage.scrollTo({
          top: Math.max(0, pane.offsetTop + region.y * scale - stage.clientHeight / 2),
          left: Math.max(0, pane.offsetLeft + region.x * scale - stage.clientWidth / 2),
          behavior: 'smooth'
        });
      }

      this.activeRegion = { page, regionIndex };
      this.markActiveRegionRows();
      this.openInspector(page, regionIndex);
    },

    markActiveRegionRows() {
      const active = this.activeRegion;
      RP.$$('#cmpResults .cmp-row').forEach((row) => {
        row.classList.toggle('active', !!active &&
          Number(row.dataset.page) === active.page &&
          Number(row.dataset.region) === active.regionIndex);
      });
    },

    // ---------------------------------------------------------------------
    // Region inspector
    //
    // The overlay tells you WHERE something changed. For an edited number the
    // old and new glyphs occupy the same pixels, so no single image can tell
    // you WHAT it changed to — hence the same patch, cropped out of both
    // revisions and magnified, next to the diff.
    // ---------------------------------------------------------------------

    openInspector(page, regionIndex) {
      const host = RP.$('#cmpInspector');
      if (!host) return;
      this.inspecting = { page, regionIndex };
      host.hidden = false;
      this.drawInspector();
    },

    closeInspector() {
      const host = RP.$('#cmpInspector');
      this.inspecting = null;
      if (host) host.hidden = true;
    },

    stepInspector(delta) {
      if (!this.changeList.length) return;
      const at = this.inspecting
        ? this.changeList.findIndex((c) => c.page === this.inspecting.page && c.index === this.inspecting.regionIndex)
        : -1;
      const next = this.changeList[RP.clamp(at + delta, 0, this.changeList.length - 1)];
      if (next) this.focusRegion(next.page, next.index);
    },

    drawInspector() {
      const host = RP.$('#cmpInspector');
      if (!host || !this.inspecting) return;
      const body = RP.$('#cmpInspectBody');
      const result = this.cache.get(this.inspecting.page);
      const region = result && result.regions && result.regions[this.inspecting.regionIndex];
      body.innerHTML = '';
      if (!region) { this.closeInspector(); return; }

      const at = this.changeList.findIndex((c) =>
        c.page === this.inspecting.page && c.index === this.inspecting.regionIndex);
      RP.$('#cmpInspectTitle').textContent =
        'Change ' + (at + 1) + ' of ' + this.changeList.length +
        '  ·  page ' + (this.inspecting.page + 1) +
        '  ·  ' + (region.kind === 'changed' ? 'modified' : region.kind);

      const crop = cropRect(region, result.width, result.height, INSPECT_PAD);
      const tiles = [
        { cap: 'Baseline', canvas: result.canvasA },
        { cap: 'Current', canvas: result.canvasB },
        { cap: 'Differences', canvas: result.composite }
      ];

      const available = Math.max(240, body.clientWidth - 40) / tiles.length;
      const zoom = this.inspectZoom || RP.clamp(available / crop.w, 1, 8);
      const outW = Math.round(crop.w * zoom);
      const outH = Math.round(crop.h * zoom);

      for (const tile of tiles) {
        const wrap = RP.el('div', { class: 'cmp-tile' });
        wrap.appendChild(RP.el('span', { class: 'cap', text: tile.cap }));
        const canvas = RP.el('canvas');
        canvas.width = outW;
        canvas.height = outH;
        canvas.style.width = outW + 'px';
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, outW, outH);
        if (tile.canvas) ctx.drawImage(tile.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);

        ctx.strokeStyle = region.kind === 'added' ? '#2f8fff' : region.kind === 'removed' ? '#ff2f2f' : '#f2c14e';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(
          (region.x - crop.x) * zoom - 2,
          (region.y - crop.y) * zoom - 2,
          region.w * zoom + 4,
          region.h * zoom + 4
        );
        wrap.appendChild(canvas);
        body.appendChild(wrap);
      }

      const zoomInput = RP.$('#cmpInspectZoom');
      if (zoomInput && !this.inspectZoom) {
        zoomInput.value = String(RP.clamp(Math.round(zoom * 2) / 2, 1, 8));
        RP.$('#cmpInspectZoomOut').textContent = zoom.toFixed(1) + '×';
      }
    },

    /** Turn the change regions into revision clouds on the live document. */
    cloudChanges() {
      if (!this.results.length) return 0;
      let added = 0;
      RP.store.checkpoint();
      for (const result of this.results) {
        const record = RP.viewer.pages[result.page];
        if (!record || !result.regions || result.unreadable) continue;
        const toPdf = (px, py) => record.viewport.convertToPdfPoint(
          px / result.scale * RP.viewer.zoom,
          py / result.scale * RP.viewer.zoom
        );
        for (const region of result.regions) {
          const p1 = toPdf(region.x, region.y);
          const p2 = toPdf(region.x + region.w, region.y + region.h);
          const rect = RP.geom.normRect(p1[0], p1[1], p2[0], p2[1]);
          RP.store.add({
            page: result.page,
            type: 'cloud',
            color: region.kind === 'removed' ? '#ff2f2f' : region.kind === 'added' ? '#2f8fff' : '#f2c14e',
            width: 2,
            opacity: 1,
            x: rect.x - 4, y: rect.y - 4, w: rect.w + 8, h: rect.h + 8,
            note: 'Revision compare: ' + region.kind
          }, { noCheckpoint: true });
          added += 1;
        }
      }
      RP.bus.emit('annots:changed', { reason: 'compare' });
      return added;
    }
  };

  // -------------------------------------------------------------------------
  // Render plumbing
  // -------------------------------------------------------------------------

  /* A pdf.js render that never settles used to hang the whole run, and the
     page it hung on came back as a blank sheet — which the old pipeline then
     reported as "everything on this page was deleted". Cancel it instead and
     let the caller retry smaller. */
  function withTimeout(task, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { task.cancel(); } catch (err) { /* already finished */ }
        reject(new Error('page render timed out after ' + Math.round(ms / 1000) + 's'));
      }, ms);
      task.promise.then(
        () => { if (!done) { done = true; clearTimeout(timer); resolve(); } },
        (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } }
      );
    });
  }

  /** Chromium keeps canvas backing stores alive until they are resized away. */
  function releaseCanvas(canvas) {
    if (!canvas) return;
    try { canvas.width = 0; canvas.height = 0; } catch (err) { /* detached */ }
  }

  function releasePair(pair) {
    if (!pair) return;
    if (pair.reference) releaseCanvas(pair.reference.canvas);
    if (pair.other) releaseCanvas(pair.other.canvas);
  }

  function releaseResult(result) {
    if (!result) return;
    releaseCanvas(result.canvasA);
    if (result.canvasB !== result.canvasA) releaseCanvas(result.canvasB);
    releaseCanvas(result.composite);
    result.canvasA = result.canvasB = result.composite = null;
  }

  function unreadableText(result) {
    if (result.unreadable === 'flooded') {
      return 'One of the two revisions rendered as solid ink, which means the ' +
        'render failed rather than the sheet being black. Nothing on this page is ' +
        'reported as changed.';
    }
    if (result.unreadable === 'one-blank') {
      return 'One revision of this page rendered empty twice, including at reduced ' +
        'resolution. It has been left out rather than reported as a wholesale change.';
    }
    return 'The page could not be rendered' + (result.detail ? ': ' + result.detail : '.');
  }

  // -------------------------------------------------------------------------
  // Mask maths
  // -------------------------------------------------------------------------

  /** Where a page of `baseW × baseH` lands when fitted and centred on a grid. */
  function fitOntoGrid(baseW, baseH, targetW, targetH) {
    const scale = Math.min(targetW / baseW, targetH / baseH);
    const drawW = baseW * scale;
    const drawH = baseH * scale;
    return {
      scale,
      drawW, drawH,
      offsetX: (targetW - drawW) / 2,
      offsetY: (targetH - drawH) / 2
    };
  }

  /**
   * Is this mask a usable picture of a page?
   *
   * Two failures look identical to the diff maths and are the reason a whole
   * document once came back "completely different": a render that never
   * painted leaves a white canvas (no ink at all), and a canvas the browser
   * failed to allocate reads back as black (ink everywhere).
   */
  function maskHealth(rendered) {
    if (!rendered) return { ok: false, reason: 'missing', coverage: 0 };
    const coverage = rendered.coverage != null
      ? rendered.coverage
      : rendered.ink / (rendered.width * rendered.height);
    if (coverage >= FLOODED_INK) return { ok: false, reason: 'flooded', coverage };
    if (!rendered.ink) return { ok: false, reason: 'blank', coverage };
    return { ok: true, reason: null, coverage };
  }

  /**
   * Decide whether a rendered pair can be trusted.
   * `final` is true on the last attempt, when a page that is genuinely blank
   * in one revision has to be accepted rather than retried forever.
   */
  function judgePair(pair, final) {
    if (!pair || !pair.reference) return { ok: false, reason: 'error', detail: 'nothing rendered' };
    if (!pair.hasCurrent || !pair.hasBase) {
      // A page that exists in only one revision is a real result, not a failure.
      const health = maskHealth(pair.reference);
      if (health.reason === 'flooded') return { ok: false, reason: 'flooded', detail: '' };
      return { ok: true, empty: !pair.reference.ink };
    }

    const a = maskHealth(pair.reference);
    const b = maskHealth(pair.other);

    if (a.reason === 'flooded' || b.reason === 'flooded') {
      return { ok: false, reason: 'flooded', detail: (a.reason === 'flooded' ? 'current' : 'baseline') + ' side' };
    }
    if (a.reason === 'blank' && b.reason === 'blank') return { ok: true, empty: true };
    if (a.reason === 'blank' || b.reason === 'blank') {
      if (!final) return { ok: false, reason: 'one-blank', detail: '' };
      return { ok: true, empty: false, oneBlank: true };
    }
    return { ok: true, empty: false };
  }

  /** Bounding box of every set pixel, or null when the mask is empty. */
  function inkBBox(mask, width, height) {
    let minX = width, minY = height, maxX = -1, maxY = -1, ink = 0;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (!mask[row + x]) continue;
        ink += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, ink };
  }

  /**
   * Coarse alignment from the two ink bounding boxes.
   *
   * A drawing's outermost ink is its sheet border, so the boxes are a reliable
   * frame of reference and they recover two things the projection correlation
   * cannot: a shift larger than its search window, and a re-plot at a slightly
   * different scale. Both are ordinary between issues of a drawing set, and
   * both used to make every mark on the sheet read as a difference.
   */
  function fitCorrection(refBox, baseBox, width, height) {
    if (!refBox || !baseBox) return null;

    // Only trust boxes that look like a sheet border rather than a lone note.
    const framed = refBox.w > width * 0.4 && refBox.h > height * 0.4 &&
                   baseBox.w > width * 0.4 && baseBox.h > height * 0.4;

    const dx = Math.round((refBox.x + refBox.w / 2) - (baseBox.x + baseBox.w / 2));
    const dy = Math.round((refBox.y + refBox.h / 2) - (baseBox.y + baseBox.h / 2));
    const usableShift = framed &&
      Math.abs(dx) <= width * 0.15 && Math.abs(dy) <= height * 0.15 &&
      (Math.abs(dx) > 0 || Math.abs(dy) > 0);

    const sx = refBox.w / baseBox.w;
    const sy = refBox.h / baseBox.h;
    const scale = (sx + sy) / 2;
    const uniform = Math.abs(sx - sy) < 0.02;
    const rescale = framed && uniform && scale > 0.9 && scale < 1.1 && Math.abs(scale - 1) > 0.004;

    // Offsets are expressed against the centred fit the renderer already applies.
    const offsetX = (refBox.x + refBox.w / 2) - (width / 2);
    const offsetY = (refBox.y + refBox.h / 2) - (height / 2);
    const baseOffsetX = (baseBox.x + baseBox.w / 2) - (width / 2);
    const baseOffsetY = (baseBox.y + baseBox.h / 2) - (height / 2);

    return {
      dx, dy, usableShift, rescale, scale,
      offsetX: rescale ? offsetX - baseOffsetX * scale : 0,
      offsetY: rescale ? offsetY - baseOffsetY * scale : 0
    };
  }

  /** Separable binary dilation: a pixel is set if any pixel within r is set. */
  function dilate(mask, width, height, radius) {
    const r = Math.round(radius);
    const temp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);

    // horizontal pass with a running count
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let count = 0;
      for (let x = 0; x <= r && x < width; x += 1) count += mask[row + x];
      for (let x = 0; x < width; x += 1) {
        temp[row + x] = count > 0 ? 1 : 0;
        const outIdx = x - r;
        const inIdx = x + r + 1;
        if (outIdx >= 0) count -= mask[row + outIdx];
        if (inIdx < width) count += mask[row + inIdx];
      }
    }
    // vertical pass
    for (let x = 0; x < width; x += 1) {
      let count = 0;
      for (let y = 0; y <= r && y < height; y += 1) count += temp[y * width + x];
      for (let y = 0; y < height; y += 1) {
        out[y * width + x] = count > 0 ? 1 : 0;
        const outIdx = y - r;
        const inIdx = y + r + 1;
        if (outIdx >= 0) count -= temp[outIdx * width + x];
        if (inIdx < height) count += temp[inIdx * width + x];
      }
    }
    return out;
  }

  /** Cheap global translation estimate from row/column ink projections. */
  function estimateShift(maskA, maskB, width, height, maxShift) {
    const limit = maxShift || SHIFT_LIMIT;
    const colsA = new Float32Array(width);
    const colsB = new Float32Array(width);
    const rowsA = new Float32Array(height);
    const rowsB = new Float32Array(height);

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const a = maskA[row + x];
        const b = maskB[row + x];
        if (a) { colsA[x] += 1; rowsA[y] += 1; }
        if (b) { colsB[x] += 1; rowsB[y] += 1; }
      }
    }
    return {
      dx: bestOffset(colsA, colsB, limit),
      dy: bestOffset(rowsA, rowsB, limit)
    };
  }

  /**
   * Offset that best aligns signal A onto signal B (normalised correlation).
   *
   * The norms are taken over the overlapping window only, so a shift that
   * leaves barely any overlap can score a perfect 1.0 on a handful of pixels.
   * Shifts that throw away more than 40% of the signal are therefore refused.
   */
  function bestOffset(a, b, limit) {
    let best = 0;
    let bestScore = -Infinity;
    const n = a.length;
    const minOverlap = n * 0.6;
    for (let shift = -limit; shift <= limit; shift += 1) {
      if (n - Math.abs(shift) < minOverlap) continue;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < n; i += 1) {
        const j = i + shift;
        if (j < 0 || j >= n) continue;
        dot += a[i] * b[j];
        normA += a[i] * a[i];
        normB += b[j] * b[j];
      }
      const score = dot / (Math.sqrt(normA * normB) || 1);
      // Prefer no shift on ties so we never invent movement.
      if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && Math.abs(shift) < Math.abs(best))) {
        bestScore = score;
        best = shift;
      }
    }
    return best;
  }

  function shiftMask(mask, width, height, dx, dy) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
      const srcY = y - dy;
      if (srcY < 0 || srcY >= height) continue;
      const srcRow = srcY * width;
      const dstRow = y * width;
      for (let x = 0; x < width; x += 1) {
        const srcX = x - dx;
        if (srcX < 0 || srcX >= width) continue;
        out[dstRow + x] = mask[srcRow + srcX];
      }
    }
    return out;
  }

  /** Connected components (8-way) with a speck filter. */
  function labelBlobs(mask, width, height, minSize) {
    const seen = new Uint8Array(mask.length);
    const blobs = [];
    let stack = new Int32Array(1 << 16);
    const minArea = Math.max(4, Math.round(minSize * 1.5));
    const minDim = Math.max(1, minSize * 0.75);

    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || seen[start]) continue;
      let top = 0;
      stack[top += 1] = start;
      seen[start] = 1;
      let minX = width, maxX = 0, minY = height, maxY = 0, area = 0;

      while (top > 0) {
        const idx = stack[top];
        top -= 1;
        const x = idx % width;
        const y = (idx - x) / width;
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (let ny = y - 1; ny <= y + 1; ny += 1) {
          if (ny < 0 || ny >= height) continue;
          for (let nx = x - 1; nx <= x + 1; nx += 1) {
            if (nx < 0 || nx >= width) continue;
            const nIdx = ny * width + nx;
            if (!mask[nIdx] || seen[nIdx]) continue;
            seen[nIdx] = 1;
            if (top + 1 >= stack.length) {
              // Grow rarely; a single huge blob is the only way to get here.
              const bigger = new Int32Array(stack.length * 2);
              bigger.set(stack);
              stack = bigger;
            }
            stack[top += 1] = nIdx;
          }
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (area < minArea && Math.max(w, h) < minDim) continue;
      blobs.push({ x: minX, y: minY, w, h, area });
      if (blobs.length > 4000) break;
    }
    return blobs;
  }

  /** Merge nearby blobs into readable change regions. */
  function mergeRegions(removedBlobs, addedBlobs, gap, width, height) {
    const items = removedBlobs.map((b) => Object.assign({ kind: 'removed' }, b))
      .concat(addedBlobs.map((b) => Object.assign({ kind: 'added' }, b)));
    if (!items.length) return [];

    const regions = [];
    for (const item of items) {
      let merged = false;
      for (const region of regions) {
        if (rectsNear(region, item, gap)) {
          const x0 = Math.min(region.x, item.x);
          const y0 = Math.min(region.y, item.y);
          const x1 = Math.max(region.x + region.w, item.x + item.w);
          const y1 = Math.max(region.y + region.h, item.y + item.h);
          region.x = x0; region.y = y0; region.w = x1 - x0; region.h = y1 - y0;
          region.pixels += item.area;
          if (region.kind !== item.kind) region.kind = 'changed';
          merged = true;
          break;
        }
      }
      if (!merged) {
        regions.push({ x: item.x, y: item.y, w: item.w, h: item.h, kind: item.kind, pixels: item.area });
      }
    }

    // A second pass catches chains that only became adjacent after merging.
    let changed = true;
    let guard = 0;
    while (changed && guard < 6) {
      changed = false;
      guard += 1;
      for (let i = 0; i < regions.length; i += 1) {
        for (let j = i + 1; j < regions.length; j += 1) {
          if (!rectsNear(regions[i], regions[j], gap)) continue;
          const a = regions[i];
          const b = regions[j];
          const x0 = Math.min(a.x, b.x);
          const y0 = Math.min(a.y, b.y);
          const x1 = Math.max(a.x + a.w, b.x + b.w);
          const y1 = Math.max(a.y + a.h, b.y + b.h);
          a.x = x0; a.y = y0; a.w = x1 - x0; a.h = y1 - y0;
          a.pixels += b.pixels;
          if (a.kind !== b.kind) a.kind = 'changed';
          regions.splice(j, 1);
          changed = true;
          j -= 1;
        }
      }
    }

    regions.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const region of regions) {
      region.x = Math.max(0, region.x);
      region.y = Math.max(0, region.y);
      region.w = Math.min(width - region.x, region.w);
      region.h = Math.min(height - region.y, region.h);
    }
    return regions;
  }

  function rectsNear(a, b, gap) {
    return !(b.x > a.x + a.w + gap || b.x + b.w < a.x - gap ||
             b.y > a.y + a.h + gap || b.y + b.h < a.y - gap);
  }

  /** The patch of page the inspector magnifies: the region plus context. */
  function cropRect(region, width, height, pad) {
    const padX = Math.max(pad, region.w * 0.35);
    const padY = Math.max(pad, region.h * 0.35);
    let x = Math.round(region.x - padX);
    let y = Math.round(region.y - padY);
    let w = Math.round(region.w + padX * 2);
    let h = Math.round(region.h + padY * 2);
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.max(1, Math.min(w, width - x));
    h = Math.max(1, Math.min(h, height - y));
    return { x, y, w, h };
  }

  /** Index of the topmost region under a point, or -1. */
  function regionAt(regions, px, py, slack) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < regions.length; i += 1) {
      const r = regions[i];
      if (px < r.x - slack || px > r.x + r.w + slack) continue;
      if (py < r.y - slack || py > r.y + r.h + slack) continue;
      const area = r.w * r.h;
      if (area < bestArea) { bestArea = area; best = i; }
    }
    return best;
  }

  Compare.internals = {
    dilate, estimateShift, bestOffset, shiftMask, labelBlobs, mergeRegions,
    fitOntoGrid, maskHealth, judgePair, inkBBox, fitCorrection, cropRect, regionAt
  };
  RP.compare = Compare;

})(window.RP);
