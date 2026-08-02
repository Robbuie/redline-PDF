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
