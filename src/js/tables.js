/* Finding ruled tables on a page and reading them out as cells.
 *
 * Schedules on a drawing are always *drawn* — a panel schedule, a part list, a
 * revision block and a door schedule all carry real vector rules — so the grid
 * is read out of the linework rather than guessed at from where the words
 * happen to line up. Guessing from the words alone cannot tell a schedule from
 * the callout balloons scattered over an isometric: those sit in tidy rows and
 * columns too, and they come out as a table full of single letters.
 *
 * **What is not obvious until this is pointed at a real drawing: a dimension
 * string is a horizontal rule crossed by two extension lines, so it passes
 * every geometric test a table passes.** Sheet 2 of the reference drawing
 * yields a dozen candidates of eighty columns, every one of them a dimension
 * chain. What separates the two is not the geometry but how full the grid is —
 * a real schedule fills about 90% of its cells and a dimension chain about 3%,
 * an order of magnitude apart rather than a close call — so the rules only ever
 * propose a candidate and `scoreOf` decides. Drop that check and the feature
 * looks like it works right up until a sheet with dimensions on it, which is
 * most of them.
 *
 * All geometry is in PDF user space, and everything except `scan` is pure so
 * `test/verify.js` can drive the whole pipeline without pdf.js or a DOM.
 */
(function (RP) {
  'use strict';

  /* A rule this close to the page's own width or height is a border or a clip
     rectangle. It overlaps every other rule on the sheet, so left in it fuses
     the whole page into one grid of ninety columns — which is exactly what the
     first version of this did. */
  var BORDER_FRACTION = 0.9;

  /* How much of *each* of two rules must overlap for them to be rows of one
     table. Mutuality is the trick: a border overlaps a table rule completely,
     but the table rule is 2% of the border, so the pair fails. */
  var ROW_OVERLAP = 0.75;

  /* How much of a vertical must sit inside the table's band to count as a
     column separator. Well under 1, so a rule ruled only against the header row
     still counts — plenty of schedules rule the header and leave the body
     columns open, and requiring a full crossing merged four columns of the
     reference part list into one. */
  var COLUMN_INSIDE = 0.6;

  /* Below this fraction of filled cells a candidate is linework, not a table.
     The two populations are far apart — about 0.9 against about 0.03 — so the
     value is not delicate; it is set to admit a sparse sign-off block waiting
     for initials. */
  var MIN_DENSITY = 0.3;

  /* A header cell is a label. Past this it is prose, and the candidate is
     something else that happens to be ruled — a drawing note, a legend. */
  var MAX_HEADER_CHARS = 28;

  var Tables = {

    /**
     * Candidate grids on a page.
     *
     * Seeded from the *horizontal* rules, because every row of a table spans
     * the same x-extent and that is a far stronger signal than columns sharing
     * a y-extent — a drawing carries a great deal of tall linework and very
     * little that repeats the same horizontal run four times over. Pure.
     */
    gridsOf: function (rules, page) {
      var A = RP.analyse;
      var grids = [];
      if (!rules || !page) return grids;

      /* Measured by the longest single span, never by the extent. Rules merge
         into a lane by position alone, so a separator that shares its x with a
         leader line elsewhere on the sheet has an extent of most of the page
         and a true length of sixty points. Judging it by the extent is what
         merged four columns of the reference part list into one. */
      var vs = (rules.v || []).filter(function (r) {
        var len = A.longestSpan(r);
        return len > 3 && len < page.height * BORDER_FRACTION;
      });
      var hs = (rules.h || []).filter(function (r) {
        var len = A.longestSpan(r);
        return len > 8 && len < page.width * BORDER_FRACTION;
      });

      var used = [];
      var seeds = hs.slice().sort(function (a, b) { return A.longestSpan(b) - A.longestSpan(a); });

      for (var s = 0; s < seeds.length; s++) {
        var seed = seeds[s];
        if (used.indexOf(seed) >= 0) continue;

        var rows = Tables.trimRows(hs.filter(function (o) {
          return used.indexOf(o) < 0 && A.spansAgree(seed, o, ROW_OVERLAP);
        }).sort(function (a, b) { return b.at - a.at; }), seed);
        if (rows.length < 2) continue;

        var band = Tables.seedSpan(seed, rows);
        var x0 = band[0];
        var x1 = band[1];
        var y1 = rows[0].at;
        var y0 = rows[rows.length - 1].at;
        if (y1 - y0 < 4) continue;

        var cols = vs.filter(function (v) {
          return v.at >= x0 - 3 && v.at <= x1 + 3 &&
                 A.spanInside(v, y0, y1, COLUMN_INSIDE);
        });

        /* The outer edges come from the *rows*, which already say where the
           table starts and stops, rather than from finding a rule there. A
           schedule tucked against the title block shares its right edge with
           that block's border, and the border test — rightly — throws that rule
           out for being nearly the height of the sheet; without this the last
           column of the reference part list, the quantities, went with it. */
        var xs = Tables.positionsOf(cols.map(function (c) { return c.at; }).concat([x0, x1]));
        if (xs.length < 3) continue;

        for (var r = 0; r < rows.length; r++) used.push(rows[r]);
        grids.push({
          cols: xs,
          rows: rows.map(function (o) { return o.at; }),
          x0: x0, x1: x1, y0: y0, y1: y1,
          claim: rows
        });
      }
      return grids;
    },

    /**
     * Rows of one table, spaced like rows of one table.
     *
     * Row rules are gathered by their x-extent alone, and on a drawing that is
     * not quite enough: a dimension string beneath a schedule, drawn to nearly
     * the same width, agrees with every row of it and joins the grid as one
     * more row — bringing its own figure in as a cell. Rows of a real table are
     * evenly spaced, so a gap far larger than the rest is the edge of the
     * table rather than a row of it. Trimmed from the ends only, and never
     * across the seed, so a table is never cut in half. Pure.
     */
    trimRows: function (rows, seed) {
      if (rows.length < 3) return rows;
      var gaps = [];
      for (var i = 1; i < rows.length; i++) gaps.push(rows[i - 1].at - rows[i].at);
      var sorted = gaps.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)] || 0;
      if (median <= 0) return rows;
      var limit = median * 3;

      var lo = 0;
      var hi = rows.length - 1;
      var pin = rows.indexOf(seed);
      if (pin < 0) pin = 0;
      /* Trimming stops *at* the seed, not one short of it: the seed is only
         guaranteed to be a row of this table, not to be an interior one, and
         requiring a row to spare on each side means a stray rule adjacent to
         the seed can never be trimmed — which is the common case, since the
         seed is whichever row rule happens to be longest. */
      while (hi > pin && rows[hi - 1].at - rows[hi].at > limit) hi -= 1;
      while (lo < pin && rows[lo].at - rows[lo + 1].at > limit) lo += 1;
      return rows.slice(lo, hi + 1);
    },

    /**
     * The x-extent the seed shares with its rows — its longest span, not its
     * whole extent, for the same reason the lengths are measured that way. Pure.
     */
    seedSpan: function (seed, rows) {
      var best = null;
      for (var i = 0; i < seed.spans.length; i++) {
        var s = seed.spans[i];
        if (!best || (s[1] - s[0]) > (best[1] - best[0])) best = s;
      }
      return best || [0, 0];
    },

    /** Near-identical positions collapsed to one, ascending. Pure. */
    positionsOf: function (values, tolerance) {
      var tol = tolerance === undefined ? 2 : tolerance;
      var sorted = values.slice().sort(function (a, b) { return a - b; });
      var out = [];
      for (var i = 0; i < sorted.length; i++) {
        if (!out.length || sorted[i] - out[out.length - 1] > tol) out.push(sorted[i]);
      }
      return out;
    },

    /**
     * A grid filled in from the page's runs.
     *
     * A run is placed by the *centre* of its box, the same rule an area text
     * selection uses: overlap would drag a long description into the column
     * next door whose separator it happens to cross, and containment would drop
     * a value whose descender pokes below its row rule. Only runs reading along
     * the page's own axis are considered. Pure.
     */
    cellsOf: function (grid, runs) {
      var A = RP.analyse;
      var table = [];
      var inside = [];

      for (var i = 0; i < runs.length; i++) {
        var item = runs[i];
        if (!item.str || !item.str.trim()) continue;
        if (A.headingOf(item) !== 0) continue;
        var box = A.boxOf(item);
        var cx = box.x + box.w / 2;
        var cy = box.y + box.h / 2;
        if (cx < grid.x0 - 2 || cx > grid.x1 + 2) continue;
        if (cy < grid.y0 - 3 || cy > grid.y1 + 3) continue;
        inside.push({ str: item.str.trim(), cx: cx, cy: cy });
      }

      for (var r = 0; r < grid.rows.length - 1; r++) {
        var top = grid.rows[r];
        var bottom = grid.rows[r + 1];
        var line = [];
        var any = false;
        for (var c = 0; c < grid.cols.length - 1; c++) {
          var left = grid.cols[c];
          var right = grid.cols[c + 1];
          var words = inside.filter(function (t) {
            return t.cy < top && t.cy >= bottom && t.cx >= left && t.cx <= right;
          }).sort(function (a, b) { return (b.cy - a.cy) || (a.cx - b.cx); });
          var cell = words.map(function (t) { return t.str; }).join(' ');
          if (cell) any = true;
          line.push(cell);
        }
        if (any) table.push(line);
      }
      return table;
    },

    /**
     * How much this candidate looks like a table rather than linework.
     *
     * Two independent questions: is the grid full enough to be holding data,
     * and does it have a row of labels at the top. Linework fails the first and
     * a ruled block of drawing notes fails the second. Pure.
     */
    scoreOf: function (table, columns) {
      if (!table.length || columns < 1) return { density: 0, header: false, ok: false };
      var cells = table.length * columns;
      var filled = 0;
      for (var i = 0; i < table.length; i++) {
        for (var j = 0; j < table[i].length; j++) if (table[i][j]) filled += 1;
      }
      var density = filled / cells;

      var header = null;
      for (var r = 0; r < table.length && !header; r++) {
        var present = table[r].filter(function (c) { return !!c; });
        if (present.length >= Math.max(2, columns * 0.5)) header = present;
      }
      var headerish = !!header && header.every(function (c) { return c.length <= MAX_HEADER_CHARS; });

      /* Both tests, always. Density alone admits a ruled block of drawing notes
         — two rows of prose in a bordered box scores 0.5 — and a heading row is
         the thing that actually distinguishes a schedule from any other ruled
         rectangle on a sheet. Density alone was the first version and the notes
         block is what it let through. */
      return {
        density: density,
        header: headerish,
        ok: density >= MIN_DENSITY && headerish
      };
    },

    /**
     * Every table on one page.
     *
     * A rejected candidate does not consume its rules, so a real table sharing
     * a row rule with a rejected dimension chain is still found. Pure — this is
     * the whole pipeline, and `test/verify.js` drives it with synthetic rules
     * rather than a PDF.
     */
    findOnPage: function (rules, runs, page) {
      var grids = Tables.gridsOf(rules, page);
      var found = [];
      var consumed = [];

      for (var g = 0; g < grids.length; g++) {
        var grid = grids[g];
        var clash = grid.claim.some(function (rule) { return consumed.indexOf(rule) >= 0; });
        if (clash) continue;

        var cells = Tables.cellsOf(grid, runs);
        if (cells.length < 2) continue;

        var score = Tables.scoreOf(cells, grid.cols.length - 1);
        if (!score.ok) continue;

        for (var c = 0; c < grid.claim.length; c++) consumed.push(grid.claim[c]);
        found.push({
          cells: cells,
          rows: cells.length,
          columns: grid.cols.length - 1,
          bbox: { x: grid.x0, y: grid.y0, w: grid.x1 - grid.x0, h: grid.y1 - grid.y0 },
          score: score
        });
      }
      return found;
    },

    /**
     * A caption sitting just above the table, if there is one.
     *
     * A schedule's title is almost never *inside* its grid — "PART LIST
     * (SUBMITTAL)" sits four points above the top rule, outside every cell —
     * so the grid alone can only ever name a table by its headings, which is
     * how the reference part list came out as "Sheet 4 P&ID TAG ITEM #". This
     * looks in the strip immediately above, within the table's own width, and
     * takes the lowest line of it. Pure.
     */
    captionOf: function (table, runs) {
      var A = RP.analyse;
      var box = table.bbox;
      var top = box.y + box.h;
      var best = null;

      for (var i = 0; i < runs.length; i++) {
        var item = runs[i];
        if (!item.str || !item.str.trim()) continue;
        if (A.headingOf(item) !== 0) continue;
        var r = A.boxOf(item);
        var cy = r.y + r.h / 2;
        var cx = r.x + r.w / 2;
        /* Within about a line and a half above the top rule: close enough to
           belong to the table, not so far as to pick up the drawing note above
           it. Scaled by the caption's own height so it holds at any plot size. */
        if (cy <= top || cy > top + r.h * 2.5) continue;
        if (cx < box.x - 2 || cx > box.x + box.w + 2) continue;
        if (!best || cy < best.cy) best = { cy: cy, str: item.str.trim() };
      }
      return best ? best.str : '';
    },

    /**
     * A name for a table, for the worksheet tab and the list.
     *
     * In preference order: a title row inside the grid, its caption, then its
     * headings. The in-grid row comes first because it is unambiguous — a lone
     * value on the top row of a ruled grid is that table's title and nothing
     * else — whereas a caption is only the nearest run above and can just as
     * easily be the tail of whatever sits over the table. Falls back to the
     * sheet rather than to "Table 3", which tells nobody anything. Pure.
     */
    nameOf: function (table, pageIndex, runs) {
      var first = table.cells[0] || [];
      var alone = first.filter(function (c) { return !!c; });
      if (alone.length === 1 && alone[0].length <= 40) return alone[0];

      var caption = runs ? Tables.captionOf(table, runs) : '';
      if (caption && caption.length <= 40) return caption;

      var header = null;
      for (var r = 0; r < table.cells.length && !header; r++) {
        var present = table.cells[r].filter(function (c) { return !!c; });
        if (present.length >= table.columns * 0.5) header = present;
      }
      if (header) {
        var joined = header.slice(0, 2).join(' ');
        if (joined && joined.length <= 34) return 'Sheet ' + (pageIndex + 1) + ' ' + joined;
      }
      return 'Sheet ' + (pageIndex + 1);
    },

    /**
     * Scan the open document. Not pure — walks the viewer's page records.
     *
     * Yields to the frame every few pages for the reason `buildIndex` does:
     * this is a full operator-list walk per page and a 77-sheet set would
     * otherwise lock the window for the length of it.
     */
    scan: async function (onProgress) {
      var out = [];
      var records = (RP.viewer && RP.viewer.pages) || [];
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        var content = await RP.analyse.pageContent(record);
        /* The page's own box, not a viewport's. A viewport is scaled by the
           zoom and turned by `/Rotate`, and both the rules and the runs here
           are in unrotated user space — measuring the border test against a
           rotated viewport swaps width for height on every landscape sheet,
           which is most of a drawing set. */
        var view = (record.pageProxy && record.pageProxy.view) || [0, 0, 0, 0];
        var page = { width: view[2] - view[0], height: view[3] - view[1] };
        var tables = Tables.findOnPage(content.rules, content.runs.items, page);
        for (var t = 0; t < tables.length; t++) {
          tables[t].page = record.index;
          tables[t].name = Tables.nameOf(tables[t], record.index, content.runs.items);
          out.push(tables[t]);
        }
        if (onProgress) onProgress(i + 1, records.length, out.length);
        if (i % 6 === 5) await RP.nextFrame();
      }
      return out;
    }
  };

  RP.tables = Tables;
})(window.RP);
