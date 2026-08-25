/* Whole-document text search: builds a lightweight index once per document,
   then reports hits with page, snippet and rectangles the viewer can flash.

   Two separate things decide whether a hit lands on the right glyphs, and both
   used to be wrong in the same visible way — a box half on the word and half
   on the one after it.

   *What the page text is.* `getTextContent` reports one **run** at a time, and
   a run is neither a word nor a line: a plotter emits "PANEL SCHEDULE" as one
   run and "E-101" as three, and two labels at opposite ends of a title block
   are two runs with nothing between them. Concatenating the runs raw therefore
   invents words at the joins — "PANEL" followed by "SCHEDULE" 200pt away reads
   as `PANELSCHEDULE`, and a query for either matches the join. So a run that
   starts far enough from where the previous one ended to read as a space gets
   one (`GAP_AS_SPACE`), and so does a line break. A query's own whitespace is
   compiled to `\s+` to match either.

   *Where in a run the match sits.* This was `charIndex / str.length` of the
   run's total advance width, which is only true in a monospaced face. In
   anything else the error accumulates along the run, so the longer the run the
   further the box drifts — and it ignored the run's matrix entirely, giving
   text plotted sideways a horizontal box sitting on its baseline. Rects now
   come from the page's **text layer** when it has one (`resolvePage`): a DOM
   range over the same characters, measured by the browser off the glyphs it
   actually laid out, which is exact and is what `tools.js` has always used for
   selection. A page with no layer yet falls back to `rectFor`, which measures
   the substring proportionally and works in the run's own axes.

   The layer is built per visible page and long after the index, so the two
   coexist by design: a hit starts approximate and is upgraded in place, once,
   the moment its page has a layer. The upgraded rect is in PDF user space like
   everything else here, so it survives zoom, rotation and a page release. */
'use strict';

(function (RP) {

  /* A run beginning at least this much of a font height past where the last
     one ended reads as a new word. A space is about 0.3em in most faces, so
     this is "a gap a person looking at the sheet would call a space" — set
     lower and kerning between two runs of one word invents a space inside it. */
  const GAP_AS_SPACE = 0.32;

  let measureCtx;   // undefined = not tried, null = unavailable

  function measuring() {
    if (measureCtx === undefined) {
      try { measureCtx = document.createElement('canvas').getContext('2d') || null; }
      catch (err) { measureCtx = null; }
    }
    return measureCtx;
  }

  /**
   * A run's origin, the unit vector it reads along, its advance width and its
   * height — all in PDF user space. Pure.
   *
   * `transform` is the run's matrix *before* `/Rotate`; every consumer here
   * hands the result to the viewport, which applies the page rotation, so this
   * stays in the same space as every other rect the app stores.
   */
  function runAxis(item) {
    const t = item.t || [1, 0, 0, 1, 0, 0];
    const len = Math.hypot(t[0], t[1]) || 1;
    return {
      x: t[4],
      y: t[5],
      dx: t[0] / len,
      dy: t[1] / len,
      w: item.w || 0,
      h: item.h || Math.hypot(t[2], t[3]) || len || 10
    };
  }

  /**
   * How far into a run's width the first `index` characters reach, 0..1.
   *
   * Measured in the substituted face rather than counted, because character
   * count is only proportional to width in a monospaced one. The face is not
   * the plotted one — nothing in the browser has that — but its proportions
   * are close enough that a box stays on its word, which counting is not.
   */
  function advanceAt(item, index) {
    const len = item.str.length;
    if (index <= 0 || !len) return 0;
    if (index >= len) return 1;
    const ctx = item.font ? measuring() : null;
    if (ctx) {
      try {
        ctx.font = '100px ' + item.font;
        if (!(item.advance > 0)) item.advance = ctx.measureText(item.str).width;
        if (item.advance > 0) return ctx.measureText(item.str.slice(0, index)).width / item.advance;
      } catch (err) { /* fall through to the even split */ }
    }
    return index / len;
  }

  /** Characters [from,to) of one run as a rect in PDF user space. Pure. */
  function runRect(item, from, to) {
    const a = runAxis(item);
    const s = advanceAt(item, from);
    const e = advanceAt(item, to);
    const x0 = a.x + a.dx * a.w * s;
    const y0 = a.y + a.dy * a.w * s;
    const x1 = a.x + a.dx * a.w * e;
    const y1 = a.y + a.dy * a.w * e;
    // The run's own "up", perpendicular to the way it reads: a sideways run
    // gets a sideways box rather than a flat one lying on its baseline.
    const ux = -a.dy * a.h;
    const uy = a.dx * a.h;
    const rect = RP.geom.normRect(
      Math.min(x0, x1, x0 + ux, x1 + ux),
      Math.min(y0, y1, y0 + uy, y1 + uy),
      Math.max(x0, x1, x0 + ux, x1 + ux),
      Math.max(y0, y1, y0 + uy, y1 + uy)
    );
    rect.w = Math.max(rect.w, 1);
    rect.h = Math.max(rect.h, 1);
    return rect;
  }

  /**
   * True when `item` starts far enough from the end of `prev` that the two
   * read as separate words. Pure — `test/verify.js` drives it.
   */
  function readsAsGap(prev, item) {
    if (!prev || !prev.str.length || !item.str.length) return false;
    const a = runAxis(prev);
    const b = runAxis(item);
    // A different reading direction is a different line whatever the distance:
    // a sheet name set vertically beside a schedule is not the last word of it.
    if (Math.abs(a.dx - b.dx) > 0.02 || Math.abs(a.dy - b.dy) > 0.02) return true;
    const endX = a.x + a.dx * a.w;
    const endY = a.y + a.dy * a.w;
    const height = Math.max(a.h, b.h) || 10;
    return Math.hypot(b.x - endX, b.y - endY) >= height * GAP_AS_SPACE;
  }

  const Search = {
    index: null,       // [{page, text, items:[{str, start, end, div, t, w, h}]}]
    building: false,
    hits: [],
    current: -1,
    query: '',
    resolved: null,    // page indices whose hits have been measured off a layer

    reset() {
      this.index = null;
      this.hits = [];
      this.current = -1;
      this.query = '';
      this.resolved = null;
      this.renderResults();
    },

    /* One Search instance serves every tab, so its state is lifted onto the tab
       being left and put back on the one being entered (see tabs.js). The index
       is plain data in PDF user space — no page records, no DOM — so it stays
       valid across the page rebuild a tab switch does. */

    stash() {
      return { index: this.index, hits: this.hits, current: this.current, query: this.query };
    },

    unstash(state) {
      this.index = (state && state.index) || null;
      this.hits = (state && state.hits) || [];
      this.current = state && Number.isFinite(state.current) ? state.current : -1;
      this.query = (state && state.query) || '';
      this.building = false;
      // Not stashed: it only caches which pages have already been *asked*, and
      // each hit carries its own `exact` flag, so rebuilding it costs one pass.
      this.resolved = null;
      const input = RP.$('#searchInput');
      if (input) input.value = this.query;
      this.renderResults();
    },

    /**
     * One page of the index from its text content. Pure — no viewer, no DOM —
     * so `test/verify.js` can drive the run-joining and the geometry.
     *
     * `div` is the run's ordinal among the runs that carry a string, which is
     * exactly the index pdf.js gives the matching span in `record.textDivs`.
     * That correspondence is the whole bridge to the text layer, and it holds
     * because both sides skip the same things: marked-content markers have no
     * `str` and are counted by neither.
     */
    pageEntry(pageIndex, content) {
      const styles = (content && content.styles) || {};
      const source = (content && content.items) || [];
      const items = [];
      let text = '';
      let div = 0;
      let prev = null;
      let prevEOL = false;

      for (const raw of source) {
        if (typeof raw.str !== 'string') continue;   // marked-content marker
        const style = styles[raw.fontName] || null;
        const item = {
          str: raw.str,
          div: div,
          t: (raw.transform || [1, 0, 0, 1, 0, 0]).slice(),
          w: raw.width || 0,
          h: raw.height || 0,
          font: (style && style.fontFamily) || ''
        };
        div += 1;

        // One space, never two, and never one the runs already carry: the
        // offsets below are offsets into this string and a stray space would
        // move every rect on the page one character to the right.
        if (prev && !/\s$/.test(text) && !/^\s/.test(item.str) &&
            (prevEOL || readsAsGap(prev, item))) {
          text += ' ';
        }
        item.start = text.length;
        text += item.str;
        item.end = text.length;
        items.push(item);

        prevEOL = !!raw.hasEOL;
        if (item.str.length) prev = item;
      }

      return { page: pageIndex, text: text, items: items };
    },

    async buildIndex(onProgress) {
      if (this.index || this.building) return this.index;
      this.building = true;
      const pages = [];
      for (const record of RP.viewer.pages) {
        if (!record.textContent) {
          try { record.textContent = await record.pageProxy.getTextContent(); } catch (err) { record.textContent = { items: [] }; }
        }
        pages.push(this.pageEntry(record.index, record.textContent));
        if (onProgress) onProgress(record.index + 1, RP.viewer.pages.length);
        if (record.index % 12 === 11) await RP.nextFrame();
      }
      this.index = pages;
      this.building = false;
      return pages;
    },

    /**
     * The runs [start,end) touches, each with its offsets *within* that run.
     *
     * This is what makes a hit addressable in two ways at once: the offsets
     * are good for a DOM range over `textDivs[div]` and for the measured
     * approximation, and they are the same offsets either way.
     */
    spansFor(pageEntry, start, end) {
      const spans = [];
      for (const item of pageEntry.items) {
        if (item.end <= start || item.start >= end) continue;
        const from = Math.max(0, start - item.start);
        const to = Math.min(item.str.length, end - item.start);
        if (to <= from) continue;
        /* A run that is nothing but whitespace is pdf.js reporting the *gap*
           between two labels, and its advance width is the whole gap — 200pt
           of it on a title block. A bar across that is a highlight over blank
           paper; the labels either side carry their own. */
        if (!item.str.slice(from, to).trim()) continue;
        spans.push({ item: item, div: item.div, from: from, to: to });
      }
      return spans;
    },

    /** The approximate on-page rects of [start,end). Pure. */
    rectFor(pageEntry, start, end) {
      return this.spansFor(pageEntry, start, end).map((span) => runRect(span.item, span.from, span.to));
    },

    // =====================================================================
    // Exact rects, off the text layer
    // =====================================================================

    /**
     * Replace the approximate rects of every hit on `record`'s page with ones
     * measured off its text layer, and say whether anything moved.
     *
     * Done once per page per search — the answer is in PDF user space, so it
     * survives the zoom, the rotation and the release that would invalidate a
     * pixel one. A hit whose runs turn out to have no box (an empty run, a
     * layer truncated by pdf.js's own div cap) is still marked done: nothing
     * about it will read differently on a later pass.
     */
    resolvePage(record) {
      if (!record || !record.viewport || !record.container) return false;
      if (!this.hits.length) return false;
      const divs = record.textDivs;
      if (!divs || !divs.length) return false;          // no layer yet — keep the approximation
      if (!this.resolved) this.resolved = new Set();
      if (this.resolved.has(record.index)) return false;

      let box = null;
      let range = null;
      let changed = false;
      for (const hit of this.hits) {
        if (hit.page !== record.index || hit.exact) continue;
        if (!box) {
          box = record.container.getBoundingClientRect();
          range = document.createRange();
        }
        const rects = this.measureHit(hit, record, divs, box, range);
        hit.exact = true;
        if (rects.length) { hit.rects = rects; changed = true; }
      }
      this.resolved.add(record.index);
      return changed;
    },

    /** One hit's rects from the text layer, in PDF user space. */
    measureHit(hit, record, divs, box, range) {
      const out = [];
      for (const span of hit.spans || []) {
        const div = divs[span.div];
        // A run whose string is empty gets a div but is never appended, so it
        // has no box to ask for — pdf.js keeps it in the list to keep the
        // ordinals lining up, which is the same reason the index does.
        if (!div || !div.isConnected) continue;
        const node = div.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const len = (node.data || '').length;
        const from = Math.min(span.from, len);
        const to = Math.min(span.to, len);
        if (to <= from) continue;
        try {
          range.setStart(node, from);
          range.setEnd(node, to);
        } catch (err) { continue; }
        // More than one rect when a run wraps; each is its own band.
        for (const r of range.getClientRects()) {
          if (r.width < 0.4 || r.height < 0.4) continue;
          const p1 = record.viewport.convertToPdfPoint(r.left - box.left, r.top - box.top);
          const p2 = record.viewport.convertToPdfPoint(r.right - box.left, r.bottom - box.top);
          out.push(RP.geom.normRect(p1[0], p1[1], p2[0], p2[1]));
        }
      }
      return out;
    },

    // =====================================================================
    // Running a search
    // =====================================================================

    /**
     * The typed query as a regex over the index text, or null when it will not
     * compile. Pure — `test/verify.js` drives it.
     *
     * The whitespace substitution is the counterpart of the run joining above:
     * the index puts a single space where the sheet has a gap or a line break,
     * and the person typing has no idea which of the three they are looking
     * at, so any whitespace matches any whitespace.
     */
    pattern(query, opts) {
      const options = opts || {};
      const text = (query || '').trim();
      if (!text) return null;
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = escaped.replace(/\s+/g, '\\s+');
      const source = options.wholeWord ? '\\b' + body + '\\b' : body;
      try { return new RegExp(source, options.matchCase ? 'g' : 'gi'); } catch (err) { return null; }
    },

    async run(query, opts) {
      const options = opts || {};
      this.query = query || '';
      this.hits = [];
      this.current = -1;
      this.resolved = null;
      if (!this.query.trim() || !RP.viewer.pages.length) { this.renderResults(); return; }

      RP.status('Indexing document…');
      await this.buildIndex();
      RP.status('');

      const regex = this.pattern(this.query, options);
      if (!regex) return;

      for (const entry of this.index) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(entry.text)) !== null) {
          if (match[0].length === 0) { regex.lastIndex += 1; continue; }
          const start = match.index;
          const end = start + match[0].length;
          const snippetStart = Math.max(0, start - 38);
          const spans = this.spansFor(entry, start, end);
          this.hits.push({
            page: entry.page,
            start,
            end,
            before: entry.text.slice(snippetStart, start),
            match: match[0],
            after: entry.text.slice(end, end + 42),
            // Kept so the rects can be re-measured off the text layer later.
            spans: spans.map((span) => ({ div: span.div, from: span.from, to: span.to })),
            rects: spans.map((span) => runRect(span.item, span.from, span.to)),
            exact: false
          });
          if (this.hits.length > 2000) break;
        }
        if (this.hits.length > 2000) break;
      }

      this.renderResults();
      if (this.hits.length) this.goTo(0);
      RP.viewer.redrawAll();
    },

    goTo(index) {
      if (!this.hits.length) return;
      this.current = (index + this.hits.length) % this.hits.length;
      const hit = this.hits[this.current];
      // Before the reveal, not after: scrolling to an approximate rect and
      // then correcting it is a visible twitch on the one hit being looked at.
      const record = RP.viewer.pages[hit.page];
      if (record) this.resolvePage(record);
      const rect = RP.geom.unionRect(hit.rects) || { x: 0, y: 0, w: 10, h: 10 };
      RP.viewer.revealRect(hit.page, rect);
      RP.viewer.redrawAll();
      this.markActiveRow();
    },

    next() { this.goTo(this.current + 1); },
    prev() { this.goTo(this.current - 1); },

    drawHits(ctx, record) {
      if (!this.hits.length) return;
      // The page is being painted, so its layer may have arrived since the
      // search ran. One pass, once per page — see `resolvePage`.
      this.resolvePage(record);
      ctx.save();
      for (let i = 0; i < this.hits.length; i += 1) {
        const hit = this.hits[i];
        if (hit.page !== record.index) continue;
        const isCurrent = i === this.current;
        ctx.fillStyle = isCurrent ? 'rgba(255,91,74,.45)' : 'rgba(242,193,78,.4)';
        for (const rect of hit.rects) {
          const view = RP.render.vpRect(record.viewport, rect);
          ctx.fillRect(view.x, view.y - 1, view.w, view.h + 2);
        }
        if (isCurrent) {
          const box = RP.render.vpRect(record.viewport, RP.geom.unionRect(hit.rects) || { x: 0, y: 0, w: 0, h: 0 });
          ctx.strokeStyle = '#ff5b4a';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(box.x - 2, box.y - 3, box.w + 4, box.h + 6);
        }
      }
      ctx.restore();
    },

    renderResults() {
      const list = RP.$('#searchList');
      const count = RP.$('#searchCount');
      if (!list) return;
      list.innerHTML = '';
      if (count) count.textContent = this.hits.length ? this.hits.length + ' hits' : '';

      if (!this.query.trim()) {
        list.appendChild(RP.el('div', { class: 'side-empty', text: 'Type to search the whole document.' }));
        return;
      }
      if (!this.hits.length) {
        list.appendChild(RP.el('div', { class: 'side-empty', text: 'No matches for “' + this.query + '”.' }));
        return;
      }

      this.hits.forEach((hit, i) => {
        const snippet = RP.el('div', { class: 'snip' });
        snippet.innerHTML = RP.escapeHtml(hit.before) +
          '<mark>' + RP.escapeHtml(hit.match) + '</mark>' +
          RP.escapeHtml(hit.after);
        const row = RP.el('button', {
          class: 'search-row' + (i === this.current ? ' active' : ''),
          'data-hit': String(i),
          onclick: () => this.goTo(i)
        }, [
          RP.el('span', { class: 'pg', text: 'p' + (hit.page + 1) }),
          snippet
        ]);
        list.appendChild(row);
      });
    },

    markActiveRow() {
      const list = RP.$('#searchList');
      if (!list) return;
      RP.$$('.search-row', list).forEach((row) => {
        const active = Number(row.dataset.hit) === this.current;
        row.classList.toggle('active', active);
        if (active) row.scrollIntoView({ block: 'nearest' });
      });
    }
  };

  RP.search = Search;
  RP.bus.on('doc:loaded', () => Search.reset());
  /* A page's text layer is built long after the index — per visible page, and
     only once its raster is down. Any hit already on that page is holding an
     approximation at that moment, so this is where it gets corrected. */
  RP.bus.on('textlayer:ready', (record) => {
    if (!Search.hits.length || !record) return;
    if (Search.resolvePage(record) && RP.viewer && RP.viewer.redrawPage) {
      RP.viewer.redrawPage(record.index);
    }
  });

})(window.RP);
