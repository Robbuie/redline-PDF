/* Selected text, and the menu of what can be done with it.

   Two gestures produce selected text and they used to have nothing in common.
   Dragging with the highlight tool in text mode went straight to a highlight
   annotation — the only thing you could ever do with a selection. Dragging a
   box with the new text-select tool produces a selection that just sits there.

   Both now converge on one *payload*: `{pages: Map<pageIndex, rects[]>, text}`,
   with the rects in PDF user space, in reading order. Everything below takes a
   payload and nothing below reads `window.getSelection()` — which matters,
   because opening a menu collapses the browser's selection before a single
   handler in it runs. The payload has to be a snapshot taken at release, and
   `tools.js` is careful to take it there.

   The standing selection (`this.current`) belongs to one document, so
   `RP.tabs.stash/unstash` lifts it across a tab switch like the search index
   and the compare run. */
'use strict';

(function (RP) {

  const PAD = 2.5;          // pt of air left around a cloud, box or cover
  const SELECT_FILL = 'rgba(47,143,255,.26)';
  const SELECT_EDGE = 'rgba(47,143,255,.85)';

  const TextSel = {

    /** The standing area selection, or null. One document's worth. */
    current: null,

    // =====================================================================
    // Payloads
    // =====================================================================

    /** True when there is nothing in `payload` worth acting on. */
    isEmpty(payload) {
      if (!payload || !payload.pages || !payload.pages.size) return true;
      for (const rects of payload.pages.values()) if (rects.length) return false;
      return true;
    },

    /** The lowest page index the payload touches — where a note or callout goes. */
    firstPage(payload) {
      if (this.isEmpty(payload)) return -1;
      return Math.min.apply(null, Array.from(payload.pages.keys()));
    },

    /** The union of one page's rects, padded, in PDF space. */
    boxOn(payload, pageIndex) {
      const rects = payload.pages.get(pageIndex) || [];
      const box = RP.geom.unionRect(rects);
      if (!box) return null;
      return { x: box.x - PAD, y: box.y - PAD, w: box.w + PAD * 2, h: box.h + PAD * 2 };
    },

    /** How many words the payload covers. Used for the status line only. */
    wordCount(payload) {
      const text = (payload && payload.text ? payload.text : '').trim();
      return text ? text.split(/\s+/).length : 0;
    },

    // =====================================================================
    // The standing selection
    // =====================================================================

    has() { return !this.isEmpty(this.current); },

    text() { return this.current ? this.current.text : ''; },

    /**
     * Adopt `payload` as the standing selection and repaint.
     *
     * Repainting goes through `redrawAll` rather than the pages the selection
     * happens to be on, because the *previous* selection may have been
     * somewhere else entirely and its highlight has to come off too.
     */
    set(payload) {
      this.current = this.isEmpty(payload) ? null : payload;
      if (RP.viewer && RP.viewer.redrawAll) RP.viewer.redrawAll();
      return this.current;
    },

    clear() {
      if (!this.current) return false;
      this.current = null;
      if (RP.viewer && RP.viewer.redrawAll) RP.viewer.redrawAll();
      return true;
    },

    /**
     * True when a PDF-space point lands inside the standing selection — the
     * test that decides whether a right-click means "act on this selection" or
     * "you have clicked somewhere else, forget it".
     */
    hitTest(pageIndex, x, y) {
      if (!this.has()) return false;
      const rects = this.current.pages.get(pageIndex) || [];
      return rects.some((r) => RP.geom.rectContains(r, x, y, 1));
    },

    /**
     * Paint the standing selection. Called from `viewer.redrawPage` alongside
     * the search hits, and like them only for the focused document — a pane
     * showing another drawing must not show this one's selection.
     */
    draw(ctx, record) {
      if (!this.has()) return;
      const rects = this.current.pages.get(record.index) || [];
      if (!rects.length) return;
      ctx.save();
      ctx.fillStyle = SELECT_FILL;
      ctx.strokeStyle = SELECT_EDGE;
      ctx.lineWidth = 1;
      for (const rect of rects) {
        const view = RP.render.vpRect(record.viewport, rect);
        ctx.fillRect(view.x, view.y, view.w, view.h);
        ctx.strokeRect(view.x + 0.5, view.y + 0.5, Math.max(0, view.w - 1), Math.max(0, view.h - 1));
      }
      ctx.restore();
    },

    // -- per-document state, lifted across a tab switch by RP.tabs ---------

    stash() { return { current: this.current }; },

    unstash(state) {
      this.current = state && state.current ? state.current : null;
    },

    // =====================================================================
    // Actions
    // =====================================================================

    /**
     * One markup per page the selection touches, carrying the same `rects`.
     *
     * Per page and not per run: a highlight over three lines of a schedule is
     * one thing the user did, and splitting it into three markups would put
     * three rows in the sidebar and need three deletes to undo by hand.
     */
    markup(payload, type) {
      if (this.isEmpty(payload)) return 0;
      const style = RP.tools.style;
      const colors = {
        highlight: style.highlightColor,
        strikeout: style.color,
        underline: style.color
      };
      let made = 0;
      for (const [pageIndex, rects] of payload.pages) {
        if (!rects.length) continue;
        RP.store.add({
          page: pageIndex,
          type,
          color: colors[type] || style.color,
          opacity: type === 'highlight' ? 0.4 : 1,
          rects: rects.map((r) => Object.assign({}, r)),
          text: (payload.text || '').slice(0, 400)
        });
        made += 1;
      }
      return made;
    },

    /** A shape around the selection: a revision cloud, a box, or a cover. */
    shape(payload, type) {
      if (this.isEmpty(payload)) return 0;
      const style = RP.tools.style;
      let made = 0;
      for (const pageIndex of payload.pages.keys()) {
        const box = this.boxOn(payload, pageIndex);
        if (!box || box.w < 1 || box.h < 1) continue;
        RP.store.add(Object.assign({
          page: pageIndex,
          type,
          color: type === 'cover' ? '#ffffff' : style.color,
          width: style.width,
          opacity: 1,
          note: type === 'cover' ? '' : (payload.text || '').slice(0, 200)
        }, box));
        made += 1;
      }
      return made;
    },

    /** A callout whose arrow points at the selection and whose text is it. */
    toCallout(payload) {
      const pageIndex = this.firstPage(payload);
      if (pageIndex < 0) return null;
      const box = this.boxOn(payload, pageIndex);
      if (!box) return null;
      const style = RP.tools.style;

      // The box goes above and to the right of what it points at, the way one
      // drawn by hand does — far enough off that it is not covering the detail
      // it is about.
      const w = Math.max(box.w, RP.viewer.pxToPdf(200));
      const annot = RP.store.add({
        page: pageIndex,
        type: 'callout',
        color: style.color,
        width: style.width,
        opacity: 1,
        tipX: box.x + box.w / 2,
        tipY: box.y + box.h,
        x: box.x + RP.viewer.pxToPdf(40),
        y: box.y + box.h + RP.viewer.pxToPdf(30),
        w,
        h: RP.viewer.pxToPdf(56),
        text: payload.text || '',
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        bold: style.bold,
        textColor: style.textColor
      });
      // A callout's box is sized from its text, and this one arrived with its
      // text already set rather than typed in — so it has to be fitted here,
      // exactly as the inline editor does on commit.
      Object.assign(annot, RP.render.fitCallout(annot));
      RP.store.touch(annot);
      return annot;
    },

    /** A sticky note pinned at the selection, with the text as its body. */
    toNote(payload) {
      const pageIndex = this.firstPage(payload);
      if (pageIndex < 0) return null;
      const box = this.boxOn(payload, pageIndex);
      if (!box) return null;
      return RP.store.add({
        page: pageIndex,
        type: 'note',
        color: RP.tools.style.noteColor,
        x: box.x,
        y: box.y + box.h,
        note: payload.text || ''
      });
    },

    /**
     * The text with a page reference in front of it, one line per page.
     *
     * Deliberately the shape the CSV report uses, so a column of these pasted
     * into an email reads as the same comment log the report would produce.
     */
    referenced(payload) {
      const lines = [];
      for (const pageIndex of Array.from(payload.pages.keys()).sort((a, b) => a - b)) {
        lines.push('p' + (pageIndex + 1) + '  ' + (payload.text || ''));
      }
      return lines.join('\n');
    },

    /** Hand the selection to the find panel. */
    find(payload) {
      const text = (payload.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      RP.sidebar.show('search');
      const input = RP.$('#searchInput');
      if (input) input.value = text;
      RP.search.run(text, {
        matchCase: !!(RP.$('#searchCase') && RP.$('#searchCase').checked),
        wholeWord: !!(RP.$('#searchWhole') && RP.$('#searchWhole').checked)
      });
    },

    // =====================================================================
    // The menu
    // =====================================================================

    /**
     * The items offered for a payload. Returned rather than opened so the page
     * context menu can splice them into its own list.
     *
     * `opts.after` runs once an item has done its work — the highlight tool
     * uses it to drop the browser selection, the text-select tool to decide
     * whether its own selection survives.
     */
    items(payload, opts) {
      if (this.isEmpty(payload)) return [];
      const options = opts || {};
      // No `annots:changed` here — `RP.store.add` already emits it, and the
      // copy actions do not add anything to announce.
      const done = (message, tone) => {
        if (message) RP.status(message, tone || 'good');
        if (typeof options.after === 'function') options.after();
      };
      const madeText = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's') + ' added';

      return [
        { heading: this.wordCount(payload) + ' words selected' },
        {
          label: 'Highlight',
          run: () => done(madeText(this.markup(payload, 'highlight'), 'highlight'))
        },
        {
          label: 'Strike out',
          run: () => done(madeText(this.markup(payload, 'strikeout'), 'strikeout'))
        },
        {
          label: 'Underline',
          run: () => done(madeText(this.markup(payload, 'underline'), 'underline'))
        },
        { separator: true },
        {
          label: 'Cloud around it',
          run: () => done(madeText(this.shape(payload, 'cloud'), 'cloud'))
        },
        {
          label: 'Box around it',
          run: () => done(madeText(this.shape(payload, 'rect'), 'box'))
        },
        {
          // Said plainly in the menu, not just in the docs. Someone reaching
          // for this on a drawing that is about to leave the office needs to
          // know the words are still in the file.
          label: 'Cover it',
          hint: 'not redaction',
          run: () => done(madeText(this.shape(payload, 'cover'), 'cover'))
        },
        { separator: true },
        {
          label: 'Copy text',
          hint: 'Ctrl+C',
          run: () => {
            RP.clip.write(payload.text).then((ok) => {
              if (ok) done(this.wordCount(payload) + ' words copied');
            });
          }
        },
        {
          label: 'Copy with page reference',
          run: () => {
            RP.clip.write(this.referenced(payload)).then((ok) => {
              if (ok) done('Copied with page reference');
            });
          }
        },
        { separator: true },
        {
          label: 'Callout with this text',
          run: () => { this.toCallout(payload); done('Callout added'); }
        },
        {
          label: 'Sticky note with this text',
          run: () => { this.toNote(payload); done('Note added'); }
        },
        {
          label: 'Find this in the drawing',
          hint: 'Ctrl+F',
          run: () => { this.find(payload); if (typeof options.after === 'function') options.after(); }
        }
      ];
    },

    /** Open the action menu for a payload at viewport coordinates. */
    open(payload, x, y, opts) {
      const items = this.items(payload, opts);
      if (!items.length) return null;
      return RP.menu.open(x, y, items);
    }
  };

  RP.textsel = TextSel;

})(window.RP);
