/* Reading a page's *content* rather than its picture.
 *
 * Several features want the same two things out of a page — where the vector
 * rules are, and where the words are — and they want them in PDF user space:
 * schedule extraction needs the rules to find a grid, a sheet index needs the
 * runs inside the title block, symbol counting needs the geometry. Each of them
 * building its own extraction would mean a page walk, a cache and a chance to
 * disagree about what a rule is, three times over, so this module is the one
 * place a page gets read and the results are cached on the viewer's page record
 * beside the text content search already keeps there.
 *
 * Everything is in PDF user space, before `/Rotate`, like every other
 * coordinate in this app. Everything is pure except `rulesOf`/`runsOf`, the two
 * that touch a page proxy, so `test/verify.js` can drive the geometry without
 * pdf.js and without a DOM.
 */
(function (RP) {
  'use strict';

  /* A segment shorter than this is a tick, a hatch or an arrowhead, not a rule. */
  var MIN_SEGMENT = 2;

  /* How far off-axis a segment may be and still count as axis-aligned. At plot
     scale this is well under half a line width, so a rule drawn a hair out of
     true still reads as one and a leader line at 2 degrees does not. */
  var AXIS_TOLERANCE = 0.8;

  /* Coordinates in the path stream, per command code. These are pdf.js's own
     path opcodes, which are *not* the OPS constants — they are a private enum
     inside the constructPath argument. Their meaning has been stable across
     v3..v6 even as the argument shape around them changed. */
  var COORDS = { 0: 2, 1: 2, 2: 6, 3: 6, 4: 0 };

  var Analyse = {

    /** `m` then `n`, in PDF's row-vector order. Pure. */
    concat: function (m, n) {
      return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5]
      ];
    },

    /** A point through a matrix. Pure. */
    applyMatrix: function (m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    },

    /** Array or typed array of numbers. Pure. */
    isNumeric: function (v) {
      return Array.isArray(v) || ArrayBuffer.isView(v);
    },

    /**
     * The path payload of one `constructPath` op, as a flat number array.
     *
     * **The argument shape is not stable across pdf.js majors and a wrong guess
     * fails silently** — it yields no segments rather than an error, so the
     * schedule finder simply stops finding schedules after a version bump and
     * nothing says why. v6 hands over `[op, [path], bbox]` where `path` is a
     * typed-array-like of command codes interleaved with their coordinates; v3
     * handed over `[ops, coords]` as two parallel arrays. Both are accepted and
     * normalised to the interleaved form, and `test/verify.js` drives both
     * shapes so a future bump fails in the suite rather than quietly in the app.
     * Same reasoning as `pdfjs-loader.js` refusing to assume a flavour. Pure.
     */
    pathData: function (args) {
      if (!args || !args.length) return null;

      // v3/v4: parallel arrays — a command list and a separate coordinate list.
      if (Array.isArray(args[0]) && args.length > 1 && Analyse.isNumeric(args[1])) {
        var out = [];
        var coords = args[1];
        var k = 0;
        for (var i = 0; i < args[0].length; i++) {
          var cmd = args[0][i];
          var take = COORDS[cmd];
          if (take === undefined) return null;
          out.push(cmd);
          for (var c = 0; c < take; c++) out.push(coords[k++]);
        }
        return out;
      }

      // v6: one interleaved list, wrapped in an array.
      var body = Array.isArray(args[1]) ? args[1][0] : args[1];
      if (!body) return null;
      if (Analyse.isNumeric(body)) return body;
      // An object with numeric keys — what a structured clone of one leaves.
      var keys = Object.keys(body);
      if (!keys.length) return null;
      var flat = new Array(keys.length);
      for (var j = 0; j < keys.length; j++) flat[j] = body[j];
      return flat;
    },

    /**
     * Axis-aligned segments from an operator list, in user space.
     *
     * Only `lineTo` and the closing leg produce rules. A curve is never a table
     * rule, and taking its endpoints would turn every arc crossing a schedule
     * into a spurious row. Pure — `test/verify.js` hands it a synthetic list.
     */
    rulesFromOps: function (opList, OPS) {
      var h = [];
      var v = [];
      if (!opList || !opList.fnArray || !OPS) return { h: h, v: v };

      var ctm = [1, 0, 0, 1, 0, 0];
      var stack = [];

      function segment(ax, ay, bx, by) {
        if (Math.abs(ay - by) <= AXIS_TOLERANCE && Math.abs(ax - bx) > MIN_SEGMENT) {
          h.push({ at: (ay + by) / 2, a: Math.min(ax, bx), b: Math.max(ax, bx) });
        } else if (Math.abs(ax - bx) <= AXIS_TOLERANCE && Math.abs(ay - by) > MIN_SEGMENT) {
          v.push({ at: (ax + bx) / 2, a: Math.min(ay, by), b: Math.max(ay, by) });
        }
      }

      for (var i = 0; i < opList.fnArray.length; i++) {
        var fn = opList.fnArray[i];
        var args = opList.argsArray[i];

        if (fn === OPS.save) {
          stack.push(ctm.slice());
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || ctm;
        } else if (fn === OPS.transform && args && args.length >= 6) {
          ctm = Analyse.concat(ctm, args);
        } else if (fn === OPS.constructPath) {
          var path = Analyse.pathData(args);
          if (!path) continue;
          var k = 0;
          var sx = 0, sy = 0, cx = 0, cy = 0;
          while (k < path.length) {
            var cmd = path[k++];
            var take = COORDS[cmd];
            if (take === undefined) break;
            if (cmd === 0) {
              cx = path[k]; cy = path[k + 1];
              sx = cx; sy = cy;
            } else if (cmd === 4) {
              var c0 = Analyse.applyMatrix(ctm, cx, cy);
              var c1 = Analyse.applyMatrix(ctm, sx, sy);
              segment(c0[0], c0[1], c1[0], c1[1]);
              cx = sx; cy = sy;
            } else {
              var nx = path[k + take - 2];
              var ny = path[k + take - 1];
              if (cmd === 1) {
                var p0 = Analyse.applyMatrix(ctm, cx, cy);
                var p1 = Analyse.applyMatrix(ctm, nx, ny);
                segment(p0[0], p0[1], p1[0], p1[1]);
              }
              cx = nx; cy = ny;
            }
            k += take;
          }
        }
      }
      return { h: h, v: v };
    },

    /**
     * Collinear segments collapsed into one rule carrying its covered spans.
     *
     * A ruled grid is almost never drawn as one line per row: CAD emits a
     * rectangle per cell, so a column separator arrives as a dozen stacked
     * segments and a row rule as a dozen side by side. Without this every table
     * looks like a field of short dashes and no grid is ever found. The spans
     * stay a *list* rather than one min-to-max extent, because a genuine break
     * in a rule is the difference between a separator running the height of a
     * table and two unrelated ticks that happen to line up. Pure.
     */
    mergeRules: function (list, tolerance, gap) {
      var tol = tolerance === undefined ? 1.5 : tolerance;
      var join = gap === undefined ? 4 : gap;
      var sorted = list.slice().sort(function (p, q) { return p.at - q.at; });
      var lanes = [];

      for (var i = 0; i < sorted.length; i++) {
        var seg = sorted[i];
        var lane = lanes[lanes.length - 1];
        if (lane && Math.abs(lane.at - seg.at) <= tol) {
          lane.spans.push([seg.a, seg.b]);
          lane.at = (lane.at * lane.n + seg.at) / (lane.n + 1);
          lane.n += 1;
        } else {
          lanes.push({ at: seg.at, n: 1, spans: [[seg.a, seg.b]] });
        }
      }

      for (var j = 0; j < lanes.length; j++) {
        var spans = lanes[j].spans.sort(function (p, q) { return p[0] - q[0]; });
        var merged = [];
        for (var s = 0; s < spans.length; s++) {
          var last = merged[merged.length - 1];
          if (last && spans[s][0] <= last[1] + join) {
            last[1] = Math.max(last[1], spans[s][1]);
          } else {
            merged.push([spans[s][0], spans[s][1]]);
          }
        }
        lanes[j].spans = merged;
      }
      return lanes;
    },

    /** Outer extent of a merged rule, ignoring its internal breaks. Pure. */
    extentOf: function (rule) {
      var lo = Infinity;
      var hi = -Infinity;
      for (var i = 0; i < rule.spans.length; i++) {
        lo = Math.min(lo, rule.spans[i][0]);
        hi = Math.max(hi, rule.spans[i][1]);
      }
      return [lo, hi];
    },

    /** Length of that extent. Pure. */
    lengthOf: function (rule) {
      var e = Analyse.extentOf(rule);
      return e[1] - e[0];
    },

    /**
     * The longest single unbroken span of a rule. Pure.
     *
     * This, not `lengthOf`, is what says how long a rule really is. Two rules
     * at the same x merge into one lane whichever parts of the page they are
     * on, so a table separator 62 points tall that shares its x with a leader
     * line 900 points away reports an *extent* of nearly a thousand — and every
     * test phrased against that extent then judges the separator by linework it
     * has nothing to do with.
     */
    longestSpan: function (rule) {
      var best = 0;
      for (var i = 0; i < rule.spans.length; i++) {
        best = Math.max(best, rule.spans[i][1] - rule.spans[i][0]);
      }
      return best;
    },

    /**
     * True when some one span of `rule` lies mostly inside [a,b]. Pure.
     *
     * Asked of a span rather than of the whole rule for the reason above: the
     * question is whether this rule has a *piece* that belongs to this band,
     * not whether the rule as a whole does.
     */
    spanInside: function (rule, a, b, fraction) {
      var frac = fraction === undefined ? 0.6 : fraction;
      for (var i = 0; i < rule.spans.length; i++) {
        var s = rule.spans[i];
        var overlap = Math.min(s[1], b) - Math.max(s[0], a);
        if (overlap > 0 && overlap >= frac * (s[1] - s[0])) return true;
      }
      return false;
    },

    /**
     * True when two rules each have a span mostly overlapping the other's. Pure.
     *
     * The mutual form is what keeps a page border out of a table: the border
     * overlaps a row rule completely, but the row rule is 2% of it, so the pair
     * fails from the border's side.
     */
    spansAgree: function (a, b, fraction) {
      var frac = fraction === undefined ? 0.75 : fraction;
      for (var i = 0; i < a.spans.length; i++) {
        for (var j = 0; j < b.spans.length; j++) {
          var p = a.spans[i];
          var q = b.spans[j];
          var overlap = Math.min(p[1], q[1]) - Math.max(p[0], q[0]);
          if (overlap > 0 &&
              overlap >= frac * (p[1] - p[0]) &&
              overlap >= frac * (q[1] - q[0])) return true;
        }
      }
      return false;
    },

    /** True when one unbroken span of `rule` covers [a,b]. Pure. */
    covers: function (rule, a, b, slack) {
      var give = slack === undefined ? 3 : slack;
      for (var i = 0; i < rule.spans.length; i++) {
        if (rule.spans[i][0] <= a + give && rule.spans[i][1] >= b - give) return true;
      }
      return false;
    },

    /**
     * Reading direction of a run in degrees, before `/Rotate`.
     *
     * The same quantity `RP.pages.orientationOf` calls the heading, and it is
     * here because a table reader has to drop runs not laid along the table's
     * own axis: a sheet name set vertically down the right edge would otherwise
     * land in whichever row band its baseline happens to cross. Pure.
     */
    headingOf: function (item) {
      var t = (item && item.t) || [1, 0, 0, 1, 0, 0];
      return (Math.round(Math.atan2(t[1], t[0]) * 180 / Math.PI) + 360) % 360;
    },

    /**
     * Axis-aligned box of a run in user space.
     *
     * The run's own rectangle is baseline-start, `w` along the reading
     * direction and `h` perpendicular to it; this is the upright box around
     * those four corners, so a sideways run gets a tall narrow box rather than
     * a flat one lying on its baseline. Same construction as
     * `RP.search.rectFor`, over the whole run instead of a slice. Pure.
     */
    boxOf: function (item) {
      var t = item.t || [1, 0, 0, 1, 0, 0];
      var len = Math.hypot(t[0], t[1]) || 1;
      var w = item.w || 0;
      var h = item.h || Math.hypot(t[2], t[3]) || len || 10;
      var dx = t[0] / len;
      var dy = t[1] / len;
      var ux = -dy * h;
      var uy = dx * h;
      var xs = [t[4], t[4] + dx * w, t[4] + ux, t[4] + dx * w + ux];
      var ys = [t[5], t[5] + dy * w, t[5] + uy, t[5] + dy * w + uy];
      return RP.geom.normRect(
        Math.min.apply(null, xs), Math.min.apply(null, ys),
        Math.max.apply(null, xs), Math.max.apply(null, ys)
      );
    },

    /**
     * The page's merged rules, cached on the viewer's page record.
     *
     * `getOperatorList` is a full trip through the one pdf.js worker and on a
     * plotted sheet the list runs to tens of thousands of ops — 42,000 on the
     * reference drawing — so this is emphatically a once-per-page cost and the
     * cache is not optional. It lives on the record beside `textContent` for
     * the reason search puts it there: the record is torn down with the page
     * DOM on a tab switch, which is exactly when the cache should go.
     */
    rulesOf: async function (record) {
      if (!record) return { h: [], v: [] };
      if (record.vectorRules) return record.vectorRules;
      var OPS = RP.pdfjs && RP.pdfjs.lib && RP.pdfjs.lib.OPS;
      if (!OPS || !record.pageProxy) return { h: [], v: [] };
      var raw;
      try {
        raw = await record.pageProxy.getOperatorList();
      } catch (err) {
        record.vectorRules = { h: [], v: [] };
        return record.vectorRules;
      }
      var found = Analyse.rulesFromOps(raw, OPS);
      record.vectorRules = {
        h: Analyse.mergeRules(found.h),
        v: Analyse.mergeRules(found.v)
      };
      return record.vectorRules;
    },

    /**
     * The page's text runs, reusing whatever search has already cached.
     *
     * `RP.search.pageEntry` is the one place run joining and offsets are
     * decided, and a second implementation here would be a second answer to
     * "where does this word start" — the bug that put highlights on the wrong
     * run before 0.17. So this borrows it rather than repeating it.
     */
    runsOf: async function (record) {
      if (!record) return { page: 0, text: '', items: [] };
      if (!record.textContent) {
        try {
          record.textContent = await record.pageProxy.getTextContent();
        } catch (err) {
          record.textContent = { items: [] };
        }
      }
      return RP.search.pageEntry(record.index, record.textContent);
    },

    /** Everything one page has to say, for a caller that wants both. */
    pageContent: async function (record) {
      var rules = await Analyse.rulesOf(record);
      var runs = await Analyse.runsOf(record);
      return { index: record.index, rules: rules, runs: runs };
    }
  };

  RP.analyse = Analyse;
})(window.RP);
