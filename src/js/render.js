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
      case 'highlight':
        return RP.geom.unionRect(annot.rects || []) || { x: 0, y: 0, w: 0, h: 0 };
      case 'pen': {
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

  function strokeStyle(ctx, annot, viewport) {
    ctx.strokeStyle = annot.color || '#ff2f2f';
    ctx.lineWidth = Math.max(0.8, (annot.width || 2) * viewport.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = annot.opacity === undefined ? 1 : annot.opacity;
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

  function drawNoteIcon(ctx, x, y, color, opacity) {
    const s = NOTE_SIZE;
    ctx.save();
    ctx.globalAlpha = opacity === undefined ? 1 : Math.max(0.5, opacity);
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

  function drawLabel(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    const padX = 5;
    const padY = 3;
    const metrics = ctx.measureText(text);
    const w = metrics.width + padX * 2;
    const h = 16;
    ctx.globalAlpha = 1;
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
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
    void padY;
  }

  function drawAnnotation(ctx, annot, viewport, opts) {
    const options = opts || {};
    ctx.save();
    strokeStyle(ctx, annot, viewport);
    ctx.fillStyle = annot.color || '#ff2f2f';

    switch (annot.type) {
      case 'highlight': {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = annot.opacity === undefined ? 0.4 : annot.opacity;
        ctx.fillStyle = annot.color || '#ffdd00';
        for (const rect of annot.rects || []) {
          const r = vpRect(viewport, rect);
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
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
          ctx.globalAlpha = (annot.opacity === undefined ? 1 : annot.opacity) * 0.25;
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = annot.opacity === undefined ? 1 : annot.opacity;
        }
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }

      case 'ellipse': {
        const r = vpRect(viewport, annot);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
        if (annot.fill) {
          ctx.globalAlpha = (annot.opacity === undefined ? 1 : annot.opacity) * 0.25;
          ctx.fill();
          ctx.globalAlpha = annot.opacity === undefined ? 1 : annot.opacity;
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
        ctx.globalAlpha = (annot.opacity === undefined ? 1 : annot.opacity) * 0.9;
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.restore();
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        drawCalloutText(ctx, annot, box, viewport);
        break;
      }

      case 'text': {
        const size = (annot.fontSize || 12) * viewport.scale;
        const origin = vp(viewport, annot.x, annot.y);
        ctx.font = fontSpec(annot, size);
        ctx.textBaseline = 'top';
        ctx.fillStyle = annot.color || '#ff2f2f';
        const lines = String(annot.text || '').split('\n');
        lines.forEach((line, i) => {
          ctx.fillText(line, origin[0], origin[1] + i * size * 1.25);
        });
        break;
      }

      case 'note': {
        const origin = vp(viewport, annot.x, annot.y);
        drawNoteIcon(ctx, origin[0], origin[1], annot.color || '#ffcf3d', annot.opacity);
        break;
      }

      case 'measure': {
        const a = vp(viewport, annot.x1, annot.y1);
        const b = vp(viewport, annot.x2, annot.y2);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        // end ticks
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
        const tick = 6;
        for (const p of [a, b]) {
          ctx.beginPath();
          ctx.moveTo(p[0] - Math.cos(angle) * tick, p[1] - Math.sin(angle) * tick);
          ctx.lineTo(p[0] + Math.cos(angle) * tick, p[1] + Math.sin(angle) * tick);
          ctx.stroke();
        }
        const pdfLen = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
        const label = annot.label || RP.store.formatLength(pdfLen);
        drawLabel(ctx, label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, annot.color);
        break;
      }

      default:
        break;
    }

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
  function drawCalloutText(ctx, annot, box, viewport) {
    const scale = viewport.scale;
    const fontSize = (annot.fontSize || 11) * scale;
    ctx.save();
    ctx.font = fontSpec(annot, fontSize);
    ctx.fillStyle = annot.textColor || DEFAULT_TEXT_COLOR;
    ctx.textBaseline = 'top';
    ctx.globalAlpha = 1;
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
        return (annot.rects || []).some((r) => RP.geom.rectContains(r, x, y, 1));
      case 'pen':
        return RP.geom.distToPolyline(x, y, annot.points || []) <= t + (annot.width || 2) / 2;
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
        for (const r of annot.rects || []) { r.x += dx; r.y += dy; }
        break;
      case 'pen':
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
        annot.rects = (orig.rects || []).map((r) => ({
          x: mapX(r.x), y: mapY(r.y), w: r.w * sx, h: r.h * sy
        }));
        break;
      case 'pen':
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
    calloutAnchor,
    calloutPart,
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
