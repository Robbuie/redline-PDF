/* Revision compare.

   The point of this module is to show TRUE differences, not scanner noise or
   sub-pixel plotting shifts. The pipeline per page pair is:

     1. render both revisions to the same pixel grid
     2. reduce each to a binary "ink" mask (everything darker than a threshold)
     3. estimate and cancel any global x/y shift between the two plots
     4. dilate each mask by the tolerance radius, then
          removed = inkA AND NOT dilated(inkB)
          added   = inkB AND NOT dilated(inkA)
        so a line that merely moved half a pixel cancels out completely
     5. drop specks below the minimum change size
     6. cluster what survives into labelled change regions you can click through
*/
'use strict';

(function (RP) {

  const WORK_DPI = 150;
  const MAX_PIXELS = 6.5e6;
  const MERGE_GAP = 16;      // px: how close two change blobs must be to merge
  const CACHE_LIMIT = 3;

  const Compare = {
    baseline: null,          // {path, name, doc}
    running: false,
    results: [],             // per page: {page, regions, added, removed, aligned, skipped}
    cache: new Map(),        // page -> full render result
    pageIndex: 0,
    mode: 'overlay',
    options: { tolerance: 2, autoAlign: true, minSize: 6, inkThreshold: 200 },
    active: false,

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

      RP.bus.on('doc:loaded', () => {
        RP.$('#cmpCurrentName').textContent = RP.store.docName || '— none —';
        this.updateRunState();
        this.results = [];
        this.cache.clear();
        RP.$('#cmpResults').innerHTML = '';
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
      this.results = [];
      this.cache.clear();

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
          const result = await this.computePage(i, { keep: i === 0 });
          this.results.push(this.summarize(result));
        } catch (err) {
          console.error('Compare failed on page ' + (i + 1), err);
          this.results.push({ page: i, error: err.message, regions: [], added: 0, removed: 0 });
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
        onlyIn: result.onlyIn,
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

    async renderToMask(doc, pageNumber, target) {
      if (pageNumber > doc.numPages) return null;
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      let scale = target ? target.scale : Math.min(WORK_DPI / 72, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      let width = target ? target.width : Math.round(base.width * scale);
      let height = target ? target.height : Math.round(base.height * scale);
      if (target) {
        // Fit this page onto the reference grid (handles a re-plotted sheet size).
        scale = Math.min(target.width / base.width, target.height / base.height);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      const viewport = page.getViewport({ scale });
      await page.render({ canvasContext: ctx, viewport }).promise;

      const image = ctx.getImageData(0, 0, width, height);
      const mask = new Uint8Array(width * height);
      const threshold = this.options.inkThreshold;
      const data = image.data;
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        // perceptual luminance; alpha is 255 because the canvas is opaque
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        mask[p] = lum < threshold ? 1 : 0;
      }
      return { mask, width, height, scale, canvas };
    },

    async computePage(pageIndex, opts) {
      const cached = this.cache.get(pageIndex);
      if (cached) return cached;

      const currentDoc = RP.store.doc;
      const baseDoc = this.baseline.doc;
      const pageNumber = pageIndex + 1;

      const hasCurrent = pageNumber <= currentDoc.numPages;
      const hasBase = pageNumber <= baseDoc.numPages;

      const reference = hasCurrent
        ? await this.renderToMask(currentDoc, pageNumber, null)
        : await this.renderToMask(baseDoc, pageNumber, null);

      const other = hasCurrent && hasBase
        ? await this.renderToMask(baseDoc, pageNumber, reference)
        : null;

      const width = reference.width;
      const height = reference.height;

      // Whole page added or removed.
      if (!hasBase || !hasCurrent) {
        const result = {
          page: pageIndex,
          width, height, scale: reference.scale,
          canvasA: hasBase ? reference.canvas : null,
          canvasB: hasCurrent ? reference.canvas : null,
          composite: this.compositeWholePage(reference, hasCurrent ? 'added' : 'removed'),
          regions: [{
            x: 0, y: 0, w: width, h: height,
            kind: hasCurrent ? 'added' : 'removed',
            pixels: 0,
            note: hasCurrent ? 'Page only exists in the current revision' : 'Page only exists in the baseline'
          }],
          addedPixels: hasCurrent ? 1 : 0,
          removedPixels: hasBase ? 1 : 0,
          shift: { dx: 0, dy: 0 },
          onlyIn: hasCurrent ? 'current' : 'baseline'
        };
        this.remember(pageIndex, result, opts);
        return result;
      }

      const currentMask = hasCurrent ? reference.mask : other.mask;
      const baseMask = other.mask;

      const shift = this.options.autoAlign
        ? estimateShift(baseMask, currentMask, width, height)
        : { dx: 0, dy: 0 };

      const alignedBase = (shift.dx || shift.dy)
        ? shiftMask(baseMask, width, height, shift.dx, shift.dy)
        : baseMask;

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

      const composite = this.composite(alignedBase, currentMask, removed, added, width, height, removedBlobs, addedBlobs);

      const result = {
        page: pageIndex,
        width, height,
        scale: reference.scale,
        canvasA: other.canvas,
        canvasB: reference.canvas,
        composite,
        regions,
        addedPixels: addedCount,
        removedPixels: removedCount,
        shift,
        onlyIn: null
      };
      this.remember(pageIndex, result, opts);
      return result;
    },

    remember(pageIndex, result, opts) {
      this.cache.set(pageIndex, result);
      if (this.cache.size > CACHE_LIMIT && !(opts && opts.keepAll)) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== pageIndex) this.cache.delete(oldest);
      }
    },

    /** Build the colour-coded overlay bitmap. */
    composite(baseMask, currentMask, removed, added, width, height, removedBlobs, addedBlobs) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(width, height);
      const data = image.data;

      // Kept context in light grey, so real changes are the only saturated ink.
      for (let i = 0, p = 0; p < removed.length; p += 1, i += 4) {
        let r = 255, g = 255, b = 255;
        if (baseMask[p] || currentMask[p]) { r = 200; g = 205; b = 212; }
        if (removed[p]) { r = 255; g = 47; b = 47; }
        if (added[p]) { r = 47; g = 143; b = 255; }
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);

      // Blobs that survived cleanup get a soft glow so they read at fit-page zoom.
      ctx.save();
      ctx.globalAlpha = 0.16;
      for (const blob of removedBlobs) { ctx.fillStyle = '#ff2f2f'; ctx.fillRect(blob.x - 3, blob.y - 3, blob.w + 6, blob.h + 6); }
      for (const blob of addedBlobs) { ctx.fillStyle = '#2f8fff'; ctx.fillRect(blob.x - 3, blob.y - 3, blob.w + 6, blob.h + 6); }
      ctx.restore();
      return canvas;
    },

    compositeWholePage(reference, kind) {
      const canvas = document.createElement('canvas');
      canvas.width = reference.width;
      canvas.height = reference.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(reference.canvas, 0, 0);
      ctx.fillStyle = kind === 'added' ? 'rgba(47,143,255,.22)' : 'rgba(255,47,47,.22)';
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
        pageIndex: this.pageIndex,
        active: this.active
      };
      this.close();
      this.baseline = null;
      this.results = [];
      this.cache = new Map();
      this.pageIndex = 0;
      return state;
    },

    unstash(state) {
      this.baseline = (state && state.baseline) || null;
      this.results = (state && state.results) || [];
      this.cache = (state && state.cache) || new Map();
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
      if (this.mode === 'side') {
        stage.appendChild(this.pane('Baseline', result.canvasA, result, 'removed'));
        stage.appendChild(this.pane('Current', result.canvasB, result, 'added'));
      } else if (this.mode === 'swipe') {
        stage.appendChild(this.swipePane(result));
      } else {
        stage.appendChild(this.pane('Differences', result.composite, result, 'both'));
      }
      this.markActiveRegionRows();
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

      const totalRegions = this.results.reduce((sum, r) => sum + (r.regions ? r.regions.length : 0), 0);
      const changedPages = this.results.filter((r) => r.regions && r.regions.length).length;
      const shifted = this.results.filter((r) => r.shift && (r.shift.dx || r.shift.dy)).length;

      const summary = RP.el('div', { class: 'cmp-summary' });
      if (!totalRegions) {
        summary.innerHTML = '<b>No true differences found.</b><br>Every mark in both revisions lines up within the tolerance you set.';
      } else {
        summary.innerHTML =
          '<b>' + totalRegions + ' change region' + (totalRegions === 1 ? '' : 's') + '</b> across ' +
          changedPages + ' page' + (changedPages === 1 ? '' : 's') + '.<br>' +
          '<span class="tag added">added</span> content is in the current revision only; ' +
          '<span class="tag removed">removed</span> was in the baseline only.' +
          (shifted ? '<br>' + shifted + ' page' + (shifted === 1 ? ' was' : 's were') + ' auto-aligned for a plot shift.' : '');
      }
      host.appendChild(summary);

      for (const result of this.results) {
        if (!result.regions || !result.regions.length) continue;
        host.appendChild(RP.el('div', {
          class: 'side-head',
          style: { padding: '10px 4px 4px' }
        }, [RP.el('h2', { text: 'Page ' + (result.page + 1) })]));

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

      if (!totalRegions) {
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
      if (!result) return;
      const region = result.regions[regionIndex];
      const pane = RP.$('#cmpStage .cmp-pane');
      if (!pane || !region) return;
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
      this.activeRegion = { page, regionIndex };
      this.markActiveRegionRows();
    },

    markActiveRegionRows() {
      const active = this.activeRegion;
      RP.$$('#cmpResults .cmp-row').forEach((row) => {
        row.classList.toggle('active', !!active &&
          Number(row.dataset.page) === active.page &&
          Number(row.dataset.region) === active.regionIndex);
      });
    },

    /** Turn the change regions into revision clouds on the live document. */
    cloudChanges() {
      if (!this.results.length) return 0;
      let added = 0;
      RP.store.checkpoint();
      for (const result of this.results) {
        const record = RP.viewer.pages[result.page];
        if (!record || !result.regions) continue;
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
  // Mask maths
  // -------------------------------------------------------------------------

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
    const limit = maxShift || 24;
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

  /** Offset that best aligns signal A onto signal B (normalised correlation). */
  function bestOffset(a, b, limit) {
    let best = 0;
    let bestScore = -Infinity;
    const n = a.length;
    for (let shift = -limit; shift <= limit; shift += 1) {
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

  Compare.internals = { dilate, estimateShift, bestOffset, shiftMask, labelBlobs, mergeRegions };
  RP.compare = Compare;

})(window.RP);
