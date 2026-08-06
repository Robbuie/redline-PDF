/* Canvas drawing + hit-testing for every markup type.
   All annotation geometry lives in PDF user space; `viewport` (from pdf.js)
   converts to CSS pixels, which keeps markups correct at any zoom or rotation. */
'use strict';

(function (RP) {

  const HANDLE = 7;          // handle square size in CSS px
  const NOTE_SIZE = 22;      // sticky note icon size in CSS px

  function vp(viewport, x, y) {
    const p = viewport.convertToViewportPoint(x, y);
    return [p[0], p[1]];
  }

  /** Convert a PDF-space rect to a viewport-space rect (rotation aware). */
  function vpRect(viewport, rect) {
    const corners = [
      vp(viewport, rect.x, rect.y),
      vp(viewport, rect.x + rect.w, rect.y),
      vp(viewport, rect.x + rect.w, rect.y + rect.h),
      vp(viewport, rect.x, rect.y + rect.h)
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x0 = Math.min.apply(null, xs);
    const y0 = Math.min.apply(null, ys);
    return { x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 };
  }

  // -------------------------------------------------------------------------
  // Bounding boxes (PDF space)
  // -------------------------------------------------------------------------

  function bbox(annot) {
    switch (annot.type) {
      // The three rects-based markups share a shape: one rectangle per run of
      // words, in PDF space. Only the paint differs.
      case 'highlight':
      case 'strikeout':
      case 'underline':
        return RP.geom.unionRect(annot.rects || []) || { x: 0, y: 0, w: 0, h: 0 };
      // Everything built from a vertex list shares a bounding box. The label a
      // measured one carries is deliberately *not* in it: the box is what the
      // marquee, the selection chrome and the rejected rule use, and growing
      // it to cover a plate that is a fixed size on screen would make all
      // three change shape with the zoom.
      case 'pen':
      case 'polyline':
      case 'polylength':
      case 'area': {
        const pts = annot.points || [];
        if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) {
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      case 'line':
      case 'arrow':
      case 'measure':
        return RP.geom.normRect(annot.x1, annot.y1, annot.x2, annot.y2);
      case 'note':
        return { x: annot.x, y: annot.y - 16, w: 16, h: 16 };
      case 'text': {
        const size = annot.fontSize || 12;
        const lines = String(annot.text || ' ').split('\n');
        const width = annot.width || Math.max.apply(null, lines.map((l) => l.length * size * 0.5).concat([40]));
        const height = lines.length * size * 1.25;
        return { x: annot.x, y: annot.y - height, w: width, h: height };
      }
      case 'callout': {
        const box = { x: annot.x, y: annot.y, w: annot.w, h: annot.h };
        return RP.geom.unionRect([box, { x: annot.tipX, y: annot.tipY, w: 0.1, h: 0.1 }]);
      }
      default:
        return { x: annot.x || 0, y: annot.y || 0, w: annot.w || 0, h: annot.h || 0 };
    }
  }

  /**
   * How thick the rule of a strikeout or underline should be, in PDF points,
   * for a run of words `rect` tall.
   *
   * Derived from the run rather than from `annot.width` so the line stays in
   * proportion to whatever it crosses: an E-size sheet carries 3pt schedule
   * text and 24pt titles on the same page, and a fixed 2pt rule either
   * obliterates the first or looks like a hairline under the second. The
   * exporter calls this too — the rule on paper has to be the rule on screen.
   */
  function ruleWeight(rect) {
    return Math.max(0.5, (rect && rect.h ? rect.h : 8) * 0.09);
  }

  // -------------------------------------------------------------------------
  // Polyline, run length and area
  //
  // Three markups, one vertex list. `polyline` is the plain shape, `polylength`
  // labels the run, `area` closes it and labels the enclosure. Everything below
  // works in PDF user space and is shared with `exporter.js`, because a takeoff
  // that reads one number on screen and another on the printout is worse than
  // one that reads nothing at all.
  // -------------------------------------------------------------------------

  const POLY_TYPES = ['polyline', 'polylength', 'area'];

  /** Is this markup built from `annot.points`, with straight segments? */
  function isPoly(type) { return POLY_TYPES.indexOf(type) >= 0; }

  /** Only `area` closes its outline back to the first vertex. */
  function isClosedPoly(type) { return type === 'area'; }

  /** The two that carry a reading. `polyline` is a drawing tool, not a ruler. */
  function isMeasuredPoly(type) { return type === 'polylength' || type === 'area'; }

  /* A segment shorter than this gets no label of its own. Two plates on top of
     each other are less readable than one, and the total still accounts for the
     length. In *points*, not pixels, so the canvas and the stamp drop the same
     segments — a threshold in screen pixels would label a run differently at
     every zoom and differently again on paper. */
  const SEGMENT_LABEL_MIN = 26;

  /**
   * The area a closed markup encloses, in square points, or `null` when the
   * outline crosses itself.
   *
   * A bow-tie has no area anybody would agree on: the shoelace sum returns the
   * *difference* of the two lobes, which is a plausible-looking number and
   * therefore the dangerous answer — a figure on a drawing gets believed and
   * ordered against. So this reports that it cannot say, and the label says so
   * too. The perimeter is still well defined and is still shown.
   */
  function polyArea(annot) {
    const pts = annot.points || [];
    if (pts.length < 3) return null;
    if (RP.geom.selfIntersects(pts, true)) return null;
    return RP.geom.polygonArea(pts);
  }

  /**
   * What a measured markup *reports*, as one or more lines — the total for a
   * run, the area and perimeter for an enclosure.
   *
   * One builder, because the sheet, the markup list, the properties dialog,
   * the CSV and the PDF report all quote this and a punch list that disagrees
   * with the drawing it was taken off is worse than no punch list. Returns an
   * empty list for anything that is not a measurement, `polyline` included —
   * it is a drawing tool, not a ruler.
   */
  function readingLines(annot, store) {
    const target = store || RP.store;
    if (annot.type === 'measure') {
      return [annot.label ||
        target.formatLength(RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2))];
    }
    const pts = annot.points || [];
    if (annot.type === 'polylength') {
      if (pts.length < 2) return [];
      return ['Total ' + target.formatLength(RP.geom.polylineLength(pts))];
    }
    if (annot.type === 'area') {
      if (pts.length < 3) return [];
      const area = polyArea(annot);
      const perimeter = 'Perimeter ' + target.formatLength(RP.geom.polygonPerimeter(pts));
      return area === null
        ? ['Outline crosses itself — no area', perimeter]
        : [target.formatArea(area), perimeter];
    }
    return [];
  }

  /** The same reading on one line, for a list row or a spreadsheet cell. */
  function readingOf(annot, store) {
    return readingLines(annot, store).join(' · ');
  }

  /**
   * Every label a measured poly carries, anchored in PDF space.
   *
   * `dy` is an offset *down the screen* from the anchor, applied by each
   * renderer in its own units — CSS pixels on the canvas, points in the stamp —
   * because the plate is a fixed size in each medium and cannot be the same
   * size in both. Anchors, text and which segments get a plate at all are
   * decided here once, so the canvas and `exporter.js` cannot drift.
   */
  function measureLabels(annot, store) {
    const target = store || RP.store;
    const pts = annot.points || [];
    const out = [];
    if (!isMeasuredPoly(annot.type) || pts.length < 2) return out;

    if (annot.type === 'polylength') {
      for (let i = 1; i < pts.length; i += 1) {
        const len = RP.geom.dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        if (len < SEGMENT_LABEL_MIN) continue;
        out.push({
          kind: 'segment',
          at: [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2],
          lines: [target.formatLength(len)],
          dy: -13
        });
      }
      // On a single-segment run the total *is* the segment, and two plates
      // saying the same thing on top of each other is noise.
      if (pts.length > 2) {
        out.push({ kind: 'total', at: pts[pts.length - 1], lines: readingLines(annot, target), dy: 15 });
      }
      return out;
    }

    const lines = readingLines(annot, target);
    if (lines.length) {
      out.push({ kind: 'total', at: RP.geom.polygonCentroid(pts), lines, dy: 0 });
    }
    return out;
  }

  /** The callout box on its own — the tip is anchored separately. */
  function calloutBox(annot) {
    return { x: annot.x, y: annot.y, w: annot.w, h: annot.h };
  }

  /**
   * Where the leader leaves the box: the midpoint of whichever edge faces the
   * tip. Computed in PDF space so drawing and hit-testing always agree.
   */
  function calloutAnchor(annot) {
    const box = calloutBox(annot);
    const candidates = [
      [box.x, box.y + box.h / 2],
      [box.x + box.w, box.y + box.h / 2],
      [box.x + box.w / 2, box.y],
      [box.x + box.w / 2, box.y + box.h]
    ];
    let best = candidates[0];
    let bestDist = Infinity;
    for (const point of candidates) {
      const d = Math.hypot(point[0] - annot.tipX, point[1] - annot.tipY);
      if (d < bestDist) { bestDist = d; best = point; }
    }
    return best;
  }

  /** Which part of a callout is under the cursor: 'box', 'leader' or null. */
  function calloutPart(annot, x, y, tol) {
    const t = tol || 4;
    if (RP.geom.rectContains(calloutBox(annot), x, y, t)) return 'box';
    const anchor = calloutAnchor(annot);
    const near = RP.geom.distToSegment(x, y, anchor[0], anchor[1], annot.tipX, annot.tipY);
    return near <= t + (annot.width || 2) / 2 ? 'leader' : null;
  }

  /** The rect the selection chrome should wrap — the box for callouts. */
  function selectionRect(annot) {
    return annot.type === 'callout' ? calloutBox(annot) : bbox(annot);
  }

  // -------------------------------------------------------------------------
  // Review status
  //
  // A resolved markup has to stay legible as a markup — a punch list is read
  // against the drawing, and an item you cannot find is worse than one you
  // cannot tell the state of. So status *dims*, it never hides: a closed or
  // rejected markup drops to STATUS_FADE of its own opacity, and a rejected
  // one additionally gets a rule through its bounding box so the two are
  // distinguishable on the sheet and not only in the list.
  //
  // Both rules live here because the canvas and `exporter.js` have to produce
  // the same picture, and that pair drifting is a recurring bug in this
  // codebase. The strike is returned as a line in *PDF space* rather than
  // drawn, so the exporter can stamp it directly and the canvas only has to
  // convert the endpoints.
  // -------------------------------------------------------------------------

  const STATUS_FADE = 0.4;

  /** The multiplier a markup's status applies to its own opacity. */
  function statusAlpha(annot) {
    return RP.statusOf(annot) === 'open' ? 1 : STATUS_FADE;
  }

  /** Whether this markup gets the rejected rule through it. */
  function statusStruck(annot) {
    return RP.statusOf(annot) === 'rejected';
  }

  /**
   * The rejected rule, in PDF space. Its weight grows with the markup so it
   * reads as a deliberate stroke over a cloud around half a sheet as well as
   * over a two-line callout, and is clamped at both ends so it never becomes a
   * hairline or a bar.
   */
  function statusStrikeLine(annot) {
    const box = selectionRect(annot);
    const y = box.y + box.h / 2;
    return {
      x1: box.x,
      y1: y,
      x2: box.x + box.w,
      y2: y,
      width: Math.max(1.5, Math.min(4, box.h * 0.03))
    };
  }

  // Callout text metrics. The inset is in *points* and is scaled at draw time;
  // measuring and drawing have to wrap at the same width or the box gets sized
  // for fewer lines than the text actually needs and the overflow lands under
  // the box instead of inside it.
  const CALLOUT_PAD = 4;
  const CALLOUT_LINE = 1.25;

  // Text-bearing markups pick a family from a fixed short list, because every
  // one of them has to survive the trip through pdf-lib's standard 14 fonts on
  // export. A free-text family box would let you choose something the exporter
  // cannot embed and the saved sheet would silently substitute.
  const FONT_STACKS = {
    sans: '"Segoe UI", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"Cascadia Mono", Consolas, "Courier New", monospace'
  };
  const DEFAULT_TEXT_COLOR = '#16181d';

  /** Canvas font shorthand for a text-bearing markup drawn at `sizePx`. */
  function fontSpec(annot, sizePx) {
    const stack = FONT_STACKS[(annot && annot.fontFamily) || 'sans'] || FONT_STACKS.sans;
    return (annot && annot.bold ? '700 ' : '') + sizePx + 'px ' + stack;
  }

  /**
   * Wrap `text` to `maxWidth`, honouring hard newlines. `measure` returns a
   * string's width in whatever units `maxWidth` is in, so the same function
   * serves the canvas (pixels) and pdf-lib (points).
   */
  function wrapLines(text, maxWidth, measure) {
    const out = [];
    for (const paragraph of String(text === undefined || text === null ? '' : text).split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (line && measure(test) > maxWidth) { out.push(line); line = word; }
        else line = test;
      }
      out.push(line);
    }
    return out;
  }

  /** Width available to text inside a callout box `widthPt` points wide. */
  function calloutTextWidth(widthPt) {
    return Math.max(20, widthPt - CALLOUT_PAD * 2);
  }

  let measureCanvas = null;
  /**
   * Height a callout needs for its text, in PDF points. `font` is anything
   * carrying `fontFamily`/`bold` — the annotation itself, normally — because a
   * bold or serif face wraps differently and the box has to be sized for the
   * face it will actually be drawn in.
   */
  function measureCalloutHeight(text, widthPt, fontSize, font) {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    const size = fontSize || 11;
    ctx.font = fontSpec(font, size);
    const lines = wrapLines(text, calloutTextWidth(widthPt), (s) => ctx.measureText(s).width);
    return Math.max(size * 2, lines.length * size * CALLOUT_LINE + CALLOUT_PAD * 2);
  }

  /**
   * The `{y, h}` a callout needs to fit its text, keeping the top edge put.
   * Anything that changes a callout's text, width, font size, family or weight
   * has to apply this, or the box stops matching what is drawn in it.
   */
  function fitCallout(annot) {
    const h = measureCalloutHeight(annot.text, annot.w, annot.fontSize || 11, annot);
    return { h, y: annot.y + annot.h - h };
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function strokeStyle(ctx, annot, viewport, fade) {
    ctx.strokeStyle = annot.color || '#ff2f2f';
    ctx.lineWidth = Math.max(0.8, (annot.width || 2) * viewport.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = (annot.opacity === undefined ? 1 : annot.opacity) * (fade === undefined ? 1 : fade);
  }

  function drawArrowHead(ctx, fromX, fromY, toX, toY, lineWidth) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const len = Math.max(9, lineWidth * 4);
    const spread = 0.42;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - len * Math.cos(angle - spread), toY - len * Math.sin(angle - spread));
    ctx.lineTo(toX - len * Math.cos(angle + spread), toY - len * Math.sin(angle + spread));
    ctx.closePath();
    ctx.fill();
  }

  /** Scalloped rectangle in the style of a revision cloud. */
  function drawCloudPath(ctx, rect, radius) {
    const r = Math.max(4, radius);
    const path = [];
    const push = (x, y) => path.push([x, y]);
    const stepsX = Math.max(1, Math.round(rect.w / (r * 1.8)));
    const stepsY = Math.max(1, Math.round(rect.h / (r * 1.8)));
    const dx = rect.w / stepsX;
    const dy = rect.h / stepsY;

    for (let i = 0; i < stepsX; i += 1) push(rect.x + i * dx + dx / 2, rect.y);
    for (let i = 0; i < stepsY; i += 1) push(rect.x + rect.w, rect.y + i * dy + dy / 2);
    for (let i = stepsX - 1; i >= 0; i -= 1) push(rect.x + i * dx + dx / 2, rect.y + rect.h);
    for (let i = stepsY - 1; i >= 0; i -= 1) push(rect.x, rect.y + i * dy + dy / 2);

    ctx.beginPath();
    const bulge = Math.max(dx, dy) * 0.62;
    for (let i = 0; i < path.length; i += 1) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const midX = (a[0] + b[0]) / 2;
      const midY = (a[1] + b[1]) / 2;
      const nx = -(b[1] - a[1]);
      const ny = (b[0] - a[0]);
      const nlen = Math.hypot(nx, ny) || 1;
      const cx = midX + (nx / nlen) * bulge * 0.5;
      const cy = midY + (ny / nlen) * bulge * 0.5;
      if (i === 0) ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(cx, cy, b[0], b[1]);
    }
    ctx.closePath();
  }

  /* `fade` is applied *after* the 0.5 floor, not before it: the floor exists so
     a deliberately faint note icon is still clickable, and a closed note is
     meant to recede. */
  function drawNoteIcon(ctx, x, y, color, opacity, fade) {
    const s = NOTE_SIZE;
    ctx.save();
    ctx.globalAlpha = (opacity === undefined ? 1 : Math.max(0.5, opacity)) * (fade === undefined ? 1 : fade);
    ctx.translate(x, y - s);
    // body
    ctx.fillStyle = color || '#ffcf3d';
    ctx.strokeStyle = 'rgba(0,0,0,.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 3;
    ctx.moveTo(r, 0);
    ctx.lineTo(s - r, 0);
    ctx.quadraticCurveTo(s, 0, s, r);
    ctx.lineTo(s, s - r - 4);
    ctx.quadraticCurveTo(s, s - 4, s - r, s - 4);
    ctx.lineTo(7, s - 4);
    ctx.lineTo(2, s + 3);
    ctx.lineTo(3.5, s - 4);
    ctx.lineTo(r, s - 4);
    ctx.quadraticCurveTo(0, s - 4, 0, s - r - 4);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // ruled lines
    ctx.strokeStyle = 'rgba(0,0,0,.34)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i += 1) {
      const ly = 5 + i * 4;
      ctx.beginPath();
      ctx.moveTo(4, ly);
      ctx.lineTo(s - 4, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* A reading on its own plate, centred on (x, y). `text` may be one string or
     several lines — an area carries its area and its perimeter, and stacking
     them keeps one plate rather than putting two on the same spot. */
  const LABEL_LINE = 13;

  function drawLabel(ctx, text, x, y, color, fade) {
    const lines = [].concat(text);
    ctx.save();
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    const padX = 5;
    const w = Math.max.apply(null, lines.map((line) => ctx.measureText(line).width)) + padX * 2;
    const h = 3 + lines.length * LABEL_LINE;
    // Normally opaque so the reading stays legible over whatever it crosses;
    // a resolved measurement recedes with the rest of its markup.
    ctx.globalAlpha = fade === undefined ? 1 : fade;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = color || '#ff2f2f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#16181d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y - h / 2 + 1.5 + LABEL_LINE * (i + 0.5) + 0.5);
    });
    ctx.restore();
  }

  /** The perpendicular end ticks a measured run is bracketed by. */
  function drawEndTick(ctx, from, to, size) {
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]) + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(to[0] - Math.cos(angle) * size, to[1] - Math.sin(angle) * size);
    ctx.lineTo(to[0] + Math.cos(angle) * size, to[1] + Math.sin(angle) * size);
    ctx.stroke();
  }

  function drawAnnotation(ctx, annot, viewport, opts) {
    const options = opts || {};
    ctx.save();

    /* Every case below sets its own alpha, and the type defaults differ — a
       highlight lands at 0.4 where a line lands at 1 — so the status fade is
       applied through this one helper rather than by overwriting
       `annot.opacity`, which would have to know each of those defaults. */
    const fade = statusAlpha(annot);
    const alpha = (fallback) => (annot.opacity === undefined ? fallback : annot.opacity) * fade;

    strokeStyle(ctx, annot, viewport, fade);
    ctx.fillStyle = annot.color || '#ff2f2f';

    switch (annot.type) {
      case 'highlight': {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = alpha(0.4);
        ctx.fillStyle = annot.color || '#ffdd00';
        for (const rect of annot.rects || []) {
          const r = vpRect(viewport, rect);
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        break;
      }

      /* Strikeout and underline carry the same `rects` as a highlight — one
         per run of words — and differ only in where the rule is drawn inside
         each one. The rule's thickness comes from the rect height rather than
         from `annot.width`, so it stays in proportion to the text it crosses:
         a 4pt schedule note and a 20pt sheet title both get a line that reads
         as a pen stroke rather than as a bar. `ruleWeight` is shared with the
         exporter so screen and paper agree. */
      case 'strikeout':
      case 'underline': {
        ctx.globalAlpha = alpha(1);
        ctx.strokeStyle = annot.color || '#ff2f2f';
        ctx.lineCap = 'butt';
        ctx.setLineDash([]);
        for (const rect of annot.rects || []) {
          const r = vpRect(viewport, rect);
          if (r.w < 0.5) continue;
          ctx.lineWidth = Math.max(1, ruleWeight(rect) * (viewport.scale || 1));
          // vpRect is in screen space, so y grows downward: the middle of the
          // run for a strikeout, just under its foot for an underline.
          const y = annot.type === 'strikeout'
            ? r.y + r.h * 0.55
            : r.y + r.h + Math.max(1, r.h * 0.08);
          ctx.beginPath();
          ctx.moveTo(r.x, y);
          ctx.lineTo(r.x + r.w, y);
          ctx.stroke();
        }
        break;
      }

      /* An opaque filled box. Deliberately *not* `rect` with `fill: true`,
         which paints at a quarter opacity so the drawing shows through — the
         whole point here is that it does not. Named "cover" and not "redact"
         because the text underneath is untouched and still selectable; see the
         note in CHANGELOG.md. */
      case 'cover': {
        ctx.globalAlpha = alpha(1);
        ctx.fillStyle = annot.color || '#ffffff';
        const r = vpRect(viewport, { x: annot.x, y: annot.y, w: annot.w, h: annot.h });
        ctx.fillRect(r.x, r.y, r.w, r.h);
        break;
      }

      case 'pen': {
        const pts = annot.points || [];
        if (pts.length < 2) break;
        ctx.beginPath();
        let prev = vp(viewport, pts[0][0], pts[0][1]);
        ctx.moveTo(prev[0], prev[1]);
        for (let i = 1; i < pts.length; i += 1) {
          const cur = vp(viewport, pts[i][0], pts[i][1]);
          const next = i + 1 < pts.length ? vp(viewport, pts[i + 1][0], pts[i + 1][1]) : null;
          if (next) ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2);
          else ctx.lineTo(cur[0], cur[1]);
          prev = cur;
        }
        ctx.stroke();
        break;
      }

      case 'line':
      case 'arrow': {
        const a = vp(viewport, annot.x1, annot.y1);
        const b = vp(viewport, annot.x2, annot.y2);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        if (annot.type === 'arrow') drawArrowHead(ctx, a[0], a[1], b[0], b[1], ctx.lineWidth);
        break;
      }

      case 'rect': {
        const r = vpRect(viewport, annot);
        if (annot.fill) {
          ctx.globalAlpha = alpha(1) * 0.25;
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = alpha(1);
        }
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }

      case 'ellipse': {
        const r = vpRect(viewport, annot);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
        if (annot.fill) {
          ctx.globalAlpha = alpha(1) * 0.25;
          ctx.fill();
          ctx.globalAlpha = alpha(1);
        }
        ctx.stroke();
        break;
      }

      case 'cloud': {
        const r = vpRect(viewport, annot);
        drawCloudPath(ctx, r, Math.max(6, 9 * viewport.scale));
        ctx.stroke();
        break;
      }

      case 'callout': {
        const box = vpRect(viewport, calloutBox(annot));
        const tip = vp(viewport, annot.tipX, annot.tipY);
        const anchorPdf = calloutAnchor(annot);
        const best = vp(viewport, anchorPdf[0], anchorPdf[1]);
        ctx.beginPath();
        ctx.moveTo(best[0], best[1]);
        ctx.lineTo(tip[0], tip[1]);
        ctx.stroke();
        drawArrowHead(ctx, best[0], best[1], tip[0], tip[1], ctx.lineWidth);
        ctx.save();
        ctx.globalAlpha = alpha(1) * 0.9;
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.restore();
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        drawCalloutText(ctx, annot, box, viewport, fade);
        break;
      }

      case 'text': {
        const size = (annot.fontSize || 12) * viewport.scale;
        const origin = vp(viewport, annot.x, annot.y);
        ctx.font = fontSpec(annot, size);
        ctx.textBaseline = 'top';
        ctx.fillStyle = annot.color || '#ff2f2f';
        ctx.globalAlpha = alpha(1);
        const lines = String(annot.text || '').split('\n');
        lines.forEach((line, i) => {
          ctx.fillText(line, origin[0], origin[1] + i * size * 1.25);
        });
        break;
      }

      case 'note': {
        const origin = vp(viewport, annot.x, annot.y);
        drawNoteIcon(ctx, origin[0], origin[1], annot.color || '#ffcf3d', annot.opacity, fade);
        break;
      }

      case 'measure': {
        const a = vp(viewport, annot.x1, annot.y1);
        const b = vp(viewport, annot.x2, annot.y2);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        drawEndTick(ctx, b, a, 6);
        drawEndTick(ctx, a, b, 6);
        const pdfLen = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
        const label = annot.label || (options.store || RP.store).formatLength(pdfLen);
        drawLabel(ctx, label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, annot.color, fade);
        break;
      }

      /* One vertex list, three readings of it. The shape is drawn the same way
         in all three cases; what differs is whether the outline closes, whether
         the interior is washed, and what the plates say. `options.pending` is
         the in-progress shape from `tools.js` — the same draw path with a
         rubber-banded last vertex, rather than a second preview renderer that
         could disagree with this one about what is being drawn. */
      case 'polyline':
      case 'polylength':
      case 'area': {
        const pts = annot.points || [];
        if (pts.length < 2) {
          if (options.pending && pts.length === 1) {
            const only = vp(viewport, pts[0][0], pts[0][1]);
            drawVertexDots(ctx, [only], annot.color);
          }
          break;
        }
        const view = pts.map((p) => vp(viewport, p[0], p[1]));
        const closed = isClosedPoly(annot.type);
        ctx.beginPath();
        ctx.moveTo(view[0][0], view[0][1]);
        for (let i = 1; i < view.length; i += 1) ctx.lineTo(view[i][0], view[i][1]);
        if (closed) ctx.closePath();
        // A wash rather than a fill: the point of an area markup is the room
        // under it, which a solid would hide. `fill: false` turns it off for
        // anyone who wants the outline alone.
        if (closed && annot.fill !== false && view.length > 2) {
          ctx.save();
          ctx.globalAlpha = alpha(1) * 0.15;
          ctx.fillStyle = annot.color || '#ff2f2f';
          ctx.fill();
          ctx.restore();
        }
        ctx.stroke();
        if (annot.type === 'polylength') {
          drawEndTick(ctx, view[1], view[0], 6);
          drawEndTick(ctx, view[view.length - 2], view[view.length - 1], 6);
        }
        if (options.pending) drawVertexDots(ctx, view, annot.color);
        for (const label of measureLabels(annot, options.store)) {
          const at = vp(viewport, label.at[0], label.at[1]);
          drawLabel(ctx, label.lines, at[0], at[1] + label.dy, annot.color, fade);
        }
        break;
      }

      default:
        break;
    }

    // Drawn after the markup and at full opacity: the fade is what says
    // "dealt with", and a rule that faded with it would be the one part of a
    // rejected markup you could not read.
    if (statusStruck(annot)) drawStatusStrike(ctx, annot, viewport);

    ctx.restore();

    if (options.selected) drawSelection(ctx, annot, viewport);
    else if (annot.note && annot.type !== 'note') drawCommentPip(ctx, annot, viewport);
  }

  /**
   * Callout text, wrapped inside `box` (viewport space). The inset scales with
   * the zoom so this wraps at exactly the width `measureCalloutHeight` sized
   * the box for, and a line that would not fit is dropped rather than drawn
   * below the box.
   */
  function drawCalloutText(ctx, annot, box, viewport, fade) {
    const scale = viewport.scale;
    const fontSize = (annot.fontSize || 11) * scale;
    ctx.save();
    ctx.font = fontSpec(annot, fontSize);
    ctx.fillStyle = annot.textColor || DEFAULT_TEXT_COLOR;
    ctx.textBaseline = 'top';
    // The text sits on its own white box, so it is opaque regardless of the
    // markup's opacity — but not regardless of its status.
    ctx.globalAlpha = fade === undefined ? 1 : fade;
    const pad = CALLOUT_PAD * (scale || 1);
    const text = annot.text || '';
    const lines = wrapLines(text, Math.max(1, box.w - pad * 2), (s) => ctx.measureText(s).width);
    let y = box.y + pad;
    for (const line of lines) {
      if (y + fontSize > box.y + box.h) break;
      if (line) ctx.fillText(line, box.x + pad, y);
      y += fontSize * CALLOUT_LINE;
    }
    ctx.restore();
  }

  /* Where the clicks landed, while the shape is still being built. Only ever
     drawn for a pending markup: a committed one shows its vertices through the
     selection handles instead, and dotting every vertex of every polygon on a
     sheet would read as ink that is not there. */
  function drawVertexDots(ctx, viewPoints, color) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color || '#ff2f2f';
    ctx.lineWidth = 1.4;
    for (const p of viewPoints) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The rejected rule. Endpoints come from `statusStrikeLine` in PDF space and
   * are converted here, so this and the exporter's copy cannot disagree about
   * where the line goes — only about which API draws it.
   */
  function drawStatusStrike(ctx, annot, viewport) {
    const line = statusStrikeLine(annot);
    const a = vp(viewport, line.x1, line.y1);
    const b = vp(viewport, line.x2, line.y2);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = annot.color || '#ff2f2f';
    ctx.lineWidth = Math.max(1, line.width * (viewport.scale || 1));
    ctx.lineCap = 'butt';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }

  /** Small dot showing that a markup carries a comment. */
  function drawCommentPip(ctx, annot, viewport) {
    const r = vpRect(viewport, bbox(annot));
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2f8fff';
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(r.x + r.w + 6, r.y - 2, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Selection chrome
  // -------------------------------------------------------------------------

  function handlesFor(annot, viewport) {
    const list = [];
    if (annot.type === 'line' || annot.type === 'arrow' || annot.type === 'measure') {
      const a = vp(viewport, annot.x1, annot.y1);
      const b = vp(viewport, annot.x2, annot.y2);
      list.push({ id: 'p1', x: a[0], y: a[1] });
      list.push({ id: 'p2', x: b[0], y: b[1] });
      return list;
    }
    /* One handle per vertex, and no box handles: a poly is edited by moving
       the points that define it, the way the line family is. Offering the
       eight-handle bounding box as well would mean two ways to change the same
       shape, and the box version cannot express "move this one corner of the
       room" — which is the edit anybody actually makes to a takeoff. */
    if (isPoly(annot.type)) {
      (annot.points || []).forEach((p, i) => {
        const at = vp(viewport, p[0], p[1]);
        list.push({ id: 'v' + i, x: at[0], y: at[1] });
      });
      return list;
    }
    if (annot.type === 'note') return list;
    const r = vpRect(viewport, selectionRect(annot));
    const mids = [
      ['nw', r.x, r.y], ['n', r.x + r.w / 2, r.y], ['ne', r.x + r.w, r.y],
      ['e', r.x + r.w, r.y + r.h / 2], ['se', r.x + r.w, r.y + r.h],
      ['s', r.x + r.w / 2, r.y + r.h], ['sw', r.x, r.y + r.h], ['w', r.x, r.y + r.h / 2]
    ];
    for (const [id, x, y] of mids) list.push({ id, x, y });
    if (annot.type === 'callout') {
      const tip = vp(viewport, annot.tipX, annot.tipY);
      list.push({ id: 'tip', x: tip[0], y: tip[1] });
    }
    return list;
  }

  function drawSelection(ctx, annot, viewport) {
    const r = vpRect(viewport, selectionRect(annot));
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#2f8fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    for (const handle of handlesFor(annot, viewport)) {
      ctx.beginPath();
      ctx.rect(handle.x - HANDLE / 2, handle.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Hit testing (PDF space, tolerance in PDF units)
  // -------------------------------------------------------------------------

  function hitTest(annot, x, y, tol) {
    const t = tol || 4;
    switch (annot.type) {
      case 'highlight':
      case 'strikeout':
      case 'underline':
        return (annot.rects || []).some((r) => RP.geom.rectContains(r, x, y, 1));
      case 'pen':
      case 'polyline':
      case 'polylength':
        return RP.geom.distToPolyline(x, y, annot.points || []) <= t + (annot.width || 2) / 2;
      /* A washed area is grabbable anywhere inside it, the way a filled rect
         is; an outline-only one is grabbable on its edge. The closing leg has
         to be tested too — it is drawn, so it has to be clickable, and
         `distToPolyline` does not know the shape closes. */
      case 'area': {
        const pts = annot.points || [];
        if (annot.fill !== false && RP.geom.pointInPolygon(x, y, pts)) return true;
        const ring = pts.length > 2 ? pts.concat([pts[0]]) : pts;
        return RP.geom.distToPolyline(x, y, ring) <= t + (annot.width || 2) / 2;
      }
      case 'line':
      case 'arrow':
      case 'measure':
        return RP.geom.distToSegment(x, y, annot.x1, annot.y1, annot.x2, annot.y2) <= t + (annot.width || 2) / 2;
      case 'rect':
      case 'cloud': {
        const r = { x: annot.x, y: annot.y, w: annot.w, h: annot.h };
        if (annot.fill && RP.geom.rectContains(r, x, y, 0)) return true;
        const inner = RP.geom.rectContains(r, x, y, -t);
        return RP.geom.rectContains(r, x, y, t) && !inner;
      }
      case 'ellipse': {
        const cx = annot.x + annot.w / 2;
        const cy = annot.y + annot.h / 2;
        const rx = Math.max(annot.w / 2, 0.001);
        const ry = Math.max(annot.h / 2, 0.001);
        const norm = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (annot.fill) return norm <= 1.05;
        const band = t / Math.min(rx, ry);
        return norm <= (1 + band * 2) && norm >= (1 - band * 2);
      }
      case 'note': {
        const r = bbox(annot);
        return RP.geom.rectContains(r, x, y, 6);
      }
      case 'callout':
        return calloutPart(annot, x, y, t) !== null;
      case 'text':
        return RP.geom.rectContains(bbox(annot), x, y, 2);
      default:
        return RP.geom.rectContains(bbox(annot), x, y, t);
    }
  }

  // -------------------------------------------------------------------------
  // Transform helpers used by the select tool
  // -------------------------------------------------------------------------

  /**
   * Move an annotation. `part` only matters for callouts: 'box' slides the box
   * while the arrow stays pinned to what it points at, 'tip' moves just the
   * arrow, anything else moves the whole thing.
   */
  function translate(annot, dx, dy, part) {
    if (annot.type === 'callout') {
      if (part !== 'tip') { annot.x += dx; annot.y += dy; }
      if (part !== 'box') { annot.tipX += dx; annot.tipY += dy; }
      return;
    }
    switch (annot.type) {
      case 'highlight':
      case 'strikeout':
      case 'underline':
        for (const r of annot.rects || []) { r.x += dx; r.y += dy; }
        break;
      case 'pen':
      case 'polyline':
      case 'polylength':
      case 'area':
        for (const p of annot.points || []) { p[0] += dx; p[1] += dy; }
        break;
      case 'line':
      case 'arrow':
      case 'measure':
        annot.x1 += dx; annot.y1 += dy; annot.x2 += dx; annot.y2 += dy;
        break;
      default:
        annot.x = (annot.x || 0) + dx;
        annot.y = (annot.y || 0) + dy;
        break;
    }
  }

  /** Scale an annotation so its bbox becomes `next` (both in PDF space). */
  function fitToBox(annot, orig, prev, next) {
    const sx = prev.w > 0.01 ? next.w / prev.w : 1;
    const sy = prev.h > 0.01 ? next.h / prev.h : 1;
    const mapX = (x) => next.x + (x - prev.x) * sx;
    const mapY = (y) => next.y + (y - prev.y) * sy;

    switch (annot.type) {
      case 'highlight':
      case 'strikeout':
      case 'underline':
        annot.rects = (orig.rects || []).map((r) => ({
          x: mapX(r.x), y: mapY(r.y), w: r.w * sx, h: r.h * sy
        }));
        break;
      case 'pen':
      case 'polyline':
      case 'polylength':
      case 'area':
        annot.points = (orig.points || []).map((p) => [mapX(p[0]), mapY(p[1])]);
        break;
      case 'line':
      case 'arrow':
      case 'measure':
        annot.x1 = mapX(orig.x1); annot.y1 = mapY(orig.y1);
        annot.x2 = mapX(orig.x2); annot.y2 = mapY(orig.y2);
        break;
      case 'callout':
        // Resizing reshapes the box only; the arrow keeps pointing where it was.
        annot.x = next.x; annot.y = next.y;
        annot.w = Math.max(12, next.w); annot.h = Math.max(12, next.h);
        break;
      case 'text':
        annot.x = next.x;
        annot.y = next.y + next.h;
        annot.fontSize = Math.max(5, (orig.fontSize || 12) * ((sx + sy) / 2));
        break;
      default:
        annot.x = next.x; annot.y = next.y;
        annot.w = Math.max(1, next.w); annot.h = Math.max(1, next.h);
        break;
    }
  }

  RP.render = {
    NOTE_SIZE,
    HANDLE,
    vp,
    vpRect,
    bbox,
    selectionRect,
    calloutBox,
    ruleWeight,
    POLY_TYPES,
    isPoly,
    isClosedPoly,
    isMeasuredPoly,
    SEGMENT_LABEL_MIN,
    polyArea,
    readingLines,
    readingOf,
    measureLabels,
    calloutAnchor,
    calloutPart,
    STATUS_FADE,
    statusAlpha,
    statusStruck,
    statusStrikeLine,
    measureCalloutHeight,
    calloutTextWidth,
    fitCallout,
    wrapLines,
    fontSpec,
    FONT_STACKS,
    DEFAULT_TEXT_COLOR,
    CALLOUT_PAD,
    CALLOUT_LINE,
    drawAnnotation,
    drawSelection,
    handlesFor,
    hitTest,
    translate,
    fitToBox
  };

})(window.RP);
