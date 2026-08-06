/* Shared helpers. Everything hangs off the global `RP` namespace because the
   renderer runs classic scripts (ES modules are blocked over file://). */
'use strict';

window.RP = window.RP || {};

(function (RP) {

  // --- DOM ----------------------------------------------------------------

  RP.$ = (sel, root) => (root || document).querySelector(sel);
  RP.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  RP.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  RP.icon = function (name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) svg.setAttribute('class', cls);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  };

  // --- misc ---------------------------------------------------------------

  let idSeq = 0;
  RP.uid = function (prefix) {
    idSeq += 1;
    return (prefix || 'a') + '-' + Date.now().toString(36) + '-' + idSeq.toString(36);
  };

  RP.clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  RP.debounce = function (fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  RP.throttleRaf = function (fn) {
    let queued = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn.apply(this, lastArgs);
      });
    };
  };

  /** Lets a long loop breathe so the UI keeps painting. */
  RP.nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  RP.escapeHtml = function (str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  RP.basename = function (p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  };

  RP.stripExt = function (name) {
    return String(name || '').replace(/\.[^.\\/]+$/, '');
  };

  RP.dirname = function (p) {
    const str = String(p || '');
    const idx = Math.max(str.lastIndexOf('\\'), str.lastIndexOf('/'));
    return idx < 0 ? '' : str.slice(0, idx);
  };

  RP.joinPath = function (dir, name) {
    if (!dir) return name;
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  };

  /* The name a "save to a new copy" defaults to. `-markup` is appended once
     and once only: marking up a copy and saving it again must not walk off
     into `E-101-markup-markup-markup.pdf`. Pure and path-shaped rather than a
     method on App, so test/verify.js can check the naming without a DOM. */
  RP.copyPath = function (docPath) {
    if (!docPath) return null;
    const base = RP.stripExt(RP.basename(docPath));
    const name = /-markup$/i.test(base) ? base : base + '-markup';
    return RP.joinPath(RP.dirname(docPath), name + '.pdf');
  };

  RP.fmtDate = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  RP.fmtRelative = function (ts) {
    if (!ts) return '';
    const secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    if (secs < 604800) return Math.round(secs / 86400) + 'd ago';
    return RP.fmtDate(ts).slice(0, 10);
  };

  // --- colour -------------------------------------------------------------

  RP.PALETTE = [
    '#ff2f2f', // redline red
    '#ff9500', // orange
    '#ffdd00', // highlighter yellow
    '#38d16a', // green
    '#2f8fff', // blue
    '#c04aff', // violet
    '#111111'  // black
  ];

  RP.hexToRgb = function (hex) {
    let h = String(hex || '#000').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const num = parseInt(h, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  };

  RP.hexToRgbUnit = function (hex) {
    const { r, g, b } = RP.hexToRgb(hex);
    return { r: r / 255, g: g / 255, b: b / 255 };
  };

  RP.rgba = function (hex, alpha) {
    const { r, g, b } = RP.hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha === undefined ? 1 : alpha})`;
  };

  // --- geometry -----------------------------------------------------------

  RP.geom = {
    normRect(x0, y0, x1, y1) {
      return {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0)
      };
    },

    rectContains(rect, x, y, pad) {
      const p = pad || 0;
      return x >= rect.x - p && x <= rect.x + rect.w + p &&
             y >= rect.y - p && y <= rect.y + rect.h + p;
    },

    rectsIntersect(a, b) {
      return !(b.x > a.x + a.w || b.x + b.w < a.x || b.y > a.y + a.h || b.y + b.h < a.y);
    },

    unionRect(rects) {
      if (!rects || !rects.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rects) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },

    dist(x0, y0, x1, y1) {
      return Math.hypot(x1 - x0, y1 - y0);
    },

    /** Shortest distance from point to the segment ab. */
    distToSegment(px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    },

    distToPolyline(px, py, points) {
      let best = Infinity;
      for (let i = 1; i < points.length; i += 1) {
        best = Math.min(best, RP.geom.distToSegment(px, py, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
      }
      if (points.length === 1) best = Math.hypot(px - points[0][0], py - points[0][1]);
      return best;
    },

    /* ---------------------------------------------------------------------
       Polylines and polygons

       The takeoff maths, and deliberately pure: `test/verify.js` checks all of
       it without a browser. Points are `[[x, y], ...]` in PDF user space, and
       a closed shape is *not* given a repeated last vertex — the closing leg
       is implied, which is what stops a saved-and-reopened polygon growing a
       zero-length edge on every round trip.
       --------------------------------------------------------------------- */

    /** Total length of the open run through `points`. */
    polylineLength(points) {
      const pts = points || [];
      let total = 0;
      for (let i = 1; i < pts.length; i += 1) {
        total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      return total;
    },

    /** Perimeter of the closed shape through `points`, closing leg included. */
    polygonPerimeter(points) {
      const pts = points || [];
      if (pts.length < 3) return RP.geom.polylineLength(pts);
      const last = pts[pts.length - 1];
      return RP.geom.polylineLength(pts) + Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]);
    },

    /**
     * Twice-the-shoelace, halved — the *signed* area of the closed shape.
     * Negative means the vertices wind clockwise, which nothing here cares
     * about except `polygonCentroid`, so callers take the magnitude.
     */
    signedArea(points) {
      const pts = points || [];
      if (pts.length < 3) return 0;
      let sum = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return sum / 2;
    },

    /** Area of the closed shape, in square PDF points. */
    polygonArea(points) {
      return Math.abs(RP.geom.signedArea(points));
    },

    /**
     * The area-weighted centroid — where a label belongs, and not the same
     * point as the average of the vertices on anything but a regular shape:
     * three clicks bunched in one corner would drag a vertex mean off the
     * middle of the room being measured. Falls back to the vertex mean for a
     * degenerate (zero-area) shape, where the weighted form divides by zero.
     */
    polygonCentroid(points) {
      const pts = points || [];
      if (!pts.length) return [0, 0];
      const area = RP.geom.signedArea(pts);
      if (pts.length < 3 || Math.abs(area) < 1e-9) {
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p[0]; sy += p[1]; }
        return [sx / pts.length, sy / pts.length];
      }
      let cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const cross = a[0] * b[1] - b[0] * a[1];
        cx += (a[0] + b[0]) * cross;
        cy += (a[1] + b[1]) * cross;
      }
      return [cx / (6 * area), cy / (6 * area)];
    },

    /** Ray casting. Used for the interior hit of a closed area markup. */
    pointInPolygon(px, py, points) {
      const pts = points || [];
      if (pts.length < 3) return false;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        const straddles = (yi > py) !== (yj > py);
        if (straddles && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },

    /**
     * Do segments ab and cd *properly* cross?
     *
     * Proper is the operative word: two edges of a polygon that share a vertex
     * touch at a point, and counting that as a crossing would report every
     * shape ever drawn as self-intersecting. So a shared endpoint is not a
     * crossing, and neither is a T where one endpoint lands on the other
     * segment — only a genuine X, or a pair of collinear edges that overlap
     * along a length rather than at a point.
     */
    segmentsCross(a, b, c, d) {
      const EPS = 1e-9;
      const side = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
      const d1 = side(a, b, c);
      const d2 = side(a, b, d);
      const d3 = side(c, d, a);
      const d4 = side(c, d, b);

      if (Math.abs(d1) > EPS && Math.abs(d2) > EPS && Math.abs(d3) > EPS && Math.abs(d4) > EPS) {
        return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
      }
      // Collinear: an overlap of non-zero length is a crossing, a touch is not.
      if (Math.abs(d1) <= EPS && Math.abs(d2) <= EPS) {
        const along = (p) => (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
        const len = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
        if (len <= EPS) return false;
        const t0 = along(c) / len;
        const t1 = along(d) / len;
        const lo = Math.max(0, Math.min(t0, t1));
        const hi = Math.min(1, Math.max(t0, t1));
        return hi - lo > 1e-6;
      }
      return false;
    },

    /**
     * Does the shape cross itself? A bow-tie has no single area anybody would
     * agree on, so `RP.render` refuses to put a number on one rather than
     * reporting the shoelace value, which is a plausible-looking difference of
     * two lobes. Vertex counts here are what a person clicked, so the O(n²)
     * pair sweep is not worth indexing.
     */
    selfIntersects(points, closed) {
      const pts = points || [];
      const n = pts.length;
      if (n < 4) return false;
      const edges = closed ? n : n - 1;
      const at = (i) => [pts[i], pts[(i + 1) % n]];
      for (let i = 0; i < edges; i += 1) {
        for (let j = i + 2; j < edges; j += 1) {
          // Adjacent edges share a vertex, and on a closed shape the first and
          // last are adjacent through the wrap.
          if (closed && i === 0 && j === edges - 1) continue;
          const [a, b] = at(i);
          const [c, d] = at(j);
          if (RP.geom.segmentsCross(a, b, c, d)) return true;
        }
      }
      return false;
    },

    /** Ramer–Douglas–Peucker; keeps freehand strokes small enough to embed. */
    simplify(points, tolerance) {
      if (points.length < 3) return points.slice();
      const tol = tolerance || 0.6;

      function rdp(start, end, keep) {
        let maxDist = 0;
        let index = -1;
        for (let i = start + 1; i < end; i += 1) {
          const d = RP.geom.distToSegment(
            points[i][0], points[i][1],
            points[start][0], points[start][1],
            points[end][0], points[end][1]
          );
          if (d > maxDist) { maxDist = d; index = i; }
        }
        if (maxDist > tol && index > 0) {
          rdp(start, index, keep);
          rdp(index, end, keep);
        } else {
          keep.push(end);
        }
      }

      const keep = [0];
      rdp(0, points.length - 1, keep);
      keep.sort((a, b) => a - b);
      return keep.map((i) => points[i]);
    }
  };

  // --- toasts / status ----------------------------------------------------

  RP.toast = function (message, kind, ms) {
    const stack = RP.$('#toasts');
    if (!stack) return;
    const node = RP.el('div', { class: 'toast ' + (kind || ''), text: message });
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('fading');
      setTimeout(() => node.remove(), 280);
    }, ms || 3200);
  };

  let statusTimer = null;
  RP.status = function (message, kind) {
    const node = RP.$('#stMsg');
    if (!node) return;
    node.textContent = message || '';
    node.className = 'st-item st-msg' + (kind ? ' ' + kind : '');
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { node.textContent = ''; }, 5000);
  };

  // --- tiny event bus -----------------------------------------------------

  RP.bus = (function () {
    const map = new Map();
    return {
      on(name, fn) {
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(fn);
        return () => map.get(name).delete(fn);
      },
      emit(name, payload) {
        const set = map.get(name);
        if (!set) return;
        for (const fn of Array.from(set)) {
          try { fn(payload); } catch (err) { console.error('bus handler failed for ' + name, err); }
        }
      }
    };
  }());

})(window.RP);
