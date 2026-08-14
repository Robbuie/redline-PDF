/* Editing commands that act on a *set* of markups: the markup clipboard, and
   arranging a selection (align, distribute, match size, match style).

   These live together because they share one awkward property: every one of
   them is a bulk mutation that has to be **one undo step**. Working through
   `store.update` per markup would push a checkpoint each, and `Ctrl+Z` after
   aligning twelve callouts would then walk back through them one at a time —
   which is not the action the user took. So each command checkpoints once and
   then mutates in place, the way a drag does.

   The geometry is split out as pure functions returning *offsets* rather than
   moving anything, for two reasons. It is the part that is easy to get wrong
   (PDF space has y pointing **up**, so "align top" is a maximum and "align
   bottom" is a minimum — the opposite of what the words suggest on screen),
   and `test/verify.js` can only reach it if no store and no DOM are involved.

   The clipboard is deliberately in-memory and app-local. It has to survive a
   tab switch and work across open drawings, which the OS clipboard would also
   do — but a markup copy would then clobber whatever text the user had on the
   clipboard, and `Ctrl+C` here is shared with the text copy in `clip.js`. An
   internal buffer keeps the two from fighting over one key. */
'use strict';

(function (RP) {

  /* How far a paste is nudged when it cannot be placed under the pointer,
     in PDF points. Enough to see the copy is a copy, small enough that it is
     still obviously the same markup. */
  const PASTE_NUDGE = 14;

  /* The fields that make a markup *look* the way it does, as opposed to the
     ones that say where it is or what it says, each against the types it means
     anything on. This is what "match style" copies.

     Explicit on both axes, deliberately. Spreading the source's whole object
     would carry its geometry, its text and its review status across and turn
     twelve callouts into twelve copies of one. And handing a field to a type
     that has no case for it — a `fontSize` on a pen stroke, a `fill` on a line
     — puts a key on the markup that nothing reads, which `exporter.js` then
     writes into the saved file and carries for ever. Testing "does the target
     already have this key?" instead is the tempting shortcut and it is wrong
     the other way: a callout that has never been given an explicit text colour
     has no `textColor` at all, and is exactly the callout you are trying to
     restyle. */
  const STYLE_FIELDS = ['color', 'opacity', 'width', 'fill', 'textColor',
    'fontSize', 'fontFamily', 'bold'];

  const TEXTUAL = ['text', 'callout'];
  const FILLABLE = ['rect', 'ellipse', 'cloud'];
  const STROKED = ['pen', 'line', 'arrow', 'measure', 'rect', 'ellipse', 'cloud',
    'callout', 'polyline', 'polylength', 'area'];

  /** Does `field` mean anything on a markup of `type`? */
  function styleApplies(field, type) {
    switch (field) {
      case 'width': return STROKED.indexOf(type) !== -1;
      case 'fill': return FILLABLE.indexOf(type) !== -1;
      case 'textColor': return type === 'callout';
      case 'fontSize':
      case 'fontFamily':
      case 'bold': return TEXTUAL.indexOf(type) !== -1;
      // Colour and opacity are on everything: a note's colour is its pin, a
      // highlight's is its wash, a text markup's is its glyphs.
      default: return true;
    }
  }

  /* Types with a box the user actually sees and can meaningfully be given
     another markup's dimensions. A line's bbox is an artefact of where its two
     ends happen to be, and "match size" on a run of highlight rects would
     stretch the rects off the words they were measured from — so both are
     left out rather than silently mangled. */
  const SIZEABLE = ['rect', 'ellipse', 'cloud', 'cover', 'callout'];

  const EDGES = {
    left: { axis: 'x', label: 'Align left' },
    right: { axis: 'x', label: 'Align right' },
    hcentre: { axis: 'x', label: 'Centre horizontally' },
    top: { axis: 'y', label: 'Align top' },
    bottom: { axis: 'y', label: 'Align bottom' },
    vcentre: { axis: 'y', label: 'Centre vertically' }
  };

  // -------------------------------------------------------------------------
  // Pure geometry — boxes in, offsets out. No store, no DOM.
  // -------------------------------------------------------------------------

  /**
   * How far each box has to move to line up on `edge`.
   *
   * Boxes are `{x, y, w, h}` in **PDF user space**, so y grows upward: `top`
   * is the largest `y + h` in the set and `bottom` is the smallest `y`. Get
   * that backwards and the two commands swap, which looks like a wiring
   * mistake rather than a sign error and is why this is tested directly.
   *
   * The target is the outer edge of the selection's own bounding box, not the
   * first or last markup picked. Selection order here is a `Set`'s insertion
   * order, which for a marquee is document order — i.e. an implementation
   * detail of how the markups were gathered, and not something a user could
   * predict or aim at.
   */
  function alignOffsets(boxes, edge) {
    const spec = EDGES[edge];
    const list = boxes || [];
    if (!spec || list.length < 2) return list.map(() => ({ dx: 0, dy: 0 }));

    let target = 0;
    switch (edge) {
      case 'left': target = Math.min.apply(null, list.map((b) => b.x)); break;
      case 'right': target = Math.max.apply(null, list.map((b) => b.x + b.w)); break;
      case 'bottom': target = Math.min.apply(null, list.map((b) => b.y)); break;
      case 'top': target = Math.max.apply(null, list.map((b) => b.y + b.h)); break;
      case 'hcentre': {
        const lo = Math.min.apply(null, list.map((b) => b.x));
        const hi = Math.max.apply(null, list.map((b) => b.x + b.w));
        target = (lo + hi) / 2;
        break;
      }
      default: {
        const lo = Math.min.apply(null, list.map((b) => b.y));
        const hi = Math.max.apply(null, list.map((b) => b.y + b.h));
        target = (lo + hi) / 2;
        break;
      }
    }

    return list.map((b) => {
      let delta = 0;
      switch (edge) {
        case 'left': delta = target - b.x; break;
        case 'right': delta = target - (b.x + b.w); break;
        case 'bottom': delta = target - b.y; break;
        case 'top': delta = target - (b.y + b.h); break;
        case 'hcentre': delta = target - (b.x + b.w / 2); break;
        default: delta = target - (b.y + b.h / 2); break;
      }
      return spec.axis === 'x' ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
    });
  }

  /**
   * How far each box has to move for the *gaps* between them to be equal.
   *
   * The two outermost boxes stay put — they define the extent, and moving them
   * would make the command drift the whole group every time it was used. Gaps
   * are equalised rather than centres, which is what "distribute" means for
   * boxes of different sizes: even centres on a wide box beside a narrow one
   * leaves visibly uneven space.
   *
   * Returns offsets in the order `boxes` came in, not in sorted order, so a
   * caller can zip them straight back onto its own list.
   */
  function distributeOffsets(boxes, axis) {
    const list = boxes || [];
    const out = list.map(() => ({ dx: 0, dy: 0 }));
    if (list.length < 3) return out;

    const horizontal = axis !== 'y';
    const lo = (b) => (horizontal ? b.x : b.y);
    const size = (b) => (horizontal ? b.w : b.h);

    const order = list.map((b, i) => i).sort((a, b) => lo(list[a]) - lo(list[b]));
    const first = list[order[0]];
    const last = list[order[order.length - 1]];
    const span = (lo(last) + size(last)) - lo(first);
    let occupied = 0;
    for (const b of list) occupied += size(b);
    // Negative when the markups overlap more than the extent allows. Spacing
    // them by a negative gap is still the right answer — it spreads them out
    // evenly *within* the extent rather than refusing, which is what a user
    // gets from every other tool that has this command.
    const gap = (span - occupied) / (list.length - 1);

    let cursor = lo(first);
    for (const index of order) {
      const box = list[index];
      const delta = cursor - lo(box);
      if (horizontal) out[index].dx = delta;
      else out[index].dy = delta;
      cursor += size(box) + gap;
    }
    return out;
  }

  /**
   * The box every markup should end up with when matching size, given the
   * boxes in the set.
   *
   * The largest in each requested dimension wins, and the box keeps its
   * *screen* top-left corner — `x` and `y + h` — so a column of boxes grows
   * downward and rightward from where each one already sits rather than
   * jumping. In PDF space that means `y` moves when the height changes.
   */
  function sizeTargets(boxes, dims) {
    const list = boxes || [];
    const wantW = !dims || dims.width !== false;
    const wantH = !dims || dims.height !== false;
    if (list.length < 2) return list.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
    const maxW = Math.max.apply(null, list.map((b) => b.w));
    const maxH = Math.max.apply(null, list.map((b) => b.h));
    return list.map((b) => {
      const w = wantW ? maxW : b.w;
      const h = wantH ? maxH : b.h;
      return { x: b.x, y: b.y + b.h - h, w, h };
    });
  }

  // -------------------------------------------------------------------------
  // The commands
  // -------------------------------------------------------------------------

  const Edit = {
    /* The markup clipboard: `{annots, page}`. Plain data, already stripped of
       identity, so a paste is a fresh `store.add` per item rather than a
       reference into whatever document it came from — which may since have
       been closed. */
    buffer: null,

    /**
     * The box to line a markup up by.
     *
     * A callout is aligned by its **box**, not by its `bbox`, which includes
     * the arrow tip: aligning the tips of six callouts left is not a command
     * anybody wants, and it would scatter the boxes doing it. Everything else
     * uses its bbox, and the whole markup — leader included — is what moves.
     */
    boxOf(annot) {
      if (annot.type === 'callout') return RP.render.calloutBox(annot);
      return RP.render.bbox(annot);
    },

    /**
     * The selection, as markups, or null with a status message if the command
     * cannot apply to it.
     *
     * Arranging across pages is refused rather than attempted. The coordinates
     * are per-page, so it would "work" — and silently move markups on a sheet
     * the user cannot see, which is the worst outcome available here. The
     * markup list can select across pages, so this is reachable.
     */
    targets(min) {
      const store = RP.store;
      const list = store.selected();
      if (list.length < (min || 2)) {
        RP.status('Select ' + (min || 2) + ' or more markups first', 'warn');
        return null;
      }
      const pages = new Set(list.map((a) => a.page));
      if (pages.size > 1) {
        RP.status('Those markups are on different sheets — arranging works within one sheet', 'warn');
        return null;
      }
      return list;
    },

    /** Line the selection up on one edge of its own bounding box. */
    align(edge) {
      const list = this.targets(2);
      if (!list) return 0;
      const offsets = alignOffsets(list.map((a) => this.boxOf(a)), edge);
      const store = RP.store;
      store.checkpoint();
      let moved = 0;
      list.forEach((annot, i) => {
        const { dx, dy } = offsets[i];
        if (!dx && !dy) return;
        RP.render.translate(annot, dx, dy);
        annot.modified = Date.now();
        moved += 1;
      });
      this.finish(list, moved, (EDGES[edge] || {}).label || 'Aligned');
      return moved;
    },

    /** Equalise the gaps between three or more markups. */
    distribute(axis) {
      const list = this.targets(3);
      if (!list) return 0;
      const offsets = distributeOffsets(list.map((a) => this.boxOf(a)), axis);
      RP.store.checkpoint();
      let moved = 0;
      list.forEach((annot, i) => {
        const { dx, dy } = offsets[i];
        if (!dx && !dy) return;
        RP.render.translate(annot, dx, dy);
        annot.modified = Date.now();
        moved += 1;
      });
      this.finish(list, moved, axis === 'y' ? 'Distributed vertically' : 'Distributed horizontally');
      return moved;
    },

    /**
     * Give every markup in the selection the largest one's dimensions.
     *
     * Only the types with a box the user drew are touched — see `SIZEABLE`.
     * The rest are left where they are and counted, so the status line can say
     * that they were skipped rather than leaving the user to wonder why a line
     * in the selection did not change.
     */
    matchSize(dims) {
      const list = this.targets(2);
      if (!list) return 0;
      const eligible = list.filter((a) => SIZEABLE.indexOf(a.type) !== -1);
      if (eligible.length < 2) {
        RP.status('Match size needs two or more boxes, ovals, clouds, covers or callouts', 'warn');
        return 0;
      }
      const boxes = eligible.map((a) => this.boxOf(a));
      const targets = sizeTargets(boxes, dims);
      RP.store.checkpoint();
      let changed = 0;
      eligible.forEach((annot, i) => {
        const next = targets[i];
        const prev = boxes[i];
        if (Math.abs(next.w - prev.w) < 0.01 && Math.abs(next.h - prev.h) < 0.01) return;
        /* `fitToBox` maps from an *original* copy rather than from the live
           annotation, because it reads geometry it is also writing. A callout
           is resized by its box, and its box is what `boxOf` returned, so the
           tip stays pinned to whatever it points at. */
        const orig = JSON.parse(JSON.stringify(annot));
        RP.render.fitToBox(annot, orig, prev, next);
        if (annot.type === 'callout') Object.assign(annot, RP.render.fitCallout(annot));
        annot.modified = Date.now();
        changed += 1;
      });
      const skipped = list.length - eligible.length;
      this.finish(list, changed, 'Matched size' + (skipped ? ' — ' + skipped + ' skipped' : ''));
      return changed;
    },

    /**
     * Push one markup's appearance onto the rest of the selection.
     *
     * `sourceId` is the markup the command was invoked *on* — the one that was
     * right-clicked — because "make these look like this one" needs an
     * unambiguous "this one", and a `Set`'s insertion order is not something a
     * user can see or aim at. Falling back to the first selected is only for
     * the case where there is no such markup.
     */
    matchStyle(sourceId) {
      const list = this.targets(2);
      if (!list) return 0;
      const source = list.find((a) => a.id === sourceId) || list[0];
      const patch = {};
      for (const field of STYLE_FIELDS) {
        if (source[field] !== undefined) patch[field] = source[field];
      }
      RP.store.checkpoint();
      let changed = 0;
      for (const annot of list) {
        if (annot === source) continue;
        // Only the fields that mean something on this type — see STYLE_FIELDS.
        let touched = false;
        for (const field of STYLE_FIELDS) {
          if (!(field in patch)) continue;
          if (!styleApplies(field, annot.type)) continue;
          if (annot[field] === patch[field]) continue;
          annot[field] = patch[field];
          touched = true;
        }
        if (!touched) continue;
        // A callout's box is sized from its text in its own face, so a new
        // font size or family has to re-fit it or the box stops matching what
        // is drawn in it.
        if (annot.type === 'callout') Object.assign(annot, RP.render.fitCallout(annot));
        annot.modified = Date.now();
        changed += 1;
      }
      this.finish(list, changed, 'Matched style of the ' + RP.store.typeLabel(source.type).toLowerCase());
      return changed;
    },

    // -----------------------------------------------------------------------
    // Grouping
    // -----------------------------------------------------------------------

    /**
     * Make the selection one group.
     *
     * Single sheet only, through the same `targets` gate as arranging and for
     * the same reason: a group moves and resizes as one, and those are per-page
     * coordinates. A group reaching onto a sheet you cannot see would drag
     * markups there every time you nudged the half you could.
     *
     * A selection that already contains groups absorbs them into the new one
     * rather than nesting — see the note in `store.js`. That is why this cannot
     * short-circuit on "they are already grouped" without also checking that
     * the group has nothing else in it: three markups of a group of five are a
     * different group from the five.
     */
    group() {
      const list = this.targets(2);
      if (!list) return 0;
      const store = RP.store;
      const existing = new Set(list.map((a) => RP.groupOf(a)));
      if (existing.size === 1 && !existing.has(null) &&
          store.groupMembers(list[0].group).length === list.length) {
        RP.status('Those markups are already one group');
        return 0;
      }
      const id = RP.uid('grp');
      store.checkpoint();
      for (const annot of list) {
        annot.group = id;
        annot.modified = Date.now();
      }
      this.finish(list, list.length, 'Grouped');
      return list.length;
    },

    /**
     * Break every group in the selection back into loose markups.
     *
     * Selection always expands to whole groups, so this cannot half-ungroup
     * one. It counts the markups it freed rather than the groups it dissolved,
     * because that is the number the status line's "n markups" phrasing means
     * everywhere else in this file.
     */
    ungroup() {
      const store = RP.store;
      const list = store.selected().filter((a) => RP.groupOf(a));
      if (!list.length) {
        RP.status('None of the selected markups are grouped', 'warn');
        return 0;
      }
      store.checkpoint();
      for (const annot of list) {
        delete annot.group;
        annot.modified = Date.now();
      }
      this.finish(list, list.length, 'Ungrouped');
      return list.length;
    },

    /** True when `group()` would do something. */
    canGroup() {
      const store = RP.store;
      if (store.selection.size < 2) return false;
      const list = store.selected();
      if (new Set(list.map((a) => a.page)).size > 1) return false;
      const groups = new Set(list.map((a) => RP.groupOf(a)));
      if (groups.size !== 1 || groups.has(null)) return true;
      return store.groupMembers(list[0].group).length !== list.length;
    },

    canUngroup() {
      return RP.store.selected().some((a) => RP.groupOf(a));
    },

    /**
     * The Group / Ungroup rows, for the drawing's menu and the markup list's.
     *
     * Its own section rather than part of `menuItems`, because the two have
     * different conditions: arranging needs two markups on one sheet, and
     * Ungroup is offered on a group however it came to be selected. Returns
     * nothing at all when neither applies, so a lone markup's menu does not
     * grow a pair of dead rows.
     */
    groupMenuItems() {
      const can = this.canGroup();
      const canUn = this.canUngroup();
      if (!can && !canUn) return [];
      const rows = [{ separator: true }];
      if (can) {
        rows.push({
          label: 'Group ' + RP.store.selection.size + ' markups',
          hint: 'Ctrl+Shift+G',
          run: () => this.group()
        });
      }
      if (canUn) {
        rows.push({ label: 'Ungroup', hint: 'Ctrl+Shift+U', run: () => this.ungroup() });
      }
      return rows;
    },

    /**
     * Commit a bulk mutation: one dirty flag, one repaint, one message.
     *
     * `checkpoint` was already taken by the caller, so a run that changed
     * nothing has pushed a history entry it did not need. Popping it back off
     * is what keeps `Ctrl+Z` from having a dead step in it after aligning a
     * selection that was already aligned.
     */
    finish(list, changed, message) {
      const store = RP.store;
      if (!changed) {
        store.history.pop();
        RP.status('Nothing to change — already arranged that way');
        return;
      }
      store.markDirty();
      store.emit('annots:changed', { reason: 'arrange' });
      RP.status(message + ': ' + changed + (changed === 1 ? ' markup' : ' markups'));
    },

    // -----------------------------------------------------------------------
    // Clipboard
    // -----------------------------------------------------------------------

    /**
     * Copy the selection — to the markup buffer *and*, as text, to Windows.
     *
     * Both, not one or the other. Copying markups already meant "put their
     * readings on the clipboard, one per line, ready for an email or an RFI",
     * and that is still what a paste into anything outside this app should
     * produce; pasting back onto a drawing wants the markups themselves. The
     * two destinations are different clipboards, so there is nothing to
     * choose between — and that is the reason the markup buffer is internal.
     * Put the markups on the OS clipboard instead and one of these two uses
     * would have to lose.
     *
     * Identity is stripped on the way *in*, not on the way out: a buffer
     * holding live ids could be pasted back into the drawing it came from and
     * produce two markups claiming one id, which the selection set and every
     * `store.get` would then disagree about.
     */
    copy() {
      const list = RP.store.selected();
      if (!list.length) return 0;
      this.buffer = {
        page: list[0].page,
        annots: list.map((annot) => {
          const copy = JSON.parse(JSON.stringify(annot));
          delete copy.id;
          delete copy.created;
          delete copy.modified;
          return copy;
        })
      };
      // Fire and forget: the OS clipboard goes through main, and the status
      // line below belongs to the copy that has already succeeded.
      const summary = RP.clip.selectedMarkupText();
      if (summary) RP.clip.write(summary);
      RP.status('Copied ' + list.length + (list.length === 1 ? ' markup' : ' markups'));
      return list.length;
    },

    cut() {
      const n = this.copy();
      if (!n) return 0;
      RP.store.remove(Array.from(RP.store.selection));
      RP.tools.closeNotePopup();
      RP.status('Cut ' + n + (n === 1 ? ' markup' : ' markups'));
      return n;
    },

    hasBuffer() { return !!(this.buffer && this.buffer.annots && this.buffer.annots.length); },

    /**
     * How far the buffer has to move to land centred on `at`, or nudged off
     * its original position when there is nowhere to point at.
     *
     * The pointer is the target because the case this exists for is stamping —
     * a set of initials, a "verify on site", the same cloud on six sheets. A
     * paste that landed back at its original coordinates would need a drag
     * after every one of them.
     */
    pasteOffset(boxes, at) {
      const union = RP.geom.unionRect(boxes);
      if (!at) return { dx: PASTE_NUDGE, dy: -PASTE_NUDGE, union };
      return {
        dx: at[0] - (union.x + union.w / 2),
        dy: at[1] - (union.y + union.h / 2),
        union
      };
    },

    /**
     * Paste the buffer onto `page`, centred on the PDF-space point `at`.
     *
     * The pasted markups become the selection, which is what makes "paste,
     * then drag it a bit" one gesture, and what lets a second `Ctrl+V`
     * somewhere else work from the same buffer without re-copying.
     */
    paste(page, at) {
      if (!this.hasBuffer()) { RP.status('Nothing to paste', 'warn'); return 0; }
      const store = RP.store;
      const target = page === undefined || page === null ? RP.viewer.currentPage : page;
      const clones = this.buffer.annots.map((a) => JSON.parse(JSON.stringify(a)));
      const { dx, dy } = this.pasteOffset(clones.map((a) => this.boxOf(a)), at);

      /* Groups are re-keyed on the way out, the way identity is stripped on the
         way in. A pasted copy carrying the source's group id would join the
         original's group — so dragging the copy would drag the markups it was
         copied from, on another sheet or in another drawing, and the two would
         never come apart again. A copy is its own group.

         Re-keyed rather than dropped, because the grouping *within* the copy is
         the thing worth keeping: a stamp made of six markups pastes as one
         thing, which is the case the whole feature exists for. */
      const counts = new Map();
      for (const clone of clones) {
        const old = RP.groupOf(clone);
        if (old) counts.set(old, (counts.get(old) || 0) + 1);
      }
      const regroup = new Map();
      for (const clone of clones) {
        const old = RP.groupOf(clone);
        if (!old) continue;
        // One member of a group copied on its own arrives as a loose markup,
        // not as a group of one — copying part of a group is how you get one.
        if (counts.get(old) < 2) { delete clone.group; continue; }
        if (!regroup.has(old)) regroup.set(old, RP.uid('grp'));
        clone.group = regroup.get(old);
      }

      for (const clone of clones) {
        RP.render.translate(clone, dx, dy);
        clone.page = target;
        clone.author = store.author || '';
        /* A pasted markup is a new item on the punch list, whatever the state
           of the one it was copied from. Carrying a 'closed' across would put
           a markup nobody has looked at into the resolved column. */
        clone.status = 'open';
      }
      // One step, one repaint — see `store.addMany`.
      const made = store.addMany(clones);
      store.selection.clear();
      for (const annot of made) store.selection.add(annot.id);
      store.emit('selection:changed');
      RP.tools.setTool('select');
      RP.status('Pasted ' + made.length + (made.length === 1 ? ' markup' : ' markups') +
        ' on page ' + (target + 1));
      return made.length;
    },

    /**
     * The Arrange rows for the right-click menu.
     *
     * Built here rather than in `tools.js` so the one place that knows what
     * these commands need — two markups for align, three for distribute — is
     * also the place that decides which rows are offered. Returns nothing at
     * all below two selected, so a single markup's menu does not grow a
     * section of disabled rows.
     */
    menuItems(sourceId) {
      const store = RP.store;
      const n = store.selection.size;
      if (n < 2) return [];
      const pages = new Set(store.selected().map((a) => a.page));
      if (pages.size > 1) return [];
      return [
        { separator: true },
        { heading: 'Arrange ' + n + ' markups' },
        { label: 'Align left', run: () => this.align('left') },
        { label: 'Centre horizontally', run: () => this.align('hcentre') },
        { label: 'Align right', run: () => this.align('right') },
        { label: 'Align top', run: () => this.align('top') },
        { label: 'Centre vertically', run: () => this.align('vcentre') },
        { label: 'Align bottom', run: () => this.align('bottom') },
        { label: 'Distribute horizontally', disabled: n < 3, run: () => this.distribute('x') },
        { label: 'Distribute vertically', disabled: n < 3, run: () => this.distribute('y') },
        { label: 'Match size', run: () => this.matchSize() },
        { label: 'Match style', run: () => this.matchStyle(sourceId) }
      ];
    }
  };

  RP.edit = Edit;
  // Exported for `test/verify.js`, which checks the sign conventions directly:
  // PDF space has y upward, so `top` is a maximum and `bottom` a minimum.
  RP.edit.alignOffsets = alignOffsets;
  RP.edit.distributeOffsets = distributeOffsets;
  RP.edit.sizeTargets = sizeTargets;
  RP.edit.STYLE_FIELDS = STYLE_FIELDS;
  RP.edit.styleApplies = styleApplies;
  RP.edit.SIZEABLE = SIZEABLE;
  RP.edit.PASTE_NUDGE = PASTE_NUDGE;

})(window.RP);
