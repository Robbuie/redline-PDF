/* Pointer interaction: creating markups, and the select tool that moves,
   resizes, recolours and deletes them after the fact. */
'use strict';

(function (RP) {

  const HANDLE_TOL = 6;   // px
  const CLICK_TOL = 4;    // px of travel still counted as a click
  const HL_GAP_RATIO = 1.2;  // bars bridge gaps up to 1.2x the row height

  const Tools = {
    tool: 'select',
    sticky: false,          // armed tool stays armed instead of drawing once
    inlineEdit: null,       // {record, pdf, annot} while the text editor is up
    style: {
      color: '#ff2f2f',
      highlightColor: '#ffdd00',
      noteColor: '#ffcf3d',
      width: 2,
      opacity: 1,
      fontSize: 12,
      fontFamily: 'sans',
      bold: false,
      textColor: '#16181d',
      fill: false
    },
    drag: null,
    pan: null,
    calibrating: false,
    highlightMode: 'text',   // 'text' selects words, 'area' drags a box
    hlPress: null,           // where a text-mode highlight drag started
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
      // A standing selection is a set of rects on a particular page of a
      // particular document. Both change under it here, so it goes.
      RP.bus.on('doc:reset', () => { RP.textsel.current = null; });
      RP.bus.on('pages:rebuilt', () => RP.textsel.clear());

      // Panning is wired per pane by `bindPane`, not here.
      this.initNotePopup();
      this.initInlineText();
    },

    /**
     * Arm a tool.
     *
     * A markup tool is a **one-shot**: it draws one markup and hands back to
     * Select — see `afterCreate`. Most marking up is one cloud here, one
     * callout there, and the tool that stayed armed meant the click that was
     * meant to select what you had just drawn drew another one instead.
     *
     * Arming the tool that is *already* armed **toggles the lock**, so a
     * locked tool stays armed for as many markups as you want. That is the CAD
     * convention, and it is what a double-click on a toolbar button does — its
     * second click re-arms the same tool. Pressing the tool's shortcut twice
     * does the same thing, so the keyboard is not shut out of it. Select is
     * never locked; the concept means nothing there.
     */
    setTool(tool, opts) {
      const lock = opts && 'sticky' in opts
        ? !!opts.sticky
        : (tool !== 'select' && this.tool === tool && !this.sticky);
      this.sticky = lock;
      this.tool = tool;
      document.body.dataset.tool = tool;
      // Tool buttons are matched by `data-tool` wherever they sit, because the
      // navigation tools live up in the view group rather than in #toolGroup.
      RP.$$('.tbtn.tool[data-tool]').forEach((btn) => {
        const on = btn.dataset.tool === tool;
        btn.classList.toggle('active', on);
        btn.classList.toggle('locked', on && lock);
      });
      if (tool !== 'select') RP.store.clearSelection();
      this.closeNotePopup();
      this.syncHighlightMode();

      const group = RP.$('#hlModeGroup');
      const sep = RP.$('#hlModeSep');
      if (group) group.hidden = tool !== 'highlight';
      if (sep) sep.hidden = tool !== 'highlight';

      this.syncTextOpts();
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
      // Locking is invisible otherwise: the button looks the same as an armed
      // one until the second markup you did not expect appears.
      if (lock) RP.status('Locked on — this tool stays armed until you pick another. Esc returns to Select');

      RP.bus.emit('tool:changed', tool);
    },

    /**
     * Hand back to Select once a tool has produced a markup.
     *
     * Called by everything that finishes creating one, never by the drag code
     * itself — a drag that came out too small to become a markup must leave
     * the tool where it was, or a slipped click disarms the tool you were
     * about to use.
     */
    afterCreate() {
      if (this.sticky || this.tool === 'select') return;
      this.setTool('select', { sticky: false });
    },

    /**
     * Show the typography group when it has something to act on.
     *
     * Typography only means anything for the two markups that carry text, so
     * the group follows the tool — but it also has to be up for as long as an
     * inline editor is open, whatever the tool is. Double-clicking a callout
     * to re-word it happens under Select, and the controls being the thing
     * that changes its typeface is no use if they are hidden while you are in
     * it. Called by `setTool` and by both ends of the inline editor.
     */
    syncTextOpts() {
      const editing = this.inlineEdit ? this.inlineEdit.annot : null;
      const textish = this.tool === 'text' || this.tool === 'callout' || !!this.inlineEdit;
      const textGroup = RP.$('#textOptsGroup');
      const textSep = RP.$('#textOptsSep');
      if (textSep) textSep.hidden = !textish;
      if (!textGroup) return;
      textGroup.hidden = !textish;
      // The callout's own text sits on white; a typewriter note is the markup
      // itself and takes the markup colour, so the swatch is only meaningful
      // for callouts. What is being edited outranks what is armed.
      const calloutish = editing ? editing.type === 'callout' : this.tool === 'callout';
      const colourField = textGroup.querySelector('#textColor');
      if (colourField && colourField.parentNode) colourField.parentNode.hidden = !calloutish;
    },

    /** Shift temporarily flips whichever highlight mode is selected. */
    effectiveHighlightMode() {
      const base = this.highlightMode;
      if (!this.shiftHeld) return base;
      return base === 'text' ? 'area' : 'text';
    },

    /**
     * Typography defaults for the next text or callout. Changing these also
     * restyles the current selection, the way picking a colour does — you have
     * a markup selected and you are looking at the control that describes it.
     *
     * The markup under an open inline editor counts as the selection. It is
     * plainly what the toolbar is describing, and a callout being created is
     * not in `store.selected()` at all — without this the controls would look
     * live while you typed and do nothing until the text had been committed
     * and the markup selected again.
     */
    setTextStyle(patch) {
      Object.assign(this.style, patch);
      RP.$$('#fontBold').forEach((btn) => btn.classList.toggle('active', !!this.style.bold));

      const live = this.inlineEdit ? this.inlineEdit.annot : null;
      const targets = live
        ? [live]
        : RP.store.selected().filter((a) => a.type === 'text' || a.type === 'callout');

      if (targets.length) {
        RP.store.checkpoint();
        for (const annot of targets) {
          // A typewriter note has no box and no separate text colour: its own
          // colour *is* its text, so the swatch would fight the style group.
          const fields = annot.type === 'callout' ? patch : omit(patch, 'textColor');
          Object.assign(annot, fields);
          // The box has to be fitted to the text in the *editor*, not to
          // `annot.text`, which is still whatever it held before this edit
          // began — on a callout being created that is the empty string.
          if (annot.type === 'callout') {
            const text = annot === live ? this.inlineText.value : annot.text;
            Object.assign(annot, RP.render.fitCallout(Object.assign({}, annot, { text })));
          }
        }
        RP.store.markDirty();
        RP.store.emit('annots:changed', { reason: 'style' });
        RP.viewer.redrawAll();
      }

      // Re-place even when nothing was restyled: a typewriter markup that has
      // not been committed yet has no annotation to patch, but the editor
      // still has to show the face the text is about to be drawn in.
      if (this.inlineEdit) {
        this.placeInlineText();
        this.inlineText.focus();
      }
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
        // Where the press landed is the only record of what the user *meant*
        // to sweep. `captureTextSelection` needs it because the browser's own
        // selection cannot be trusted to describe the shape on screen — see
        // the note there.
        this.hlPress = { page: record.index, clientX: event.clientX, clientY: event.clientY };
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
      } else if (this.tool === 'textselect') {
        // A fresh drag replaces whatever was standing, the way a click in a
        // text editor does. Clearing on the way *down* rather than on the way
        // up means the old selection does not sit under the new marquee.
        this.checkPageHasText(record);
        RP.textsel.clear();
        this.drag = {
          mode: 'textmarquee',
          record,
          startPdf: pdf,
          startLocal: local,
          movedPx: 0
        };
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
        case 'textmarquee': break;
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
      else if (drag.mode === 'textmarquee') this.finishTextMarquee(drag);
      else if (drag.mode === 'zoomrect') this.finishZoomRect(drag);
      else if (drag.mode === 'move' || drag.mode === 'resize') {
        if ((drag.movedPx || 0) < CLICK_TOL && drag.mode === 'move') {
          // A plain click on an already-selected markup: keep the selection.
        }
        // A narrower callout needs more lines than the old height allowed for,
        // so grow it to fit once the drag has settled — grow only, or dragging
        // a box deliberately taller would snap straight back. The drag already
        // checkpointed.
        if (drag.mode === 'resize' && drag.annot && drag.annot.type === 'callout') {
          const fit = RP.render.fitCallout(drag.annot);
          if (fit.h > drag.annot.h) Object.assign(drag.annot, fit);
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
            text: '', fontSize: this.style.fontSize,
            fontFamily: this.style.fontFamily, bold: this.style.bold,
            textColor: this.style.textColor
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
      if (draft.type === 'callout') {
        // A callout hands back to Select in `closeInlineText` instead of here.
        // The toolbar's typography group is hidden the moment the tool stops
        // being text-ish, and it has to stay reachable while the text is being
        // typed — changing the typeface mid-callout is the point of it.
        this.openInlineText(drag.record, [annot.x, annot.y + annot.h], annot);
        return;
      }
      this.afterCreate();
    },

    /** Preview of the in-progress markup + the marquee rectangle. */
    drawPreview(ctx, record) {
      const drag = this.drag;
      if (!drag || drag.record.index !== record.index) return;

      if (drag.mode === 'create' && drag.draft) {
        RP.render.drawAnnotation(ctx, drag.draft, record.viewport, {});
      } else if ((drag.mode === 'marquee' || drag.mode === 'textmarquee' || drag.mode === 'zoomrect') && drag.pdf) {
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

    // ---------------------------------------------------------------------
    // Area text selection
    // ---------------------------------------------------------------------

    /**
     * Turn the marquee into a standing text selection.
     *
     * This is the easy direction. The text-mode highlighter has to reconstruct
     * what the user meant from the browser's selection, which arrives in DOM
     * order — i.e. the order the plotter wrote the entities — and needs
     * `HL.sweep` to throw out the runs it dragged in from elsewhere on the
     * sheet. An area selection has no such problem: the box says exactly which
     * words are wanted, and the browser's selection is never consulted at all.
     *
     * Single page by design, like the markup marquee: the drag is anchored to
     * the page it started on, and a box spanning a page break on a continuous
     * scroll is not a gesture anybody makes deliberately.
     */
    finishTextMarquee(drag) {
      const record = drag.record;
      const band = normBand(drag.startLocal, drag.local || drag.startLocal);
      if (band.right - band.left < 3 || band.bottom - band.top < 3) return;

      const words = wordsInBand(record, band);
      if (!words.length) {
        RP.status('No text in that area', 'warn');
        return;
      }

      // Straight to rows and runs — no sweep. `bars` merges each row's words
      // into the same stretches a highlight would paint, so an area selection
      // and a dragged one produce identical geometry over identical words.
      const rows = HL.rows(words);
      const bars = [];
      for (const row of rows) for (const bar of HL.bars(row.words)) bars.push(bar);
      if (!bars.length) return;

      const pages = new Map([[record.index, bars.map((bar) => toPdfBar(record, bar))]]);
      const swept = new Map([[record.index, rows.map((row) => row.words)]]);
      const payload = { pages, text: HL.textOf(swept) };

      RP.textsel.set(payload);
      const count = RP.textsel.wordCount(payload);
      RP.status(count + (count === 1 ? ' word selected' : ' words selected') +
        ' — Ctrl+C to copy, right-click for more');
    },

    /** Warn once if the sheet is a scan with no text to select. */
    checkPageHasText(record) {
      if (this.warnedNoText || !record) return;
      const spans = record.textLayer ? record.textLayer.childElementCount : 0;
      const items = record.textContent && record.textContent.items ? record.textContent.items.length : 0;
      if (spans > 0 || items > 0) return;
      this.warnedNoText = true;
      RP.toast('This page has no selectable text — it is a scan. Use area highlight (hold Shift) to mark a region instead', 'warn', 6000);
    },

    /**
     * Read the browser's text selection and offer what to do with it.
     *
     * The selection used to become a highlight the instant the pointer came
     * up, because a highlight was the only thing it could become. It now
     * becomes a *payload* — see `textsel.js` — and a menu opens over it.
     *
     * The payload has to be built here and now. Opening a menu moves focus and
     * takes a `pointerdown` listener of its own, and the browser's selection
     * does not survive either; by the time an item's handler runs there is
     * nothing left to read. So the geometry is snapshotted at release and
     * every action downstream works from the snapshot.
     */
    captureTextSelection(event) {
      const payload = this.selectionPayload(event);
      this.hlPress = null;
      if (!payload) return;

      const selection = window.getSelection();
      const at = event
        ? { x: event.clientX, y: event.clientY }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

      // The browser selection is deliberately left on screen while the menu is
      // open, so the words being acted on stay visible under it. It is dropped
      // once an action has run; dismissing the menu leaves it alone, because
      // "I did not mean that one" is not the same as "I did not mean to
      // select anything".
      RP.textsel.open(payload, at.x, at.y, {
        after: () => { if (selection) selection.removeAllRanges(); }
      });
    },

    /**
     * The browser's text selection as a payload, or null.
     *
     * Two things make a drawing's text layer different from a document's, and
     * both of them land here.
     *
     * The browser selects in *DOM order*, and pdf.js emits one span per text
     * run in content-stream order — the order the plotter wrote the entities,
     * which has nothing to do with reading order. Dragging down two lines of a
     * description block therefore sweeps in every run the plotter happened to
     * write in between, and those land all over the sheet. So the selection is
     * read as a set of *candidates* and the shape actually swept is rebuilt
     * geometrically, row by row, from the press point to the release point.
     *
     * And the glyphs in the text layer are not the glyphs on the page: pdf.js
     * lays a substituted face over a CAD stick font and stretches it with
     * `--scale-x` so only the run's total advance is guaranteed to line up.
     * The caret therefore lands a fraction of a character from where it looks
     * like it should — measured against a plotted sheet, bars came out inset
     * 1 to 2.5pt at each end, about a third of a character, which reads as the
     * first letter of a word refusing to highlight. Selections are rounded out
     * to whole words before anything is measured.
     */
    selectionPayload(event) {
      const selection = window.getSelection();
      const press = this.hlPress;
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

      // Only act on selections that started inside a page's text layer —
      // otherwise selecting text in the sidebar would create markups. Checking
      // the anchor (not the common ancestor) keeps selections that run across
      // several pages working.
      const anchor = selection.anchorNode;
      const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (!anchorEl || !anchorEl.closest || !anchorEl.closest('.text-layer')) return null;

      const under = event ? RP.viewer.pageAt(event.clientX, event.clientY) : null;
      const release = under
        ? { page: under.index, clientX: event.clientX, clientY: event.clientY }
        : null;
      // Order the two ends by page, then down the page. Left/right on a single
      // row is left to `HL.sweep`, which normalises that itself.
      let from = press;
      let to = release;
      if (from && to && (from.page > to.page ||
          (from.page === to.page && from.clientY > to.clientY + 2))) { from = release; to = press; }

      const byPage = new Map();
      const sweptByPage = new Map();
      for (const record of RP.viewer.pages) {
        if (!record || !record.textDivs || !record.textDivs.length) continue;
        const words = selectedWordRects(selection, record);
        if (!words.length) continue;
        const rows = HL.rows(words);
        // The swept rows are kept as well as the bars they collapse into: the
        // bars are the geometry, the rows still carry the words, and the text
        // is rebuilt from those below.
        const swept = HL.sweep(rows, endpointOn(rows, record, from, true),
          endpointOn(rows, record, to, false));
        const bars = [];
        for (const rowWords of swept) {
          for (const bar of HL.bars(rowWords)) bars.push(bar);
        }
        if (!bars.length) continue;
        sweptByPage.set(record.index, swept);
        byPage.set(record.index, bars.map((bar) => toPdfBar(record, bar)));
      }

      if (!byPage.size) return null;
      return { pages: byPage, text: HL.textOf(sweptByPage) };
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
      this.afterCreate();
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
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeInlineText(true); }
        // Enter finishes the markup; Shift+Enter is the line break. A callout is
        // a label on a drawing, not a paragraph — one line is the common case
        // and reaching for the mouse to end every one of them is the cost of
        // making the rare multi-line case free. Ctrl/Cmd+Enter still commits so
        // the old habit does not break. Alt is let through to the browser.
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          this.closeInlineText();
        }
      });
      // Clicking away commits — except onto the typography controls, which are
      // part of the edit rather than a click out of it. Reaching for the
      // typeface dropdown mid-callout would otherwise commit the markup and
      // then restyle nothing, because by the time `change` fires the editor
      // has closed and the markup is no longer selected.
      this.inlineText.addEventListener('blur', (e) => {
        const to = e.relatedTarget;
        if (to && to.closest && to.closest('#textOptsGroup')) return;
        this.closeInlineText();
      });
      this.inlineText.addEventListener('input', () => {
        this.inlineText.style.height = 'auto';
        this.inlineText.style.height = this.inlineText.scrollHeight + 'px';
      });
    },

    openInlineText(record, pdf, existing) {
      const editor = this.inlineText;
      this.inlineEdit = { record, pdf, annot: existing || null };
      editor.hidden = false;
      editor.value = existing ? (existing.text || '') : '';
      this.placeInlineText();
      this.syncTextOpts();
      RP.bus.emit('textedit:changed', existing || null);
      setTimeout(() => {
        editor.focus();
        editor.style.height = editor.scrollHeight + 'px';
      }, 10);
    },

    /**
     * Put the editor over the markup it is editing, in that markup's face.
     *
     * Split out of `openInlineText` because the typography controls now work
     * *during* an edit: changing the typeface or the size re-fits a callout's
     * box, and an editor left at the old geometry would go on wrapping to a
     * width the box no longer has — which is the same class of bug as a fixed
     * pixel inset, and shows up as a line escaping below the box.
     */
    placeInlineText() {
      const edit = this.inlineEdit;
      if (!edit) return;
      const editor = this.inlineText;
      const { record, pdf, annot } = edit;

      // A callout box is *drawn* as the axis-aligned `vpRect` of its four
      // corners, so the editor has to be placed from that same rect. Converting
      // the single top-left PDF corner instead only agrees on an unrotated
      // page: on a sheet with its own /Rotate — which is most plotted landscape
      // drawings — that corner lands somewhere else entirely and the editor
      // opens away from the box it belongs to, usually below it.
      const rect = annot && annot.type === 'callout'
        ? RP.render.vpRect(record.viewport, RP.render.calloutBox(annot))
        : null;
      const view = rect ? [rect.x, rect.y] : record.viewport.convertToViewportPoint(pdf[0], pdf[1]);

      const box = record.container.getBoundingClientRect();
      // Typed in the face it will be drawn in, or the wrap you see while typing
      // is not the wrap you get. Set piecemeal rather than through the `font`
      // shorthand, which would reset the line-height the stylesheet sets.
      const face = annot || this.style;
      editor.style.left = (box.left + view[0]) + 'px';
      editor.style.top = (box.top + view[1]) + 'px';
      editor.style.fontSize = ((face.fontSize || this.style.fontSize) * RP.viewer.zoom) + 'px';
      editor.style.fontFamily = RP.render.FONT_STACKS[face.fontFamily || 'sans'] || RP.render.FONT_STACKS.sans;
      editor.style.fontWeight = face.bold ? '700' : '400';
      editor.style.color = annot
        ? (annot.type === 'callout' ? (annot.textColor || RP.render.DEFAULT_TEXT_COLOR) : (annot.color || '#16181d'))
        : this.style.color;
      editor.style.width = (rect ? rect.w : 220) + 'px';
      editor.style.height = 'auto';
      editor.style.height = editor.scrollHeight + 'px';
    },

    closeInlineText(discard) {
      const editor = this.inlineText;
      if (!editor || editor.hidden || !this.inlineEdit) return;
      const { record, pdf, annot } = this.inlineEdit;
      const value = editor.value;
      editor.hidden = true;
      this.inlineEdit = null;
      this.syncTextOpts();
      RP.bus.emit('textedit:changed', null);

      if (discard) { RP.viewer.redrawPage(record.index); return; }

      let made = false;
      if (annot) {
        if (!value.trim() && annot.type === 'callout') {
          // Nothing was typed, so nothing was made — leave the tool armed, or
          // an abandoned callout costs you a trip back to the toolbar.
          RP.store.remove(annot.id);
        } else if (annot.type === 'callout') {
          made = true;
          // Grow or shrink the box to fit, keeping its top edge where it is.
          // Measured off a copy: mutating first would land the new text in the
          // checkpoint `update` takes, and undo would not bring the old text back.
          const fit = RP.render.fitCallout(Object.assign({}, annot, { text: value }));
          RP.store.update(annot.id, Object.assign({ text: value }, fit));
        } else {
          made = true;
          RP.store.update(annot.id, { text: value });
        }
      } else if (value.trim()) {
        made = true;
        RP.store.add({
          page: record.index,
          type: 'text',
          color: this.style.color,
          opacity: this.style.opacity,
          fontSize: this.style.fontSize,
          fontFamily: this.style.fontFamily,
          bold: this.style.bold,
          x: pdf[0],
          y: pdf[1],
          text: value
        });
      }
      RP.viewer.redrawPage(record.index);
      // Text and callout hand the tool back from here rather than from
      // `finishDraft`, so that the typography group survives the whole edit.
      // A double-click re-edit reaches this too and is harmless: the tool is
      // Select by then, and `afterCreate` stands down for it.
      if (made) this.afterCreate();
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

      /* Right-clicking inside a standing area selection means "act on this",
         so the full set of text actions is spliced in at the top and the bare
         "Copy text" row is dropped — it would be the same command twice.
         Right-clicking anywhere else leaves the selection alone but offers
         only the plain copy, because the click was not about it. */
      const inSelection = RP.textsel.hitTest(record.index, pdf[0], pdf[1]);
      const textItems = inSelection
        ? RP.textsel.items(RP.textsel.current, { after: () => RP.textsel.clear() })
        : [{
          label: 'Copy text',
          hint: 'Ctrl+C',
          disabled: !hasText,
          run: () => RP.clip.copyText()
        }];

      RP.menu.open(event.clientX, event.clientY, [
        ...textItems,
        hit ? { separator: true } : null,
        ...(hit ? RP.app.statusMenuItems() : []),
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
          // `createNote` hands the tool back and opens the editor itself, so
          // this is the whole gesture.
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

  /** A copy of `obj` without `key`. */
  function omit(obj, key) {
    const out = Object.assign({}, obj);
    delete out[key];
    return out;
  }

  /** True while the keystroke belongs to a field, not to the drawing. */
  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ||
           node.tagName === 'SELECT' || node.isContentEditable === true;
  }

  // ---------------------------------------------------------------------
  // Highlight geometry
  //
  // Pure, and in page-local CSS pixels with y running down the screen, which
  // is the space the pointer arrives in. Nothing here touches the DOM, so
  // `test/verify.js` can drive it with plain rectangles — the ordering and
  // bridging bugs it covers were all invisible until a sheet was in front of
  // someone. Conversion to PDF space happens once, on the finished bars.
  // ---------------------------------------------------------------------

  const HL = {

    /**
     * Bucket word rects into visual rows, top of the page first.
     *
     * Rows are grown from the *middles* of the words against a shared band
     * rather than by sorting on `top`: words on one row rarely share a top
     * edge — a different face, a superscript or a taller glyph all shift it —
     * and sorting on it interleaved rows, which then merged left-to-right in
     * the wrong order and left fragments behind.
     */
    rows(words) {
      const sorted = words.slice()
        .sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom) || a.left - b.left);
      const rows = [];
      for (const word of sorted) {
        const middle = (word.top + word.bottom) / 2;
        const row = rows[rows.length - 1];
        if (row && middle >= row.top && middle <= row.bottom) {
          row.top = Math.min(row.top, word.top);
          row.bottom = Math.max(row.bottom, word.bottom);
          row.words.push(word);
        } else {
          rows.push({ top: word.top, bottom: word.bottom, words: [word] });
        }
      }
      for (const row of rows) row.words.sort((a, b) => a.left - b.left);
      return rows;
    },

    /**
     * The words the pointer actually swept, as one array per row.
     *
     * `from` and `to` are `{row, x}` in reading order; either being null means
     * that end is unbounded, and both null means take the selection as it
     * stands (a keyboard or double-click selection, where there is no drag to
     * reconstruct).
     *
     * The filter is a walk rather than a box because a drawing has no single
     * text block to bound: the run grows a horizontal *band* as it goes and
     * each row is admitted only where it overlaps the band so far. That is
     * what a reading-order selection actually is — spatially contiguous — and
     * it is what rejects the far-away runs the browser hands over from
     * elsewhere in the content stream while still letting a genuine paragraph
     * widen past the two points that were clicked.
     */
    sweep(rows, from, to) {
      if (!rows.length) return [];
      if (!from || !to) return rows.map((row) => row.words.slice());

      let a = from;
      let b = to;
      if (a.row > b.row || (a.row === b.row && a.x > b.x)) { a = to; b = from; }

      const out = [];
      let band = null;
      for (let i = Math.max(0, a.row); i <= Math.min(rows.length - 1, b.row); i += 1) {
        const runs = this.runs(rows[i].words);
        // The first row that yields anything seeds the band, and it seeds it
        // from *one* run — the one the press landed in, or the next one to its
        // right. Admitting everything right of the press instead let the far
        // column in on the very first row, and from there the band was wide
        // enough to admit it on every row below.
        const keep = band
          ? runs.filter((run) => run.right > band[0] && run.left < band[1])
          : runs.filter((run) => run.right > a.x).slice(0, 1);

        let words = [];
        for (const run of keep) words = words.concat(run.words);
        if (i === a.row) words = words.filter((w) => w.right > a.x);
        if (i === b.row) words = words.filter((w) => w.left < b.x);
        if (!words.length) continue;

        let lo = Infinity;
        let hi = -Infinity;
        for (const w of words) { lo = Math.min(lo, w.left); hi = Math.max(hi, w.right); }
        band = band ? [Math.min(band[0], lo), Math.max(band[1], hi)] : [lo, hi];
        out.push(words);
      }
      return out;
    },

    /**
     * The words of one row grouped into contiguous runs.
     *
     * The gap rule lives here and nowhere else, so "words the sweep treats as
     * one stretch of text" and "words a bar paints through" are the same
     * question by construction. Drift between the two would show up as a bar
     * that stops in the middle of a phrase the sweep had already accepted.
     */
    runs(rowWords, ratio) {
      const gapRatio = ratio === undefined ? HL_GAP_RATIO : ratio;
      const out = [];
      let cur = null;
      for (const word of rowWords.slice().sort((a, b) => a.left - b.left)) {
        const gap = cur ? word.left - cur.right : Infinity;
        const height = Math.max(word.bottom - word.top, cur ? cur.bottom - cur.top : 0);
        if (cur && gap <= height * gapRatio) {
          cur.right = Math.max(cur.right, word.right);
          cur.top = Math.min(cur.top, word.top);
          cur.bottom = Math.max(cur.bottom, word.bottom);
          cur.words.push(word);
        } else {
          cur = {
            left: word.left, top: word.top, right: word.right, bottom: word.bottom,
            words: [word]
          };
          out.push(cur);
        }
      }
      return out;
    },

    /**
     * One bar per run of words on a row.
     *
     * The space between two highlighted words is painted through, so a phrase
     * reads as one stroke of a pen rather than a box per word. Only *word*
     * gaps though: anything wider than `ratio` times the row height starts a
     * new bar, which is what stops a schedule row's separate columns being
     * joined by a bar across blank paper. Measured on a plotted sheet the two
     * populations are cleanly separated with nothing in between: letter gaps
     * came in around 0.3 of the row height and word gaps around 0.93, with
     * column gaps several times that.
     *
     * The union is a union of *edges*: carrying the larger of two heights
     * instead, against the higher of two tops, quietly produced a bar shorter
     * than the words it covered.
     */
    bars(rowWords, ratio) {
      return this.runs(rowWords, ratio).map((run) => ({
        left: run.left, top: run.top, right: run.right, bottom: run.bottom
      }));
    },

    /**
     * The swept words as text, in reading order.
     *
     * `selection.toString()` cannot be used for this. The browser concatenates
     * in DOM order and pdf.js emits one span per run in *content-stream*
     * order — the order the plotter wrote the entities — so a two-line
     * description block comes back with its lines interleaved and runs from
     * the far side of the sheet dropped in between. The rows have already been
     * bucketed top-to-bottom and sorted left-to-right by `rows` and `runs`, so
     * walking them is both correct and free.
     *
     * Takes `Map<pageIndex, rows[]>` where a row is an array of word rects
     * carrying `text`. Runs on one row are joined by a double space, because a
     * gap wide enough to break a bar is a column boundary on a schedule and
     * running the two columns together would read as one phrase. Pure — no
     * DOM, so `test/verify.js` drives it directly.
     */
    textOf(sweptByPage) {
      // Whitespace is squeezed out of each word as it goes in, never off the
      // finished string: a pass over the whole thing would collapse the double
      // space that separates two columns back down to a word space, which is
      // the distinction this is drawing in the first place.
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const pages = [];
      for (const pageIndex of Array.from(sweptByPage.keys()).sort((a, b) => a - b)) {
        const lines = [];
        for (const rowWords of sweptByPage.get(pageIndex) || []) {
          const parts = this.runs(rowWords)
            .map((run) => run.words.map((w) => clean(w.text)).filter(Boolean).join(' '))
            .filter(Boolean);
          if (parts.length) lines.push(parts.join('  '));
        }
        if (lines.length) pages.push(lines.join('\n'));
      }
      return pages.join('\n\n').trim();
    }
  };

  /**
   * One bar, in page-local CSS pixels, as a rect in PDF user space.
   *
   * The 6%/88% trim takes off the sliver browsers leave above and below a line
   * box, which is leading rather than glyph and makes a highlight look like it
   * is set in a taller face than the text it covers.
   */
  function toPdfBar(record, bar) {
    const p1 = record.viewport.convertToPdfPoint(bar.left, bar.top);
    const p2 = record.viewport.convertToPdfPoint(bar.right, bar.bottom);
    const rect = RP.geom.normRect(p1[0], p1[1], p2[0], p2[1]);
    rect.y += rect.h * 0.06;
    rect.h *= 0.88;
    return rect;
  }

  /**
   * Which row of `rows` an endpoint sits on, in page-local pixels.
   *
   * An endpoint on another page means this page is swept from that side
   * entirely; no endpoint at all means no drag was recorded and the caller
   * should not filter. The row is the *nearest* one rather than the containing
   * one, because a press in the leading between two lines still belongs to a
   * line as far as the user is concerned.
   */
  function endpointOn(rows, record, point, atStart) {
    if (!point || !rows.length) return null;
    if (point.page !== record.index) {
      return atStart ? { row: 0, x: -Infinity } : { row: rows.length - 1, x: Infinity };
    }
    const box = record.container.getBoundingClientRect();
    const x = point.clientX - box.left;
    const y = point.clientY - box.top;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const dist = y < row.top ? row.top - y : (y > row.bottom ? y - row.bottom : 0);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return { row: best, x };
  }

  /** Two page-local points as a normalised band. Pure. */
  function normBand(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y)
    };
  }

  /**
   * True when a word rect belongs to `band`.
   *
   * The test is on the word's *centre*, not on any overlap. Overlap would drag
   * in the whole of a long run whose first letter the box happened to clip,
   * which on a schedule row means selecting the column you deliberately
   * stopped short of. Containment would instead drop a word whose descender
   * pokes out of the bottom edge. The centre is what a person means by "I put
   * the box over this word". Pure — `test/verify.js` drives it.
   */
  function centreInBand(word, band) {
    const cx = (word.left + word.right) / 2;
    const cy = (word.top + word.bottom) / 2;
    return cx >= band.left && cx <= band.right && cy >= band.top && cy <= band.bottom;
  }

  /**
   * Every word of a page that falls inside `band`, in page-local pixels.
   *
   * Two passes for cost, not for correctness. Splitting a span into one Range
   * per word and asking each for its client rects is the expensive part, and a
   * plotted title block has hundreds of spans, so spans are first rejected —
   * or accepted whole — on their own bounding box, and only the ones the band
   * actually cuts through get word-split. The reads are all reads with no
   * writes in between, so the browser can serve them from one layout rather
   * than one per span.
   */
  function wordsInBand(record, band) {
    const box = record.container.getBoundingClientRect();
    const out = [];
    for (const div of record.textDivs || []) {
      if (!div || !div.isConnected) continue;
      const r = div.getBoundingClientRect();
      const span = {
        left: r.left - box.left,
        top: r.top - box.top,
        right: r.right - box.left,
        bottom: r.bottom - box.top
      };
      if (span.right <= band.left || span.left >= band.right ||
          span.bottom <= band.top || span.top >= band.bottom) continue;

      const whole = span.left >= band.left && span.right <= band.right &&
                    span.top >= band.top && span.bottom <= band.bottom;
      if (whole) {
        if (span.right - span.left < 0.5 || span.bottom - span.top < 0.5) continue;
        out.push(Object.assign({ text: div.textContent || '' }, span));
        continue;
      }
      for (const word of wordRectsOf(div, box)) {
        if (centreInBand(word, band)) out.push(word);
      }
    }
    return out;
  }

  /**
   * One span split into its whitespace-separated words, as page-local rects.
   *
   * A word that wraps gives more than one client rect; the text rides on the
   * first, matching `selectedWordRects`, so `HL.textOf` picks each word up
   * exactly once.
   */
  function wordRectsOf(div, box) {
    const node = div.firstChild;
    if (!node || node.nodeType !== 3) return [];
    const text = node.data || '';
    if (!text.trim()) return [];

    const out = [];
    const range = document.createRange();
    const word = /\S+/g;
    let match = word.exec(text);
    while (match) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      let first = true;
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        out.push({
          left: rect.left - box.left,
          top: rect.top - box.top,
          right: rect.right - box.left,
          bottom: rect.bottom - box.top,
          text: first ? match[0] : ''
        });
        first = false;
      }
      match = word.exec(text);
    }
    return out;
  }

  /**
   * The selected words of one page, as rects local to its container.
   *
   * Works off `record.textDivs` — pdf.js's own list of leaf spans — rather
   * than the ranges' client rects, because a rect tells you nothing about
   * which word it came from and rounding out to a word boundary is the whole
   * point. `.text-layer` also contains `.markedContent` wrappers that are
   * `display: contents` and have no box of their own; textDivs excludes them.
   */
  function selectedWordRects(selection, record) {
    if (typeof selection.containsNode !== 'function') return [];
    const box = record.container.getBoundingClientRect();
    const out = [];
    for (const div of record.textDivs) {
      if (!div || !div.isConnected || !selection.containsNode(div, true)) continue;
      const got = wholeWordRects(selection, div);
      let first = true;
      for (const rect of got.rects) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        out.push({
          left: rect.left - box.left,
          top: rect.top - box.top,
          right: rect.right - box.left,
          bottom: rect.bottom - box.top,
          // A span that wraps yields more than one client rect for one piece
          // of text. The text rides on the *first* of them and the rest carry
          // none, so rebuilding the text in reading order picks each span up
          // exactly once, at the position of its leftmost/topmost rect.
          text: first ? got.text : ''
        });
        first = false;
      }
    }
    return out;
  }

  /**
   * The client rects of one span's selected text, grown to whole words.
   *
   * A range that stops mid-word is nearly always the substituted face
   * disagreeing with the plotted glyphs rather than an intention, so both ends
   * are pushed out to the enclosing whitespace. Taking the rects from one
   * range per span, rather than per word, also means the spaces *inside* the
   * span come back inside the rect for free.
   */
  function wholeWordRects(selection, div) {
    const node = div.firstChild;
    if (!node || node.nodeType !== 3) {
      return { rects: Array.from(div.getClientRects()), text: div.textContent || '' };
    }
    const text = node.data || '';
    if (!text.trim()) return { rects: [], text: '' };

    let from = text.length;
    let to = 0;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      if (typeof range.intersectsNode === 'function' && !range.intersectsNode(node)) continue;
      from = Math.min(from, range.startContainer === node ? range.startOffset : 0);
      to = Math.max(to, range.endContainer === node ? range.endOffset : text.length);
    }
    if (to <= from) return { rects: [], text: '' };
    while (from > 0 && !/\s/.test(text[from - 1])) from -= 1;
    while (to < text.length && !/\s/.test(text[to])) to += 1;

    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    // The substring is taken from the same offsets the rects were measured
    // from, so the words a bar covers and the words that get copied are the
    // same words by construction.
    return { rects: Array.from(range.getClientRects()), text: text.slice(from, to) };
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
  RP.tools.hl = HL;   // pure geometry, exposed so verify.js can drive it
  // The area-selection predicates are pure too, and the band rule is exactly
  // the kind of thing that is invisible until a sheet is in front of someone.
  RP.tools.band = { normBand, centreInBand };

})(window.RP);
