/* Pointer interaction: creating markups, and the select tool that moves,
   resizes, recolours and deletes them after the fact. */
'use strict';

(function (RP) {

  const HANDLE_TOL = 6;   // px
  const CLICK_TOL = 4;    // px of travel still counted as a click

  const Tools = {
    tool: 'select',
    style: {
      color: '#ff2f2f',
      highlightColor: '#ffdd00',
      noteColor: '#ffcf3d',
      width: 2,
      opacity: 1,
      fontSize: 12,
      fill: false
    },
    drag: null,
    pan: null,
    calibrating: false,
    highlightMode: 'text',   // 'text' selects words, 'area' drags a box
    shiftHeld: false,
    spaceHeld: false,
    warnedNoText: false,

    /**
     * Pointer wiring is per pane, not global: `RP.tabs` calls this once for
     * each pane it creates. The handlers still work against `RP.viewer`, which
     * is safe because the pane repoints it on pointerdown in the capture phase,
     * before any of these run.
     */
    bindPane(pane) {
      const pagesEl = pane.el.querySelector('.pages');

      /* Under the select tool the ink layer stops swallowing input (see
         app.css) so the text layer beneath it is reachable and text can be
         selected with the same tool you edit markups with. That re-exposes the
         browser's own selection to every *other* select-tool gesture, though —
         a marquee drag across a title block would paint a text selection
         behind it. Text selection is a default action of `mousedown`, and
         refusing it on `pointerdown` is too late, so it is refused here, in
         the capture phase, for everything that is not a press on real glyphs.
         Same shape as the pan handler in `initPan`, and for the same reason. */
      pagesEl.addEventListener('mousedown', (event) => {
        if (this.tool !== 'select' || event.button !== 0) return;
        if (!RP.clip.isGlyph(event.target)) event.preventDefault();
      }, true);

      pagesEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      pagesEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
      pagesEl.addEventListener('pointerup', (e) => this.onPointerUp(e));
      pagesEl.addEventListener('pointercancel', () => this.cancelDrag());
      pagesEl.addEventListener('dblclick', (e) => this.onDoubleClick(e));
      pagesEl.addEventListener('contextmenu', (e) => this.onContextMenu(e));
      this.initPan(pane.el.querySelector('.viewer'));
    },

    init() {
      document.addEventListener('mouseup', (event) => {
        if (this.tool === 'highlight' && this.effectiveHighlightMode() === 'text') {
          // Let the browser finish committing the selection first.
          setTimeout(() => this.captureTextSelection(event), 0);
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Shift' && !this.shiftHeld) { this.shiftHeld = true; this.syncHighlightMode(); }
        if (e.code === 'Space' && !isTypingTarget(e.target)) {
          // Space would otherwise page the viewer down; held, it means "pan".
          e.preventDefault();
          this.setSpaceHeld(true);
        }
      });
      document.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') { this.shiftHeld = false; this.syncHighlightMode(); }
        if (e.code === 'Space') this.setSpaceHeld(false);
      });
      window.addEventListener('blur', () => {
        this.shiftHeld = false;
        this.syncHighlightMode();
        this.setSpaceHeld(false);
      });

      RP.bus.on('doc:loaded', () => { this.warnedNoText = false; });

      // Panning is wired per pane by `bindPane`, not here.
      this.initNotePopup();
      this.initInlineText();
    },

    setTool(tool) {
      this.tool = tool;
      document.body.dataset.tool = tool;
      // Tool buttons are matched by `data-tool` wherever they sit, because the
      // navigation tools live up in the view group rather than in #toolGroup.
      RP.$$('.tbtn.tool[data-tool]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool));
      if (tool !== 'select') RP.store.clearSelection();
      this.closeNotePopup();
      this.syncHighlightMode();

      const group = RP.$('#hlModeGroup');
      const sep = RP.$('#hlModeSep');
      if (group) group.hidden = tool !== 'highlight';
      if (sep) sep.hidden = tool !== 'highlight';
      if (tool === 'highlight') {
        RP.status(this.highlightMode === 'text'
          ? 'Drag across text to highlight it — hold Shift for a box'
          : 'Drag a box to highlight an area — hold Shift to select text');
      } else if (tool === 'callout') {
        RP.status('Press on the detail to pin the arrow, then drag to place the box');
      } else if (tool === 'pan') {
        RP.status('Drag to move around the sheet — holding Space or the middle button does this from any tool');
      } else if (tool === 'zoomrect') {
        RP.status('Drag a box around what you want to see — click to zoom in a step. Esc returns to Select');
      }

      RP.bus.emit('tool:changed', tool);
    },

    /** Shift temporarily flips whichever highlight mode is selected. */
    effectiveHighlightMode() {
      const base = this.highlightMode;
      if (!this.shiftHeld) return base;
      return base === 'text' ? 'area' : 'text';
    },

    setHighlightMode(mode) {
      this.highlightMode = mode === 'area' ? 'area' : 'text';
      RP.$$('#hlModeGroup .chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.hlmode === this.highlightMode);
      });
      this.syncHighlightMode();
    },

    syncHighlightMode() {
      const area = this.tool === 'highlight' && this.effectiveHighlightMode() === 'area';
      document.body.classList.toggle('hl-area', area);
    },

    activeColor() {
      if (this.tool === 'highlight') return this.style.highlightColor;
      if (this.tool === 'note') return this.style.noteColor;
      return this.style.color;
    },

    setColor(hex) {
      if (this.tool === 'highlight') this.style.highlightColor = hex;
      else if (this.tool === 'note') this.style.noteColor = hex;
      else this.style.color = hex;
      // Recolour whatever is selected, so the swatches double as an edit control.
      const selected = RP.store.selected();
      if (selected.length) {
        RP.store.checkpoint();
        for (const annot of selected) annot.color = hex;
        RP.store.markDirty();
        RP.bus.emit('annots:changed', { reason: 'style' });
      }
    },

    setWidth(value) {
      this.style.width = value;
      const selected = RP.store.selected();
      if (selected.length) {
        RP.store.checkpoint();
        for (const annot of selected) annot.width = value;
        RP.store.markDirty();
        RP.bus.emit('annots:changed', { reason: 'style' });
      }
    },

    setOpacity(value) {
      this.style.opacity = value;
      const selected = RP.store.selected();
      if (selected.length) {
        RP.store.checkpoint();
        for (const annot of selected) annot.opacity = value;
        RP.store.markDirty();
        RP.bus.emit('annots:changed', { reason: 'style' });
      }
    },

    // ---------------------------------------------------------------------
    // Panning
    // ---------------------------------------------------------------------

    /**
     * Panning is wired on the scroll container in the *capture* phase rather
     * than joining the delegated handling on `#pages`, for two reasons: a pan
     * can start anywhere, including the gutter between pages, and taking the
     * event on the way down is what stops the press underneath from also
     * starting a markup drag, a marquee, or a text selection.
     */
    initPan(viewerEl) {
      if (!viewerEl) return;

      // Text selection and, on Windows, middle-click autoscroll are default
      // actions of `mousedown`; refusing them on `pointerdown` is too late.
      viewerEl.addEventListener('mousedown', (event) => {
        if (this.wantsPan(event)) event.preventDefault();
      }, true);

      viewerEl.addEventListener('pointerdown', (event) => {
        if (!this.wantsPan(event)) return;
        event.preventDefault();
        event.stopPropagation();
        // Which scroller to move is decided per press: in a split, the pan
        // belongs to the pane the pointer went down in, not the focused one.
        this.beginPan(event, viewerEl);
      }, true);

      viewerEl.addEventListener('pointermove', (event) => this.updatePan(event), true);
      viewerEl.addEventListener('pointerup', () => this.endPan(), true);
      viewerEl.addEventListener('pointercancel', () => this.endPan(), true);
      viewerEl.addEventListener('auxclick', (event) => {
        if (event.button === 1) event.preventDefault();
      });
    },

    wantsPan(event) {
      if (this.pan) return false;
      if (event.button === 1) return true;          // middle-drag, from any tool
      if (event.button !== 0) return false;
      return this.spaceHeld || this.tool === 'pan';
    },

    beginPan(event, scroller) {
      const viewerEl = scroller || this.viewerEl;
      this.viewerEl = viewerEl;
      this.pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewerEl.scrollLeft,
        scrollTop: viewerEl.scrollTop
      };
      // Capture on the scroller keeps the drag alive when the cursor runs off
      // the window, which at 400% on an E-size sheet happens constantly.
      try { viewerEl.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      document.body.classList.add('panning');
    },

    updatePan(event) {
      const pan = this.pan;
      if (!pan || event.pointerId !== pan.pointerId) return;
      this.viewerEl.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
      this.viewerEl.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
    },

    endPan() {
      if (!this.pan) return;
      try { this.viewerEl.releasePointerCapture(this.pan.pointerId); } catch (err) { /* ignore */ }
      this.pan = null;
      document.body.classList.remove('panning');
    },

    setSpaceHeld(held) {
      if (this.spaceHeld === held) return;
      this.spaceHeld = held;
      document.body.classList.toggle('space-pan', held);
      if (!held) this.endPan();
    },

    // ---------------------------------------------------------------------
    // Pointer handling
    // ---------------------------------------------------------------------

    recordFromEvent(event) {
      const pageEl = event.target.closest ? event.target.closest('.page') : null;
      if (!pageEl) return null;
      return RP.viewer.pages[Number(pageEl.dataset.page)] || null;
    },

    localPoint(record, event) {
      const rect = record.container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },

    onPointerDown(event) {
      if (event.button !== 0) return;
      const record = this.recordFromEvent(event);
      if (!record) return;

      // Panning owns the press when the hand tool is armed or Space is down,
      // and it takes it in the capture phase on #viewer. This is the same
      // escape hatch from the other side: a second pointer arriving mid-pan
      // must not start a markup here.
      if (this.pan || this.spaceHeld || this.tool === 'pan') return;

      // The highlighter in text mode must not start a drag at all: this
      // listener is delegated on #pages, so it also sees pointerdown on the
      // text layer, and swallowing it there is what stopped text selection
      // from ever starting.
      if (this.tool === 'highlight' && this.effectiveHighlightMode() === 'text') {
        this.checkPageHasText(record);
        return;
      }

      // Same escape hatch, for the file's own annotations: a press that lands
      // on a link or a comment bubble belongs to that element, not to us. CSS
      // already stops the layer taking input while a drawing tool is armed, so
      // this only ever fires for select and area-highlight.
      if (event.target.closest && event.target.closest('.' + RP.annots.LAYER_CLASS)) return;

      const pdf = RP.viewer.clientToPdf(record, event.clientX, event.clientY);
      const local = this.localPoint(record, event);
      this.closeInlineText();

      if (this.tool === 'select') {
        this.beginSelectInteraction(record, event, pdf, local);
      } else if (this.tool === 'zoomrect') {
        this.drag = {
          mode: 'zoomrect',
          record,
          startPdf: pdf,
          startLocal: local,
          startClient: { x: event.clientX, y: event.clientY },
          movedPx: 0
        };
      } else if (this.tool === 'note') {
        this.createNote(record, pdf);
      } else if (this.tool === 'text') {
        this.openInlineText(record, pdf, null);
      } else {
        this.beginCreate(record, event, pdf, local);
      }

      if (this.drag) {
        try { event.target.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        this.drag.pointerId = event.pointerId;
        this.drag.captureTarget = event.target;
      }
    },

    onPointerMove(event) {
      const drag = this.drag;
      if (!drag) return;
      const record = drag.record;
      const pdf = RP.viewer.clientToPdf(record, event.clientX, event.clientY);
      const local = this.localPoint(record, event);
      drag.movedPx = Math.max(drag.movedPx || 0, Math.hypot(local.x - drag.startLocal.x, local.y - drag.startLocal.y));
      drag.pdf = pdf;
      drag.local = local;
      drag.shift = event.shiftKey;

      switch (drag.mode) {
        case 'create': this.updateDraft(drag, pdf, event); break;
        case 'move': this.updateMove(drag, pdf); break;
        case 'resize': this.updateResize(drag, local, pdf); break;
        case 'marquee': break;
        case 'zoomrect': break;
        default: break;
      }
      RP.viewer.redrawPage(record.index);
    },

    onPointerUp(event) {
      const drag = this.drag;
      if (!drag) return;
      try { drag.captureTarget.releasePointerCapture(drag.pointerId); } catch (err) { /* ignore */ }

      if (drag.mode === 'create') this.finishDraft(drag);
      else if (drag.mode === 'marquee') this.finishMarquee(drag, event);
      else if (drag.mode === 'zoomrect') this.finishZoomRect(drag);
      else if (drag.mode === 'move' || drag.mode === 'resize') {
        if ((drag.movedPx || 0) < CLICK_TOL && drag.mode === 'move') {
          // A plain click on an already-selected markup: keep the selection.
        }
        RP.store.markDirty();
        RP.bus.emit('annots:changed', { reason: 'edit' });
      }

      const record = drag.record;
      this.drag = null;
      RP.viewer.redrawPage(record.index);
    },

    cancelDrag() {
      if (!this.drag) return;
      const record = this.drag.record;
      if (this.drag.mode === 'move' || this.drag.mode === 'resize') RP.store.undo();
      this.drag = null;
      RP.viewer.redrawPage(record.index);
    },

    // ---------------------------------------------------------------------
    // Select / edit
    // ---------------------------------------------------------------------

    beginSelectInteraction(record, event, pdf, local) {
      const store = RP.store;

      // 1. resize handle of an already-selected markup?
      for (const annot of store.selected()) {
        if (annot.page !== record.index) continue;
        for (const handle of RP.render.handlesFor(annot, record.viewport)) {
          if (Math.abs(handle.x - local.x) <= HANDLE_TOL && Math.abs(handle.y - local.y) <= HANDLE_TOL) {
            store.checkpoint();
            this.drag = {
              mode: 'resize',
              record,
              annot,
              handle: handle.id,
              orig: JSON.parse(JSON.stringify(annot)),
              prevPdf: RP.render.selectionRect(annot),
              prevView: RP.render.vpRect(record.viewport, RP.render.selectionRect(annot)),
              startLocal: local,
              startPdf: pdf,
              movedPx: 0
            };
            return;
          }
        }
      }

      // 2. a markup under the cursor? (topmost first)
      const tol = RP.viewer.pxToPdf(5);
      const onPage = store.forPage(record.index);
      let hit = null;
      for (let i = onPage.length - 1; i >= 0; i -= 1) {
        if (RP.render.hitTest(onPage[i], pdf[0], pdf[1], tol)) { hit = onPage[i]; break; }
      }

      if (hit) {
        if (event.shiftKey) store.toggleSelect(hit.id);
        else if (!store.selection.has(hit.id)) store.select(hit.id);
        store.checkpoint();
        const targets = store.selected();
        // Grabbing a callout's box slides the box alone; grabbing its leader
        // moves the whole callout. Group drags always move everything.
        let calloutPart = null;
        if (targets.length === 1 && hit.type === 'callout') {
          calloutPart = RP.render.calloutPart(hit, pdf[0], pdf[1], tol) === 'box' ? 'box' : 'all';
        }
        this.drag = {
          mode: 'move',
          record,
          startPdf: pdf,
          lastPdf: pdf,
          startLocal: local,
          movedPx: 0,
          targets,
          calloutPart
        };
        RP.bus.emit('markup:focus', hit.id);
        return;
      }

      // 3. on the document's own text, with no markup over it -> let the
      //    browser select the words. This is the escape hatch that makes
      //    Ctrl+C and "Copy text" mean anything under the select tool; the
      //    matching `mousedown` refusal in `bindPane` is what stops every
      //    other select gesture from selecting text as a side effect.
      //
      //    Marquee still starts anywhere that is not a glyph, which is how a
      //    marquee is drawn in practice — from clear space around the markups
      //    you are gathering up.
      if (RP.clip.isGlyph(event.target)) {
        if (!event.shiftKey) store.clearSelection();
        return;
      }

      // 4. empty space -> marquee select
      if (!event.shiftKey) store.clearSelection();
      this.drag = {
        mode: 'marquee',
        record,
        startPdf: pdf,
        startLocal: local,
        movedPx: 0,
        additive: event.shiftKey
      };
    },

    updateMove(drag, pdf) {
      const dx = pdf[0] - drag.lastPdf[0];
      const dy = pdf[1] - drag.lastPdf[1];
      drag.lastPdf = pdf;
      for (const annot of drag.targets) RP.render.translate(annot, dx, dy, drag.calloutPart);
    },

    updateResize(drag, local, pdf) {
      const annot = drag.annot;
      const viewport = drag.record.viewport;

      if (drag.handle === 'p1') { annot.x1 = pdf[0]; annot.y1 = pdf[1]; return; }
      if (drag.handle === 'p2') { annot.x2 = pdf[0]; annot.y2 = pdf[1]; return; }
      if (drag.handle === 'tip') { annot.tipX = pdf[0]; annot.tipY = pdf[1]; return; }

      const prev = drag.prevView;
      let { x, y, w, h } = prev;
      const right = x + w;
      const bottom = y + h;
      const id = drag.handle;

      if (id.includes('w')) { x = Math.min(local.x, right - 4); w = right - x; }
      if (id.includes('e')) { w = Math.max(4, local.x - x); }
      if (id.includes('n')) { y = Math.min(local.y, bottom - 4); h = bottom - y; }
      if (id.includes('s')) { h = Math.max(4, local.y - y); }

      const corners = [
        viewport.convertToPdfPoint(x, y),
        viewport.convertToPdfPoint(x + w, y),
        viewport.convertToPdfPoint(x + w, y + h),
        viewport.convertToPdfPoint(x, y + h)
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const next = {
        x: Math.min.apply(null, xs),
        y: Math.min.apply(null, ys),
        w: Math.max.apply(null, xs) - Math.min.apply(null, xs),
        h: Math.max.apply(null, ys) - Math.min.apply(null, ys)
      };
      RP.render.fitToBox(annot, drag.orig, drag.prevPdf, next);
    },

    finishMarquee(drag, event) {
      if ((drag.movedPx || 0) < CLICK_TOL) return;
      const rect = RP.geom.normRect(drag.startPdf[0], drag.startPdf[1], drag.pdf[0], drag.pdf[1]);
      const store = RP.store;
      if (!drag.additive) store.selection.clear();
      for (const annot of store.forPage(drag.record.index)) {
        if (RP.geom.rectsIntersect(rect, RP.render.bbox(annot))) store.selection.add(annot.id);
      }
      RP.bus.emit('selection:changed');
      void event;
    },

    // ---------------------------------------------------------------------
    // Marquee zoom
    // ---------------------------------------------------------------------

    finishZoomRect(drag) {
      // Dropped first: zooming relays out every page and redraws through
      // `drawPreview`, which would otherwise paint the rectangle back on.
      this.drag = null;

      if (!drag.pdf || (drag.movedPx || 0) < CLICK_TOL) {
        // A click, not a drag — step in on the point that was clicked.
        RP.viewer.setZoom(RP.viewer.zoom * 1.5, { anchor: drag.startClient });
        return;
      }
      RP.viewer.zoomToRect(
        drag.record.index,
        RP.geom.normRect(drag.startPdf[0], drag.startPdf[1], drag.pdf[0], drag.pdf[1])
      );
    },

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    beginCreate(record, event, pdf, local) {
      const base = {
        page: record.index,
        type: this.tool,
        color: this.activeColor(),
        width: this.style.width,
        opacity: this.tool === 'highlight' ? 0.4 : this.style.opacity
      };
      let draft;

      switch (this.tool) {
        case 'pen':
          draft = Object.assign(base, { points: [[pdf[0], pdf[1]]] });
          break;
        case 'line':
        case 'arrow':
        case 'measure':
          draft = Object.assign(base, { x1: pdf[0], y1: pdf[1], x2: pdf[0], y2: pdf[1] });
          break;
        case 'callout': {
          // Press pins the arrow to what you are pointing at; the drag then
          // carries the box somewhere it does not cover the detail.
          const w = RP.viewer.pxToPdf(200);
          const h = RP.viewer.pxToPdf(56);
          draft = Object.assign(base, {
            tipX: pdf[0], tipY: pdf[1],
            x: pdf[0] + RP.viewer.pxToPdf(46),
            y: pdf[1] + RP.viewer.pxToPdf(34),
            w, h,
            text: '', fontSize: this.style.fontSize
          });
          break;
        }
        case 'highlight':
          draft = Object.assign(base, { rects: [{ x: pdf[0], y: pdf[1], w: 0, h: 0 }], area: true });
          break;
        default: // rect, ellipse, cloud
          draft = Object.assign(base, { x: pdf[0], y: pdf[1], w: 0, h: 0, fill: this.style.fill });
          break;
      }

      this.drag = {
        mode: 'create',
        record,
        draft,
        startPdf: pdf,
        startLocal: local,
        movedPx: 0
      };
      void event;
    },

    updateDraft(drag, pdf, event) {
      const draft = drag.draft;
      const shift = event && event.shiftKey;

      switch (draft.type) {
        case 'pen': {
          const last = draft.points[draft.points.length - 1];
          if (RP.geom.dist(last[0], last[1], pdf[0], pdf[1]) > 0.6) draft.points.push([pdf[0], pdf[1]]);
          break;
        }
        case 'line':
        case 'arrow':
        case 'measure': {
          let [x, y] = pdf;
          if (shift) {
            // constrain to 0 / 45 / 90 degrees
            const dx = x - draft.x1;
            const dy = y - draft.y1;
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            x = draft.x1 + Math.cos(angle) * len;
            y = draft.y1 + Math.sin(angle) * len;
          }
          draft.x2 = x;
          draft.y2 = y;
          break;
        }
        case 'highlight': {
          draft.rects = [RP.geom.normRect(drag.startPdf[0], drag.startPdf[1], pdf[0], pdf[1])];
          break;
        }
        case 'callout': {
          // The box follows the cursor at a fixed size; the tip stays put.
          draft.x = pdf[0] - draft.w / 2;
          draft.y = pdf[1] - draft.h / 2;
          break;
        }
        default: {
          const rect = RP.geom.normRect(drag.startPdf[0], drag.startPdf[1], pdf[0], pdf[1]);
          if (shift) { const side = Math.max(rect.w, rect.h); rect.w = side; rect.h = side; }
          Object.assign(draft, rect);
          break;
        }
      }
    },

    finishDraft(drag) {
      const draft = drag.draft;
      const minPdf = RP.viewer.pxToPdf(3);

      if (draft.type === 'pen') {
        if (draft.points.length < 2) return;
        draft.points = RP.geom.simplify(draft.points, Math.max(0.4, RP.viewer.pxToPdf(0.8)));
      } else if (draft.type === 'line' || draft.type === 'arrow' || draft.type === 'measure') {
        if (RP.geom.dist(draft.x1, draft.y1, draft.x2, draft.y2) < minPdf) return;
      } else if (draft.type === 'highlight') {
        const r = draft.rects[0];
        if (r.w < minPdf || r.h < minPdf) return;
      } else if (draft.type === 'callout') {
        // Always valid: a plain click drops the box at its default offset.
      } else if (draft.w < minPdf || draft.h < minPdf) {
        return;
      }

      const annot = RP.store.add(draft);

      if (draft.type === 'measure') this.afterMeasure(annot);
      if (draft.type === 'callout') this.openInlineText(drag.record, [annot.x, annot.y + annot.h], annot);
    },

    /** Preview of the in-progress markup + the marquee rectangle. */
    drawPreview(ctx, record) {
      const drag = this.drag;
      if (!drag || drag.record.index !== record.index) return;

      if (drag.mode === 'create' && drag.draft) {
        RP.render.drawAnnotation(ctx, drag.draft, record.viewport, {});
      } else if ((drag.mode === 'marquee' || drag.mode === 'zoomrect') && drag.pdf) {
        const zoom = drag.mode === 'zoomrect';
        const rect = RP.geom.normRect(drag.startPdf[0], drag.startPdf[1], drag.pdf[0], drag.pdf[1]);
        const view = RP.render.vpRect(record.viewport, rect);
        ctx.save();
        ctx.strokeStyle = zoom ? '#ffb02e' : '#2f8fff';
        ctx.fillStyle = zoom ? 'rgba(255,176,46,.10)' : 'rgba(47,143,255,.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(view.x, view.y, view.w, view.h);
        ctx.strokeRect(view.x, view.y, view.w, view.h);
        ctx.restore();
      }
    },

    // ---------------------------------------------------------------------
    // Text-selection highlighting
    // ---------------------------------------------------------------------

    /** Warn once if the sheet is a scan with no text to select. */
    checkPageHasText(record) {
      if (this.warnedNoText || !record) return;
      const spans = record.textLayer ? record.textLayer.childElementCount : 0;
      const items = record.textContent && record.textContent.items ? record.textContent.items.length : 0;
      if (spans > 0 || items > 0) return;
      this.warnedNoText = true;
      RP.toast('This page has no selectable text — use Area mode (or hold Shift) to highlight a region', 'warn', 6000);
    },

    captureTextSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;

      // Only act on selections that started inside a page's text layer —
      // otherwise selecting text in the sidebar would create markups. Checking
      // the anchor (not the common ancestor) keeps selections that run across
      // several pages working.
      const anchor = selection.anchorNode;
      const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (!anchorEl || !anchorEl.closest || !anchorEl.closest('.text-layer')) return;

      const byPage = new Map();
      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        for (const clientRect of Array.from(range.getClientRects())) {
          if (clientRect.width < 1 || clientRect.height < 1) continue;
          const record = RP.viewer.pageAt(clientRect.left + clientRect.width / 2, clientRect.top + clientRect.height / 2);
          if (!record) continue;
          const box = record.container.getBoundingClientRect();
          const p1 = record.viewport.convertToPdfPoint(clientRect.left - box.left, clientRect.top - box.top);
          const p2 = record.viewport.convertToPdfPoint(clientRect.right - box.left, clientRect.bottom - box.top);
          const rect = RP.geom.normRect(p1[0], p1[1], p2[0], p2[1]);
          // Trim the leading/trailing sliver browsers add around line boxes.
          rect.y += rect.h * 0.06;
          rect.h *= 0.88;
          if (!byPage.has(record.index)) byPage.set(record.index, []);
          byPage.get(record.index).push(rect);
        }
      }

      if (!byPage.size) return;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      let first = null;
      for (const [pageIndex, rects] of byPage) {
        const annot = RP.store.add({
          page: pageIndex,
          type: 'highlight',
          color: this.style.highlightColor,
          opacity: 0.4,
          rects: mergeRowRects(rects),
          text: text.slice(0, 400)
        });
        if (!first) first = annot;
      }
      selection.removeAllRanges();
      RP.status('Highlighted ' + byPage.size + (byPage.size === 1 ? ' passage' : ' passages'), 'good');
    },

    // ---------------------------------------------------------------------
    // Sticky notes
    // ---------------------------------------------------------------------

    createNote(record, pdf) {
      const annot = RP.store.add({
        page: record.index,
        type: 'note',
        color: this.style.noteColor,
        x: pdf[0],
        y: pdf[1],
        note: ''
      });
      RP.store.select(annot.id);
      this.setTool('select');
      RP.viewer.redrawPage(record.index);
      this.openNotePopup(annot);
    },

    initNotePopup() {
      this.notePopup = RP.$('#notePopup');
      this.noteText = RP.$('#noteText');
      RP.$('#noteClose').addEventListener('click', () => this.closeNotePopup());
      RP.$('#noteDelete').addEventListener('click', () => {
        if (this.activeNoteId) {
          RP.store.remove(this.activeNoteId);
          this.closeNotePopup();
        }
      });
      this.noteText.addEventListener('input', RP.debounce(() => {
        if (!this.activeNoteId) return;
        const annot = RP.store.get(this.activeNoteId);
        if (!annot) return;
        annot.note = this.noteText.value;
        RP.store.touch(annot);
      }, 220));
      this.noteText.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); this.closeNotePopup(); }
      });
    },

    openNotePopup(annot) {
      const record = RP.viewer.pages[annot.page];
      if (!record) return;
      this.activeNoteId = annot.id;
      const view = RP.render.vpRect(record.viewport, RP.render.bbox(annot));
      const box = record.container.getBoundingClientRect();
      const popup = this.notePopup;
      popup.hidden = false;
      const left = RP.clamp(box.left + view.x + 26, 12, window.innerWidth - 290);
      const top = RP.clamp(box.top + view.y - 10, 60, window.innerHeight - 240);
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      this.noteText.value = annot.note || '';
      RP.$('#noteMeta').textContent = [annot.author, RP.fmtDate(annot.created)].filter(Boolean).join(' · ');
      setTimeout(() => this.noteText.focus(), 10);
    },

    closeNotePopup() {
      if (!this.notePopup) return;
      this.notePopup.hidden = true;
      this.activeNoteId = null;
    },

    // ---------------------------------------------------------------------
    // Typewriter text / callout text
    // ---------------------------------------------------------------------

    initInlineText() {
      this.inlineText = RP.$('#inlineText');
      this.inlineText.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.closeInlineText(true); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.closeInlineText(); }
      });
      this.inlineText.addEventListener('blur', () => this.closeInlineText());
      this.inlineText.addEventListener('input', () => {
        this.inlineText.style.height = 'auto';
        this.inlineText.style.height = this.inlineText.scrollHeight + 'px';
      });
    },

    openInlineText(record, pdf, existing) {
      const editor = this.inlineText;
      this.inlineEdit = { record, pdf, annot: existing || null };
      const view = record.viewport.convertToViewportPoint(pdf[0], pdf[1]);
      const box = record.container.getBoundingClientRect();
      const size = (existing ? existing.fontSize : this.style.fontSize) * RP.viewer.zoom;
      editor.hidden = false;
      editor.style.left = (box.left + view[0]) + 'px';
      editor.style.top = (box.top + view[1]) + 'px';
      editor.style.fontSize = size + 'px';
      editor.style.width = existing && existing.type === 'callout'
        ? (RP.render.vpRect(record.viewport, existing).w) + 'px'
        : '220px';
      editor.value = existing ? (existing.text || '') : '';
      editor.style.height = 'auto';
      setTimeout(() => {
        editor.focus();
        editor.style.height = editor.scrollHeight + 'px';
      }, 10);
    },

    closeInlineText(discard) {
      const editor = this.inlineText;
      if (!editor || editor.hidden || !this.inlineEdit) return;
      const { record, pdf, annot } = this.inlineEdit;
      const value = editor.value;
      editor.hidden = true;
      this.inlineEdit = null;

      if (discard) { RP.viewer.redrawPage(record.index); return; }

      if (annot) {
        if (!value.trim() && annot.type === 'callout') {
          RP.store.remove(annot.id);
        } else if (annot.type === 'callout') {
          // Grow or shrink the box to fit, keeping its top edge where it is.
          const needed = RP.render.measureCalloutHeight(value, annot.w, annot.fontSize || 11);
          const top = annot.y + annot.h;
          RP.store.update(annot.id, { text: value, h: needed, y: top - needed });
        } else {
          RP.store.update(annot.id, { text: value });
        }
      } else if (value.trim()) {
        RP.store.add({
          page: record.index,
          type: 'text',
          color: this.style.color,
          opacity: this.style.opacity,
          fontSize: this.style.fontSize,
          x: pdf[0],
          y: pdf[1],
          text: value
        });
      }
      RP.viewer.redrawPage(record.index);
    },

    onDoubleClick(event) {
      const record = this.recordFromEvent(event);
      if (!record) return;
      const pdf = RP.viewer.clientToPdf(record, event.clientX, event.clientY);
      const tol = RP.viewer.pxToPdf(5);
      const onPage = RP.store.forPage(record.index);
      for (let i = onPage.length - 1; i >= 0; i -= 1) {
        const annot = onPage[i];
        if (!RP.render.hitTest(annot, pdf[0], pdf[1], tol)) continue;
        if (annot.type === 'note') { this.openNotePopup(annot); return; }
        if (annot.type === 'text' || annot.type === 'callout') {
          const anchor = annot.type === 'text' ? [annot.x, annot.y] : [annot.x, annot.y + annot.h];
          this.openInlineText(record, anchor, annot);
          return;
        }
        // anything else: open the comment editor so every markup can carry a note
        this.openNotePopup(annot);
        return;
      }
    },

    // ---------------------------------------------------------------------
    // Context menu
    // ---------------------------------------------------------------------

    /** Topmost markup under a PDF-space point on `record`, or null. */
    hitAt(record, pdf) {
      const tol = RP.viewer.pxToPdf(5);
      const onPage = RP.store.forPage(record.index);
      for (let i = onPage.length - 1; i >= 0; i -= 1) {
        if (RP.render.hitTest(onPage[i], pdf[0], pdf[1], tol)) return onPage[i];
      }
      return null;
    },

    /**
     * Right-click on the drawing.
     *
     * Delegated on `.pages` like every other pointer handler here, so it also
     * fires over the text layer and over the file's own annotation layer. A
     * press on someone else's comment is left alone for the same reason
     * `onPointerDown` bails there — that element is not ours to act on.
     */
    onContextMenu(event) {
      if (event.target.closest && event.target.closest('.' + RP.annots.LAYER_CLASS)) return;
      const record = this.recordFromEvent(event);
      if (!record) return;
      event.preventDefault();

      // A drag in progress means the press that started it is still live; a
      // menu on top of that would leave the drag orphaned.
      this.cancelDrag();

      const pdf = RP.viewer.clientToPdf(record, event.clientX, event.clientY);
      const hit = this.hitAt(record, pdf);
      const store = RP.store;

      // Right-clicking a markup that is not selected selects it, so the menu
      // and the toolbar always act on the same thing. An already-selected
      // markup keeps a multiple selection intact.
      if (hit && !store.selection.has(hit.id)) {
        this.setTool('select');
        store.select(hit.id);
      }

      const many = store.selection.size > 1;
      const hasText = RP.clip.hasTextSelection();

      RP.menu.open(event.clientX, event.clientY, [
        {
          label: 'Copy text',
          hint: 'Ctrl+C',
          disabled: !hasText,
          run: () => RP.clip.copyText()
        },
        hit ? { separator: true } : null,
        hit ? {
          label: 'Markup properties…',
          run: () => RP.props.open(hit)
        } : null,
        hit ? {
          label: many ? 'Delete markups' : 'Delete markup',
          hint: 'Del',
          danger: true,
          run: () => RP.app.deleteSelection()
        } : null,
        { separator: true },
        {
          label: 'Add note here',
          // `createNote` already returns to the select tool and opens the
          // editor, so this is the whole gesture.
          run: () => this.createNote(record, pdf)
        },
        { separator: true },
        {
          label: 'Print…',
          hint: 'Ctrl+P',
          run: () => RP.print.show()
        }
      ]);
    },

    // ---------------------------------------------------------------------
    // Measurement calibration
    // ---------------------------------------------------------------------

    async afterMeasure(annot) {
      if (RP.store.scale) return;
      const answer = await RP.promptDialog({
        title: 'Calibrate the drawing scale',
        message: 'You just measured a known distance. Enter its real length and every measurement on this drawing will use that scale.',
        fields: [
          { name: 'length', label: 'Real length', value: '', placeholder: 'e.g. 3.5', type: 'text' },
          { name: 'unit', label: 'Unit', value: 'm', type: 'select', options: ['mm', 'cm', 'm', 'in', 'ft'] }
        ],
        confirm: 'Set scale',
        cancel: 'Skip'
      });
      if (!answer) return;
      const real = parseFloat(answer.length);
      if (!isFinite(real) || real <= 0) return;
      const pdfLength = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
      RP.store.setScale({ pdfLength, realLength: real, unit: answer.unit });
      RP.bus.emit('annots:changed', { reason: 'scale' });
      RP.toast('Scale set: 1 pt = ' + (real / pdfLength).toPrecision(4) + ' ' + answer.unit, 'good');
    },

    async recalibrate() {
      const answer = await RP.promptDialog({
        title: 'Reset scale',
        message: 'Clear the current calibration? Draw a measurement over a known distance to set a new one.',
        fields: [],
        confirm: 'Clear scale',
        cancel: 'Cancel'
      });
      if (!answer) return;
      RP.store.setScale(null);
      RP.bus.emit('annots:changed', { reason: 'scale' });
    }
  };

  /** True while the keystroke belongs to a field, not to the drawing. */
  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ||
           node.tagName === 'SELECT' || node.isContentEditable === true;
  }

  /** Merge selection rects that sit on the same text row into one bar. */
  function mergeRowRects(rects) {
    const sorted = rects.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const out = [];
    for (const rect of sorted) {
      const last = out[out.length - 1];
      if (last &&
          Math.abs((last.y + last.h / 2) - (rect.y + rect.h / 2)) < Math.min(last.h, rect.h) * 0.6 &&
          rect.x <= last.x + last.w + 2) {
        const right = Math.max(last.x + last.w, rect.x + rect.w);
        last.x = Math.min(last.x, rect.x);
        last.w = right - last.x;
        last.y = Math.min(last.y, rect.y);
        last.h = Math.max(last.h, rect.h);
      } else {
        out.push(Object.assign({}, rect));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Small promise-based prompt (Electron has no window.prompt)
  // -------------------------------------------------------------------------

  RP.promptDialog = function (opts) {
    return new Promise((resolve) => {
      const inputs = {};
      const body = RP.el('div', { class: 'modal-body' });
      if (opts.message) {
        body.appendChild(RP.el('p', {
          text: opts.message,
          style: { margin: '10px 0 14px', color: 'var(--txt-2)', fontSize: '12.5px', lineHeight: '1.6' }
        }));
      }
      for (const field of opts.fields || []) {
        let input;
        if (field.type === 'select') {
          input = RP.el('select', {}, (field.options || []).map((o) => RP.el('option', { value: o, text: o })));
          input.value = field.value || (field.options || [])[0] || '';
        } else {
          input = RP.el('input', { type: 'text', value: field.value || '', placeholder: field.placeholder || '' });
        }
        inputs[field.name] = input;
        body.appendChild(RP.el('label', { class: 'opt field' }, [
          RP.el('span', { text: field.label }), input
        ]));
      }

      const backdrop = RP.el('div', { class: 'modal-backdrop' });
      const finish = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
      const collect = () => {
        const out = {};
        for (const [name, input] of Object.entries(inputs)) out[name] = input.value;
        return out;
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
        if (e.key === 'Enter') { e.stopPropagation(); finish(collect()); }
      };

      const footer = RP.el('div', {
        style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', padding: '4px 18px 18px' }
      }, [
        RP.el('button', { class: 'ghost-btn', text: opts.cancel || 'Cancel', onclick: () => finish(null) }),
        RP.el('button', { class: 'primary-btn', text: opts.confirm || 'OK', onclick: () => finish(collect()) })
      ]);

      const modal = RP.el('div', { class: 'modal', style: { width: 'min(440px, 92vw)' } }, [
        RP.el('header', {}, [RP.el('h2', { text: opts.title || '' })]),
        body,
        footer
      ]);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      document.addEventListener('keydown', onKey, true);
      const firstInput = Object.values(inputs)[0];
      if (firstInput) setTimeout(() => firstInput.focus(), 20);
    });
  };

  RP.tools = Tools;

})(window.RP);
