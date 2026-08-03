/* The markup properties dialog.

   Everything about one markup in one place: what it is, where it is, who put
   it there, how big it is, and the style and comment you can change without
   having to select it and go hunting along the toolbar. Reached from the
   viewer's right-click menu.

   Edits go through `RP.store.update`, which checkpoints for undo, so closing
   the dialog is not a commit and Ctrl+Z steps back through the changes made
   here exactly as it does for a drag. */
'use strict';

(function (RP) {

  const Props = {
    el: null,
    annotId: null,

    /** Open on a specific markup. Re-opening on another one replaces the dialog. */
    open(annot) {
      this.close();
      if (!annot) return;
      this.annotId = annot.id;

      const backdrop = RP.el('div', { class: 'modal-backdrop' });
      const modal = RP.el('div', { class: 'modal props-modal' });

      modal.appendChild(RP.el('header', {}, [
        RP.el('h2', { text: RP.store.typeLabel(annot.type) + ' properties' }),
        RP.el('button', {
          class: 'np-close',
          onclick: () => this.close()
        }, [RP.icon('close')])
      ]));

      const body = RP.el('div', { class: 'modal-body' });
      body.appendChild(this.factsTable(annot));
      body.appendChild(this.styleSection(annot));
      const type = this.typeSection(annot);
      if (type) body.appendChild(type);
      body.appendChild(this.commentSection(annot));
      modal.appendChild(body);

      modal.appendChild(RP.el('footer', { class: 'modal-foot' }, [
        RP.el('button', {
          class: 'ghost-btn small',
          text: 'Go to markup',
          onclick: () => { this.close(); RP.sidebar.focusAnnot(annot); }
        }),
        RP.el('span', { class: 'spacer', style: { flex: '1' } }),
        RP.el('button', {
          class: 'ghost-btn small danger',
          text: 'Delete',
          onclick: () => { RP.store.remove(annot.id); this.close(); }
        }),
        RP.el('button', { class: 'primary-btn small', text: 'Done', onclick: () => this.close() })
      ]));

      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) this.close(); });
      document.body.appendChild(backdrop);
      this.el = backdrop;

      this.onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } };
      document.addEventListener('keydown', this.onKey, true);

      // A markup deleted from under the dialog — by undo, or by a page edit —
      // leaves it describing something that is no longer there.
      this.offBus = RP.bus.on('annots:changed', () => {
        if (this.annotId && !RP.store.get(this.annotId)) this.close();
      });
    },

    close() {
      if (!this.el) return;
      this.el.remove();
      this.el = null;
      this.annotId = null;
      document.removeEventListener('keydown', this.onKey, true);
      if (this.offBus) { this.offBus(); this.offBus = null; }
    },

    // -- sections ----------------------------------------------------------

    factsTable(annot) {
      const box = RP.render.bbox(annot);
      const rows = [
        ['Type', RP.store.typeLabel(annot.type)],
        ['Page', String(annot.page + 1)],
        ['Author', annot.author || '—'],
        ['Created', RP.fmtDate(annot.created)],
        ['Modified', annot.modified && annot.modified !== annot.created ? RP.fmtDate(annot.modified) : '—'],
        ['Size', describeSize(annot, box)],
        ['Position', 'x ' + box.x.toFixed(1) + ' pt, y ' + box.y.toFixed(1) + ' pt']
      ];

      return RP.el('section', {}, [
        RP.el('h3', { text: 'Details' }),
        RP.el('div', { class: 'props-grid' }, rows.flatMap(([label, value]) => [
          RP.el('span', { class: 'props-key', text: label }),
          RP.el('span', { class: 'props-val', text: value })
        ]))
      ]);
    },

    styleSection(annot) {
      // Highlights and notes carry a fill, not a stroke, so a line width on
      // them would be a control that does nothing.
      const strokes = !['highlight', 'note', 'text'].includes(annot.type);

      const colour = RP.el('input', { type: 'color', value: annot.color || '#ff2f2f' });
      colour.addEventListener('input', () => this.patch({ color: colour.value }));

      const width = RP.el('input', {
        type: 'range', min: '1', max: '12', step: '0.5', value: String(annot.width || 2)
      });
      const widthOut = RP.el('output', { text: String(annot.width || 2) });
      width.addEventListener('input', () => {
        widthOut.textContent = width.value;
        this.patch({ width: Number(width.value) });
      });

      const opacityValue = Math.round((annot.opacity === undefined ? 1 : annot.opacity) * 100);
      const opacity = RP.el('input', {
        type: 'range', min: '10', max: '100', step: '5', value: String(opacityValue)
      });
      const opacityOut = RP.el('output', { text: opacityValue + '%' });
      opacity.addEventListener('input', () => {
        opacityOut.textContent = opacity.value + '%';
        this.patch({ opacity: Number(opacity.value) / 100 });
      });

      return RP.el('section', {}, [
        RP.el('h3', { text: 'Appearance' }),
        RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: annot.type === 'callout' ? 'Box colour' : 'Colour' }), colour
        ]),
        strokes ? RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Line width' }), width, widthOut
        ]) : null,
        RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Opacity' }), opacity, opacityOut
        ])
      ]);
    },

    /**
     * Typeface, size, weight and — for callouts, whose text sits on its own
     * white box — the text colour. Every one of these changes how the text
     * wraps, so a callout is refitted after each.
     */
    typeSection(annot) {
      if (annot.type !== 'text' && annot.type !== 'callout') return null;
      const isCallout = annot.type === 'callout';

      const family = RP.el('select', {}, [
        RP.el('option', { value: 'sans', text: 'Sans' }),
        RP.el('option', { value: 'serif', text: 'Serif' }),
        RP.el('option', { value: 'mono', text: 'Mono' })
      ]);
      family.value = annot.fontFamily || 'sans';
      family.addEventListener('change', () => this.patchText({ fontFamily: family.value }));

      const size = RP.el('input', {
        type: 'number', min: '4', max: '96', step: '1',
        value: String(annot.fontSize || (isCallout ? 11 : 12))
      });
      size.addEventListener('change', () => {
        const next = Math.min(96, Math.max(4, Number(size.value) || 12));
        size.value = String(next);
        this.patchText({ fontSize: next });
      });

      const bold = RP.el('input', { type: 'checkbox' });
      bold.checked = !!annot.bold;
      bold.addEventListener('change', () => this.patchText({ bold: bold.checked }));

      const textColour = RP.el('input', {
        type: 'color', value: annot.textColor || RP.render.DEFAULT_TEXT_COLOR
      });
      textColour.addEventListener('input', () => this.patchText({ textColor: textColour.value }));

      return RP.el('section', {}, [
        RP.el('h3', { text: 'Text' }),
        RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Typeface' }), family
        ]),
        RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Size' }), size
        ]),
        RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Bold' }), bold
        ]),
        isCallout ? RP.el('label', { class: 'opt field props-field' }, [
          RP.el('span', { text: 'Text colour' }), textColour
        ]) : null
      ]);
    },

    /** A typography edit, refitting the box it wraps inside. */
    patchText(values) {
      const live = RP.store.get(this.annotId);
      if (!live) return;
      if (live.type !== 'callout') { this.patch(values); return; }
      this.patch(Object.assign({}, values, RP.render.fitCallout(Object.assign({}, live, values))));
    },

    commentSection(annot) {
      const isText = annot.type === 'text' || annot.type === 'callout';
      const area = RP.el('textarea', {
        class: 'props-note',
        rows: '4',
        placeholder: isText ? 'The text drawn on the sheet…' : 'A comment on this markup…'
      });
      area.value = (isText ? annot.text : annot.note) || '';
      area.addEventListener('input', RP.debounce(() => {
        if (!isText) { this.patch({ note: area.value }); return; }
        // A callout's box is sized to its text, so editing it here has to refit
        // the box too or the overflow draws below it.
        if (annot.type !== 'callout') { this.patch({ text: area.value }); return; }
        const live = RP.store.get(this.annotId);
        if (!live) return;
        const fit = RP.render.fitCallout(Object.assign({}, live, { text: area.value }));
        this.patch(Object.assign({ text: area.value }, fit));
      }, 300));

      return RP.el('section', {}, [
        RP.el('h3', { text: isText ? 'Text' : 'Comment' }),
        area
      ]);
    },

    /** One edit. Checkpoints, so each change here is its own undo step. */
    patch(values) {
      if (!this.annotId) return;
      RP.store.update(this.annotId, values);
    }
  };

  /** Size in whatever unit the markup is actually about. */
  function describeSize(annot, box) {
    if (annot.type === 'measure') {
      const length = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
      return RP.store.formatLength(length) +
        (RP.store.scale ? '' : ' — scale not calibrated');
    }
    if (annot.type === 'note') return '—';
    return box.w.toFixed(1) + ' × ' + box.h.toFixed(1) + ' pt';
  }

  RP.props = Props;

})(window.RP);
