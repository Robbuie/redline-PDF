/* Whole-document text search: builds a lightweight index once per document,
   then reports hits with page, snippet and an approximate rectangle so the
   viewer can flash the match. */
'use strict';

(function (RP) {

  const Search = {
    index: null,       // [{page, text, items:[{str, start, end, rect}]}]
    building: false,
    hits: [],
    current: -1,
    query: '',

    reset() {
      this.index = null;
      this.hits = [];
      this.current = -1;
      this.query = '';
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
      const input = RP.$('#searchInput');
      if (input) input.value = this.query;
      this.renderResults();
    },

    async buildIndex(onProgress) {
      if (this.index || this.building) return this.index;
      this.building = true;
      const pages = [];
      for (const record of RP.viewer.pages) {
        if (!record.textContent) {
          try { record.textContent = await record.pageProxy.getTextContent(); } catch (err) { record.textContent = { items: [] }; }
        }
        const items = [];
        let text = '';
        for (const item of record.textContent.items) {
          if (typeof item.str !== 'string') continue;
          const start = text.length;
          text += item.str;
          const tr = item.transform || [1, 0, 0, 1, 0, 0];
          items.push({
            str: item.str,
            start,
            end: text.length,
            rect: {
              x: tr[4],
              y: tr[5],
              w: item.width || 0,
              h: item.height || Math.abs(tr[3]) || 10
            }
          });
          if (item.hasEOL) text += '\n';
        }
        pages.push({ page: record.index, text, items });
        if (onProgress) onProgress(record.index + 1, RP.viewer.pages.length);
        if (record.index % 12 === 11) await RP.nextFrame();
      }
      this.index = pages;
      this.building = false;
      return pages;
    },

    /** Approximate the on-page rect of [start,end) within a page's text. */
    rectFor(pageEntry, start, end) {
      const rects = [];
      for (const item of pageEntry.items) {
        if (item.end <= start || item.start >= end) continue;
        const len = Math.max(1, item.str.length);
        const from = Math.max(0, start - item.start) / len;
        const to = Math.min(len, end - item.start) / len;
        const x = item.rect.x + item.rect.w * from;
        const w = Math.max(2, item.rect.w * (to - from));
        rects.push({ x, y: item.rect.y, w, h: item.rect.h || 10 });
      }
      return rects;
    },

    async run(query, opts) {
      const options = opts || {};
      this.query = query || '';
      this.hits = [];
      this.current = -1;
      if (!this.query.trim() || !RP.viewer.pages.length) { this.renderResults(); return; }

      RP.status('Indexing document…');
      await this.buildIndex();
      RP.status('');

      const flags = options.matchCase ? 'g' : 'gi';
      const escaped = this.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = options.wholeWord ? '\\b' + escaped + '\\b' : escaped;
      let regex;
      try { regex = new RegExp(pattern, flags); } catch (err) { return; }

      for (const entry of this.index) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(entry.text)) !== null) {
          if (match[0].length === 0) { regex.lastIndex += 1; continue; }
          const start = match.index;
          const end = start + match[0].length;
          const snippetStart = Math.max(0, start - 38);
          this.hits.push({
            page: entry.page,
            start,
            end,
            before: entry.text.slice(snippetStart, start),
            match: match[0],
            after: entry.text.slice(end, end + 42),
            rects: this.rectFor(entry, start, end)
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
      const rect = RP.geom.unionRect(hit.rects) || { x: 0, y: 0, w: 10, h: 10 };
      RP.viewer.revealRect(hit.page, rect);
      RP.viewer.redrawAll();
      this.markActiveRow();
    },

    next() { this.goTo(this.current + 1); },
    prev() { this.goTo(this.current - 1); },

    drawHits(ctx, record) {
      if (!this.hits.length) return;
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

})(window.RP);
