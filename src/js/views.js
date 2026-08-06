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

  RP.views = {
    MODES, LABELS, HINTS, SPREAD_GAP, COLUMN_PAD,
    normalize, isPaged, spreadOf, rowsFor, rowOfPage, rowStartOf,
    inkBoxOf, fitScale
  };

})(window.RP);
