/* View modes: how the pages of a document are arranged in the scroll column.

   Continuous scroll used to be the only layout, and `viewer.js` assumed it
   everywhere — a single vertical stack of pages, one page per row, page index
   and row index the same number. A facing spread breaks that assumption in one
   place (two pages share a row) and a paged mode breaks it in another (only one
   row is in the column at a time), so the grouping rule and the two questions
   the viewer keeps asking about a mode live here rather than being re-derived
   at each call site.

   Everything in this file is pure and free of the DOM on purpose: the grouping
   is the part that is easy to get subtly wrong (the cover page is the only
   page whose row is not `(i + 1) >> 1`) and `test/verify.js` can only reach it
   if it is. The viewer holds the rows themselves; this only says what they
   should be. */
'use strict';

(function (RP) {

  /* The four combinations of "one page or two" and "scroll the whole document
     or show one row at a time". Two orthogonal properties, carried as one
     string because it is one user-facing choice, one thing to persist, and one
     thing for `tabs.js` to stash. */
  const MODES = ['continuous', 'single', 'facing', 'facing-continuous'];

  const LABELS = {
    continuous: 'Continuous',
    single: 'Single page',
    facing: 'Two pages',
    'facing-continuous': 'Two pages, continuous'
  };

  /* The two fixed pixel measurements of the page column: the gutter between
     the sheets of a spread, and the padding around the column as a whole.
     Neither scales with the zoom, so both have to be taken off the pane before
     the fit divides by the page widths — see `fitScale`. They are the same two
     numbers as the `gap` on `.page-row` and the `padding` on `.pages` in
     app.css, and `test/verify.js` checks that they still agree. */
  const SPREAD_GAP = 14;
  const COLUMN_PAD = 60;

  /* What the browser will actually give you as a canvas.
     ---------------------------------------------------------------------------
     Chromium refuses a canvas over ~16384 px on a side, and over a total area
     it will not commit to, and IT DOES BOTH SILENTLY: the allocation fails,
     `page.render()` resolves as normal, and what you have is a white sheet with
     nothing logged. `snapshot.js` has known this since the copy-region feature
     went in (MAX_PIXELS there, same reasoning); the page canvases never got the
     same treatment, so a large-format sheet blanked at high zoom and looked
     like a broken drawing rather than a limit being hit.

     The numbers are not theoretical on this app's documents. An ANSI E sheet is
     2448 x 3168 pt, so at dpr 2 the side limit lands at about 335% zoom — and a
     long plot out of a DWF (a riser diagram or a site plan run out on one
     continuous sheet) can be 7000 pt wide, which crosses it barely above
     fit-width. That is the blank page.

     MAX_PIXELS is 24 megapixels to match snapshot.js. It is deliberately above
     the common case rather than tuned down to it: an E-size sheet at fit-width
     on a 1600px pane is ~13 MP at dpr 2, so a normal drawing is never touched
     by this and only the sheets that would otherwise fail get a softer
     raster. */
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_PIXELS = 24e6;

  /* The detail tile.
     ---------------------------------------------------------------------------
     The cap above stops a large sheet blanking, and it pays for it in
     sharpness: an ANSI E sheet at 400% is clamped to about 0.44 device pixels
     per CSS pixel, because the whole page is one canvas and the whole page
     will not fit in one. But only the part of it on screen ever needs to be
     sharp, and a crop is what pdf.js's `transform` parameter is for —
     `snapshot.js` has rendered regions that way since 0.8.

     So a capped sheet gets a *second* pair of canvases over the top of the
     first, covering the visible crop at the full device pixel ratio. The
     whole-page pair underneath is unchanged and still covers the page box,
     which is the whole reason this is an overlay rather than a replacement:
     scrolling off the tile falls back to a soft sheet, never to a blank one,
     and nothing outside `viewer.js` has to learn about an offset.

     MARGIN is small on purpose. It is slack against a scroll, and every pixel
     of it is paid for in a canvas that competes with the base for the same
     memory budget; the base is already covering anything the tile does not.
     MAX_TILE_PIXELS is below MAX_CANVAS_PIXELS for the same reason — two
     canvases at 16 MP is 128 MB, which is what a viewport-sized crop on a 4K
     pane costs, and the base pair is still live underneath it. */
  const TILE_MARGIN = 120;
  const MAX_TILE_PIXELS = 16e6;
  /* Below this the tile is not worth taking. Re-rendering a crop through the
     one pdf.js worker to gain a few percent of resolution is work the sheet
     you are reading has to wait behind, and the difference is not visible. */
  const MIN_TILE_GAIN = 1.25;

  const HINTS = {
    continuous: 'One column, scroll straight through the set',
    single: 'One sheet at a time',
    facing: 'A spread at a time, cover sheet on its own',
    'facing-continuous': 'Spreads in one scrolling column'
  };

  /** Anything unrecognised — an older saved view, a future build's mode. */
  function normalize(mode) {
    return MODES.indexOf(mode) === -1 ? 'continuous' : mode;
  }

  /** One row in the column at a time, rather than the whole document. */
  function isPaged(mode) {
    const m = normalize(mode);
    return m === 'single' || m === 'facing';
  }

  /** Pages per row. */
  function spreadOf(mode) {
    const m = normalize(mode);
    return (m === 'facing' || m === 'facing-continuous') ? 2 : 1;
  }

  /**
   * Group page indices into rows.
   *
   * The cover page sits alone, which is what makes a spread read as a bound
   * document rather than as pages that happen to be side by side: page 2 backs
   * page 1, so 2 and 3 face each other, not 1 and 2. It also means the row of
   * a page is not `index >> 1` — every call site that needs it must go through
   * `rowOfPage` rather than dividing by the spread.
   */
  function rowsFor(count, mode) {
    const total = Math.max(0, count | 0);
    const rows = [];
    if (!total) return rows;
    if (spreadOf(mode) === 1) {
      for (let i = 0; i < total; i += 1) rows.push([i]);
      return rows;
    }
    rows.push([0]);
    for (let i = 1; i < total; i += 2) {
      rows.push(i + 1 < total ? [i, i + 1] : [i]);
    }
    return rows;
  }

  /** Which row a page lands in, without building the rows. */
  function rowOfPage(index, mode) {
    const i = Math.max(0, index | 0);
    if (spreadOf(mode) === 1 || i === 0) return i;
    return (i + 1) >> 1;
  }

  /** First page of the row a page is in — what "current page" means in a spread. */
  function rowStartOf(index, mode) {
    const i = Math.max(0, index | 0);
    if (spreadOf(mode) === 1 || i === 0) return i;
    return i % 2 === 0 ? i - 1 : i;
  }

  /**
   * Bounding box of the ink in an RGBA raster, or null if the page is blank.
   *
   * This is what "fit visible" fits to. A drawing is mostly paper: an E-size
   * sheet fitted by its page box wastes the plot margin and the strip outside
   * the border on every side, and on a scan the sheet is smaller again than
   * the page it was scanned onto. Fitting the ink instead is the difference
   * between a legible schedule and one you have to zoom into every time.
   *
   * Deliberately a raster scan rather than a walk over the text runs: on an
   * electrical drawing almost nothing is text, so a text bbox would fit to the
   * title block and ignore the plan. `threshold` is generous because a scan's
   * "white" is nearer 240 than 255, and single stray pixels are not trimmed —
   * a speck at the corner of a scan would undo the whole thing, so a row or
   * column has to carry `minRun` marked pixels to count as ink.
   */
  function inkBoxOf(data, width, height, opts) {
    const options = opts || {};
    const threshold = options.threshold == null ? 236 : options.threshold;
    const minRun = options.minRun == null ? 2 : options.minRun;
    if (!data || width <= 0 || height <= 0) return null;

    const cols = new Uint32Array(width);
    const rows = new Uint32Array(height);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const p = rowStart + x * 4;
        // Rec. 601 luma is close enough, and cheaper than a colour conversion
        // on a raster this small.
        const luma = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        if (luma > threshold) continue;
        cols[x] += 1;
        rows[y] += 1;
      }
    }

    const span = (counts, length) => {
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < length; i += 1) {
        if (counts[i] < minRun) continue;
        if (lo === -1) lo = i;
        hi = i;
      }
      return lo === -1 ? null : { lo, hi };
    };

    const h = span(cols, width);
    const v = span(rows, height);
    if (!h || !v) return null;
    return { x: h.lo, y: v.lo, w: h.hi - h.lo + 1, h: v.hi - v.lo + 1 };
  }

  /**
   * The zoom that puts a row of pages in the pane.
   *
   * Separated from `viewer.applyFit` because the facing case is where fit
   * quietly goes wrong: the gap between two pages is a fixed number of CSS
   * pixels and does *not* scale with the zoom, so dividing the pane width by
   * the summed page widths overshoots by the gap and the right-hand sheet ends
   * up a sliver off the edge. Widths and heights are unscaled (scale 1)
   * viewport dimensions, already carrying each page's own /Rotate.
   */
  function fitScale(widths, heights, opts) {
    const options = opts || {};
    const availW = Math.max(1, options.availWidth || 0);
    const availH = Math.max(1, options.availHeight || 0);
    const gap = options.gap || 0;
    let sumW = 0;
    let maxH = 0;
    for (let i = 0; i < widths.length; i += 1) {
      sumW += widths[i];
      if (heights[i] > maxH) maxH = heights[i];
    }
    if (sumW <= 0 || maxH <= 0) return 1;
    const usableW = Math.max(1, availW - gap * Math.max(0, widths.length - 1));
    const byWidth = usableW / sumW;
    if (options.mode === 'page') return Math.min(byWidth, availH / maxH);
    return byWidth;
  }

  /**
   * How large a page may actually be rastered, given how large it is laid out.
   *
   * Returns the backing-store size to give the canvas and the scale to render
   * at — which is the requested device pixel ratio until one of the limits
   * bites, and less than it after that. **The CSS box is not this function's
   * business and must not follow it**: the page keeps its layout size and the
   * smaller bitmap is stretched over it, which is the same trade `setZoom`
   * already makes for a deferred raster. A soft sheet is a sheet; a refused
   * canvas is a white rectangle with no way to tell it from an empty drawing.
   *
   * Both limits are applied to the *scale*, not to the dimensions, so the page
   * stays in proportion — capping the long side alone would squash the raster
   * against a CSS box that did not change and put every markup out of place.
   *
   * @param {number} width  laid-out page width in CSS pixels
   * @param {number} height laid-out page height in CSS pixels
   * @param {number} dpr    the device pixel ratio the caller would like
   * @returns {{scale: number, width: number, height: number, capped: boolean}}
   */
  function rasterPlan(width, height, dpr, opts) {
    const options = opts || {};
    const maxSide = options.maxSide || MAX_CANVAS_SIDE;
    const maxPixels = options.maxPixels || MAX_CANVAS_PIXELS;
    const w = Math.max(1, Math.floor(width) || 1);
    const h = Math.max(1, Math.floor(height) || 1);
    const wanted = Math.max(0.01, dpr || 1);

    // The side limit first: it is a hard refusal rather than a memory question,
    // and clamping it can only reduce the area, so the order is safe.
    let scale = Math.min(wanted, maxSide / w, maxSide / h);

    const pixels = w * h * scale * scale;
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);

    /* Floor, never round: a rounded dimension can land back *on* the limit the
       scale was just clamped to, which is the one value that must not come
       out of here. At least one pixel each way, or the context is unusable. */
    const cw = Math.max(1, Math.min(maxSide, Math.floor(w * scale)));
    const ch = Math.max(1, Math.min(maxSide, Math.floor(h * scale)));

    return { scale, width: cw, height: ch, capped: scale < wanted - 1e-9 };
  }

  /** Overlap of two axis-aligned boxes, or null when they do not meet. */
  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const t = Math.min(a.y + a.h, b.y + b.h);
    if (r <= x || t <= y) return null;
    return { x, y, w: r - x, h: t - y };
  }

  /**
   * The part of a page worth rastering at full resolution, in *page-local*
   * CSS pixels.
   *
   * `page` and `view` are both boxes in the scroller's own coordinate space —
   * the space `viewer.topOf`/`leftOf` measure in, which does not move when the
   * pane scrolls. The result is translated to the page's own origin, because
   * that is the space the render transform and the markup pass work in.
   *
   * Returns null when there is nothing to do, and the two null cases are
   * different things worth keeping apart in the caller's head: the page is not
   * on screen at all, or the whole page is already inside the tile — in which
   * case the base canvas *is* the tile and a second copy of it would be pure
   * cost. That second case is what makes an ordinary sheet, or any sheet
   * zoomed out to fit, take this path and come out unchanged.
   */
  function detailTile(page, view, opts) {
    const options = opts || {};
    const margin = options.margin == null ? TILE_MARGIN : options.margin;
    if (!page || !view || page.w <= 0 || page.h <= 0) return null;

    const grown = {
      x: view.x - margin, y: view.y - margin,
      w: view.w + margin * 2, h: view.h + margin * 2
    };
    const hit = intersect(page, grown);
    if (!hit) return null;

    // Outward, never inward: a tile rounded in leaves a hairline of the soft
    // base showing along two edges of the sharp crop, which reads as a seam.
    const x = Math.max(0, Math.floor(hit.x - page.x));
    const y = Math.max(0, Math.floor(hit.y - page.y));
    const w = Math.min(Math.ceil(page.w) - x, Math.ceil(hit.w) + 1);
    const h = Math.min(Math.ceil(page.h) - y, Math.ceil(hit.h) + 1);
    if (w <= 0 || h <= 0) return null;
    // The whole page is on screen; the base already covers it.
    if (x === 0 && y === 0 && w >= page.w - 1 && h >= page.h - 1) return null;
    return { x, y, w, h };
  }

  /**
   * Is the part of the page actually on screen still inside `tile`?
   *
   * The margin is deliberately *not* applied here. Re-rendering the moment the
   * view leaves the margin would take the tile again every `margin` pixels of
   * scroll, which on the one pdf.js worker is the sheet you are reading
   * queueing behind a crop of itself. Asking only about the strictly visible
   * part spends the whole margin as slack instead.
   */
  function tileCovers(tile, page, view) {
    if (!tile || !page || !view) return false;
    const hit = intersect(page, view);
    if (!hit) return true;   // nothing on screen; nothing to cover
    const x = hit.x - page.x;
    const y = hit.y - page.y;
    return x >= tile.x - 0.5 && y >= tile.y - 0.5
      && x + hit.w <= tile.x + tile.w + 0.5
      && y + hit.h <= tile.y + tile.h + 0.5;
  }

  /* The thumbnail navigator.
     ---------------------------------------------------------------------------
     Two questions, both answered in *fractions of the page box* rather than in
     pixels of either surface. The thumbnail is the page at some other scale,
     so a fraction is the one quantity that means the same thing on both — and
     it is rotation-safe for free, because the thumbnail is rendered through
     the same `rotationOf` the page viewport is and the two are therefore
     always in the same displayed orientation. Going via PDF space instead
     would need the rotation applying and unapplying for no gain. */

  /**
   * The part of a page that is on screen, as fractions of the page box.
   *
   * `page` and `view` are boxes in the scroller's own coordinates — the same
   * space `detailTile` works in, which `viewer.topOf`/`leftOf` measure and
   * which does not move when the pane scrolls.
   *
   * Null when the sheet is not on screen at all. A box covering the whole
   * sheet is returned as such rather than as null: "all of it is visible" is a
   * real answer, and it is the caller's business whether a box around the
   * entire thumbnail is worth drawing.
   */
  function visibleBox(page, view) {
    if (!page || !view || page.w <= 0 || page.h <= 0) return null;
    const hit = intersect(page, view);
    if (!hit) return null;
    return {
      x: (hit.x - page.x) / page.w,
      y: (hit.y - page.y) / page.h,
      w: hit.w / page.w,
      h: hit.h / page.h
    };
  }

  /**
   * Where to scroll so that a given fraction of a page sits in the middle of
   * the pane. The answer is deliberately *unclamped* — the caller owns the
   * scroll limits (`maxScrollTop` measures the live container) and clamping
   * here would need this function to know about them.
   *
   * Centred, not cornered: a click on a thumbnail means "show me this", and
   * putting the point under the pointer at the top-left of the pane hides it
   * behind the toolbars on one axis and shows a screenful of the sheet the
   * user did not point at on the other.
   */
  function scrollToFraction(page, view, fx, fy) {
    if (!page || !view) return { top: 0, left: 0 };
    return {
      top: page.y + fy * page.h - view.h / 2,
      left: page.x + fx * page.w - view.w / 2
    };
  }

  RP.views = {
    MODES, LABELS, HINTS, SPREAD_GAP, COLUMN_PAD,
    MAX_CANVAS_SIDE, MAX_CANVAS_PIXELS,
    TILE_MARGIN, MAX_TILE_PIXELS, MIN_TILE_GAIN,
    normalize, isPaged, spreadOf, rowsFor, rowOfPage, rowStartOf,
    inkBoxOf, fitScale, rasterPlan, intersect, detailTile, tileCovers,
    visibleBox, scrollToFraction
  };

})(window.RP);
